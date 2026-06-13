import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ClaudeQuota } from "@getpaseo/protocol/messages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatResetLabel,
  formatUpdatedAgo,
  resolveRingColor,
  type UpdatedAgo,
} from "./claude-quota-meter-core";

export {
  CLAUDE_ORANGE,
  CLAUDE_ORANGE_INNER_DARK,
  CLAUDE_ORANGE_INNER_LIGHT,
  resolveRingColor,
  formatResetLabel,
  formatUpdatedAgo,
} from "./claude-quota-meter-core";

const SVG_SIZE = 18;
const CENTER = SVG_SIZE / 2;
const OUTER_RADIUS = 7.5;
const INNER_RADIUS = 4;
const STROKE_WIDTH = 2;
const OUTER_CIRCUMFERENCE = 2 * Math.PI * OUTER_RADIUS;
const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_RADIUS;

function clampFraction(utilization: number): number {
  return Math.max(0, Math.min(100, utilization)) / 100;
}

interface ClaudeQuotaMeterProps {
  quota: ClaudeQuota;
  fetchedAt: number | null;
}

function resolveUpdatedText(
  updated: UpdatedAgo | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!updated) {
    return null;
  }
  if (updated.kind === "justNow") {
    return t("claudeQuota.updatedJustNow");
  }
  if (updated.kind === "minutes") {
    return t("claudeQuota.updatedMinutes", { minutes: updated.value });
  }
  return t("claudeQuota.updatedHours", { hours: updated.value });
}

export function ClaudeQuotaMeter({ quota, fetchedAt }: ClaudeQuotaMeterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const fiveHour = quota.fiveHour ?? null;
  const sevenDay = quota.sevenDay ?? null;
  if (!fiveHour && !sevenDay) {
    return null;
  }
  const now = new Date();
  const colorScheme = theme.colorScheme;
  const track = theme.colors.surface3;
  const outerColor = fiveHour
    ? resolveRingColor({
        utilization: fiveHour.utilization,
        ring: "outer",
        colorScheme,
        destructive: theme.colors.destructive,
      })
    : track;
  const innerColor = sevenDay
    ? resolveRingColor({
        utilization: sevenDay.utilization,
        ring: "inner",
        colorScheme,
        destructive: theme.colors.destructive,
      })
    : track;
  const outerOffset = fiveHour
    ? OUTER_CIRCUMFERENCE * (1 - clampFraction(fiveHour.utilization))
    : OUTER_CIRCUMFERENCE;
  const innerOffset = sevenDay
    ? INNER_CIRCUMFERENCE * (1 - clampFraction(sevenDay.utilization))
    : INNER_CIRCUMFERENCE;
  const updatedText = resolveUpdatedText(formatUpdatedAgo(fetchedAt, now.getTime()), t);

  const rows: Array<{
    id: string;
    label: string;
    bucket: { utilization: number; resetsAt?: string };
  }> = [];
  if (fiveHour) {
    rows.push({ id: "fiveHour", label: t("claudeQuota.labels.fiveHour"), bucket: fiveHour });
  }
  if (sevenDay) {
    rows.push({ id: "weekAll", label: t("claudeQuota.labels.weekAll"), bucket: sevenDay });
  }
  if (quota.sevenDaySonnet) {
    rows.push({
      id: "weekSonnet",
      label: t("claudeQuota.labels.weekSonnet"),
      bucket: quota.sevenDaySonnet,
    });
  }
  if (quota.sevenDayOpus) {
    rows.push({
      id: "weekOpus",
      label: t("claudeQuota.labels.weekOpus"),
      bucket: quota.sevenDayOpus,
    });
  }

  const accessibilitySummary = rows
    .map((row) =>
      t("claudeQuota.accessibilityRow", {
        label: row.label,
        percentage: Math.round(row.bucket.utilization),
      }),
    )
    .join(", ");

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={styles.container}
          accessibilityRole="image"
          accessibilityLabel={t("claudeQuota.accessibility", { summary: accessibilitySummary })}
        >
          <Svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={OUTER_RADIUS}
              fill="none"
              stroke={track}
              strokeWidth={STROKE_WIDTH}
            />
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={OUTER_RADIUS}
              fill="none"
              stroke={outerColor}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={OUTER_CIRCUMFERENCE}
              strokeDashoffset={outerOffset}
            />
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={INNER_RADIUS}
              fill="none"
              stroke={track}
              strokeWidth={STROKE_WIDTH}
            />
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={INNER_RADIUS}
              fill="none"
              stroke={innerColor}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={INNER_CIRCUMFERENCE}
              strokeDashoffset={innerOffset}
            />
          </Svg>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipContent}>
          <Text style={styles.tooltipTitle}>{t("claudeQuota.title")}</Text>
          {rows.map((row) => {
            const reset = formatResetLabel(row.bucket.resetsAt, now);
            const percentage = Math.round(row.bucket.utilization);
            const text = reset
              ? t("claudeQuota.rowWithReset", { label: row.label, percentage, reset })
              : t("claudeQuota.rowWithoutReset", { label: row.label, percentage });
            return (
              <Text key={row.id} style={styles.tooltipText}>
                {text}
              </Text>
            );
          })}
          {updatedText ? <Text style={styles.tooltipDetail}>{updatedText}</Text> : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  tooltipContent: {
    gap: theme.spacing[1],
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
