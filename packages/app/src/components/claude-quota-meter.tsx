import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ClaudeQuota } from "@getpaseo/protocol/messages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatResetLabel, formatUpdatedAgo, resolveRingColor } from "./claude-quota-meter.ts";

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

export function ClaudeQuotaMeter({ quota, fetchedAt }: ClaudeQuotaMeterProps) {
  const { theme } = useUnistyles();
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
  const updatedLabel = formatUpdatedAgo(fetchedAt, now.getTime());

  const rows: Array<{ label: string; bucket: { utilization: number; resetsAt?: string } }> = [];
  if (fiveHour) {
    rows.push({ label: "5h session", bucket: fiveHour });
  }
  if (sevenDay) {
    rows.push({ label: "Week (all models)", bucket: sevenDay });
  }
  if (quota.sevenDaySonnet) {
    rows.push({ label: "Week (Sonnet)", bucket: quota.sevenDaySonnet });
  }
  if (quota.sevenDayOpus) {
    rows.push({ label: "Week (Opus)", bucket: quota.sevenDayOpus });
  }

  const accessibilitySummary = rows
    .map((row) => `${row.label} ${Math.round(row.bucket.utilization)}% used`)
    .join(", ");

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={styles.container}
          accessibilityRole="image"
          accessibilityLabel={`Claude usage: ${accessibilitySummary}`}
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
          <Text style={styles.tooltipTitle}>Claude usage</Text>
          {rows.map((row) => {
            const reset = formatResetLabel(row.bucket.resetsAt, now);
            const detail = `${Math.round(row.bucket.utilization)}%${reset ? ` · resets ${reset}` : ""}`;
            return (
              <Text key={row.label} style={styles.tooltipText}>
                {`${row.label} — ${detail}`}
              </Text>
            );
          })}
          {updatedLabel ? <Text style={styles.tooltipDetail}>{updatedLabel}</Text> : null}
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
