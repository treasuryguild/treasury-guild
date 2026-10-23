"use client";

// Editor for a live GitHub project item that is not (yet) an imported task:
// title, labels, open/closed state, project status, assignees and bounty
// number fields are pushed to GitHub by /api/github/issue. The description is
// not on the live board payload, so it is edited on the imported task or on
// GitHub.

import { useState } from "react";
import { Button, ErrorText, Field, Input, Modal, Select } from "@/components/ui";
import type { GithubIssueEditInput } from "@/lib/api/types";
import type { MergedBoardItem } from "@/lib/boardTypes";
import { useGithubEditorOptions } from "@/hooks/useGithubEditorOptions";

/** GitHub's per-issue assignee cap. */
const MAX_GITHUB_ASSIGNEES = 10;

function loginsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map((l) => l.toLowerCase()).sort();
  const right = [...b].map((l) => l.toLowerCase()).sort();
  return left.every((l, i) => l === right[i]);
}

export function GithubItemModal({
  item,
  workgroupId,
  status,
  statusOptions,
  busy = false,
  saveError,
  onClose,
  onSave,
}: {
  item: MergedBoardItem;
  workgroupId: string;
  /** The Status column the item currently sits in. */
  status: string;
  statusOptions: readonly string[];
  busy?: boolean;
  saveError?: string | null;
  onClose: () => void;
  onSave: (edit: GithubIssueEditInput) => void;
}) {
  const editorOptions = useGithubEditorOptions({
    workgroupId,
    itemNodeId: item.itemNodeId,
  });
  const assignableLogins = editorOptions.data?.assignableLogins ?? [];
  const numberFieldNames = editorOptions.data?.numberFieldNames ?? [];

  const [title, setTitle] = useState(item.title);
  const [labels, setLabels] = useState(item.labels.join(", "));
  const [state, setState] = useState(item.state === "CLOSED" ? "closed" : "open");
  const [nextStatus, setNextStatus] = useState(status);
  const [assignees, setAssignees] = useState<string[]>(() => [...item.assigneeLogins]);
  const [addGithubLogin, setAddGithubLogin] = useState("");
  const [addBountyField, setAddBountyField] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(item.amounts).map(([k, v]) => [k, String(v)])),
  );
  const [error, setError] = useState<string | null>(null);

  const chosenLogins = new Set(assignees.map((l) => l.toLowerCase()));
  const availableGithubLogins = assignableLogins.filter(
    (login) => !chosenLogins.has(login.toLowerCase()),
  );
  const usedBountyFields = new Set(Object.keys(amounts).map((n) => n.toLowerCase()));
  const availableBountyFields = numberFieldNames.filter(
    (name) => !usedBountyFields.has(name.toLowerCase()),
  );

  function addGithubAssignee(login: string) {
    if (!login) return;
    if (assignees.length >= MAX_GITHUB_ASSIGNEES) {
      setError(`GitHub allows at most ${MAX_GITHUB_ASSIGNEES} assignees`);
      return;
    }
    if (chosenLogins.has(login.toLowerCase())) return;
    setAssignees((list) => [...list, login]);
    setAddGithubLogin("");
  }

  function addBountyRow(fieldName: string) {
    if (!fieldName) return;
    if (usedBountyFields.has(fieldName.toLowerCase())) return;
    setAmounts((a) => ({ ...a, [fieldName]: "" }));
    setAddBountyField("");
  }

  function save() {
    setError(null);
    const edit: GithubIssueEditInput = {};
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Give the issue a title");
      return;
    }
    if (trimmedTitle !== item.title) edit.title = trimmedTitle;
    const nextLabels = labels.split(",").map((l) => l.trim()).filter(Boolean);
    if (nextLabels.join("\n") !== item.labels.join("\n")) edit.labels = nextLabels;
    const nextState = state as "open" | "closed";
    if (nextState !== (item.state === "CLOSED" ? "closed" : "open")) edit.state = nextState;
    if (nextStatus && nextStatus !== status) edit.status = nextStatus;
    if (!loginsEqual(assignees, item.assigneeLogins)) edit.assignees = assignees;

    const originalKeys = Object.keys(item.amounts);
    const changedAmounts: Record<string, string> = {};
    let amountsDirty = false;
    for (const [field, raw] of Object.entries(amounts)) {
      const amount = raw.trim();
      if (!amount || Number(amount) <= 0) {
        setError(`Enter a positive amount for ${field}`);
        return;
      }
      if (String(item.amounts[field] ?? "") !== amount) amountsDirty = true;
      changedAmounts[field] = amount;
    }
    for (const field of originalKeys) {
      if (!(field in amounts) && !Object.keys(amounts).some((k) => k.toLowerCase() === field.toLowerCase())) {
        changedAmounts[field] = "";
        amountsDirty = true;
      }
    }
    if (amountsDirty) edit.amounts = changedAmounts;
    if (Object.keys(edit).length === 0) {
      onClose();
      return;
    }
    onSave(edit);
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      scroll
      title={item.number != null ? `#${item.number} ${item.title}` : item.title}
      className="max-w-md"
    >
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          This issue is on the GitHub project board but is not a payable task
          here. Changes are saved to GitHub; giving it the payable label and
          the import column imports it as a task.
        </p>
        <Field label="Title (on GitHub)">
          <Input aria-label="Title (on GitHub)" value={title} maxLength={256} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Labels on GitHub (comma-separated)">
          <Input aria-label="Labels on GitHub (comma-separated)" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="audited" />
        </Field>
        <Field label="Issue state">
          <Select aria-label="Issue state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </Select>
        </Field>
        {statusOptions.length > 0 && (
          <Field label="Project status (on GitHub)">
            <Select aria-label="Project status" value={nextStatus} onChange={(e) => setNextStatus(e.target.value)}>
              {nextStatus && !statusOptions.includes(nextStatus) && (
                <option value={nextStatus}>{nextStatus}</option>
              )}
              {statusOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Assignees (on GitHub)">
          <div className="space-y-2">
            {assignees.map((login) => (
              <div key={login} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 text-sm text-zinc-300">@{login}</span>
                <Button
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => setAssignees((list) => list.filter((l) => l !== login))}
                  aria-label={`Remove @${login}`}
                >
                  ✕
                </Button>
              </div>
            ))}
            {assignees.length === 0 && (
              <p className="text-xs text-amber-500">No assignees</p>
            )}
          </div>
          <Select
            className="mt-2"
            aria-label="Add GitHub assignee"
            value={addGithubLogin}
            disabled={editorOptions.loading || availableGithubLogins.length === 0}
            onChange={(e) => {
              const login = e.target.value;
              setAddGithubLogin(login);
              if (login) addGithubAssignee(login);
            }}
          >
            <option value="">
              {editorOptions.loading
                ? "Loading assignable users…"
                : availableGithubLogins.length === 0
                  ? "No more assignable users"
                  : "+ Add GitHub assignee…"}
            </option>
            {availableGithubLogins.map((login) => (
              <option key={login} value={login}>@{login}</option>
            ))}
          </Select>
          {editorOptions.error && (
            <p className="mt-1 text-xs text-amber-500">{editorOptions.error}</p>
          )}
        </Field>
        <Field label="Bounty (the project's number fields on GitHub)">
          {Object.keys(amounts).length === 0 ? (
            <p className="text-xs text-amber-500">
              {availableBountyFields.length > 0 || editorOptions.loading
                ? "No bounty fields on this issue yet — add one below."
                : "No bounty fields on this issue yet — add a number field on the GitHub project board first."}
            </p>
          ) : (
            <div className="space-y-2">
              {Object.entries(amounts).map(([field, value]) => (
                <div key={field} className="flex min-w-0 items-center gap-2">
                  <span className="w-24 shrink-0 text-sm text-zinc-400">{field}</span>
                  <Input
                    className="min-w-24 flex-1"
                    aria-label={`Amount for ${field}`}
                    value={value}
                    onChange={(e) => setAmounts((a) => ({ ...a, [field]: e.target.value }))}
                    placeholder="0"
                  />
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    onClick={() =>
                      setAmounts((a) => {
                        const next = { ...a };
                        delete next[field];
                        return next;
                      })
                    }
                    aria-label={`Remove ${field}`}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Select
            className="mt-2"
            aria-label="Add bounty field"
            value={addBountyField}
            disabled={editorOptions.loading || availableBountyFields.length === 0}
            onChange={(e) => {
              const name = e.target.value;
              setAddBountyField(name);
              if (name) addBountyRow(name);
            }}
          >
            <option value="">
              {editorOptions.loading
                ? "Loading project fields…"
                : availableBountyFields.length === 0
                  ? "No more number fields on the project"
                  : "+ Add bounty field…"}
            </option>
            {availableBountyFields.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </Select>
        </Field>
        <ErrorText error={error ?? saveError} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save to GitHub</Button>
        </div>
      </div>
    </Modal>
  );
}
