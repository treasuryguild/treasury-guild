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
import type { ChartRow, ChartSeries, DashboardBucket } from "@/lib/dashboardSeries";
import { AXIS_TICK, CHART_GRID, CHART_SELECTION, CHART_SERIES, compactNumber } from "./chartTheme";
import { ChartFrame } from "./ChartFrame";
import { ChartTooltip } from "./ChartTooltip";
import { chartRangeCopy, selectedRange } from "./ContributorsTasksChart";

export function TreasurySpendingChart({ rows, series, ticker, allTime = false, bucket = "month" }: {
  rows: ChartRow[];
  /** One stack per treasury with spending in the window. */
  series: ChartSeries[];
  ticker: string;
  /** The rows cover the whole history: no selected period to shade. */
  allTime?: boolean;
  bucket?: DashboardBucket;
}) {
  const empty = series.length === 0;
  const range = selectedRange(rows);
  const stacked = series.length > 1;
  const copy = chartRangeCopy(allTime, bucket);
  return (
    <ChartFrame
      title={`Treasury spending · ${ticker}`}
      description={`Net ${ticker} paid out each ${copy.each}, by budget period${stacked ? ", stacked by treasury wallet" : ""}. Reconciled refunds are deducted.`}
      height={280}
      empty={empty ? `No ${ticker} paid out ${copy.emptySpan}.` : null}
      table={{
        columns: [copy.column,...series.map((item) => item.name), ...(stacked ? ["Total"] : [])],
        rows: rows.map((row) => [
          row.label,
          ...series.map((item) => row.labels[item.key]!),
          ...(stacked ? [row.labels.total!] : []),
        ]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid vertical={false} stroke={CHART_GRID} />
          {range && <ReferenceArea x1={range[0]} x2={range[1]} fill={CHART_SELECTION} fillOpacity={1} stroke="none" />}
          <XAxis dataKey="label" tickFormatter={copy.tick}tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis width={48} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value: number) => compactNumber.format(value)} />
          <Tooltip cursor={{ fill: CHART_SELECTION }} content={<ChartTooltip showTotal />} />
          {stacked && <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />}
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={`values.${item.key}`}
              name={item.name}
              stackId="treasury"
              fill={CHART_SERIES[index % CHART_SERIES.length]}
              maxBarSize={32}
              radius={stacked ? undefined : [3, 3, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
