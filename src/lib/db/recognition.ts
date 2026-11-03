// Service-role recognition settings and events.
import "server-only";

import { PgCode } from "@/lib/constants";
import { maybe, rows, rpc, serviceClient } from "@/lib/db/client";
import {
  RECOGNITION_EVENT_COLUMNS,
  RECOGNITION_SETTING_CHANGE_COLUMNS,
  RECOGNITION_SETTINGS_COLUMNS,
  type RecognitionEventRow,
  type RecognitionSettingChangeRow,
  type RecognitionSettingsRow,
} from "@/lib/db/types";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import {
  recognitionSettingsFromRow,
  recognitionSettingsToRow,
  type RecognitionSettings,
} from "@/lib/recognition/settings";

const WRITE_ERRORS = {
  [PgCode.CheckViolation]: BadRequestError,
  [PgCode.InsufficientPrivilege]: ForbiddenError,
  [PgCode.NoDataFound]: NotFoundError,
  [PgCode.UniqueViolation]: BadRequestError,
};

export async function loadRecognitionSettings(communityId: string): Promise<RecognitionSettings> {
  const row = maybe<RecognitionSettingsRow>(
    await serviceClient().from("recognition_settings").select(RECOGNITION_SETTINGS_COLUMNS)
      .eq("community_id", communityId).maybeSingle(),
    "load recognition settings",
  );
  return recognitionSettingsFromRow(row);
}

export async function recognitionEnabled(communityId: string): Promise<boolean> {
  return (await loadRecognitionSettings(communityId)).enabled;
}

export async function saveRecognitionSettings(
  communityId: string,
  settings: RecognitionSettings,
  actor: string,
): Promise<void> {
  rpc<null>(await serviceClient().rpc("save_recognition_settings", {
    p_community_id: communityId,
    p_settings: recognitionSettingsToRow(settings),
    p_actor: actor,
  }), WRITE_ERRORS);
}

export async function listRecognitionSettingChanges(
  communityId: string,
  limit = 50,
): Promise<RecognitionSettingChangeRow[]> {
  return rows<RecognitionSettingChangeRow>(
    await serviceClient().from("recognition_setting_changes")
      .select(RECOGNITION_SETTING_CHANGE_COLUMNS)
      .eq("community_id", communityId)
      .order("changed_at", { ascending: false })
      .limit(limit),
    "list recognition setting changes",
  );
}

export async function createEndorsement(input: {
  taskId: string;
  subjectWallet: string;
  actor: string;
  seasonKey: string;
  note?: string | null;
}): Promise<string> {
  return rpc<string>(await serviceClient().rpc("create_recognition_endorsement", {
    p_task_id: input.taskId,
    p_subject_wallet: input.subjectWallet,
    p_actor: input.actor,
    p_season_key: input.seasonKey,
    p_note: input.note ?? null,
  }), WRITE_ERRORS);
}

export async function createPeerKudos(input: {
  taskId: string;
  subjectWallet: string;
  actor: string;
  seasonKey: string;
  note?: string | null;
}): Promise<string> {
  return rpc<string>(await serviceClient().rpc("create_recognition_peer_kudos", {
    p_task_id: input.taskId,
    p_subject_wallet: input.subjectWallet,
    p_actor: input.actor,
    p_season_key: input.seasonKey,
    p_note: input.note ?? null,
  }), WRITE_ERRORS);
}

export async function revokeRecognitionEvent(
  eventId: string,
  actor: string,
  reason?: string | null,
): Promise<boolean> {
  return rpc<boolean>(await serviceClient().rpc("revoke_recognition_event", {
    p_event_id: eventId,
    p_actor: actor,
    p_reason: reason ?? null,
  }), WRITE_ERRORS);
}

export async function listRecognitionEventsForTask(taskId: string): Promise<RecognitionEventRow[]> {
  return rows<RecognitionEventRow>(
    await serviceClient().from("recognition_events").select(RECOGNITION_EVENT_COLUMNS)
      .eq("task_id", taskId)
      .order("created_at", { ascending: true }),
    "list recognition events for task",
  );
}

export async function listRecognitionEventsForSeason(
  communityId: string,
  seasonKey: string,
): Promise<RecognitionEventRow[]> {
  return rows<RecognitionEventRow>(
    await serviceClient().from("recognition_events").select(RECOGNITION_EVENT_COLUMNS)
      .eq("community_id", communityId)
      .eq("season_key", seasonKey)
      .order("created_at", { ascending: false }),
    "list recognition events for season",
  );
}

export async function countActorEndorsements(
  communityId: string,
  seasonKey: string,
  actor: string,
): Promise<number> {
  const list = rows<{ id: string }>(
    await serviceClient().from("recognition_events").select("id")
      .eq("community_id", communityId)
      .eq("season_key", seasonKey)
      .eq("actor_wallet", actor)
      .eq("kind", "endorsement")
      .is("revoked_at", null),
    "count actor endorsements",
  );
  return list.length;
}
