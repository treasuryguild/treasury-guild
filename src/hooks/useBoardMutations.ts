"use client";

// Board writes (RLS-gated to admins and the workgroup's leads). Every write
// re-fetches the board; failures surface through `error`.
import {
  canDropTask,
  DEFAULT_BOARD_COLUMNS,
  type BoardTask,
} from "@/lib/boardTypes";
import { PayState, SETTLED_PAY_STATES, TaskSource } from "@/lib/constants";
import type { BoardColumnRow } from "@/lib/db/types";
import { browserClient } from "@/lib/supabase/browser";
import type { TaskSaveFields } from "@/components/board/TaskModal";
import { useAsyncAction } from "./useAsyncAction";
import { saveTaskFields, throwOn } from "./useTaskSave";

export function useBoardMutations({
  workgroupId,
  columns,
  tasks,
  reload,
}: {
  workgroupId: string;
  columns: BoardColumnRow[];
  tasks: BoardTask[];
  reload: () => void;
}) {
  const action = useAsyncAction("Board update failed");

  async function addTask(columnId: string, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const ok = await action.run(async () => {
      throwOn(
        await browserClient().from("tasks").insert({
          workgroup_id: workgroupId,
          title: trimmed,
          column_id: columnId,
        }),
        "add task",
      );
      reload();
      return true;
    });
    return !!ok;
  }

  async function moveTask(taskId: string, columnId: string): Promise<void> {
    const column = columns.find((c) => c.id === columnId);
    const task = tasks.find((t) => t.id === taskId);
    // Paid tasks stay put and only the confirm poller fills the Paid column.
    if (!column || !task || !canDropTask(task, column)) return;
    const settled = SETTLED_PAY_STATES.includes(task.pay_state);
    const update: Record<string, unknown> = { column_id: columnId };
    // native tasks: the payable column drives audited/payable state
    if (task.source === TaskSource.Native && !settled) {
      update.audited = column.marks_payable;
      update.pay_state = column.marks_payable ? PayState.Payable : PayState.None;
    }
    await action.run(async () => {
      throwOn(
        await browserClient().from("tasks").update(update).eq("id", taskId).select("id").single(),
        "move task",
      );
      reload();
    });
  }

  async function saveTask(task: BoardTask, fields: TaskSaveFields): Promise<boolean> {
    const ok = await action.run(async () => {
      await saveTaskFields(task.id, fields);
      reload();
      return true;
    });
    return !!ok;
  }

  /** Retitle a task the chain import created (its title is not on-chain). */
  async function renameTask(task: BoardTask, title: string): Promise<boolean> {
    const ok = await action.run(async () => {
      throwOn(
        await browserClient().from("tasks").update({ title }).eq("id", task.id).select("id").single(),
        "rename task",
      );
      reload();
      return true;
    });
    return !!ok;
  }

  async function seedAppBoard(): Promise<void> {
    await action.run(async () => {
      throwOn(
        await browserClient()
          .from("board_columns")
          .insert(DEFAULT_BOARD_COLUMNS.map((c) => ({ workgroup_id: workgroupId, ...c }))),
        "create columns",
      );
      reload();
    });
  }

  return { addTask, moveTask, saveTask, renameTask, seedAppBoard, busy: action.busy, error: action.error };
}
