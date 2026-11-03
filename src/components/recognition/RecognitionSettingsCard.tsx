"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { Button, Card, ErrorText, Field, Input, SectionTitle, Select } from "@/components/ui";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import {
  DEFAULT_RECOGNITION_SETTINGS,
  RECOGNITION_PRESETS,
  RecognitionSeason,
  type RecognitionPreset,
  type RecognitionSettings,
} from "@/lib/recognition/settings";

export function RecognitionSettingsCard({
  communityId,
  initial,
  canEdit,
  onSaved,
}: {
  communityId: string;
  initial: RecognitionSettings;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RecognitionSettings>(initial);
  const action = useAsyncAction();

  const set = <K extends keyof RecognitionSettings>(key: K, value: RecognitionSettings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const applyPreset = (preset: RecognitionPreset) => {
    setDraft((d) => ({ ...d, ...RECOGNITION_PRESETS[preset], enabled: d.enabled || true }));
  };

  const save = () => {
    void action.run(async () => {
      await apiFetch("/api/recognition/settings", {
        method: "POST",
        body: {
          communityId,
          enabled: draft.enabled,
          season: draft.season,
          maxEndorsementsPerActorSeason: draft.maxEndorsementsPerActorSeason,
          showLeaderboard: draft.showLeaderboard,
          peerKudosEnabled: draft.peerKudosEnabled,
          minMemberDaysToKudos: draft.minMemberDaysToKudos,
          electorateEndorsed: draft.electorateEndorsed,
          endorsedMinScore: draft.endorsedMinScore,
        },
      });
      onSaved();
    });
  };

  return (
    <Card>
      <SectionTitle>Recognition</SectionTitle>
      <p className="mb-4 text-sm text-zinc-400">
        Optional endorsements of paid work, scored in seasons. Off by default; never changes
        payouts, budgets or who may sign.
      </p>
      <ErrorText error={action.error} />
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.enabled} disabled={!canEdit}
          onChange={(e) => set("enabled", e.target.checked)} />
        Enable recognition for this community
      </label>
      {canEdit && (
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="text-xs text-zinc-500 self-center">Presets:</span>
          {(Object.keys(RECOGNITION_PRESETS) as RecognitionPreset[]).map((preset) => (
            <Button key={preset} variant="ghost" disabled={action.busy}
              onClick={() => applyPreset(preset)}>
              {preset[0]!.toUpperCase() + preset.slice(1)}
            </Button>
          ))}
          <Button variant="ghost" disabled={action.busy}
            onClick={() => setDraft({ ...DEFAULT_RECOGNITION_SETTINGS, enabled: draft.enabled })}>
            Reset knobs
          </Button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Season" size="sm">
          <Select value={draft.season} disabled={!canEdit || !draft.enabled}
            onChange={(e) => set("season", e.target.value as RecognitionSeason)}>
            <option value={RecognitionSeason.Quarter}>Quarter</option>
            <option value={RecognitionSeason.Month}>Month</option>
          </Select>
        </Field>
        <Field label="Max endorsements per lead per season" size="sm">
          <Input type="number" min={1} max={100} disabled={!canEdit || !draft.enabled}
            value={draft.maxEndorsementsPerActorSeason}
            onChange={(e) => set("maxEndorsementsPerActorSeason", Number(e.target.value) || 1)} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={draft.showLeaderboard} disabled={!canEdit || !draft.enabled}
            onChange={(e) => set("showLeaderboard", e.target.checked)} />
          Show season leaderboard on the Recognition page
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={draft.peerKudosEnabled} disabled={!canEdit || !draft.enabled}
            onChange={(e) => set("peerKudosEnabled", e.target.checked)} />
          Allow peer kudos on paid tasks
        </label>
        <Field label="Min membership days to give kudos" size="sm">
          <Input type="number" min={0} max={365} disabled={!canEdit || !draft.enabled || !draft.peerKudosEnabled}
            value={draft.minMemberDaysToKudos}
            onChange={(e) => set("minMemberDaysToKudos", Number(e.target.value) || 0)} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={draft.electorateEndorsed} disabled={!canEdit || !draft.enabled}
            onChange={(e) => set("electorateEndorsed", e.target.checked)} />
          Offer “Recognized contributors” as a proposal electorate
        </label>
        <Field label="Minimum score for that electorate" size="sm">
          <Input type="number" min={0} max={1000} step={0.25}
            disabled={!canEdit || !draft.enabled || !draft.electorateEndorsed}
            value={draft.endorsedMinScore}
            onChange={(e) => set("endorsedMinScore", Number(e.target.value) || 0)} />
        </Field>
      </div>
      {canEdit && (
        <div className="mt-4">
          <Button disabled={action.busy} onClick={save}>Save</Button>
        </div>
      )}
    </Card>
  );
}
