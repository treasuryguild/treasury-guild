"use client";

import type { PaydayFilter, PaydayStatus } from "@/lib/payday/view";
import { Button, Input, Select } from "@/components/ui";

const STATUSES: { value: PaydayStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "selected", label: "Selected" },
  { value: "unticked", label: "Unticked" },
  { value: "attention", label: "Needs attention" },
];

/** View filters: they change what is listed, never what is paid. */
export function PaydayFilters({
  filter,
  counts,
  workgroups,
  onChange,
}: {
  filter: PaydayFilter;
  counts: Record<PaydayStatus, number>;
  workgroups: { id: string; name: string }[];
  onChange: (next: PaydayFilter) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {STATUSES.map((s) => (
        <Button
          key={s.value}
          variant={filter.status === s.value ? "primary" : "secondary"}
          aria-pressed={filter.status === s.value}
          onClick={() => onChange({ ...filter, status: s.value })}
        >
          {s.label} ({counts[s.value]})
        </Button>
      ))}
      <div className="flex min-w-0 basis-full gap-2 sm:ml-auto sm:basis-auto">
        {workgroups.length > 1 && (
          <Select
            aria-label="Workgroup"
            className="min-w-0 flex-1 sm:w-44"
            value={filter.workgroupId}
            onChange={(e) => onChange({ ...filter, workgroupId: e.target.value })}
          >
            <option value="">All workgroups</option>
            {workgroups.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        )}
        <Input
          type="search"
          aria-label="Search tasks"
          placeholder="#number or title"
          className="min-w-0 flex-1 sm:w-48"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
      </div>
    </div>
  );
}
