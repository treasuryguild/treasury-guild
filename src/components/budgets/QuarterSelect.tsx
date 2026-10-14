import { Select } from "@/components/ui";

/** The first month of each quarter ("01", "04", …), as a quarter picker offers them. */
export function QuarterSelect({ month, disabled, onChange }: {
  /** Two-digit first month of the selected quarter. */
  month: string;
  disabled?: boolean;
  onChange: (month: string) => void;
}) {
  return (
    <Select aria-label="Budget quarter" value={month} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="01">Q1 · Jan–Mar</option>
      <option value="04">Q2 · Apr–Jun</option>
      <option value="07">Q3 · Jul–Sep</option>
      <option value="10">Q4 · Oct–Dec</option>
    </Select>
  );
}
