"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { PatchAttendeeBody } from "@/lib/api/schemas";
import { contributorLabel } from "@/lib/assignees";
import type { MemberOption } from "@/lib/boardTypes";
import type { CallAttendee } from "@/lib/db/types";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Input, Modal, Select } from "@/components/ui";

const OTHER = "__address__";

/**
 * Link a name on the list to the wallet that gets the reward: a community
 * member, or any address. "Remember" stores name -> wallet for the community,
 * so the next pasted list links this person by itself.
 */
export function LinkWalletDialog({
  callId,
  attendee,
  members,
  onClose,
  onSaved,
}: {
  callId: string;
  attendee: CallAttendee;
  members: MemberOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isMember = members.some((m) => m.wallet === attendee.wallet_address);
  const [choice, setChoice] = useState(
    attendee.wallet_address ? (isMember ? attendee.wallet_address : OTHER) : "",
  );
  const [address, setAddress] = useState(attendee.wallet_address && !isMember ? attendee.wallet_address : "");
  const [remember, setRemember] = useState(true);
  const action = useAsyncAction();

  const wallet = choice === OTHER ? address.trim() : choice;

  async function save(next: string | null) {
    const body: PatchAttendeeBody = { attendeeId: attendee.id, wallet: next, remember: !!next && remember };
    const ok = await action.run(() => apiFetch(`/api/calls/${callId}/attendees`, { method: "PATCH", body }));
    if (ok) onSaved();
  }

  return (
    <Modal open onClose={onClose} busy={action.busy} title={`Wallet for ${attendee.display_name}`} className="w-full">
      <div className="space-y-4">
        <Field label="Who is this?">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a member…</option>
            {members.map((m) => (
              <option key={m.wallet} value={m.wallet}>{contributorLabel(m)}</option>
            ))}
            <option value={OTHER}>Another address…</option>
          </Select>
        </Field>
        {choice === OTHER && (
          <Field label="Address">
            <Input className="font-mono text-xs" value={address} placeholder="addr…" spellCheck={false}
              onChange={(e) => setAddress(e.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this name for the community&apos;s next calls
        </label>
      </div>
      <ErrorText error={action.error} className="mt-3" />
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {attendee.wallet_address && (
          <Button variant="ghost" className="mr-auto" disabled={action.busy} onClick={() => void save(null)}>
            Unlink
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={action.busy}>Cancel</Button>
        <Button disabled={!wallet} loading={action.busy} onClick={() => void save(wallet)}>
          {action.busy ? "Saving…" : "Link wallet"}
        </Button>
      </div>
    </Modal>
  );
}
