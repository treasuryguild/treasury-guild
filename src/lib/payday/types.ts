// Payday page types. Client-safe.

import type { BoardTask } from "@/lib/boardTypes";
import { BOARD_TASK_COLUMNS } from "@/lib/db/types";

/**
 * A payable task as listed on Payday: the full board task shape (so the
 * board's task editor can open it in place) plus its workgroup for routing.
 * Every assignee is paid the full amounts; all must have a wallet.
 */
export interface PayableTask extends BoardTask {
  workgroup_id: string;
  workgroup: { name: string; treasury_id: string | null };
}

export const PAYABLE_TASK_COLUMNS = `${BOARD_TASK_COLUMNS}, workgroup_id, workgroup:workgroups!inner(name, community_id, treasury_id, archived_at)`;
