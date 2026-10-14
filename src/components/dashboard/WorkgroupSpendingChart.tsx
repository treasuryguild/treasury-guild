"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartRow } from "@/lib/dashboardSeries";
import { truncate } from "@/lib/format";
import { AXIS_TICK, CHART_GRID, CHART_SELECTION, CHART_SERIES, DATA_LABEL } from "./chartTheme";
import { ChartFrame } from "./ChartFrame";
import { ChartTooltip } from "./ChartTooltip";

const MAX_NAME = 26;

function nameTick(label: string): string {
  return truncate(label, MAX_NAME);
}

export function WorkgroupSpendingChart({ rows, ticker, periodLabel }: {
  rows: ChartRow[];
  ticker: string;
  periodLabel: string;
}) {
  const height = Math.max(120, 24 + rows.length * 36);
  return (
    <ChartFrame
      title={`Spending by workgroup · ${ticker}`}
      description={`${periodLabel}, by budget period, net of refunds. The same figures as the table's Spent column.`}
      height={height}
      empty={rows.length === 0 ? `No ${ticker} spending or budgets in ${periodLabel}.` : null}
      table={{
        columns: ["Workgroup", "Spent", "Budget"],
        rows: rows.map((row) => [row.label, row.labels.spent!, row.labels.budget!]),
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 84, left: 0, bottom: 4 }} barCategoryGap="30%">
          <CartesianGrid horizontal={false} stroke={CHART_GRID} />
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={170} tickFormatter={nameTick} tick={AXIS_TICK} tickLine={false} axisLine={false} interval={0} />
          <Tooltip cursor={{ fill: CHART_SELECTION }} content={<ChartTooltip />} />
          <Bar dataKey="values.spent" name="Spent" fill={CHART_SERIES[0]} maxBarSize={22} radius={[0, 3, 3, 0]}>
            <LabelList dataKey="labels.spent" position="right" style={DATA_LABEL} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
