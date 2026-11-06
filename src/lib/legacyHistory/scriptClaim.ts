// Decode a previous-wallet script CBOR and check it matches the address.
import "server-only";

import { deserializeAddress } from "@meshsdk/core";
import { BadRequestError } from "@/lib/errors";
import { csl } from "@/lib/cardano/csl";
import { decodeNativeScriptFromCsl } from "@/lib/cardano/nativeScriptUtils";
import { groupRequired, shapeFromDecoded, shapeProblem } from "@/lib/cardano/templates";

export interface LegacyScriptClaim {
  scriptCbor: string;
  scriptHash: string;
  baseKeyHashes: string[];
  required: number;
}

/** Parse CBOR, require a template base group, and check the script hash matches the address. */
export function resolveLegacyScriptClaim(address: string, scriptCborRaw: string): LegacyScriptClaim {
  const scriptCbor = scriptCborRaw.replace(/\s/g, "").toLowerCase();
  if (!scriptCbor || scriptCbor.length > 32_768 || !/^(?:[0-9a-f]{2})+$/.test(scriptCbor)) {
    throw new BadRequestError("Paste a native script as CBOR hex (up to 16 KB)");
  }
  let native;
  try {
    native = csl.NativeScript.from_hex(scriptCbor);
  } catch {
    throw new BadRequestError("Invalid native-script CBOR");
  }
  const shape = shapeFromDecoded(decodeNativeScriptFromCsl(native));
  if (!shape) {
    throw new BadRequestError(
      "The script must be a flat all/any/at-least multisig, or a clawback, lock-until or co-signer template",
    );
  }
  const problem = shapeProblem(shape);
  if (problem) throw new BadRequestError(problem);

  const scriptHash = native.hash().to_hex().toLowerCase();
  let addressScriptHash: string | null = null;
  try {
    const parts = deserializeAddress(address);
    addressScriptHash = parts.scriptHash ? parts.scriptHash.toLowerCase() : null;
  } catch {
    throw new BadRequestError("Invalid previous-wallet address");
  }
  if (!addressScriptHash) {
    throw new BadRequestError("That address is not a script address; leave the script blank");
  }
  if (addressScriptHash !== scriptHash) {
    throw new BadRequestError("The script CBOR does not match this address");
  }

  return {
    scriptCbor,
    scriptHash,
    baseKeyHashes: shape.base.keyHashes.map((h) => h.toLowerCase()),
    required: groupRequired(shape.base),
  };
}

/** True when the address's payment credential is a script hash. */
export function addressIsScript(address: string): boolean {
  try {
    const parts = deserializeAddress(address);
    return !!parts.scriptHash;
  } catch {
    return false;
  }
}
