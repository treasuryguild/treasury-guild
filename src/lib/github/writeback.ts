// Post-payment write-back: comment with the tx hash, add a "paid" label and
// move the project item to the repo's Paid status. The comment is the audit
// trail and the only step allowed to fail loudly; the cron retries while
// payout status != written_back, and a retry must never post a second
// comment because a label or column move failed (permissions, missing
// option). Those two are best-effort and logged.
import "server-only";

import { installationOctokit } from "./app";
import { setProjectItemStatus } from "./projectsV2";
import { splitRepoFullName } from "./repoName";
import { explorerTxUrl, type Network } from "@/lib/config";
import { formatQuantity } from "@/lib/assets";
import { shortHash } from "@/lib/format";

export interface WriteBackResult {
  /** The Status option the item now sits in, when a move was requested and
   * the project has that option (GitHub's spelling); null otherwise. */
  movedToStatus: string | null;
}

export async function writeBackPayment(opts: {
  installationId: number;
  repoFullName: string;
  issueNumber: number;
  /** What each recipient was paid for this task, all units. */
  amounts: { ticker: string; decimals: number; quantity: bigint }[];
  /** Every assignee paid, each receiving `amounts` in full. */
  recipientLabels: string[];
  txHash: string;
  network: Network;
  /** The issue's project item and the Status to move it to; omitted when
   * the repo has no paid status or the task never recorded its item. */
  projectItem?: { itemNodeId: string; status: string } | null;
}): Promise<WriteBackResult> {
  const {
    installationId,
    repoFullName,
    issueNumber,
    amounts,
    recipientLabels,
    txHash,
    network,
    projectItem,
  } = opts;
  const octokit = await installationOctokit(installationId);
  const { owner, repo } = splitRepoFullName(repoFullName);

  const paid = amounts
    .map((a) => `${formatQuantity(a.quantity, a.decimals)} ${a.ticker}`)
    .join(" + ");
  const each = recipientLabels.length > 1 ? " each" : "";
  const recipients = recipientLabels.map((l) => `\`${l}\``).join(", ");
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: `💸 Paid **${paid}**${each} to ${recipients} in tx [\`${shortHash(txHash, 16)}\`](${explorerTxUrl(network, txHash)}) via Treasury Guild.`,
  });

  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: ["paid"],
    });
  } catch {
    // label creation can fail on permissions; the comment is the audit trail
  }

  let movedToStatus: string | null = null;
  if (projectItem) {
    try {
      const result = await setProjectItemStatus(
        installationId,
        projectItem.itemNodeId,
        projectItem.status,
      );
      if (result.outcome === "updated" || result.outcome === "unchanged") {
        movedToStatus = result.status;
      } else {
        console.warn(
          `write-back ${repoFullName}#${issueNumber}: not moved to "${projectItem.status}" (${result.outcome})`,
        );
      }
    } catch (err) {
      // Typically FORBIDDEN until the App's Projects permission is read & write.
      console.warn(`write-back ${repoFullName}#${issueNumber}: status move failed`, err);
    }
  }
  return { movedToStatus };
}
