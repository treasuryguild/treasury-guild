"use client";

// Propose who is added and removed as leads of one workgroup. The server
// freezes the rules: the other leads can object, or admins decide when none
// of them can.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { CreateProposalResponse } from "@/lib/api/types";
import { ProposalKind } from "@/lib/constants";
import type { MemberWithContributor } from "@/lib/db/types";
import { voterName } from "@/lib/governance/labels";
import { leadChangeNeedsAdmins } from "@/lib/governance/payload";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Modal } from "@/components/ui";

export function ChangeLeadsDialog({
  open, onClose, communityId, slug, workgroup, members, currentLeads, sessionWallet, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  communityId: string;
  slug: string;
  workgroup: { id: string; name: string };
  members: MemberWithContributor[];
  currentLeads: readonly string[];
  sessionWallet: string | null;
  onCreated: () => void;
}) {
  const router = useRouter();
  const action = useAsyncAction();
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const names = useMemo(
    () => new Map(members.map((member) => [member.wallet_address, member.contributors?.handle ?? null])),
    [members],
  );
  const leadSet = useMemo(() => new Set(currentLeads), [currentLeads]);
  const candidates = members.filter((member) => !leadSet.has(member.wallet_address));
  const subjects = [...add, ...remove];
  const needsAdmins = leadChangeNeedsAdmins(currentLeads, subjects, sessionWallet ?? "");
  const objectors = currentLeads.filter((wallet) => !add.includes(wallet) && !remove.includes(wallet));

  function toggle(list: string[], wallet: string, on: boolean, set: (next: string[]) => void) {
    set(on ? [...list, wallet] : list.filter((item) => item !== wallet));
  }

  async function submit() {
    const created = await action.run(() => apiFetch<CreateProposalResponse>("/api/proposals", {
      body: {
        kind: ProposalKind.Lead,
        communityId,
        title: `Lead change: ${workgroup.name}`.slice(0, 140),
        body: "",
        workgroupId: workgroup.id,
        add,
        remove,
      },
    }));
    if (!created) return;
    onCreated();
    onClose();
    router.push(routes.proposal(slug, created.id));
  }

  return (
    <Modal open={open} onClose={onClose} busy={action.busy} scroll title={`Change leads of ${workgroup.name}`}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          The other leads have a day to see this and three days to object. One objection rejects it.
          Anyone added or removed does not vote.
        </p>
        <Field label="Add" hint="Members who do not lead this workgroup yet.">
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl bg-zinc-800/60 p-2">
            {candidates.length === 0 && <p className="text-sm text-zinc-500">Every member already leads it.</p>}
            {candidates.map((member) => (
              <label key={member.wallet_address} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={add.includes(member.wallet_address)}
                  onChange={(e) => toggle(add, member.wallet_address, e.target.checked, setAdd)} />
                {voterName(member.wallet_address, names.get(member.wallet_address))}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Remove" hint="Current leads.">
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl bg-zinc-800/60 p-2">
            {currentLeads.length === 0 && <p className="text-sm text-zinc-500">This workgroup has no leads.</p>}
            {currentLeads.map((wallet) => (
              <label key={wallet} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={remove.includes(wallet)}
                  onChange={(e) => toggle(remove, wallet, e.target.checked, setRemove)} />
                {voterName(wallet, names.get(wallet))}
              </label>
            ))}
          </div>
        </Field>
        <p className="text-sm text-zinc-400">
          {needsAdmins
            ? "No other lead can object. An admin files this, and admins decide it."
            : `Can object: ${objectors.map((wallet) => voterName(wallet, names.get(wallet))).join(", ")}.`}
        </p>
        <ErrorText error={action.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={action.busy} onClick={onClose}>Cancel</Button>
          <Button loading={action.busy} disabled={add.length + remove.length === 0} onClick={() => void submit()}>
            Propose change
          </Button>
        </div>
      </div>
    </Modal>
  );
}
