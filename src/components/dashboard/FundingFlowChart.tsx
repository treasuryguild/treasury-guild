"use client";

import { useState } from "react";
import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip, type TooltipContentProps } from "recharts";
import { fitFlowLabel, flowColumns, flowMinWidth, type FlowGraph, type FlowLink, type FlowNode } from "@/lib/fundingFlow";
import { CHART_SERIES } from "./chartTheme";
import { ChartFrame } from "./ChartFrame";

const NODE_WIDTH = 12;
const LABEL_GAP = 6;
const MARGIN_LEFT = 8;
/** Height kept for the sideways scrollbar of a long chain. */
const SCROLLBAR_BAND = 14;
/** Height kept under the plot per note, so the card never scrolls. */
const NOTE_LINE = 36;

/** Sources, treasuries and workgroups in the palette's fixed order; transfers fourth. Direct payments sit with workgroups: both are spending. */
const NODE_COLOR: Record<FlowNode["kind"], string> = {
  source: CHART_SERIES[0],
  treasury: CHART_SERIES[1],
  workgroup: CHART_SERIES[2],
  direct: CHART_SERIES[2],
};
const LINK_COLOR: Record<FlowLink["kind"], string> = {
  income: CHART_SERIES[0],
  transfer: CHART_SERIES[3],
  payout: CHART_SERIES[2],
};

// Recharts spreads our node and link objects into its layout payloads, so the
// graph's own fields ride along; the render props only type the layout part.
type NodePayload = FlowNode & { depth: number };
type LinkPayload = FlowLink & { source: NodePayload; target: NodePayload };

interface NodeProps {
  x: number; y: number; width: number; height: number;
  payload: object;
  /** Label room in px by column; the last column's is the right margin. */
  rooms: readonly number[];
}

/**
 * Labels sit to the right of their node, cut to the room up to the next
 * column's label (`fitFlowLabel`), so two columns never write over each other.
 */
function FlowNodeShape({ x, y, width, height, payload: raw, rooms }: NodeProps) {
  const payload = raw as NodePayload;
  const label = fitFlowLabel(payload.name, rooms[Math.min(payload.depth, rooms.length - 1)] ?? 0);
  return (
    <Layer>
      <Rectangle x={x} y={y} width={width} height={height} fill={NODE_COLOR[payload.kind]} fillOpacity={0.9} radius={2} />
      {label && (
        <text
          x={x + width + LABEL_GAP}
          y={y + height / 2}
          textAnchor="start"
          dominantBaseline="middle"
          fontSize={12}
          fill="var(--foreground)"
        >
          {label !== payload.name && <title>{payload.name}</title>}
          {label}
        </text>
      )}
    </Layer>
  );
}

/**
 * The right margin holding the last column's labels, and each column's label
 * room, for a plot `width` px wide. Columns are spread evenly (`align="justify"`).
 * No room at all until the width is known, so nothing is drawn unbounded.
 */
function labelLayout(width: number, columns: number): { right: number; rooms: number[] } {
  const right = Math.round(Math.min(140, Math.max(96, width * 0.3)));
  if (width <= 0) return { right, rooms: [] };
  const step = columns > 1 ? (width - MARGIN_LEFT - right - NODE_WIDTH) / (columns - 1) : 0;
  const between = step - NODE_WIDTH - 2 * LABEL_GAP;
  return { right, rooms: Array.from({ length: columns }, (_, depth) => depth === columns - 1 ? right - LABEL_GAP - 2 : between) };
}

interface LinkProps {
  sourceX: number; targetX: number; sourceY: number; targetY: number;
  sourceControlX: number; targetControlX: number; linkWidth: number;
  payload: object;
}

function FlowLinkShape({ sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, payload: raw }: LinkProps) {
  const payload = raw as LinkPayload;
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={LINK_COLOR[payload.kind]}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={0.35}
    />
  );
}

/** Exact amounts from the payload; the float is geometry only. */
function FlowTooltip({ active, payload }: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null;
  const item = payload[0]!.payload as NodePayload | LinkPayload;
  const isLink = "source" in item && typeof item.source === "object";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-xs shadow-lg">
      {isLink ? (
        <>
          <p className="font-medium">{(item as LinkPayload).source.name} → {(item as LinkPayload).target.name}</p>
          <p className="mt-1 font-mono tabular-nums">{(item as LinkPayload).label}</p>
        </>
      ) : (
        <>
          <p className="font-medium">{(item as NodePayload).name}</p>
          <ul className="mt-1 space-y-0.5">
            {(item as NodePayload).kind !== "source" && (
              <li className="flex gap-3"><span className="text-zinc-400">In</span><span className="ml-auto font-mono tabular-nums">{(item as NodePayload).inflow}</span></li>
            )}
            {(item as NodePayload).kind !== "workgroup" && (
              <li className="flex gap-3"><span className="text-zinc-400">Out</span><span className="ml-auto font-mono tabular-nums">{(item as NodePayload).outflow}</span></li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Income sources → treasuries → (other treasuries) → workgroups for one
 * token in the selected period. Nodes and links come from `fundingFlowGraph`;
 * the data table lists every raw flow and `notes` say what the diagram nets.
 */
export function FundingFlowChart({ graph, ticker, periodLabel }: {
  graph: FlowGraph;
  ticker: string;
  periodLabel: string;
}) {
  const empty = graph.links.length === 0;
  const [width, setWidth] = useState(0);
  const columns = flowColumns(graph);
  // A long chain keeps a readable width and scrolls sideways on a narrow screen.
  const minWidth = flowMinWidth(columns);
  const { right, rooms } = labelLayout(width, columns);
  const plotHeight = Math.max(220, 40 * Math.max(graph.nodes.length, 1));
  return (
    <ChartFrame
      title={`Funding flow · ${ticker}`}
      description={`Where ${ticker} came from, which wallets held it and which workgroups it paid in ${periodLabel}. Income by the day it arrived, payouts by budget period, refunds deducted; transfers between the community's wallets are neither income nor spending.`}
      height={plotHeight + (minWidth ? SCROLLBAR_BAND : 0) + NOTE_LINE * graph.notes.length}
      empty={empty ? `No ${ticker} arrived or was paid out in ${periodLabel}.` : null}
      table={{ columns: ["From", "To", "Amount"], rows: graph.table }}
    >
      <div className="overflow-x-auto overflow-y-hidden">
        <div style={{ height: plotHeight, minWidth: minWidth ?? undefined }}>
          <ResponsiveContainer width="100%" height="100%" onResize={(next) => setWidth(next)}>
            <Sankey
              data={{ nodes: graph.nodes, links: graph.links }}
              nodeWidth={NODE_WIDTH}
              nodePadding={18}
              margin={{ top: 8, right, bottom: 8, left: MARGIN_LEFT }}
              align="justify"
              node={(props) => <FlowNodeShape {...props} rooms={rooms} />}
              link={(props) => <FlowLinkShape {...props} />}
            >
              <Tooltip content={<FlowTooltip />} />
            </Sankey>
          </ResponsiveContainer>
        </div>
      </div>
      {graph.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-zinc-500">
          {graph.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </ChartFrame>
  );
}
