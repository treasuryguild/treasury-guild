// Recharts styling from the app's CSS variables (globals.css). SVG resolves
// `var()` in presentation attributes, so both colour schemes work untouched.

/** Categorical series in a fixed, colour-vision-safe order; never cycled. */
export const CHART_SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
] as const;

export const CHART_GRID = "var(--chart-grid)";
export const CHART_SELECTION = "var(--accent-soft)";

export const AXIS_TICK = { fill: "var(--muted)", fontSize: 12 } as const;
export const DATA_LABEL = { fill: "var(--muted)", fontSize: 11 } as const;

/** Compact axis ticks ("1.2K"); exact values live in tooltips and labels. */
export const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
