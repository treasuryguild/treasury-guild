#!/usr/bin/env node
// Rebuild the database record of a Treasury Guild payout from the chain.
//
//   node --env-file=.env scripts/recover-payout-tx.mjs <txHash> [<txHash>...] [--remote]
//
// For a payout that Treasury Guild built and submitted but whose rows were lost
// (for example a local database reset after a locally submitted seed:live
// batch), this reads the transaction from Koios — body CBOR, inputs, outputs
// and the label-190001 metadata — and recreates the `transactions` row, one
// `payouts` row per (task, wallet, unit), and the tasks' paid state. Tasks
// must already exist with the numbers the metadata names (re-run the seed or
// recreate them first) and be payable with the recipient among their
// assignees; anything that does not line up aborts that hash with a message
// and nothing is written for it. Re-running is a no-op for a known hash.
//
// Targets the local stack (NEXT_PUBLIC_SUPABASE_URL on 127.0.0.1/localhost)
// unless --remote is given. Needs SUPABASE_SERVICE_ROLE_KEY; KOIOS_API_KEY and
// KOIOS_BASE_URL_{MAINNET,PREPROD} are optional, as in src/lib/env.server.ts.

import { createClient } from "@supabase/supabase-js";
import { csl } from "@meshsdk/core-csl";

const PAYOUT_LABEL = "190001";
const MESSAGE_LABEL = "674";
const LOVELACE = "lovelace";
const ADA_DECIMALS = 6;
const TX_CONFIRMED = 2;

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const hashes = args.filter((a) => /^[0-9a-f]{64}$/i.test(a)).map((h) => h.toLowerCase());
if (hashes.length === 0) {
  console.error("usage: node --env-file=.env scripts/recover-payout-tx.mjs <txHash> [<txHash>...] [--remote]");
  process.exit(2);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (run with --env-file=.env)");
  process.exit(2);
}
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(supabaseUrl);
if (!isLocal && !remote) {
  console.error(`Refusing non-local database ${supabaseUrl} without --remote`);
  process.exit(2);
}
if (remote) console.warn(`!!! Writing to ${supabaseUrl} !!!`);

const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

function koiosBase(network) {
  return network === 1
    ? process.env.KOIOS_BASE_URL_MAINNET || "https://api.koios.rest/api/v1"
    : process.env.KOIOS_BASE_URL_PREPROD || "https://preprod.koios.rest/api/v1";
}

async function koios(network, path, body) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (process.env.KOIOS_API_KEY) headers.authorization = `Bearer ${process.env.KOIOS_API_KEY}`;
  const res = await fetch(`${koiosBase(network)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Koios ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function must(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** "2.5" with 6 decimals -> 2500000n; exact string math, no floats. */
function toBaseUnits(display, decimals) {
  if (!/^\d+(\.\d+)?$/.test(display)) throw new Error(`Bad amount "${display}"`);
  const [whole, frac = ""] = display.split(".");
  if (frac.length > decimals) {
    throw new Error(`Amount "${display}" has more than ${decimals} decimals`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** "2026-09" -> "2026-09-01"; "2026-Q3" -> "2026-07-01" (the quarter's first month). */
function periodToMonth(code) {
  const q = /^(\d{4})-Q([1-4])$/.exec(code);
  if (q) return `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0")}-01`;
  if (/^\d{4}-\d{2}$/.test(code)) return `${code}-01`;
  throw new Error(`Bad budget period "${code}"`);
}

/** Key hashes of the vkey witnesses in a signed tx (core-csl, read-only). */
function witnessKeyHashes(cborHex) {
  const vkeys = csl.Transaction.from_hex(cborHex).witness_set().vkeys();
  const out = [];
  if (!vkeys) return out;
  for (let i = 0; i < vkeys.len(); i++) {
    out.push(vkeys.get(i).vkey().public_key().hash().to_hex().toLowerCase());
  }
  return out;
}

function parsePayoutMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("No label-190001 metadata");
  }
  if (meta.src !== "treasury-guild" || meta.v !== 3) {
    throw new Error(`Not a v3 Treasury Guild payout (src=${meta.src}, v=${meta.v})`);
  }
  for (const key of ["w", "b", "k", "p"]) {
    if (!Array.isArray(meta[key])) throw new Error(`Metadata "${key}" is not a list`);
  }
  return meta;
}

async function recover(hash) {
  const existing = must(
    await db.from("transactions").select("id").eq("tx_hash", hash).maybeSingle(),
    "check transactions",
  );
  if (existing) {
    console.log(`${hash.slice(0, 12)}: already recorded (transactions ${existing.id}); nothing to do`);
    return;
  }

  const treasuries = must(
    await db.from("treasuries").select("id, community_id, address, network"),
    "load treasuries",
  );
  const byAddress = new Map(treasuries.map((t) => [t.address, t]));

  // The tx's network is whichever Koios knows it on; the treasury is the input address.
  let info = null;
  let treasury = null;
  for (const network of [...new Set(treasuries.map((t) => t.network))]) {
    const found = (
      await koios(network, "/tx_info", {
        _tx_hashes: [hash],
        _inputs: true,
        _assets: true,
        _metadata: true,
      })
    ).find((r) => r.tx_hash === hash);
    if (!found) continue;
    const spender = found.inputs
      .map((i) => i.payment_addr.bech32)
      .find((a) => byAddress.has(a));
    if (!spender) throw new Error("No treasury address among the tx inputs");
    info = found;
    treasury = byAddress.get(spender);
    break;
  }
  if (!info || !treasury) throw new Error("Transaction not found on any treasury network");

  const cborRows = await koios(treasury.network, "/tx_cbor", { _tx_hashes: [hash] });
  const cbor = cborRows.find((r) => r.tx_hash === hash)?.cbor;
  if (!cbor) throw new Error("Koios returned no CBOR for the tx");

  const meta = parsePayoutMeta(info.metadata?.[PAYOUT_LABEL]);
  const message = info.metadata?.[MESSAGE_LABEL]?.msg;
  const outputsByIndex = new Map(info.outputs.map((o) => [o.tx_index, o]));

  // Tickers -> units and decimals: ADA is built in, tokens come from the
  // community's persisted mappings, else from its mints.
  const assets = must(
    await db
      .from("community_assets")
      .select("field_name, unit, decimals")
      .eq("community_id", treasury.community_id),
    "load community assets",
  );
  const mints = must(
    await db
      .from("mints")
      .select("ticker, policy_id, asset_name_hex, decimals")
      .eq("treasury_id", treasury.id),
    "load mints",
  );
  function unitFor(ticker) {
    if (ticker === "ADA") return { unit: LOVELACE, decimals: ADA_DECIMALS };
    const mapped = assets.find((a) => a.field_name.toLowerCase() === ticker.toLowerCase());
    if (mapped) return { unit: mapped.unit, decimals: mapped.decimals };
    const mint = mints.find((m) => (m.ticker ?? "").toLowerCase() === ticker.toLowerCase());
    if (mint) return { unit: `${mint.policy_id}${mint.asset_name_hex}`, decimals: mint.decimals };
    throw new Error(`Unknown ticker "${ticker}" (no community_assets mapping or mint)`);
  }
  const units = meta.k.map(unitFor);

  // Metadata entries -> recipient wallets (by tx_index) and per-task amounts.
  const numbers = new Set();
  const plan = []; // { wallet, tasks: [{ number, period, amounts: [{ unit, quantity }] }] }
  for (const entry of meta.p) {
    const [outIdx, taskList] = entry;
    const output = outputsByIndex.get(outIdx);
    if (!output) throw new Error(`Metadata names output ${outIdx}, which the tx does not have`);
    const wallet = output.payment_addr.bech32;
    if (wallet === treasury.address) throw new Error(`Output ${outIdx} is the treasury's own change`);
    const expected = new Map(); // unit -> quantity
    const tasks = [];
    for (const [number, wIdx, bIdx, amounts] of taskList) {
      if (typeof number !== "number") throw new Error(`Bad task tuple in output ${outIdx}`);
      numbers.add(number);
      const taskAmounts = [];
      amounts.forEach((display, k) => {
        if (display === "") return;
        const { unit, decimals } = units[k];
        const quantity = toBaseUnits(display, decimals);
        taskAmounts.push({ unit, quantity });
        expected.set(unit, (expected.get(unit) ?? 0n) + quantity);
      });
      tasks.push({ number, period: meta.b[bIdx], workgroup: meta.w[wIdx], amounts: taskAmounts });
    }
    // Cross-check against the real output: tokens exact, lovelace >= (min-UTxO bump).
    for (const [unit, quantity] of expected) {
      if (unit === LOVELACE) {
        if (BigInt(output.value) < quantity) {
          throw new Error(`Output ${outIdx} carries ${output.value} lovelace, metadata says ${quantity}`);
        }
        continue;
      }
      const actual =
        (output.asset_list ?? []).find((a) => `${a.policy_id}${a.asset_name ?? ""}` === unit)
          ?.quantity ?? "0";
      if (BigInt(actual) !== quantity) {
        throw new Error(`Output ${outIdx}: ${unit.slice(0, 12)}… on-chain ${actual} vs metadata ${quantity}`);
      }
    }
    plan.push({ wallet, tasks });
  }

  const taskRows = must(
    await db
      .from("tasks")
      .select("id, number, pay_state, paid_tx_hash, budget_month, task_assignees(wallet_address)")
      .eq("community_id", treasury.community_id)
      .in("number", [...numbers]),
    "load tasks",
  );
  const taskByNumber = new Map(taskRows.map((t) => [t.number, t]));
  for (const number of numbers) {
    const task = taskByNumber.get(number);
    if (!task) throw new Error(`Task #${number} does not exist in this community — recreate it first`);
    if (task.pay_state !== "payable") {
      const paid = task.paid_tx_hash ? ` (paid in ${task.paid_tx_hash.slice(0, 12)}…)` : "";
      throw new Error(`Task #${number} is ${task.pay_state}${paid}, not payable`);
    }
  }
  for (const { wallet, tasks } of plan) {
    for (const t of tasks) {
      const assignees = taskByNumber.get(t.number).task_assignees.map((a) => a.wallet_address);
      if (!assignees.includes(wallet)) {
        throw new Error(`Task #${t.number} is not assigned to ${wallet}; refusing to guess`);
      }
    }
  }

  // Who signed: treasury signers whose key hash witnessed the tx.
  const signers = must(
    await db.from("treasury_signers").select("wallet_address, key_hash").eq("treasury_id", treasury.id),
    "load signers",
  );
  let signedAddresses = [];
  try {
    const hashesInTx = new Set(witnessKeyHashes(cbor));
    signedAddresses = signers
      .filter((s) => hashesInTx.has(s.key_hash.toLowerCase()))
      .map((s) => s.wallet_address);
  } catch (err) {
    console.warn(`  could not read witnesses (${err.message}); signed_addresses left empty`);
  }
  const owner = must(
    await db
      .from("community_members")
      .select("wallet_address")
      .eq("community_id", treasury.community_id)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle(),
    "load owner",
  );
  const createdBy = signedAddresses[0] ?? owner?.wallet_address ?? signers[0]?.wallet_address;
  if (!createdBy) throw new Error("Nobody to attribute the transaction to");

  const blockTime = new Date(info.tx_timestamp * 1000).toISOString();
  const payments = plan.reduce((n, r) => n + r.tasks.length, 0);
  const description = `Payout: ${numbers.size} tasks, ${payments} payments, ${plan.length} contributors (${meta.k.join(", ")})`;

  const tx = must(
    await db
      .from("transactions")
      .insert({
        treasury_id: treasury.id,
        kind: "payout",
        tx_cbor: cbor,
        tx_hash: hash,
        description,
        signed_addresses: signedAddresses,
        state: TX_CONFIRMED,
        created_by: createdBy,
        created_at: blockTime,
        submitted_at: blockTime,
        // History is never announced.
        discord_notified_at: blockTime,
      })
      .select("id")
      .single(),
    "insert transaction",
  );

  const payoutRows = plan.flatMap(({ wallet, tasks }) =>
    tasks.flatMap((t) =>
      t.amounts.map((a) => ({
        transaction_id: tx.id,
        task_id: taskByNumber.get(t.number).id,
        contributor_wallet: wallet,
        unit: a.unit,
        amount: a.quantity.toString(),
        status: "confirmed",
        created_at: blockTime,
      })),
    ),
  );
  must(await db.from("payouts").insert(payoutRows), "insert payouts");

  for (const number of numbers) {
    const task = taskByNumber.get(number);
    const period = plan.flatMap((r) => r.tasks).find((t) => t.number === number)?.period;
    const patch = { pay_state: "paid", paid_tx_hash: hash };
    if (!task.budget_month && period) patch.budget_month = periodToMonth(period);
    must(await db.from("tasks").update(patch).eq("id", task.id), `mark task #${number} paid`);
  }

  must(await db.from("external_txs").delete().eq("tx_hash", hash), "drop external record");

  const sorted = [...numbers].sort((a, b) => a - b);
  console.log(`${hash.slice(0, 12)}: recovered as transactions ${tx.id}`);
  console.log(`  ${description}`);
  console.log(`  message: ${Array.isArray(message) ? message.join("") : "-"}`);
  console.log(
    `  tasks #${sorted.join(", #")} -> paid; ${payoutRows.length} payout rows; signed by ${signedAddresses.length} signer(s)`,
  );
}

let failed = 0;
for (const hash of hashes) {
  try {
    await recover(hash);
  } catch (err) {
    failed += 1;
    console.error(`${hash.slice(0, 12)}: FAILED — ${err.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
