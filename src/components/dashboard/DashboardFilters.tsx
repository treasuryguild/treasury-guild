"use client";

import { unitTicker, type UnitDisplay } from "@/lib/assetRegistry";
import { budgetOwnerLabel } from "@/lib/budgetSetups";
import { ALL_WORKGROUPS, BUDGETED_TOKENS, type DashboardView } from "@/lib/dashboardSeries";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { BudgetPeriodPicker } from "@/components/budgets/BudgetPeriodPicker";
import { Field, Select } from "@/components/ui";

export function DashboardFilters({ month, view, workgroupId, unit, workgroups, treasuries, tokens, display, onPeriod, onWorkgroup, onUnit }: {
  month: string;
  view: DashboardView;
  /** `ALL_WORKGROUPS`, a workgroup id or a treasury id (its direct payments). */
  workgroupId: string;
  unit: string;
  workgroups: WorkgroupSummary[];
  treasuries: { id: string; name: string }[];
  /** Units with a budget or spending in view: single-token overrides of the budgeted set. */
  tokens: string[];
  display: UnitDisplay;
  onPeriod: (month: string, view: DashboardView) => void;
  onWorkgroup: (workgroupId: string) => void;
  onUnit: (unit: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <BudgetPeriodPicker month={month} view={view} recurring={false} allTime onChange={onPeriod} />
      <Field label="Workgroup">
        <Select aria-label="Focus dashboard on a workgroup or treasury" value={workgroupId}
          onChange={(event) => onWorkgroup(event.target.value)}>
          <option value={ALL_WORKGROUPS}>All workgroups, projects & treasuries</option>
          {workgroups.map((workgroup) => (
            <option key={workgroup.id} value={workgroup.id}>
              {workgroup.name}{workgroup.archived_at ? " (Archived)" : ""}
            </option>
          ))}
          {treasuries.length > 0 && <optgroup label="Direct payments from a treasury">
            {treasuries.map((treasury) => (
              <option key={treasury.id} value={treasury.id}>{budgetOwnerLabel("treasury", treasury.name)}</option>
            ))}
          </optgroup>}
        </Select>
      </Field>
      <Field label="Token">
        <Select aria-label="Tokens shown in the spending charts" value={unit}
          onChange={(event) => onUnit(event.target.value)}>
          <option value={BUDGETED_TOKENS}>As budgeted</option>
          {tokens.map((token) => (
            <option key={token} value={token}>{unitTicker(token, display)}</option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
