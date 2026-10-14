// Pure sync decision logic — kept free of server-only imports for unit tests.

export type SyncAction =
  | "insert"
  | "update"
  | "update_mirror_only"
  | "delete"
  | "skip";

/** Import gate: in the review column AND carrying the payable label (both ci). */
export function matchesImportFilter(
  repo: { payable_label: string; import_status: string },
  labels: string[],
  projectStatus: string | null | undefined,
): boolean {
  return (
    !!projectStatus &&
    projectStatus.toLowerCase() === repo.import_status.toLowerCase() &&
    labels.some((l) => l.toLowerCase() === repo.payable_label.toLowerCase())
  );
}

export interface AssigneeDiff {
  /** Logins to add, in incoming order (first casing wins). */
  added: string[];
  /** Existing logins no longer assigned on GitHub. */
  removed: string[];
  /** Existing logins still assigned (existing casing kept). */
  kept: string[];
}

/**
 * Reconcile a task's stored GitHub assignee logins with the issue's current
 * list, case-insensitively. Only `added` logins trigger contributor lookup and
 * community auto-join, so repeated sweeps don't re-upsert membership every
 * hour; `removed` rows are deleted (unassignment never removes membership).
 */
export function diffAssigneeLogins(
  existing: readonly string[],
  incoming: readonly string[],
): AssigneeDiff {
  const key = (s: string) => s.toLowerCase();
  const existingKeys = new Set(existing.map(key));
  const incomingKeys = new Set<string>();
  const added: string[] = [];
  for (const login of incoming) {
    if (!login) continue;
    const k = key(login);
    if (incomingKeys.has(k)) continue;
    incomingKeys.add(k);
    if (!existingKeys.has(k)) added.push(login);
  }
  return {
    added,
    removed: existing.filter((l) => !incomingKeys.has(key(l))),
    kept: existing.filter((l) => incomingKeys.has(key(l))),
  };
}

/**
 * Pure decision matrix. settled = pay_state in queued/paid/reconciled: those
 * tasks are historical payment records — mirror GitHub text and status
 * (whether or not the issue still matches the import filter: paid issues
 * normally sit in the Paid column) but never touch amounts/audited/pay_state,
 * and never delete them.
 */
export function decideSyncAction(opts: {
  exists: boolean;
  settled: boolean;
  matchesFilter: boolean;
}): SyncAction {
  if (!opts.exists) return opts.matchesFilter ? "insert" : "skip";
  if (opts.settled) return "update_mirror_only";
  return opts.matchesFilter ? "update" : "delete";
}
