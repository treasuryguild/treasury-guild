import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { MAX_ACTIVE_INVITES_PER_COMMUNITY } from "@/lib/invites/options";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  hash: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/lib/invites/token", () => ({
  hashInviteToken: mocks.hash,
  generateInviteToken: mocks.generate,
}));

import {
  countActiveInvites,
  createInvite,
  previewInvite,
  redeemInvite,
} from "./invites";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const TOKEN = "tok_raw_value_xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const HASH = "a".repeat(64);
const PREPROD = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const MAINNET = "addr1qyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

interface Op {
  table: string;
  op: "select" | "insert" | "update";
  filters: [string, unknown][];
  values?: Record<string, unknown>;
}

let ops: Op[];
let selectData: unknown;
let insertData: unknown;

function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const record = (k: string, v: unknown) => {
    op.filters.push([k, v]);
    return chain;
  };
  const respond = () => {
    if (op.op === "insert") return { data: insertData, error: null };
    return { data: selectData, error: null };
  };
  const chain = {
    select: () => chain,
    insert: (values: Record<string, unknown>) => {
      op.op = "insert";
      op.values = values;
      return chain;
    },
    update: (values: Record<string, unknown>) => {
      op.op = "update";
      op.values = values;
      return chain;
    },
    eq: record,
    is: record,
    order: () => chain,
    maybeSingle: () => {
      ops.push(op);
      return Promise.resolve(respond());
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve(respond()).then(resolve, reject);
    },
  };
  return chain;
}

function inviteRow(patch: Record<string, unknown> = {}) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    community_id: COMMUNITY,
    token_hash: HASH,
    created_by: PREPROD,
    created_at: "2026-10-01T00:00:00.000Z",
    expires_at: "2026-11-01T00:00:00.000Z",
    max_uses: 10,
    use_count: 0,
    last_used_at: null,
    revoked_at: null,
    label: null,
    communities: { name: "Guild", slug: "guild", network: 0 },
    ...patch,
  };
}

beforeEach(() => {
  ops = [];
  selectData = [];
  insertData = null;
  mocks.from.mockImplementation(builder);
  mocks.hash.mockReturnValue(HASH);
  mocks.generate.mockReturnValue(TOKEN);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  vi.useRealTimers();
});

describe("countActiveInvites", () => {
  it("counts every unrevoked invite, including expired and used-up ones", async () => {
    selectData = Array.from({ length: 3 }, (_, i) => ({ id: `i-${i}` }));
    expect(await countActiveInvites(COMMUNITY)).toBe(3);
    expect(ops[0]?.filters).toEqual(
      expect.arrayContaining([
        ["community_id", COMMUNITY],
        ["revoked_at", null],
      ]),
    );
  });
});

describe("createInvite", () => {
  it("refuses when the community already holds the active-invite cap", async () => {
    selectData = Array.from({ length: MAX_ACTIVE_INVITES_PER_COMMUNITY }, (_, i) => ({ id: `i-${i}` }));
    await expect(createInvite({
      communityId: COMMUNITY,
      createdBy: PREPROD,
      expiresInDays: 30,
      maxUses: null,
      label: null,
    })).rejects.toThrow(BadRequestError);
    await expect(createInvite({
      communityId: COMMUNITY,
      createdBy: PREPROD,
      expiresInDays: 30,
      maxUses: null,
      label: null,
    })).rejects.toThrow(/20 active invite links/);
    expect(ops.every((o) => o.op === "select")).toBe(true);
  });
});

describe("previewInvite", () => {
  it("keeps an exhausted invite valid so an existing member can still open the link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    selectData = inviteRow({ use_count: 10, max_uses: 10 });
    expect(await previewInvite(TOKEN)).toEqual({
      name: "Guild", slug: "guild", network: 0, valid: true,
    });
  });

  it("marks revoked and expired invites invalid without distinguishing them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    selectData = inviteRow({ revoked_at: "2026-10-10T00:00:00.000Z" });
    expect(await previewInvite(TOKEN)).toMatchObject({ valid: false });

    selectData = inviteRow({ expires_at: "2026-10-01T00:00:00.000Z", revoked_at: null });
    expect(await previewInvite(TOKEN)).toMatchObject({ valid: false });
  });

  it("answers null for an unknown token", async () => {
    selectData = null;
    expect(await previewInvite(TOKEN)).toBeNull();
  });
});

describe("redeemInvite", () => {
  it("refuses a wrong-network wallet before calling the redeem RPC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    selectData = inviteRow({ communities: { name: "Guild", slug: "guild", network: 0 } });
    await expect(redeemInvite(TOKEN, MAINNET)).rejects.toThrow(BadRequestError);
    await expect(redeemInvite(TOKEN, MAINNET)).rejects.toThrow(/preprod/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses an invalid invite as not found without redeeming", async () => {
    selectData = inviteRow({ revoked_at: "2026-10-01T00:00:00.000Z" });
    await expect(redeemInvite(TOKEN, PREPROD)).rejects.toThrow(NotFoundError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("redeems on the matching network", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    selectData = inviteRow();
    mocks.rpc.mockResolvedValue({
      data: { communityId: COMMUNITY, slug: "guild", name: "Guild", network: 0, already: false },
      error: null,
    });
    expect(await redeemInvite(TOKEN, PREPROD)).toMatchObject({ slug: "guild", already: false });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("redeem_community_invite", {
      p_token_hash: HASH,
      p_wallet: PREPROD,
    });
  });
});
