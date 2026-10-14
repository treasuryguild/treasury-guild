"use client";

import type { CreateTreasuryResponse } from "@/lib/api/types";
import { shortMonthLabel } from "@/lib/budgets";
import { routes } from "@/lib/routes";
import { Card, Field, LinkButton, Select } from "@/components/ui";

/** Select value of a treasury that is not tied to a workgroup. */
export const COMMUNITY_TREASURY = "";

/**
 * What a new treasury is used for: the whole community (no link, any
 * workgroup can be paid from it) or one workgroup / project, whose payment
 * wallet it becomes.
 */
export function TreasuryLinkField({ workgroups, value, disabled, onChange }: {
  workgroups: { id: string; name: string }[];
  value: string;
  disabled?: boolean;
  onChange: (workgroupId: string) => void;
}) {
  return (
    <Field
      label="Used for"
      hint="A community treasury can pay any workgroup or project. A linked treasury becomes that workgroup's payment wallet; more can be linked later from each workgroup's details."
    >
      <Select aria-label="Used for" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value={COMMUNITY_TREASURY}>Community treasury</option>
        {workgroups.map((workgroup) => <option key={workgroup.id} value={workgroup.id}>{workgroup.name}</option>)}
      </Select>
    </Field>
  );
}

/** Shown in place of the form when a link was requested: what happened to it. */
export function TreasuryCreatedNotice({ slug, result, workgroupName }: {
  slug: string;
  result: CreateTreasuryResponse;
  workgroupName: string;
}) {
  const { treasury, link, linkError } = result;
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-medium">{treasury.name} created</h2>
      <div role="status" className="space-y-2 text-sm text-zinc-300">
        {link?.effective === "current" && (
          <p>{workgroupName} is paid from this treasury from {shortMonthLabel(link.startsOn.slice(0, 7))}.</p>
        )}
        {link?.effective === "next" && (
          <p>
            {workgroupName} already has payouts from another wallet this period, so it is paid from this
            treasury from {shortMonthLabel(link.startsOn.slice(0, 7))}.
          </p>
        )}
        {!link && (
          <p className="text-amber-500">
            The treasury was not linked to {workgroupName}{linkError ? `: ${linkError}` : ""}. Set the
            payment wallet from the workgroup&apos;s <span className="font-medium">Edit details</span> dialog.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <LinkButton href={routes.treasury(slug)}>Go to treasury</LinkButton>
        {!link && <LinkButton href={routes.community(slug)} variant="secondary">Workgroups</LinkButton>}
      </div>
    </Card>
  );
}
