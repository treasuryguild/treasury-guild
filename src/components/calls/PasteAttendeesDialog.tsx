"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { AddAttendeesBody } from "@/lib/api/schemas";
import type { AddAttendeesResponse } from "@/lib/api/types";
import { parsePastedNames } from "@/lib/calls/nameMatch";
import { MAX_PASTED_ATTENDEES } from "@/lib/constants";
import { plural } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Modal, Textarea } from "@/components/ui";

/**
 * Paste a participant list (one name per line), e.g. copied from the Zoom or
 * Meet participants panel. Names that match exactly one member, or a name
 * remembered from an earlier call, arrive linked; the rest wait for a wallet.
 */
export function PasteAttendeesDialog({
  callId,
  onClose,
  onAdded,
}: {
  callId: string;
  onClose: () => void;
  onAdded: (result: AddAttendeesResponse) => void;
}) {
  const [text, setText] = useState("");
  const names = useMemo(() => parsePastedNames(text), [text]);
  const action = useAsyncAction();

  async function add() {
    const body: AddAttendeesBody = { kind: "names", names };
    const result = await action.run(() =>
      apiFetch<AddAttendeesResponse>(`/api/calls/${callId}/attendees`, { body }),
    );
    if (result) onAdded(result);
  }

  const tooMany = names.length > MAX_PASTED_ATTENDEES;
  return (
    <Modal open onClose={onClose} busy={action.busy} title="Paste attendees" className="w-full">
      <Field
        label="One name per line"
        hint={tooMany
          ? `At most ${MAX_PASTED_ATTENDEES} names at a time`
          : `${plural(names.length, "name")} · repeats and people already on the list are skipped`}
      >
        <Textarea rows={10} value={text} placeholder={"Alice\nBob Smith\n@carol"} spellCheck={false}
          onChange={(e) => setText(e.target.value)} />
      </Field>
      <ErrorText error={action.error} className="mt-3" />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={action.busy}>Cancel</Button>
        <Button disabled={names.length === 0 || tooMany} loading={action.busy} onClick={() => void add()}>
          {action.busy ? "Adding…" : "Add to the list"}
        </Button>
      </div>
    </Modal>
  );
}
