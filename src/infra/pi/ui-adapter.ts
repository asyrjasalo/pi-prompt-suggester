import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { SuggestionSink } from "../../app/orchestrators/turn-end.js";
import type { GhostAcceptKey } from "../../config/types.js";
import type { SuggestionUsageStats } from "../../domain/state.js";
import { formatTokens } from "./display.js";
import { formatGhostAcceptKeys } from "./ghost-accept-keys.js";
import { getSuggestionStatusText, usesGhostEditor, usesWidgetSuggestion } from "./suggestion-display-mode.js";
import type { UiContextLike } from "./ui-context.js";

/** Pi's default braille spinner frames. */
const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"] as const;
const SPINNER_INTERVAL_MS = 80;

let spinnerFrameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let activeTui: { requestRender: () => void } | undefined;

function startSpinnerAnimation(): void {
	if (spinnerTimer !== undefined) return;
	if (!activeTui) return;
	const tui = activeTui;
	spinnerTimer = setInterval(() => {
		spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
		tui.requestRender();
	}, SPINNER_INTERVAL_MS);
}

function stopSpinnerAnimation(): void {
	if (spinnerTimer !== undefined) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
		spinnerFrameIndex = 0;
	}
}

/** Widget-mode footer hint; matches `ghostAcceptKeys` (same labels as ghost editor). */
export function widgetAcceptHintText(ghostAcceptKeys: readonly GhostAcceptKey[] | undefined): string {
	return `${formatGhostAcceptKeys(ghostAcceptKeys)} accepts`;
}

function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("extension ctx is stale");
}

function editorHasTypedContent(ctx: ExtensionContext): boolean {
	return ctx.ui.getEditorText().trim().length > 0;
}

/** Widget panel text: active suggestion, or restore buffer when editor cleared after accept. Dimmed when user has typed content. */
function effectiveWidgetSuggestionText(runtime: UiContextLike, ctx: ExtensionContext): { text: string; isWorking: boolean; dimmed: boolean } | undefined {
	const working = runtime.getWorkingText();
	if (working) return { text: working, isWorking: true, dimmed: false };

	const hasTyped = editorHasTypedContent(ctx);
	const primary = runtime.getSuggestion();
	if (primary) return { text: primary, isWorking: false, dimmed: hasTyped };
	const restored = runtime.getWidgetRestoreSuggestion();
	if (restored) return { text: restored, isWorking: false, dimmed: hasTyped };
	return undefined;
}

function getSafeUiContext(runtime: UiContextLike): ExtensionContext | undefined {
	try {
		const ctx = runtime.getContext();
		if (!ctx?.hasUI) return undefined;
		return ctx;
	} catch (error) {
		if (isStaleContextError(error)) return undefined;
		throw error;
	}
}

function formatUsage(
	usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats },
	suggesterModelDisplay: string | undefined,
): string {
	const combinedInput = usage.suggester.inputTokens + usage.seeder.inputTokens;
	const combinedOutput = usage.suggester.outputTokens + usage.seeder.outputTokens;
	const combinedCacheRead = usage.suggester.cacheReadTokens + usage.seeder.cacheReadTokens;
	const combinedCost = usage.suggester.costTotal + usage.seeder.costTotal;
	const suffix = suggesterModelDisplay ? `, suggester: ${suggesterModelDisplay}` : "";
	return `suggester usage: ↑${formatTokens(combinedInput)} ↓${formatTokens(combinedOutput)} R${formatTokens(combinedCacheRead)} $${combinedCost.toFixed(3)} (${usage.suggester.calls} sugg, ${usage.seeder.calls} seed)${suffix}`;
}

function formatPanelLog(
	ctx: ExtensionContext,
	status: { level: "debug" | "info" | "warn" | "error"; text: string },
): string {
	const theme = ctx.ui.theme;
	if (status.level === "error") return theme.fg("error", status.text);
	if (status.level === "warn") return theme.fg("warning", status.text);
	if (status.level === "debug") return theme.fg("dim", status.text);
	return theme.fg("muted", status.text);
}

export function refreshSuggesterUi(runtime: UiContextLike): void {
	const ctx = getSafeUiContext(runtime);
	if (!ctx) return;

	ctx.ui.setStatus("suggester", undefined);
	ctx.ui.setStatus("suggester-events", undefined);
	ctx.ui.setStatus("suggester-usage", undefined);

	const widgetMode = usesWidgetSuggestion(runtime.suggestionDisplayMode);
	const suggestionText = widgetMode && ctx ? effectiveWidgetSuggestionText(runtime, ctx) : undefined;
	const suggestionStatus =
		runtime.showPanelStatus && widgetMode && ctx && !editorHasTypedContent(ctx)
			? runtime.getPanelSuggestionStatus()
			: undefined;
	const suggestionHint =
		widgetMode && suggestionText && !suggestionText.isWorking && !suggestionText.dimmed ? widgetAcceptHintText(runtime.ghostAcceptKeys) : undefined;
	const usageStatus = runtime.showUsageInPanel ? runtime.getPanelUsageStatus() : undefined;
	const logStatus = runtime.getPanelLogStatus();

	// Manage spinner animation lifecycle.
	const shouldAnimate = !!suggestionText?.isWorking && runtime.animateWidgetWorkingIndicator;
	if (shouldAnimate) {
		startSpinnerAnimation();
	} else {
		stopSpinnerAnimation();
	}

	// In widget mode, always keep the widget alive so widgets below don't shift.
	// render() falls back to an empty line when suggestion is hidden (user typed).
	// In ghost mode, remove the widget entirely (ghost editor owns the UI).
	if (!widgetMode && !suggestionStatus && !logStatus && !usageStatus) {
		ctx.ui.setWidget("suggester-panel", undefined);
		return;
	}

	ctx.ui.setWidget(
		"suggester-panel",
		(_tui, theme) => {
			activeTui = _tui;
			return {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				const hintAnsi =
					suggestionHint ? theme.fg("dim", ` · ${suggestionHint}`) : "";
				const hintWidth = hintAnsi ? visibleWidth(hintAnsi) : 0;
				if (suggestionText) {
					const isWorking = suggestionText.isWorking;
					const animate = isWorking && runtime.animateWidgetWorkingIndicator;
					// Flatten to single line: replace newlines with space, collapse whitespace
					const flattened = suggestionText.text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
					const prefix = isWorking ? (animate ? `${SPINNER_FRAMES[spinnerFrameIndex]} ` : "○ ") : "✦ ";
					const lineContent = isWorking
						? (animate
							? `${theme.fg("accent", SPINNER_FRAMES[spinnerFrameIndex])} ${theme.fg("dim", flattened)}`
							: theme.fg("dim", `${prefix}${flattened}`))
						: theme.fg(suggestionText.dimmed ? "dim" : "accent", `${prefix}${flattened}`);
					const wrapWidth = hintWidth > 0 ? Math.max(10, width - hintWidth) : Math.max(10, width);
					// Truncate suggestion to single line, add "..." when content overflows
					const truncatedSuggestion = truncateToWidth(lineContent, wrapWidth, "...", false);
					const truncated = hintAnsi
						? truncateToWidth(truncatedSuggestion + hintAnsi, width, "", true)
						: truncateToWidth(truncatedSuggestion, Math.max(10, width), "", true);
					const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
					lines.push(truncated + pad);
				}
				const parts: string[] = [];
				if (suggestionStatus) parts.push(theme.fg("accent", suggestionStatus));
				if (suggestionHint && !suggestionText) parts.push(theme.fg("dim", suggestionHint));
				if (logStatus) parts.push(formatPanelLog(ctx, logStatus));
				const line = parts.join(" · ");
				if (line) {
					const truncated = truncateToWidth(line, Math.max(10, width), "", true);
					const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
					lines.push(truncated + pad);
				}
				if (usageStatus) {
					const truncated = truncateToWidth(theme.fg("dim", usageStatus), Math.max(10, width), "", true);
					const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
					lines.push(truncated + pad);
				}
			return lines.length > 0 ? lines : [" ".repeat(Math.max(1, width))];
			},
		};
		},
		{ placement: "belowEditor" },
	);
}

export function acceptWidgetSuggestion(runtime: UiContextLike): "accepted" | "missing-suggestion" | "mismatch" | "unavailable" {
	const ctx = getSafeUiContext(runtime);
	if (!ctx || !usesWidgetSuggestion(runtime.suggestionDisplayMode)) return "unavailable";
	const suggestion = runtime.getSuggestion() ?? runtime.getWidgetRestoreSuggestion();
	if (!suggestion) return "missing-suggestion";
	const editorText = ctx.ui.getEditorText();
	if (editorText.length > 0 && !suggestion.startsWith(editorText)) return "mismatch";
	ctx.ui.setEditorText(suggestion);
	runtime.setSuggestion(undefined);
	runtime.setWidgetRestoreSuggestion(suggestion);
	runtime.setPanelSuggestionStatus(undefined);
	refreshSuggesterUi(runtime);
	return "accepted";
}

export class PiSuggestionSink implements SuggestionSink {
	public constructor(private readonly runtime: UiContextLike) {}

	public async showWorking(text: string): Promise<void> {
		this.runtime.setWorkingText(text);
		refreshSuggesterUi(this.runtime);
	}

	public async showSuggestion(text: string, options?: { restore?: boolean; generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = getSafeUiContext(this.runtime);
		if (!ctx) return;

		this.runtime.setWorkingText(undefined);

		const editorText = ctx.ui.getEditorText();
		const trimmedEditorText = editorText.trim();
		const isMultilineSuggestion = text.includes("\n");
		const prefixCompatible = !editorText.includes("\n") && text.startsWith(editorText);
		const canGhostInEditor = usesGhostEditor(this.runtime.suggestionDisplayMode) && (isMultilineSuggestion
			? trimmedEditorText.length === 0
			: this.runtime.prefillOnlyWhenEditorEmpty
				? trimmedEditorText.length === 0
				: trimmedEditorText.length === 0 || prefixCompatible);

		this.runtime.setSuggestion(text);
		this.runtime.setWidgetRestoreSuggestion(undefined);
		this.runtime.setPanelSuggestionStatus(getSuggestionStatusText({
			displayMode: this.runtime.suggestionDisplayMode,
			restored: options?.restore,
			canGhostInEditor,
			ghostAcceptKeys: this.runtime.ghostAcceptKeys,
		}));
		refreshSuggesterUi(this.runtime);
	}

	public async clearSuggestion(options?: { generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		this.runtime.setWorkingText(undefined);
		this.runtime.setSuggestion(undefined);
		this.runtime.setWidgetRestoreSuggestion(undefined);
		this.runtime.setPanelSuggestionStatus(undefined);
		refreshSuggesterUi(this.runtime);
	}

	public async setUsage(usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats }): Promise<void> {
		const ctx = getSafeUiContext(this.runtime);
		if (!ctx) return;
		if (usage.suggester.calls <= 0 && usage.seeder.calls <= 0) {
			this.runtime.setPanelUsageStatus(undefined);
			refreshSuggesterUi(this.runtime);
			return;
		}
		this.runtime.setPanelUsageStatus(formatUsage(usage, this.runtime.getSuggesterModelDisplay()));
		refreshSuggesterUi(this.runtime);
	}
}
