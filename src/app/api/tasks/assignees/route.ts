import { parseJson, sessionRoute } from "@/lib/api/route";
import { setTaskAssigneesSchema } from "@/lib/api/schemas";
import type { TaskAssigneesResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/authz";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { requireCommunity } from "@/lib/db/communities";
import { assertWorkgroupActive } from "@/lib/db/workgroups";
import { SETTLED_PAY_STATES } from "@/lib/constants";
import { ensureContributor } from "@/lib/db/membership";
import { replaceTaskAssignees } from "@/lib/db/taskAssignees";
import { loadTaskForManager } from "@/lib/db/tasks";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors";


// Replaces a task's assignee set. Admins and the workgroup's leads only.
// GitHub logins are managed on GitHub: the submitted github rows must be
// exactly the task's existing ones (wallet edits only — never added or
// removed here, on any task), while manual rows may be added or removed
// freely. Settled tasks are locked because the assignee set is the paid-to
// record behind their payouts; replace_task_assignees re-checks that under the
// task's row lock and writes the whole set in one step.

export const POST = sessionRoute(async (req, { session }) => {
  const { wallet } = session;
  const { taskId, assignees } = await parseJson(req, setTaskAssigneesSchema);

  const task = await loadTaskForManager(taskId);
  if (!task) throw new NotFoundError("Task not found");

  await requireWorkgroupManager(
    task.workgroups.community_id, task.workgroup_id, wallet,
    "Only admins and workgroup leads can edit assignees",
  );
  assertWorkgroupActive(task.workgroups.archived_at);
  if (task.archived_at) {
    throw new ConflictError("Restore this task before editing assignees");
  }
  if (SETTLED_PAY_STATES.includes(task.pay_state)) {
    throw new ConflictError("Assignees are locked once a payout has been queued or paid");
  }

  const githubIds = new Set(
    task.task_assignees.filter((a) => a.source === "github").map((a) => a.id),
  );
  const submitted = assignees.filter((a) => a.source === "github").map((a) => a.id);
  const submittedIds = new Set(submitted);
  if (
    submitted.length !== submittedIds.size ||
    submittedIds.size !== githubIds.size ||
    [...githubIds].some((id) => !submittedIds.has(id))
  ) {
    throw new BadRequestError("GitHub assignees are managed on GitHub");
  }

  // A payout to the other network is refused at build time; catch it here.
  const { network } = await requireCommunity(task.workgroups.community_id);
  const offNetwork = assignees.find((a) => a.wallet && addressToNetwork(a.wallet) !== network);
  if (offNetwork) {
    throw new BadRequestError(
      network === 1
        ? "This community pays on mainnet: use a mainnet address"
        : "This community pays on preprod: use a preprod (addr_test…) address",
    );
  }

  for (const a of assignees) {
    if (a.wallet) await ensureContributor(a.wallet);
  }
  const saved = await replaceTaskAssignees(taskId, assignees);
  return { assignees: saved } satisfies TaskAssigneesResponse;
});
