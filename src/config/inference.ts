import type { ThinkingLevel } from "./types.js";

export function toInvocationThinkingLevel(value: string): Exclude<ThinkingLevel, "off"> | undefined {
	if (value === "session-default" || value === "off") return undefined;
	return value as Exclude<ThinkingLevel, "off">;
}
