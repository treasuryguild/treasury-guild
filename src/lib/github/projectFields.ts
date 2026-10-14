// Pure Project v2 field-value extraction — no server-only import so it can
// be unit tested.

export interface ProjectFieldValues {
  status: string | null;
  /** Every number field with a value > 0, keyed by field name. */
  numbers: Record<string, number>;
}

export interface RawFieldValueNode {
  /** Single-select value (e.g. the Status column name). */
  name?: string;
  /** Number-field value. */
  number?: number;
  field?: { name?: string };
}

/**
 * The Status option a configured name refers to, matched case-insensitively
 * like the import filter. Null when the project has no such option — the
 * write-back then leaves the item where it is rather than inventing columns.
 */
export function matchStatusOption<T extends { name: string }>(
  options: readonly T[],
  statusName: string,
): T | null {
  const wanted = statusName.trim().toLowerCase();
  if (!wanted) return null;
  return options.find((o) => o.name.toLowerCase() === wanted) ?? null;
}

/** Pick the Status single-select and all positive number fields. */
export function extractProjectFields(
  nodes: RawFieldValueNode[],
): ProjectFieldValues {
  let status: string | null = null;
  const numbers: Record<string, number> = {};
  for (const node of nodes) {
    const fieldName = node.field?.name;
    if (!fieldName) continue;
    if (typeof node.name === "string" && fieldName === "Status") {
      status = node.name;
    } else if (typeof node.number === "number" && node.number > 0) {
      numbers[fieldName] = node.number;
    }
  }
  return { status, numbers };
}
