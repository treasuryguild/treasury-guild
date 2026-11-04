// Settle workgroup names a history CSV uses, without writing them. A create
// becomes a stand-in workgroup the planner can total against; the confirm is
// what inserts it. Pure.
import { normalizeWorkgroupName } from "./parse";
import { resolveLegacyWorkgroup } from "./plan";
import type { LegacyWorkgroup } from "./types";

export interface WorkgroupDecision {
  /** The CSV name, or its normalized form. Compared after normalization. */
  ref: string;
  action: "create" | "map";
  workgroupId?: string;
  /** The workgroup's name when creating one. Defaults to the CSV's own text. */
  displayName?: string;
}

export interface WorkgroupQuestion {
  ref: string;
  message: string;
}

export interface AppliedDecisions {
  workgroups: LegacyWorkgroup[];
  aliases: Map<string, string>;
  /** Decisions the confirm must carry out. Ones the community already matches are dropped. */
  applied: WorkgroupDecision[];
  questions: WorkgroupQuestion[];
}

const PENDING = "pending:";

/** The stand-in id a create gets until the confirm inserts the workgroup. */
export function pendingWorkgroupId(ref: string): string {
  return `${PENDING}${ref}`;
}

export function isPendingWorkgroupId(id: string): boolean {
  return id.startsWith(PENDING);
}

/**
 * Fold the caller's choices into the workgroups the planner sees. A create
 * while workgroup proposals are on, a create whose name is already taken, or
 * a map to a workgroup that is not in the community becomes a question and
 * is not applied.
 */
export function applyWorkgroupDecisions(
  workgroups: readonly LegacyWorkgroup[],
  aliases: ReadonlyMap<string, string>,
  decisions: readonly WorkgroupDecision[],
  governanceOn: boolean,
): AppliedDecisions {
  const nextGroups = [...workgroups];
  const nextAliases = new Map(aliases);
  const applied: WorkgroupDecision[] = [];
  const questions: WorkgroupQuestion[] = [];

  for (const decision of decisions) {
    const ref = normalizeWorkgroupName(decision.ref);
    if (ref === "") {
      questions.push({ ref: decision.ref, message: "Name the workgroup." });
      continue;
    }
    const display = (decision.displayName ?? decision.ref).trim();
    const current = resolveLegacyWorkgroup(ref, display, nextAliases, nextGroups);

    if (decision.action === "map") {
      const target = nextGroups.find((w) => w.id === decision.workgroupId);
      if (!target) {
        questions.push({ ref, message: `No workgroup in this community has id ${decision.workgroupId ?? ""}. Map "${display}" to one that exists, archived ones included.` });
        continue;
      }
      if (current.status === "resolved" && current.workgroup.id === target.id) continue;
      nextAliases.set(ref, target.id);
      applied.push({ ref, action: "map", workgroupId: target.id, displayName: display });
      continue;
    }

    if (current.status === "resolved") continue;
    if (governanceOn) {
      questions.push({
        ref,
        message: `Workgroup proposals are on, so "${display}" cannot be created here. Map the name to an existing workgroup instead.`,
      });
      continue;
    }
    const taken = nextGroups.find((w) => !w.archived && w.name.trim().toLowerCase() === display.toLowerCase());
    if (taken) {
      questions.push({
        ref,
        message: `A workgroup named "${taken.name}" already exists. Map "${display}" to it (or to another workgroup) instead of creating one.`,
      });
      continue;
    }
    const id = pendingWorkgroupId(ref);
    nextGroups.push({ id, name: display, archived: false });
    nextAliases.set(ref, id);
    applied.push({ ref, action: "create", displayName: display });
  }

  return { workgroups: nextGroups, aliases: nextAliases, applied, questions };
}
