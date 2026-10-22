import "server-only";

import { TaskSource } from "@/lib/constants";
import {
  deleteInstallation,
  loadInstallationWorkgroupIds,
  workgroupHasRepos,
} from "@/lib/db/github";
import { setWorkgroupKind, workgroupIsActive } from "@/lib/db/workgroups";

/**
 * Remove an installation locally: the installation row deletes, its repo and
 * project links cascade away, and every workgroup it fed that has no repos
 * left becomes a native board again. Imported tasks and payout history are
 * deliberately kept (frozen: nothing syncs or writes back without the links).
 * Archived workgroups are skipped — their kind cannot change while archived
 * and their boards are frozen anyway.
 */
export async function removeInstallation(installationId: number): Promise<void> {
  const workgroupIds = await loadInstallationWorkgroupIds(installationId);
  await deleteInstallation(installationId);
  for (const workgroupId of workgroupIds) {
    if (!(await workgroupIsActive(workgroupId))) continue;
    if (await workgroupHasRepos(workgroupId)) continue;
    await setWorkgroupKind(workgroupId, TaskSource.Native);
  }
}
