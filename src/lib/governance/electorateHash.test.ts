import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { electorateHash, electorateText } from "./electorateHash";

// The same vector supabase/tests/anchors.sql asserts against open_proposal_voting.
const VECTOR = [
  { wallet: "member", recused: false },
  { wallet: "admin", recused: true },
];
const VECTOR_TEXT = "admin 1\nmember 0";
const VECTOR_HASH = createHash("sha256").update(VECTOR_TEXT).digest("hex");

describe("electorateHash", () => {
  it("hashes one sorted line per voter with the recusal flag, no trailing newline", async () => {
    expect(electorateText(VECTOR)).toBe(VECTOR_TEXT);
    expect(await electorateHash(VECTOR)).toBe(VECTOR_HASH);
    // Pinned: the SQL fixture asserts this very value.
    expect(VECTOR_HASH).toBe("1207249599776faf8e6edc213696014d65b72a5430a5028e86cac8c4ddea1b57");
  });

  it("sorts by byte order, not by locale, and is empty-safe", async () => {
    const mixed = [{ wallet: "b", recused: false }, { wallet: "B", recused: false }, { wallet: "a", recused: false }];
    expect(electorateText(mixed)).toBe("B 0\na 0\nb 0");
    expect(await electorateHash([])).toBe(createHash("sha256").update("").digest("hex"));
    expect(await electorateHash([...VECTOR].reverse())).toBe(VECTOR_HASH);
  });
});
