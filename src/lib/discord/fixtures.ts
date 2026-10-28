// Test scenarios for the Discord payout message, used by the /dev tools page
// (preview + send) and by tests. Pure and client-safe; each scenario builds
// its payload through the real builders so the preview is what production
// would post. Deterministic: fixed timestamp, hash and wallets.

import { unitTicker } from "@/lib/assetRegistry";
import {
  AVATAR_PATH,
  buildConnectedEmbed,
  buildPayoutEmbed,
  MAX_WORKGROUP_LINES,
  type BudgetBalanceLine,
  type DiscordWebhookPayload,
  type PayoutAmount,
  type PayoutMessageInput,
  type PayoutMessageTask,
} from "./payoutMessage";

export const DISCORD_SCENARIO_IDS = [
  "kitchen-sink",
  "minimal",
  "no-extras",
  "many-workgroups",
  "mainnet",
  "connected",
] as const;
export type DiscordScenarioId = (typeof DISCORD_SCENARIO_IDS)[number];

export interface DiscordScenario {
  id: DiscordScenarioId;
  title: string;
  description: string;
  build: () => DiscordWebhookPayload;
}

const AT = new Date("2026-09-15T12:00:00Z");
const TX_HASH = "9f3c2e1d0b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e7f80";
const APP = "https://app.treasuryguild.com";
const SLUG = "guild-dao";
const TREASURY = "Main treasury";
const TREASURY_ADDR = "addr_test1qztreasuryguildtreasury00000000000000000000000000000000000000000000000000000000000000000abc123";

const ADA = { ticker: "ADA", decimals: 6 };
const GVT = { ticker: "GVT", decimals: 2 };
const HOSKY = { ticker: "HOSKY", decimals: 0 };
/** A unit no registry knows: the message falls back to the hex ticker. */
export const UNKNOWN_UNIT = `${"f".repeat(56)}aabbcc`;
const UNKNOWN = { ticker: unitTicker(UNKNOWN_UNIT, new Map()), decimals: 0 };

const ada = (lovelace: bigint): PayoutAmount => ({ ...ADA, quantity: lovelace });
const gvt = (hundredths: bigint): PayoutAmount => ({ ...GVT, quantity: hundredths });
const hosky = (units: bigint): PayoutAmount => ({ ...HOSKY, quantity: units });

/** Deterministic fake wallet; only counted, never shown. */
const wallet = (n: number) => `addr_test1q${n.toString(36).padStart(6, "0")}`;
const wallets = (from: number, count: number) => Array.from({ length: count }, (_, i) => wallet(from + i));

const DEV = "Dev";
const DESIGN = "Design & Community Outreach Working Group with a very long name";
const OPS = "Ops";
const RESEARCH = "Research";
const EVENTS = "Events";

function task(workgroupName: string, amounts: PayoutAmount[], recipientWallets: string[]): PayoutMessageTask {
  return { workgroupName, amounts, recipientWallets };
}

function budget(
  workgroupName: string,
  periodLabel: string,
  asset: { ticker: string; decimals: number },
  allocated: bigint,
  spent: bigint,
): BudgetBalanceLine {
  return { workgroupName, periodLabel, ...asset, allocated, spent };
}

const community = (extras = true): PayoutMessageInput["community"] =>
  extras
    ? { name: "Guild DAO", url: `${APP}/c/${SLUG}`, iconUrl: `${APP}${AVATAR_PATH}` }
    : { name: "Guild DAO" };

const links = { transaction: `${APP}/c/${SLUG}/tx/00000000-0000-4000-8000-000000000001`, dashboard: `${APP}/c/${SLUG}/dashboard` };

const balanceUrl = (network: 0 | 1) =>
  network === 1 ? `https://pool.pm/${TREASURY_ADDR}` : `https://preprod.cexplorer.io/address/${TREASURY_ADDR}`;

function minimalInput(network: 0 | 1): PayoutMessageInput {
  return {
    community: community(),
    treasuryName: TREASURY,
    txHash: TX_HASH,
    network,
    links,
    tasks: [task(DEV, [ada(150_000_000n)], wallets(1, 1))],
    budgets: [budget(DEV, "September 2026", ADA, 3_000_000_000n, 450_000_000n)],
    balance: { url: balanceUrl(network), amounts: [ada(12_345_678_901n), gvt(1_000_000n)] },
    rate: { price: 0.4212, currency: "usd", symbol: "ADA" },
    at: AT,
  };
}

/** Every rendering path of the payout message in one batch. */
function kitchenSink(): PayoutMessageInput {
  return {
    community: community(),
    treasuryName: TREASURY,
    txHash: TX_HASH,
    network: 0,
    links,
    tasks: [
      // several tasks in one workgroup, mixed assets, one paid to two wallets ("× 2")
      task(DEV, [ada(150_000_000n)], wallets(1, 1)),
      task(DEV, [ada(300_000_000n), gvt(25_050n)], wallets(2, 2)),
      // long workgroup name → truncated; token with 0 decimals; seven recipients
      task(DESIGN, [hosky(1_000_000n)], wallets(10, 7)),
      // unknown unit → hex ticker fallback; dust ADA
      task(OPS, [ada(1n), { ...UNKNOWN, quantity: 500n }], wallets(20, 1)),
      // huge quantity: thousands separators, exact digits
      task(RESEARCH, [ada(123_456_789_012_345_678_901n)], wallets(30, 1)),
      // token only, no ADA
      task(EVENTS, [gvt(1_234n)], wallets(40, 3)),
    ],
    budgets: [
      // monthly, two assets, one fine and one overspent
      budget(DEV, "September 2026", ADA, 3_000_000_000n, 750_000_000n),
      budget(DEV, "September 2026", GVT, 50_000n, 62_500n),
      // quarterly
      budget(DESIGN, "Q3 2026", HOSKY, 5_000_000n, 3_250_000n),
      // fully used
      budget(RESEARCH, "September 2026", ADA, 200_000_000_000_000_000_000n, 200_000_000_000_000_000_000n),
      // Ops and Events: no budget
    ],
    balance: {
      url: balanceUrl(0),
      amounts: [
        ada(987_654_321_000n),
        gvt(12_345_678n),
        hosky(999_999_999_999n),
        { ...UNKNOWN, quantity: 42n },
        { ticker: "SNEK", decimals: 0, quantity: 1n },
      ],
    },
    rate: { price: 0.4212, currency: "usd", symbol: "ADA" },
    at: AT,
  };
}

export const DISCORD_SCENARIOS: readonly DiscordScenario[] = [
  {
    id: "kitchen-sink",
    title: "Kitchen sink",
    description:
      "One payout that hits every rendering path: several workgroups with mixed assets, a long workgroup name, the hex ticker fallback, huge and dust quantities, monthly and quarterly budgets including an overspent and a fully used one, workgroups without a budget, a multi-token treasury balance, links and an exchange rate.",
    build: () => buildPayoutEmbed(kitchenSink()),
  },
  {
    id: "minimal",
    title: "Minimal",
    description: "The common case: one task, one workgroup, ADA only, a budget, the balance and the rate.",
    build: () => buildPayoutEmbed(minimalInput(0)),
  },
  {
    id: "no-extras",
    title: "No extras",
    description:
      "Everything optional missing: no in-app links or community icon, no budgets, the balance could not be loaded and the community has no exchange rate (date-only footer).",
    build: () =>
      buildPayoutEmbed({
        community: community(false),
        treasuryName: TREASURY,
        txHash: TX_HASH,
        network: 0,
        tasks: [task(DEV, [ada(150_000_000n)], wallets(1, 1))],
        budgets: [],
        balance: null,
        rate: null,
        at: AT,
      }),
  },
  {
    id: "many-workgroups",
    title: "Many workgroups",
    description: `${MAX_WORKGROUP_LINES + 4} workgroups paid at once: the spending and budget blocks cap at ${MAX_WORKGROUP_LINES} and say how many more there are.`,
    build: () => {
      const names = Array.from({ length: MAX_WORKGROUP_LINES + 4 }, (_, i) => `Workgroup ${String(i + 1).padStart(2, "0")}`);
      return buildPayoutEmbed({
        ...minimalInput(0),
        tasks: names.map((name, i) => task(name, [ada(BigInt(i + 1) * 10_000_000n)], wallets(100 + i, 1))),
        budgets: names.filter((_, i) => i % 2 === 0).map((name) => budget(name, "September 2026", ADA, 1_000_000_000n, 250_000_000n)),
      });
    },
  },
  {
    id: "mainnet",
    title: "Mainnet",
    description: "The minimal payout on mainnet: explorer links go to cexplorer.io and the treasury balance to pool.pm.",
    build: () => buildPayoutEmbed(minimalInput(1)),
  },
  {
    id: "connected",
    title: "Connected",
    description: "The hello message posted when an admin saves a webhook on a treasury card.",
    build: () => buildConnectedEmbed(TREASURY),
  },
];

export function buildScenario(id: DiscordScenarioId): DiscordWebhookPayload {
  const scenario = DISCORD_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown Discord scenario "${id}"`);
  return scenario.build();
}
