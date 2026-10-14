"use client";

// Pick the CSV to import (read in the browser, parsed on the server) or
// download a template to fill in.
import { useState } from "react";
import { downloadText } from "@/lib/browser/download";
import { LEGACY_MAX_CSV_CHARS } from "@/lib/constants";
import { LEGACY_CSV_TEMPLATE, LEGACY_CSV_TEMPLATE_NAME } from "@/lib/legacyHistory/template";
import { Button, ErrorText, Field } from "@/components/ui";

export function HistoryUpload({
  fileName,
  disabled,
  onFile,
}: {
  fileName: string | null;
  disabled: boolean;
  onFile: (file: { name: string; text: string }) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function read(file: File) {
    setError(null);
    if (file.size > LEGACY_MAX_CSV_CHARS * 4) {
      setError("The file is larger than 1 MB. Split it into several files.");
      return;
    }
    const text = await file.text();
    if (text.length > LEGACY_MAX_CSV_CHARS) {
      setError("The file is larger than 1 MB. Split it into several files.");
      return;
    }
    onFile({ name: file.name, text });
  }

  return (
    <div className="space-y-2">
      <Field label="CSV file" hint={
        <>Columns: <span className="font-mono">userId</span> (last 6 characters of the receiver&apos;s address),
          one column per token named by its ticker (for example <span className="font-mono">ADA</span>),{" "}
          <span className="font-mono">task</span>, <span className="font-mono">date</span> (DD.MM.YYYY) and{" "}
          <span className="font-mono">workgroup</span>.</>
      }>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
            e.target.value = "";
          }}
          className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:text-zinc-100 hover:file:bg-zinc-700"
        />
      </Field>
      {fileName && <p className="text-xs text-zinc-500">Selected: {fileName}</p>}
      <ErrorText error={error} />
      <Button variant="ghost" className="!px-0 text-sm"
        onClick={() => downloadText(LEGACY_CSV_TEMPLATE_NAME, LEGACY_CSV_TEMPLATE, "text/csv")}>
        Download a template
      </Button>
    </div>
  );
}
