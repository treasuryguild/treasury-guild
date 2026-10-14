"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartRow, DashboardBucket } from "@/lib/dashboardSeries";
import { AXIS_TICK, CHART_GRID, CHART_SELECTION, CHART_SERIES } from "./chartTheme";
import { ChartFrame } from "./ChartFrame";
import { ChartTooltip } from "./ChartTooltip";

/** "Sep 2026" → "Sep"; the tooltip and data table keep the year. */
export function monthTick(label: string): string {
  return label.slice(0, 3);
}

/** First and last label of the selected months, for the highlight band. */
export function selectedRange(rows: readonly ChartRow[]): [string, string] | null {
  const selected = rows.filter((row) => row.selected);
  return selected.length > 0 ? [selected[0]!.label, selected[selected.length - 1]!.label] : null;
}

/** The time charts' wording: the trailing year around a period, or the whole history. */
export function chartRangeCopy(allTime: boolean, bucket: DashboardBucket) {
  return {
    each: bucket === "quarter" ? "quarter" : "month",
    column: bucket === "quarter" ? "Quarter" : "Month",
    span: allTime ? "since the first payment" : "over the last 12 months",
    emptySpan: allTime ? "yet" : "in the last 12 months",
    // A multi-year axis needs the year; a quarter label is short already.
    tick: allTime ? (label: string) => label : monthTick,
  };
}

export function ContributorsTasksChart({ rows, allTime = false, bucket = "month" }: {
  rows: ChartRow[];
  /** The rows cover the whole history: no selected period to shade. */
  allTime?: boolean;
  bucket?: DashboardBucket;
}) {
  const empty = rows.every((row) => row.values.contributors === 0 && row.values.tasks === 0);
  const range = selectedRange(rows);
  const copy = chartRangeCopy(allTime, bucket);
  return (
    <ChartFrame
      title="Contributors and tasks paid"
      description={`Distinct wallets and tasks paid each ${copy.each}, by budget period, ${copy.span}.${allTime ? "" : " The selected period is shaded."}`}
      height={280}
      empty={empty ? `No payouts ${copy.emptySpan}.` : null}
      table={{
        columns: [copy.column, "Contributors", "Tasks"],
        rows: rows.map((row) => [row.label, row.labels.contributors!, row.labels.tasks!]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="25%">
          <CartesianGrid vertical={false} stroke={CHART_GRID} />
          {range && <ReferenceArea x1={range[0]} x2={range[1]} fill={CHART_SELECTION} fillOpacity={1} stroke="none" />}
          <XAxis dataKey="label" tickFormatter={copy.tick}tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis allowDecimals={false} width={32} tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: CHART_SELECTION }} content={<ChartTooltip />} />
          <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="values.contributors" name="Contributors" fill={CHART_SERIES[0]} maxBarSize={28} radius={[3, 3, 0, 0]} />
          <Bar dataKey="values.tasks" name="Tasks" fill={CHART_SERIES[1]} maxBarSize={28} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
