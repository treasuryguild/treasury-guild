// Display-handle rules shared by the profile card and the DB check
// constraint (migration 0082). Client-safe: no server-only imports.

/** Letters, digits, underscore and hyphen; 2–32 characters. */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;

export function isValidHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}
