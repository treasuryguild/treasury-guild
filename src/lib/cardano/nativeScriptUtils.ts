import "server-only";

import type { csl } from "@meshsdk/core-csl";
import type { DecodedNativeScript } from "./types";

export type { DecodedNativeScript };

export function decodeNativeScriptFromCsl(
  ns: csl.NativeScript,
): DecodedNativeScript {
  const sp = ns.as_script_pubkey();
  if (sp) {
    return { type: "sig", keyHash: sp.addr_keyhash().to_hex() };
  }

  const tls = ns.as_timelock_start?.();
  if (tls) {
    const slot = String(tls.slot_bignum?.().to_str?.() ?? tls.slot?.() ?? "0");
    return { type: "timelockStart", slot };
  }

  const tle = ns.as_timelock_expiry?.();
  if (tle) {
    const slot = String(tle.slot_bignum?.().to_str?.() ?? tle.slot?.() ?? "0");
    return { type: "timelockExpiry", slot };
  }

  const saAll = ns.as_script_all();
  if (saAll) {
    const list = saAll.native_scripts();
    const scripts: DecodedNativeScript[] = [];
    for (let i = 0; i < list.len(); i++) {
      scripts.push(decodeNativeScriptFromCsl(list.get(i)));
    }
    return { type: "all", scripts };
  }

  const saAny = ns.as_script_any();
  if (saAny) {
    const list = saAny.native_scripts();
    const scripts: DecodedNativeScript[] = [];
    for (let i = 0; i < list.len(); i++) {
      scripts.push(decodeNativeScriptFromCsl(list.get(i)));
    }
    return { type: "any", scripts };
  }

  const saNOfK = ns.as_script_n_of_k();
  if (saNOfK) {
    const n = saNOfK.n();
    const list = saNOfK.native_scripts();
    const scripts: DecodedNativeScript[] = [];
    for (let i = 0; i < list.len(); i++) {
      scripts.push(decodeNativeScriptFromCsl(list.get(i)));
    }
    const required =
      typeof n === "number"
        ? n
        : Number(
            (n as unknown as { to_str?: () => string }).to_str?.() ??
              (n as unknown as number),
          );
    return { type: "atLeast", required, scripts };
  }

  // Unknown variant; default to requiring 1 signature
  return { type: "atLeast", required: 1, scripts: [] };
}

/** Collect all sig key hashes from a decoded native script tree (deduplicated). */
export function collectSigKeyHashes(node: DecodedNativeScript): string[] {
  if (node.type === "sig") return [node.keyHash.toLowerCase()];
  if (node.type === "all" || node.type === "any" || node.type === "atLeast") {
    const out: string[] = [];
    for (const child of node.scripts) out.push(...collectSigKeyHashes(child));
    return Array.from(new Set(out));
  }
  return [];
}
