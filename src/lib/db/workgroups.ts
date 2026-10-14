import "server-only";

import { DEFAULT_BOARD_COLUMNS } from "@/lib/boardTypes";
import { TaskSource } from "@/lib/constants";
import type { WorkgroupLifecycleStatus } from "@/lib/api/types";
import { check, maybe, must, rows, rpc, serviceClient } from "./client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { ContributorProfile, WorkgroupRow } from "./types";

/**
 * A native workgroup with the default board, as the community page creates
 * one from the browser. Used where the server creates it on an admin's
 * behalf (the chain import's "create this workgroup").
 */
export async function createWorkgroupWithBoard(communityId: string, name: string): Promise<string> {
  const db = serviceClient();
  const group = must<{ id: string }>(
    await db
      .from("workgroups")
      .insert({ community_id: communityId, name, kind: TaskSource.Native })
      .select("id")
      .single(),
    "create workgroup",
  );
  check(
    await db.from("board_columns").insert(DEFAULT_BOARD_COLUMNS.map((c) => ({ workgroup_id: group.id, ...c }))),
    "create board columns",
  );
  return group.id;
}

export async function workgroupIsActive(workgroupId: string): Promise<boolean> {
  const group = maybe<{ archived_at: string | null }>(
    await serviceClient().from("workgroups").select("archived_at").eq("id", workgroupId).maybeSingle(),
    "load workgroup archive status",
  );
  return !!group && group.archived_at === null;
}

const ARCHIVED_MESSAGE = "Restore this workgroup before making changes";

/** For a workgroup row already in hand: archived workgroups are frozen. */
export function assertWorkgroupActive(archivedAt: string | null | undefined): void {
  if (archivedAt) throw new ConflictError(ARCHIVED_MESSAGE);
}

export async function requireActiveWorkgroup(workgroupId: string): Promise<void> {
  if (!(await workgroupIsActive(workgroupId))) throw new ConflictError(ARCHIVED_MESSAGE);
}

/** The workgroup's community, or null when the workgroup is gone. */
export async function workgroupCommunityId(
  workgroupId: string,
): Promise<string | null> {
  const row = maybe<{ community_id: string }>(
    await serviceClient()
      .from("workgroups")
      .select("community_id")
      .eq("id", workgroupId)
      .maybeSingle(),
    "load workgroup",
  );
  return row?.community_id ?? null;
}

/** The workgroup's community; 404 when the workgroup is gone. */
export async function requireWorkgroupCommunity(workgroupId: string): Promise<string> {
  const communityId = await workgroupCommunityId(workgroupId);
  if (!communityId) throw new NotFoundError("Workgroup not found");
  return communityId;
}

export async function communityWorkgroupIds(
  communityId: string,
): Promise<string[]> {
  return rows<{ id: string }>(
    await serviceClient()
      .from("workgroups")
      .select("id")
      .eq("community_id", communityId),
    "load community workgroups",
  ).map((w) => w.id);
}

export type CommunityWorkgroup = Pick<WorkgroupRow, "id" | "name" | "kind" | "archived_at" | "treasury_id">;

/** The community's workgroups (archived ones included), by name. */
export async function listCommunityWorkgroups(communityId: string): Promise<CommunityWorkgroup[]> {
  return rows<CommunityWorkgroup>(
    await serviceClient()
      .from("workgroups")
      .select("id, name, kind, archived_at, treasury_id")
      .eq("community_id", communityId)
      .order("name"),
    "list community workgroups",
  );
}

export type WorkgroupWithLeads = Pick<WorkgroupRow, "id" | "name" | "description" | "kind" | "archived_at" | "treasury_id"> & {
  workgroup_leads: { wallet_address: string; contributors: ContributorProfile | ContributorProfile[] | null }[];
};

/** The community's workgroups (archived ones included) with their leads' profiles, by name. */
export async function listWorkgroupsWithLeads(communityId: string): Promise<WorkgroupWithLeads[]> {
  return rows<WorkgroupWithLeads>(
    await serviceClient()
      .from("workgroups")
      .select("id, name, description, kind, archived_at, treasury_id, workgroup_leads(wallet_address, contributors(handle, github_username))")
      .eq("community_id", communityId)
      .order("name"),
    "list workgroups with leads",
  );
}

/** What archiving or deleting the workgroup would meet (workgroup_lifecycle_status); null when it is gone. */
export async function loadWorkgroupLifecycleStatus(workgroupId: string): Promise<WorkgroupLifecycleStatus | null> {
  return rpc<WorkgroupLifecycleStatus | null>(
    await serviceClient().rpc("workgroup_lifecycle_status", { p_workgroup_id: workgroupId }),
  );
}

/** Archive, restore or delete a workgroup; the rules live in change_workgroup_lifecycle. */
export async function changeWorkgroupLifecycle(input: {
  workgroupId: string;
  action: string;
  actor: string;
  confirmation: string | null;
}): Promise<void> {
  rpc(
    await serviceClient().rpc("change_workgroup_lifecycle", {
      p_workgroup_id: input.workgroupId, p_action: input.action, p_actor: input.actor,
      p_confirmation: input.confirmation,
    }),
  );
}

export async function addWorkgroupLead(workgroupId: string, wallet: string): Promise<void> {
  check(
    await serviceClient()
      .from("workgroup_leads")
      .upsert(
        { workgroup_id: workgroupId, wallet_address: wallet },
        { onConflict: "workgroup_id,wallet_address", ignoreDuplicates: true },
      ),
    "add workgroup lead",
  );
}

export async function removeWorkgroupLead(workgroupId: string, wallet: string): Promise<void> {
  check(
    await serviceClient()
      .from("workgroup_leads")
      .delete()
      .eq("workgroup_id", workgroupId)
      .eq("wallet_address", wallet),
    "remove workgroup lead",
  );
}

/** workgroups.kind drives board rendering (github = status columns, no kanban). */
export async function setWorkgroupKind(workgroupId: string, kind: TaskSource): Promise<void> {
  check(
    await serviceClient().from("workgroups").update({ kind }).eq("id", workgroupId),
    "set workgroup kind",
  );
}
