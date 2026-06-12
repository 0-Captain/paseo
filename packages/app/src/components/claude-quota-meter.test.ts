import { describe, expect, test } from "vitest";
import {
  formatResetLabel,
  formatUpdatedAgo,
  resolveRingColor,
  CLAUDE_ORANGE,
  CLAUDE_ORANGE_INNER_DARK,
  CLAUDE_ORANGE_INNER_LIGHT,
} from "./claude-quota-meter";

const DESTRUCTIVE = "#c64f43";

describe("resolveRingColor", () => {
  test("outer ring is Claude orange under 90%", () => {
    expect(
      resolveRingColor({
        utilization: 89.9,
        ring: "outer",
        colorScheme: "dark",
        destructive: DESTRUCTIVE,
      }),
    ).toBe(CLAUDE_ORANGE);
  });
  test("inner ring uses dark variant on dark scheme", () => {
    expect(
      resolveRingColor({
        utilization: 10,
        ring: "inner",
        colorScheme: "dark",
        destructive: DESTRUCTIVE,
      }),
    ).toBe(CLAUDE_ORANGE_INNER_DARK);
  });
  test("inner ring uses light variant on light scheme", () => {
    expect(
      resolveRingColor({
        utilization: 10,
        ring: "inner",
        colorScheme: "light",
        destructive: DESTRUCTIVE,
      }),
    ).toBe(CLAUDE_ORANGE_INNER_LIGHT);
  });
  test("either ring turns destructive at >=90%", () => {
    expect(
      resolveRingColor({
        utilization: 90,
        ring: "outer",
        colorScheme: "dark",
        destructive: DESTRUCTIVE,
      }),
    ).toBe(DESTRUCTIVE);
    expect(
      resolveRingColor({
        utilization: 95,
        ring: "inner",
        colorScheme: "light",
        destructive: DESTRUCTIVE,
      }),
    ).toBe(DESTRUCTIVE);
  });
});

describe("formatResetLabel", () => {
  const now = new Date("2026-06-12T03:00:00Z");
  test("same-day reset renders time only", () => {
    const sameDay = new Date(now);
    sameDay.setHours(now.getHours() + 1);
    const label = formatResetLabel(sameDay.toISOString(), now);
    expect(label).toMatch(/\d/);
    expect(label).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });
  test("future-day reset includes weekday", () => {
    const label = formatResetLabel("2026-06-17T00:00:00Z", now);
    expect(label).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });
  test("invalid or missing date returns null", () => {
    expect(formatResetLabel("not-a-date", now)).toBeNull();
    expect(formatResetLabel(undefined, now)).toBeNull();
  });
});

describe("formatUpdatedAgo", () => {
  const nowMs = Date.parse("2026-06-12T03:00:00Z");
  test("under a minute", () => {
    expect(formatUpdatedAgo(nowMs - 20_000, nowMs)).toBe("Updated just now");
  });
  test("minutes", () => {
    expect(formatUpdatedAgo(nowMs - 2 * 60_000, nowMs)).toBe("Updated 2m ago");
  });
  test("hours", () => {
    expect(formatUpdatedAgo(nowMs - 3 * 3_600_000, nowMs)).toBe("Updated 3h ago");
  });
  test("null fetchedAt returns null", () => {
    expect(formatUpdatedAgo(null, nowMs)).toBeNull();
  });
});
