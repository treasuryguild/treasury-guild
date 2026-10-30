"use client";

// An admin sends a failed lead change to a wider vote, with the same people
// added and removed.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { CreateProposalResponse } from "@/lib/api/types";
import { ProposalKind } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { isLeadPayload } from "@/lib/governance/payload";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Modal, Select } from "@/components/ui";

export function EscalateLeadChange({ proposal, communityId, slug }: {
  proposal: ProposalRow;
  communityId: string;
  slug: string;
}) {
  const router = useRouter();
  const action = useAsyncAction();
  const [open, setOpen] = useState(false);
  const [electorate, setElectorate] = useState<"workgroup" | "members">("workgroup");
  if (!isLeadPayload(proposal.payload)) return null;
  const { workgroupId, add, remove } = proposal.payload.leadChange;

  async function submit() {
    const created = await action.run(() => apiFetch<CreateProposalResponse>("/api/proposals", {
      body: {
        kind: ProposalKind.Lead,
        communityId,
        title: `Escalate #${proposal.number}: ${proposal.title}`.slice(0, 140),
        body: proposal.body,
        workgroupId,
        add,
        remove,
        escalation: electorate,
        escalatesProposalId: proposal.id,
      },
    }));
    if (!created) return;
    setOpen(false);
    router.push(routes.proposal(slug, created.id));
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="secondary" onClick={() => setOpen(true)}>Escalate</Button>
      <Modal open={open} onClose={() => setOpen(false)} busy={action.busy} title={`Escalate #${proposal.number}`}>
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            The same people are added and removed. This vote is a majority, with two days to discuss and five days to vote.
          </p>
          <Field label="Who votes">
            <Select aria-label="Who votes on the escalation" value={electorate}
              onChange={(e) => setElectorate(e.target.value as "workgroup" | "members")}>
              <option value="workgroup">People of this workgroup</option>
              <option value="members">All members</option>
            </Select>
          </Field>
          <ErrorText error={action.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={action.busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={action.busy} onClick={() => void submit()}>Propose escalation</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
