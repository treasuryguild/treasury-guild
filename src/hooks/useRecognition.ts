// Recognition settings and season/task events for community pages.
"use client";

import { apiFetch } from "@/lib/api/client";
import type { RecognitionEventsResponse, RecognitionSettingsResponse } from "@/lib/api/types";
import { useAsyncData } from "@/hooks/useAsyncData";
import { recognitionSeasonKey } from "@/lib/recognition/season";
import type { RecognitionSettings } from "@/lib/recognition/settings";

export function useRecognitionSettings(communityId: string | null | undefined) {
  return useAsyncData(communityId, () =>
    apiFetch<RecognitionSettingsResponse>("/api/recognition/settings", {
      query: { communityId: communityId! },
    }).then((r) => r.settings));
}

export function useRecognitionSeason(
  communityId: string | null | undefined,
  settings: RecognitionSettings | null | undefined,
) {
  const seasonKey = settings?.enabled ? recognitionSeasonKey(settings.season) : null;
  return useAsyncData(
    communityId && seasonKey ? `${communityId}:${seasonKey}` : null,
    () => apiFetch<RecognitionEventsResponse>("/api/recognition/events", {
      query: { communityId: communityId!, seasonKey: seasonKey! },
    }),
  );
}

export function useRecognitionTaskEvents(taskId: string | null | undefined, enabled: boolean) {
  return useAsyncData(enabled && taskId ? taskId : null, () =>
    apiFetch<RecognitionEventsResponse>("/api/recognition/events", {
      query: { taskId: taskId! },
    }));
}
