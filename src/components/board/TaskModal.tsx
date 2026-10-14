"use client";

// Task editor. Native tasks get the full editor: description, assignees, and
// a multi-token bounty (rows write tasks.amounts; the ADA row is mirrored into
// bounty_lovelace with the same rules the GitHub sync uses).
// GitHub tasks are mirror data the hourly sync overwrites, so title,
// description and amounts are read-only here. Their GitHub assignees are
// managed on GitHub (the sync adds and removes them); this editor sets each
// one's payout wallet and can add extra manual assignees the sync never
// touches. Every assignee receives the task's full amounts.

import { useState } from "react";
import {
  Button,
  ErrorText,
  ExplorerLink,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "@/components/ui";
import type { TaskAssigneeInput } from "@/lib/api/schemas";
import { contributorLabel, sortedAssignees } from "@/lib/assignees";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { BUDGET_MONTH_RE, BudgetCadence, currentBudgetMonth, quarterStartMonth } from "@/lib/budgets";
import { cadenceAt, type BudgetSetup } from "@/lib/budgetSetups";
import type { Network } from "@/lib/config";
import { TaskSource } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import {
  amountRowsFromTask,
  amountsFromRows,
  type AmountRow,
  type BoardTask,
  type MemberOption,
} from "@/lib/boardTypes";
import { shortAddress } from "@/lib/format";
import { QuarterSelect } from "@/components/budgets/QuarterSelect";

export type { MemberOption };

export interface TaskSaveFields {
  /** The complete assignee set (sent to /api/tasks/assignees). */
  assignees: TaskAssigneeInput[];
  /** "YYYY-MM-DD" (first of month) or null. */
  budget_month?: string | null;
  body?: string | null;
  amounts?: Record<string, string> | null;
  bounty_lovelace?: number | null;
}


const CUSTOM = "__custom";

interface EditorRow extends AmountRow {
  /** Ticker typed by hand rather than picked from the wallet dropdown. */
  custom: boolean;
}

/**
 * One assignee being edited: a member wallet, "" (none yet), or CUSTOM with
 * the raw address in `custom` (outside wallets, or members since removed).
 */
interface AssigneeEditorRow {
  key: number;
  source: "github" | "manual";
  /** task_assignees id for github rows (the route matches on it). */
  id: string | null;
  ghLogin: string | null;
  selection: string;
  custom: string;
}

export function TaskModal({
  task,
  members,
  tokenTickers,
  network,
  budgetSetups = [],
  onClose,
  onSave,
  onRename,
  onArchive,
  busy = false,
  saveError,
}: {
  task: BoardTask;
  members: MemberOption[];
  /** Tickers of tokens held by the paying treasury wallet(s), sans ADA. */
  tokenTickers: string[];
  /** For the explorer link once the task has been paid. */
  network: Network;
  /**
   * The workgroup's budget setups, so a quarterly-budgeted workgroup can
   * remind the editor which month a quarter-long task should use.
   */
  budgetSetups?: readonly Pick<BudgetSetup, "starts_on" | "cadence">[];
  onClose: () => void;
  onSave: (fields: TaskSaveFields) => void;
  /**
   * Retitle a task the chain import created. The title is not on-chain, so
   * it arrives as "Imported task #N"; a paid task is otherwise locked, which
   * is why this is its own action and not part of Save.
   */
  onRename?: (title: string) => void;
  onArchive?: () => void;
  busy?: boolean;
  saveError?: string | null;
}) {
  const isGithub = task.source === TaskSource.Github;
  const tickerOptions = [
    "ADA",
    ...tokenTickers.filter((t) => t.toLowerCase() !== "ada"),
  ];
  const [assigneeRows, setAssigneeRows] = useState<AssigneeEditorRow[]>(() => {
    const initial = sortedAssignees(task.task_assignees).map((a, key) => {
      const wallet = a.wallet_address;
      const isMember = !wallet || members.some((m) => m.wallet === wallet);
      return {
        key,
        source: a.source,
        id: a.id,
        ghLogin: a.gh_login,
        selection: isMember ? (wallet ?? "") : CUSTOM,
        custom: isMember ? "" : (wallet ?? ""),
      };
    });
    // A native task with nobody assigned opens with one empty row to fill.
    return initial.length === 0 && !isGithub ? [emptyManualRow(0)] : initial;
  });
  const [nextKey, setNextKey] = useState(assigneeRows.length);
  const [body, setBody] = useState(task.body ?? "");
  // Budget attribution is editable on every task (the GitHub sync never
  // touches it). Unset tasks default to the current month; the payout build
  // uses the same default, so what the user sees is what goes on chain.
  const [budgetMonth, setBudgetMonth] = useState(
    task.budget_month?.slice(0, 7) ?? currentBudgetMonth(),
  );
  const [rows, setRows] = useState<EditorRow[]>(() => {
    // A task without a bounty opens with no rows: a pre-filled ticker with a
    // blank amount would fail validation on an assignee-only save, and ADA is
    // not every community's payout token. "+ Add token" starts a row.
    const initial = amountRowsFromTask(task);
    // A stored ticker the wallet doesn't hold (yet) opens in custom mode.
    return initial.map((row) => ({
      ...row,
      custom: !tickerOptions.some(
        (t) => t.toLowerCase() === row.ticker.toLowerCase(),
      ),
    }));
  });
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState<string | null>(null);
  // Budgets are attributed by month; a quarter is its first month. When the
  // workgroup is budgeted by quarter the editor asks for the quarter, so the
  // user never has to know that convention.
  const quarterly = cadenceAt(budgetSetups, budgetMonth) === BudgetCadence.Quarterly;
  const quarterStart = quarterStartMonth(budgetMonth);

  function emptyManualRow(key: number): AssigneeEditorRow {
    return { key, source: "manual", id: null, ghLogin: null, selection: "", custom: "" };
  }

  function setAssignee(key: number, patch: Partial<AssigneeEditorRow>) {
    setAssigneeRows((list) =>
      list.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function addAssignee() {
    setAssigneeRows((list) => [...list, emptyManualRow(nextKey)]);
    setNextKey((k) => k + 1);
  }

  function setRow(i: number, patch: Partial<EditorRow>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function save() {
    setError(null);
    const assignees: TaskAssigneeInput[] = [];
    const seen = new Set<string>();
    for (const r of assigneeRows) {
      const wallet = (r.selection === CUSTOM ? r.custom.trim() : r.selection) || null;
      if (wallet) {
        if (seen.has(wallet)) {
          setError("Each wallet can be assigned once");
          return;
        }
        seen.add(wallet);
      }
      if (r.source === "github") {
        assignees.push({ source: "github", id: r.id as string, wallet });
      } else if (wallet) {
        assignees.push({ source: "manual", wallet });
      }
    }
    const month = quarterly ? quarterStart : budgetMonth.trim();
    if (month && !BUDGET_MONTH_RE.test(month)) {
      setError("Budget month must be a year and month");
      return;
    }
    const fields: TaskSaveFields = {
      assignees,
      budget_month: month ? `${month}-01` : null,
    };
    if (!isGithub) {
      let amounts: Record<string, string> | null;
      try {
        amounts = amountsFromRows(rows);
      } catch (err) {
        setError(errorMessage(err, "Invalid amounts"));
        return;
      }
      const lovelace = adaLovelaceFromAmounts(amounts);
      fields.body = body.trim() || null;
      fields.amounts = amounts;
      fields.bounty_lovelace = lovelace ? Number(lovelace) : null;
    }
    onSave(fields);
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      scroll
      title={`#${task.number} ${task.title}`}
      className="max-w-md"
    >
        <div className="space-y-4">
          {task.paid_tx_hash && (
            <p className="text-xs text-zinc-400">
              Paid in tx{" "}
              <ExplorerLink network={network} target={{ txHash: task.paid_tx_hash }}
                className="font-mono text-indigo-400 hover:underline">
                {shortAddress(task.paid_tx_hash)}
              </ExplorerLink>
            </p>
          )}
          {task.chain_number !== null && (
            <p className="text-xs text-zinc-500">
              Imported from the on-chain payout record
              {task.chain_number !== task.number && <>, where it is task #{task.chain_number}</>}. Titles
              and descriptions are not stored on-chain, so give it its real title here.
            </p>
          )}
          {task.chain_number !== null && onRename && (
            <Field label="Title">
              <div className="flex gap-2">
                <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
                <Button
                  variant="secondary"
                  disabled={busy || !title.trim() || title.trim() === task.title}
                  onClick={() => onRename(title.trim())}
                >
                  Save title
                </Button>
              </div>
            </Field>
          )}
          {isGithub ? (
            <p className="text-xs text-zinc-500">
              Synced from GitHub — title, description and amounts are managed
              on GitHub and overwritten by the hourly sync. GitHub assignees
              are managed on GitHub too; their payout wallets and any extra
              manual assignees are edited here.
            </p>
          ) : (
            <Field label="Description">
              <Textarea
                rows={3}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What needs to be done?"
              />
            </Field>
          )}

          <Field label="Assignees (each receives the full payout)">
            <div className="space-y-2">
              {assigneeRows.map((row) => {
                const github = row.source === "github";
                return (
                  <div
                    key={row.key}
                    className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap"
                  >
                    {github && (
                      <span className="shrink-0 text-xs text-zinc-400">@{row.ghLogin}</span>
                    )}
                    <Select
                      className="min-w-0 flex-1"
                      aria-label={github ? `Wallet for @${row.ghLogin}` : "Assignee"}
                      value={row.selection}
                      onChange={(e) => setAssignee(row.key, { selection: e.target.value })}
                    >
                      <option value="">{github ? "Not linked" : "Choose a member…"}</option>
                      {members.map((m) => (
                        <option key={m.wallet} value={m.wallet}>
                          {contributorLabel(m)}
                        </option>
                      ))}
                      <option value={CUSTOM}>Custom address…</option>
                    </Select>
                    {row.selection === CUSTOM && (
                      <Input
                        className="min-w-0 flex-1 font-mono text-xs"
                        aria-label="Custom address"
                        value={row.custom}
                        onChange={(e) => setAssignee(row.key, { custom: e.target.value })}
                        placeholder="addr…"
                      />
                    )}
                    {!github && (
                      <Button
                        variant="ghost"
                        className="shrink-0"
                        onClick={() =>
                          setAssigneeRows((list) => list.filter((r) => r.key !== row.key))
                        }
                        aria-label="Remove assignee"
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                );
              })}
              {assigneeRows.length === 0 && (
                <p className="text-xs text-amber-500">No assignees</p>
              )}
            </div>
            <Button variant="ghost" className="mt-2" onClick={addAssignee}>
              + Add assignee
            </Button>
          </Field>

          {quarterly ? (
            <Field label="Budget quarter (which budget this task's payout counts against; recorded on-chain)">
              <div className="flex gap-2">
                <QuarterSelect
                  month={quarterStart.slice(5)}
                  onChange={(month) => setBudgetMonth(`${quarterStart.slice(0, 4)}-${month}`)}
                />
                <Input
                  type="number"
                  aria-label="Budget year"
                  className="!w-28"
                  min={1000}
                  max={9999}
                  value={quarterStart.slice(0, 4)}
                  onChange={(e) => {
                    if (/^[1-9]\d{3}$/.test(e.target.value)) {
                      setBudgetMonth(`${e.target.value}-${quarterStart.slice(5)}`);
                    }
                  }}
                />
              </div>
            </Field>
          ) : (
            <Field label="Budget month (which budget this task's payout counts against; recorded on-chain)">
              <Input
                type="month"
                aria-label="Budget month"
                value={budgetMonth}
                onChange={(e) => setBudgetMonth(e.target.value)}
              />
            </Field>
          )}

          {!isGithub && (
            <Field
              label="Bounty (tokens held by the paying wallet; a custom ticker is matched to a treasury token at payout)"
            >
              <div className="space-y-2">
                {rows.map((row, i) => (
                  <div key={i} className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Select
                      className="task-token-select flex-none"
                      value={row.custom ? CUSTOM : row.ticker}
                      onChange={(e) =>
                        e.target.value === CUSTOM
                          ? setRow(i, { custom: true, ticker: "" })
                          : setRow(i, {
                              custom: false,
                              ticker: e.target.value,
                            })
                      }
                    >
                      {!row.custom && row.ticker === "" && (
                        <option value="">Token…</option>
                      )}
                      {tickerOptions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      <option value={CUSTOM}>Custom…</option>
                    </Select>
                    {row.custom && (
                      <Input
                        className="min-w-24 flex-1"
                        value={row.ticker}
                        onChange={(e) => setRow(i, { ticker: e.target.value })}
                        placeholder="TICKER"
                      />
                    )}
                    <Input
                      className="min-w-24 flex-1"
                      value={row.amount}
                      onChange={(e) => setRow(i, { amount: e.target.value })}
                      placeholder="0"
                    />
                    <Button
                      variant="ghost"
                      className="shrink-0"
                      onClick={() =>
                        setRows((r) => r.filter((_, idx) => idx !== i))
                      }
                      aria-label="Remove amount"
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                {rows.length === 0 && (
                  <p className="text-xs text-amber-500">No bounty yet</p>
                )}
              </div>
              <Button
                variant="ghost"
                className="mt-2"
                onClick={() =>
                  setRows((r) => [
                    ...r,
                    { ticker: "", amount: "", custom: false },
                  ])
                }
              >
                + Add token
              </Button>
            </Field>
          )}

          <ErrorText error={error ?? saveError} />

          <div className="flex flex-wrap justify-end gap-2">
            {!isGithub && onArchive && <Button variant="ghost" className="mr-auto" disabled={busy} onClick={onArchive}>Archive task</Button>}
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} onClick={save}>Save</Button>
          </div>
        </div>
    </Modal>
  );
}
