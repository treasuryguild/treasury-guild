// Browser dismissals for the Overview setup checklist. Keyed by community +
// item id so dismissing never hides the same gap on Integrations.
import { SETUP_CHECKLIST_STORAGE_KEY } from "@/lib/constants";
import type { SetupItemId } from "./status";

function storageKey(communityId: string, itemId: SetupItemId): string {
  return `${communityId}:${itemId}`;
}

function readAll(): string[] {
  try {
    const raw = window.localStorage.getItem(SETUP_CHECKLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeAll(keys: string[]): void {
  try {
    window.localStorage.setItem(SETUP_CHECKLIST_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // storage unavailable: dismissals just do not persist
  }
}

export function isSetupItemDismissed(communityId: string, itemId: SetupItemId): boolean {
  return readAll().includes(storageKey(communityId, itemId));
}

export function dismissSetupItem(communityId: string, itemId: SetupItemId): void {
  const key = storageKey(communityId, itemId);
  const all = readAll();
  if (all.includes(key)) return;
  writeAll([...all, key]);
}
