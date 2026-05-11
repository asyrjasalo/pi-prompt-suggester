import { type ExtensionAPI, type ExtensionContext, type InputEvent, VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import path from "node:path";

async function buildIdleHint(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	const parts: string[] = [];
	parts.push(`pi v${VERSION}`);

	const commands = pi.getCommands();
	const byScope = (source: string) => {
		const paths = commands.filter((c) => c.source === source).map((c) => c.sourceInfo.path);
		const user = new Set(paths.filter((_, i) => commands.filter((c) => c.source === source)[i].sourceInfo.scope === "user")).size;
		const project = new Set(paths.filter((_, i) => commands.filter((c) => c.source === source)[i].sourceInfo.scope === "project")).size;
		return { user, project };
	};

	const fmtScope = (user: number, project: number, label: string) => {
		const parts_s: string[] = [];
		if (user > 0) parts_s.push(`${user}u`);
		if (project > 0) parts_s.push(`${project}p`);
		return parts_s.length > 0 ? `${parts_s.join("/")} ${label}` : "";
	};

	const prompts = byScope("prompt");
	const ps = fmtScope(prompts.user, prompts.project, "prompts");
	if (ps) parts.push(ps);

	const skills = byScope("skill");
	const ss = fmtScope(skills.user, skills.project, "skills");
	if (ss) parts.push(ss);

	const ext = byScope("extension");
	const es = fmtScope(ext.user, ext.project, "extensions");
	if (es) parts.push(es);

	try {
		const sessions = await SessionManager.list(ctx.cwd);
		if (sessions.length > 0) parts.push(`${sessions.length} sessions for ${path.basename(ctx.cwd)}`);
	} catch { /* ignore */ }

	return parts.length > 0 ? parts.join(" · ") : undefined;
}
import { createAppComposition, type AppComposition } from "./composition/root.js";
import { buildLatestHistoricalTurnContext } from "./app/services/conversation-signals.js";
import { PiExtensionAdapter } from "./infra/pi/extension-adapter.js";
import { GhostSuggestionEditor } from "./infra/pi/ghost-suggestion-editor.js";
import { getGhostEditorSyncAction, type GhostEditorInstallState } from "./infra/pi/ghost-editor-installation.js";
import {
	handleConfigCommand,
	handleInstructionCommand,
	handleModelCommand,
	handleSeedTraceCommand,
	handleSettingsUiCommand,
	handleThinkingCommand,
	handleVariantCommand,
	handleAbCommand,
	renderStatus,
} from "./infra/pi/command-handlers.js";
import { matchesGhostAcceptKey } from "./infra/pi/ghost-accept-keys.js";
import { acceptWidgetSuggestion, refreshSuggesterUi } from "./infra/pi/ui-adapter.js";
import { createUiContext, type UiContextLike } from "./infra/pi/ui-context.js";
import { usesWidgetSuggestion } from "./infra/pi/suggestion-display-mode.js";

export default function suggester(pi: ExtensionAPI) {
	let compositionPromise: Promise<AppComposition> | undefined;
	let ghostEditorInstallState: GhostEditorInstallState | undefined;
	/** Latest composition with context; used by widget terminal accept hook. */
	let hotComposition: AppComposition | undefined;
	let widgetAcceptTerminalUnsub: (() => void) | undefined;

	function syncGhostEditorInstallation(ctx: ExtensionContext, composition: AppComposition): void {
		if (!ctx.hasUI) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		switch (getGhostEditorSyncAction({
			state: ghostEditorInstallState,
			context: ctx,
			displayMode: composition.config.suggestion.displayMode,
			sessionFile,
		})) {
			case "noop":
				return;
			case "uninstall":
				ctx.ui.setEditorComponent(undefined);
				ghostEditorInstallState = undefined;
				return;
			case "install":
				break;
		}

		ctx.ui.setEditorComponent((tui, theme, kb) =>
			new GhostSuggestionEditor(
				tui,
				theme,
				kb,
				() => composition.runtimeRef.getSuggestion(),
				() => composition.runtimeRef.getSuggestionRevision(),
				composition.config.suggestion.ghostAcceptKeys,
				() => composition.runtimeRef.getEditorHistoryState(),
				(state) => composition.runtimeRef.setEditorHistoryState(state),
			),
		);
		ghostEditorInstallState = { context: ctx, sessionFile };
	}

	async function getComposition(): Promise<AppComposition> {
		if (!compositionPromise) {
			compositionPromise = createAppComposition(pi).catch((error) => {
				compositionPromise = undefined;
				throw error;
			});
		}
		return await compositionPromise;
	}

	async function setRuntimeContext(ctx: ExtensionContext): Promise<AppComposition> {
		const composition = await getComposition();
		composition.runtimeRef.setContext(ctx);
		hotComposition = composition;
		return composition;
	}

	function attachWidgetAcceptTerminalInput(ctx: ExtensionContext): void {
		widgetAcceptTerminalUnsub?.();
		widgetAcceptTerminalUnsub = ctx.ui.onTerminalInput((data: string) => {
			const composition = hotComposition;
			if (!composition) return undefined;
			if (!usesWidgetSuggestion(composition.config.suggestion.displayMode)) return undefined;

			const runtime = composition.runtimeRef;
			const hasSuggestion = runtime.getSuggestion() ?? runtime.getWidgetRestoreSuggestion();
			if (hasSuggestion && matchesGhostAcceptKey(data, composition.config.suggestion.ghostAcceptKeys)) {
				const result = acceptWidgetSuggestion(getUiContext(composition));
				if (result === "accepted") return { consume: true };
				return undefined;
			}

			setImmediate(() => refreshSuggesterUi(getUiContext(composition)));
			return undefined;
		});
	}

	function getUiContext(composition: AppComposition): UiContextLike {
		return createUiContext({
			runtimeRef: composition.runtimeRef,
			config: composition.config,
			variantStore: composition.stores.variantStore,
			getSessionThinkingLevel: () => pi.getThinkingLevel(),
		});
	}

	function syncSuggestionUi(ctx: ExtensionContext, composition: AppComposition): void {
		if (!ctx.hasUI) return;
		syncGhostEditorInstallation(ctx, composition);
		refreshSuggesterUi(getUiContext(composition));
	}

	const adapter = new PiExtensionAdapter(pi, {
		onSessionStart: async (ctx) => {
			const composition = await setRuntimeContext(ctx);

			// Build idle hint for empty widget state
			buildIdleHint(pi, ctx).then((hint) => {
				composition.runtimeRef.setIdleHint(hint);
				if (ctx.hasUI) refreshSuggesterUi(getUiContext(composition));
			}).catch(() => { /* non-critical */ });
			if (ctx.hasUI) {
				attachWidgetAcceptTerminalInput(ctx);
				if (composition.config.suggestion.hideChatWorkingIndicator) {
					ctx.ui.setWorkingVisible(false);
				}
			}
			const generationId = composition.runtimeRef.bumpEpoch();
			syncSuggestionUi(ctx, composition);
			await composition.orchestrators.sessionStart.handle();

			const sourceLeafId = ctx.sessionManager.getLeafId() ?? `turn-${Date.now()}`;
			if (composition.runtimeRef.getLastBootstrappedLeafId() === sourceLeafId) return;

			const state = await composition.stores.stateStore.load();
			if (state.lastSuggestion?.turnId === sourceLeafId) {
				composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
				return;
			}

			const branchEntries = ctx.sessionManager
				.getBranch()
				.filter((entry): entry is ReturnType<typeof ctx.sessionManager.getBranch>[number] & { type: "message" } =>
					entry.type === "message"
				);
			const historicalTurn = buildLatestHistoricalTurnContext({ branchEntries });
			if (!historicalTurn) return;

			composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
			composition.runtimeRef.setLastTurnContext(historicalTurn);
			const signal = composition.runtimeRef.getSignal();
			void composition.orchestrators.agentEnd.handle(historicalTurn, generationId, signal).catch((error: unknown) => {
				if (error instanceof Error && error.name === "AbortError") return;
				console.error(error);
			});
		},
		onAgentEnd: async (turn, ctx) => {
			if (!turn) return;
			const composition = await setRuntimeContext(ctx);
			syncSuggestionUi(ctx, composition);
			composition.runtimeRef.setLastTurnContext(turn);
			const generationId = composition.runtimeRef.bumpEpoch();
			const signal = composition.runtimeRef.getSignal();
			void composition.orchestrators.agentEnd.handle(turn, generationId, signal).catch((error: unknown) => {
				if (error instanceof Error && error.name === "AbortError") return;
				console.error(error);
			});
		},
		onUserSubmit: async (event: InputEvent, ctx) => {
			const composition = await setRuntimeContext(ctx);
			syncSuggestionUi(ctx, composition);
			composition.runtimeRef.bumpEpoch();
			await composition.orchestrators.userSubmit.handle({
				turnId: ctx.sessionManager.getLeafId() ?? `input-${Date.now()}`,
				userPrompt: event.text,
				source: event.source,
			});
		},
		onReseedCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await composition.orchestrators.reseedRunner.trigger({
				reason: "manual",
				changedFiles: [],
			});
			ctx.ui.notify("suggester reseed queued", "info");
		},
		onStatusCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const [seed, state] = await Promise.all([
				composition.stores.seedStore.load(),
				composition.stores.stateStore.load(),
			]);
			const effectiveConfig = composition.stores.variantStore.getEffectiveConfig(composition.config);
			pi.sendMessage(
				{
					customType: "prompt-suggester-status",
					content: renderStatus(
						seed,
						state,
						effectiveConfig,
						ctx,
						composition.stores.variantStore.getActiveVariantName(),
					),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
		onModelCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleModelCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onThinkingCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleThinkingCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onConfigCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleConfigCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onInstructionCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleInstructionCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onVariantCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleVariantCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onAbCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleAbCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onSettingsUiCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleSettingsUiCommand(ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onSeedTraceCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleSeedTraceCommand(args, pi, composition);
			ctx.ui.notify("suggester seed trace sent to chat", "info");
		},
	});

	adapter.register();
}
