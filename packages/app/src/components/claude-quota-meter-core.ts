// Claude brand colors — deliberately NOT theme tokens (see design spec).
export const CLAUDE_ORANGE = "#D97757";
export const CLAUDE_ORANGE_INNER_DARK = "#E5A088";
export const CLAUDE_ORANGE_INNER_LIGHT = "#C97D5E";

const DESTRUCTIVE_THRESHOLD = 90;

export function resolveRingColor(params: {
  utilization: number;
  ring: "outer" | "inner";
  colorScheme: "dark" | "light";
  destructive: string;
}): string {
  if (params.utilization >= DESTRUCTIVE_THRESHOLD) {
    return params.destructive;
  }
  if (params.ring === "outer") {
    return CLAUDE_ORANGE;
  }
  return params.colorScheme === "dark" ? CLAUDE_ORANGE_INNER_DARK : CLAUDE_ORANGE_INNER_LIGHT;
}

export function formatResetLabel(resetsAt: string | undefined, now: Date): string | null {
  if (!resetsAt) {
    return null;
  }
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) {
    return null;
  }
  if (reset.toDateString() === now.toDateString()) {
    return reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const weekday = reset.toLocaleDateString("en-US", { weekday: "short" });
  const time = reset.toLocaleTimeString(undefined, { hour: "numeric" });
  return `${weekday} ${time}`;
}

// Structured "time since last fetch" so the component renders it through i18n
// (the actual wording lives in the translation resources, not here).
export type UpdatedAgo =
  | { kind: "justNow" }
  | { kind: "minutes"; value: number }
  | { kind: "hours"; value: number };

export function formatUpdatedAgo(fetchedAt: number | null, nowMs: number): UpdatedAgo | null {
  if (fetchedAt === null || !Number.isFinite(fetchedAt)) {
    return null;
  }
  const elapsedMs = Math.max(0, nowMs - fetchedAt);
  if (elapsedMs < 60_000) {
    return { kind: "justNow" };
  }
  if (elapsedMs < 3_600_000) {
    return { kind: "minutes", value: Math.floor(elapsedMs / 60_000) };
  }
  return { kind: "hours", value: Math.floor(elapsedMs / 3_600_000) };
}
