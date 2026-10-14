import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import { UnauthorizedError } from "@/lib/errors";

// The /api/v1 routes are one-line v1Route(endpoint) wirings (v1Route itself is
// tested in src/lib/api/v1Route.test.ts, the endpoints beside their modules).
// This pins each path to its endpoint: `run` of the real endpoint object is
// replaced, so its real scope and input schema still apply.

const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null, requireSession: async () => null }));

import { budgetSummary } from "@/lib/api/v1/budgets";
import { listCommunities, whoami } from "@/lib/api/v1/communities";
import type { ApiEndpoint } from "@/lib/api/v1/endpoint";
import { listCalls } from "@/lib/api/v1/calls";
import { fundingSummary } from "@/lib/api/v1/funding";
import { listIncoming } from "@/lib/api/v1/incoming";
import { listMembers } from "@/lib/api/v1/members";
import { listProposals, proposalDetail } from "@/lib/api/v1/proposals";
import { signingQueue } from "@/lib/api/v1/signing";
import { listTasks } from "@/lib/api/v1/tasks";
import { listTransactions, transactionDetail } from "@/lib/api/v1/transactions";
import { treasuryOverview } from "@/lib/api/v1/treasuries";
import { listWorkgroups } from "@/lib/api/v1/workgroups";
import { GET as budgetsGET } from "./communities/[community]/budgets/route";
import { GET as callsGET } from "./communities/[community]/calls/route";
import { GET as fundingGET } from "./communities/[community]/funding/route";
import { GET as proposalGET } from "./communities/[community]/proposals/[proposal]/route";
import { GET as transactionGET } from "./communities/[community]/transactions/[tx]/route";
import { GET as incomingGET } from "./communities/[community]/incoming/route";
import { GET as membersGET } from "./communities/[community]/members/route";
import { GET as proposalsGET } from "./communities/[community]/proposals/route";
import { GET as tasksGET } from "./communities/[community]/tasks/route";
import { GET as transactionsGET } from "./communities/[community]/transactions/route";
import { GET as treasuriesGET } from "./communities/[community]/treasuries/route";
import { GET as workgroupsGET } from "./communities/[community]/workgroups/route";
import { GET as communitiesGET } from "./communities/route";
import { GET as meGET } from "./me/route";
import { GET as signingQueueGET } from "./me/signing-queue/route";

const CALLER = { wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" };
const endpoints = {
  whoami, listCommunities, signingQueue, budgetSummary, listIncoming, listMembers, listProposals, listTasks, listTransactions,
  treasuryOverview, listWorkgroups, listCalls, fundingSummary, proposalDetail, transactionDetail,
} as Record<string, ApiEndpoint>;
type Name = keyof typeof endpoints;
const runs = {} as Record<Name, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue(CALLER);
  mocks.rateLimit.mockResolvedValue(undefined);
  for (const [name, endpoint] of Object.entries(endpoints)) {
    runs[name] = vi.spyOn(endpoint, "run").mockResolvedValue({ endpoint: name }) as unknown as ReturnType<typeof vi.fn>;
  }
});

function onlyRan(name: Name) {
  for (const [other, run] of Object.entries(runs)) {
    expect(run, other).toHaveBeenCalledTimes(other === name ? 1 : 0);
  }
}

const rootRoutes = [
  { path: "/api/v1/me", handler: meGET, name: "whoami" },
  { path: "/api/v1/communities", handler: communitiesGET, name: "listCommunities" },
  { path: "/api/v1/me/signing-queue", handler: signingQueueGET, name: "signingQueue" },
] as const;
const communityRoutes = [
  { segment: "budgets", handler: budgetsGET, name: "budgetSummary" },
  { segment: "calls", handler: callsGET, name: "listCalls" },
  { segment: "funding", handler: fundingGET, name: "fundingSummary" },
  { segment: "incoming", handler: incomingGET, name: "listIncoming" },
  { segment: "members", handler: membersGET, name: "listMembers" },
  { segment: "proposals", handler: proposalsGET, name: "listProposals" },
  { segment: "tasks", handler: tasksGET, name: "listTasks" },
  { segment: "transactions", handler: transactionsGET, name: "listTransactions" },
  { segment: "treasuries", handler: treasuriesGET, name: "treasuryOverview" },
  { segment: "workgroups", handler: workgroupsGET, name: "listWorkgroups" },
] as const;

describe("/api/v1 route wiring", () => {
  it.each(rootRoutes)("GET $path runs $name for the caller", async ({ path, handler, name }) => {
    const res = await handler(new Request(`http://localhost${path}`), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ endpoint: name });
    expect(res.headers.get("cache-control")).toBe("no-store");
    onlyRan(name);
    expect(runs[name]).toHaveBeenCalledWith(CALLER, expect.any(Object));
    expect(mocks.caller).toHaveBeenCalledWith(expect.any(Request), { allowSession: true });
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
  });

  it.each(communityRoutes)("GET /api/v1/communities/[community]/$segment runs $name with the path's community", async ({ segment, handler, name }) => {
    const res = await handler(
      new Request(`http://localhost/api/v1/communities/signius/${segment}?community=other`),
      { params: Promise.resolve({ community: "signius" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ endpoint: name });
    onlyRan(name);
    expect(runs[name]).toHaveBeenCalledWith(CALLER, expect.objectContaining({ community: "signius" }));
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
  });

  it.each([...rootRoutes, ...communityRoutes])("$name answers 401 without a caller and 403 without the scope", async ({ handler, name }) => {
    const call = () => (handler as typeof budgetsGET)(new Request("http://localhost/api/v1/x"), { params: Promise.resolve({ community: "signius" }) });
    mocks.caller.mockRejectedValueOnce(new UnauthorizedError());
    expect((await call()).status).toBe(401);
    mocks.caller.mockResolvedValueOnce({ ...CALLER, scopes: [] });
    expect((await call()).status).toBe(403);
    expect(runs[name]).not.toHaveBeenCalled();
  });

  it.each([
    { path: "transactions/h123", handler: transactionGET, params: { community: "signius", tx: "h123" }, name: "transactionDetail" },
    { path: "proposals/7", handler: proposalGET, params: { community: "signius", proposal: "7" }, name: "proposalDetail" },
  ] as const)("GET /api/v1/communities/[community]/$path runs $name with every path segment", async ({ path, handler, params, name }) => {
    const res = await (handler as typeof budgetsGET)(
      new Request(`http://localhost/api/v1/communities/signius/${path}`),
      { params: Promise.resolve(params) } as never,
    );
    expect(res.status).toBe(200);
    onlyRan(name);
    expect(runs[name]).toHaveBeenCalledWith(CALLER, expect.objectContaining(name === "transactionDetail" ? { community: "signius", tx: "h123" } : { community: "signius", proposal: 7 }));
  });

  it("reads query parameters as the endpoint's input", async () => {
    await tasksGET(
      new Request("http://localhost/api/v1/communities/signius/tasks?limit=3&includeArchived=true"),
      { params: Promise.resolve({ community: "signius" }) },
    );
    expect(runs.listTasks).toHaveBeenCalledWith(CALLER, expect.objectContaining({ community: "signius", limit: 3, includeArchived: true }));
    const bad = await tasksGET(
      new Request("http://localhost/api/v1/communities/signius/tasks?limit=lots"),
      { params: Promise.resolve({ community: "signius" }) },
    );
    expect(bad.status).toBe(400);
    expect(runs.listTasks).toHaveBeenCalledTimes(1);
  });
});
