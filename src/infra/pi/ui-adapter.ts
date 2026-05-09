import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { SuggestionSink } from "../../app/orchestrators/turn-end.js";
import type { GhostAcceptKey } from "../../config/types.js";
import type { SuggestionUsageStats } from "../../domain/state.js";
import { formatTokens } from "./display.js";
import { formatGhostAcceptKeys } from "./ghost-accept-keys.js";
import { getSuggestionStatusText, usesGhostEditor, usesWidgetSuggestion } from "./suggestion-display-mode.js";
import type { UiContextLike } from "./ui-context.js";

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

/** Widget panel text: active suggestion, or restore buffer when editor cleared after accept. Hidden while user has typed anything (trimmed). */
function effectiveWidgetSuggestionText(runtime: UiContextLike, ctx: ExtensionContext): string | undefined {
	if (editorHasTypedContent(ctx)) return undefined;
	const primary = runtime.getSuggestion();
	if (primary) return primary;
	return runtime.getWidgetRestoreSuggestion();
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
		widgetMode && suggestionText ? widgetAcceptHintText(runtime.ghostAcceptKeys) : undefined;
	const usageStatus = runtime.showUsageInPanel ? runtime.getPanelUsageStatus() : undefined;
	const logStatus = runtime.getPanelLogStatus();
	if (!suggestionText && !suggestionStatus && !logStatus && !usageStatus) {
		ctx.ui.setWidget("suggester-panel", undefined);
		return;
	}

	ctx.ui.setWidget(
		"suggester-panel",
		(_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				const hintAnsi =
					suggestionHint ? theme.fg("muted", ` · ${suggestionHint}`) : "";
				const hintWidth = hintAnsi ? visibleWidth(hintAnsi) : 0;
				if (suggestionText) {
					const sourceLines = suggestionText.split("\n");
					let inlinedHintOnFirstVisualLine = false;
					for (let index = 0; index < sourceLines.length; index += 1) {
						const prefix = index === 0 ? "✦ " : "  ";
						const wrapWidth =
							index === 0 && hintWidth > 0 && !inlinedHintOnFirstVisualLine
								? Math.max(10, width - hintWidth)
								: Math.max(10, width);
						const wrapped = wrapTextWithAnsi(
							theme.fg("accent", `${prefix}${sourceLines[index] ?? ""}`),
							wrapWidth,
						);
						const segments = wrapped.length > 0 ? wrapped : [theme.fg("accent", prefix.trimEnd())];
						let segIdx = 0;
						for (const wrappedLine of segments) {
							let truncated: string;
							if (index === 0 && segIdx === 0 && hintAnsi && !inlinedHintOnFirstVisualLine) {
								truncated = truncateToWidth(wrappedLine + hintAnsi, width, "", true);
								inlinedHintOnFirstVisualLine = true;
							}
							else {
								truncated = truncateToWidth(wrappedLine, Math.max(10, width), "", true);
							}
							const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
							lines.push(truncated + pad);
							segIdx += 1;
						}
					}
				}
				const parts: string[] = [];
				if (suggestionStatus) parts.push(theme.fg("accent", suggestionStatus));
				if (suggestionHint && !suggestionText) parts.push(theme.fg("muted", suggestionHint));
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
		}),
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

	public async showSuggestion(text: string, options?: { restore?: boolean; generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = getSafeUiContext(this.runtime);
		if (!ctx) return;

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
