import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TurnContext } from "../../domain/suggestion.js";

export interface EditorHistoryState {
	entries: string[];
	index: number;
}

export class RuntimeRef {
	private currentContext: ExtensionContext | undefined;
	private generationEpoch = 0;
	private abortController = new AbortController();
	private currentSuggestion: string | undefined;
	/** After widget accept clears `currentSuggestion`, holds text to show again when editor emptied. */
	private widgetRestoreSuggestion: string | undefined;
	private suggestionRevision = 0;
	private lastTurnContext: TurnContext | undefined;
	private lastBootstrappedLeafId: string | undefined;
	private panelSuggestionStatus: string | undefined;
	private panelUsageStatus: string | undefined;
	private panelLogStatus: { level: "debug" | "info" | "warn" | "error"; text: string } | undefined;
	private workingText: string | undefined;
	private idleHint: string | undefined;
	private editorHistoryState: EditorHistoryState = { entries: [], index: -1 };

	public setContext(ctx: ExtensionContext): void {
		this.currentContext = ctx;
	}

	public getContext(): ExtensionContext | undefined {
		return this.currentContext;
	}

	public bumpEpoch(): number {
		this.generationEpoch += 1;
		this.abortController.abort();
		this.abortController = new AbortController();
		return this.generationEpoch;
	}

	public getEpoch(): number {
		return this.generationEpoch;
	}

	public getSignal(): AbortSignal {
		return this.abortController.signal;
	}

	public setSuggestion(text: string | undefined): void {
		this.currentSuggestion = text?.trim() || undefined;
		this.suggestionRevision += 1;
	}

	public setWidgetRestoreSuggestion(text: string | undefined): void {
		this.widgetRestoreSuggestion = text?.trim() || undefined;
	}

	public getWidgetRestoreSuggestion(): string | undefined {
		return this.widgetRestoreSuggestion;
	}

	public getSuggestion(): string | undefined {
		return this.currentSuggestion;
	}

	public getSuggestionRevision(): number {
		return this.suggestionRevision;
	}

	public setLastTurnContext(turn: TurnContext | undefined): void {
		this.lastTurnContext = turn;
	}

	public getLastTurnContext(): TurnContext | undefined {
		return this.lastTurnContext;
	}

	public getLastBootstrappedLeafId(): string | undefined {
		return this.lastBootstrappedLeafId;
	}

	public markBootstrappedLeafId(leafId: string): void {
		this.lastBootstrappedLeafId = leafId;
	}

	public setPanelSuggestionStatus(text: string | undefined): void {
		this.panelSuggestionStatus = text?.trim() || undefined;
	}

	public getPanelSuggestionStatus(): string | undefined {
		return this.panelSuggestionStatus;
	}

	public setPanelUsageStatus(text: string | undefined): void {
		this.panelUsageStatus = text?.trim() || undefined;
	}

	public getPanelUsageStatus(): string | undefined {
		return this.panelUsageStatus;
	}

	public setPanelLogStatus(status: { level: "debug" | "info" | "warn" | "error"; text: string } | undefined): void {
		this.panelLogStatus = status;
	}

	public getPanelLogStatus(): { level: "debug" | "info" | "warn" | "error"; text: string } | undefined {
		return this.panelLogStatus;
	}

	public setWorkingText(text: string | undefined): void {
		this.workingText = text?.trim() || undefined;
	}

	public getWorkingText(): string | undefined {
		return this.workingText;
	}

	public setIdleHint(hint: string | undefined): void {
		this.idleHint = hint;
	}

	public getIdleHint(): string | undefined {
		return this.idleHint;
	}

	public setEditorHistoryState(state: EditorHistoryState): void {
		const entries = state.entries.map((entry) => entry.trim()).filter(Boolean);
		const maxIndex = entries.length - 1;
		const index = entries.length === 0 ? -1 : Math.max(-1, Math.min(state.index, maxIndex));
		this.editorHistoryState = { entries, index };
	}

	public getEditorHistoryState(): EditorHistoryState {
		return {
			entries: [...this.editorHistoryState.entries],
			index: this.editorHistoryState.index,
		};
	}
}
