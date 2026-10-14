// How a finalize splits attendees over tasks. finalize_call (migration 0037)
// does the real split with the same arithmetic; this is the preview.

/**
 * Balanced task sizes for `count` attendees at most `max` per task:
 * 41 at 20 -> [14, 14, 13], never [20, 20, 1].
 */
export function chunkSizes(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (max < 1) throw new Error("Chunk size must be positive");
  const chunks = Math.ceil(count / max);
  const sizes = new Array<number>(chunks).fill(0);
  // Attendee i lands in chunk floor(i * chunks / count), as in the SQL.
  for (let i = 0; i < count; i++) {
    const index = Math.floor((i * chunks) / count);
    sizes[index] = (sizes[index] ?? 0) + 1;
  }
  return sizes;
}
