import "server-only";

import { serializeNativeScript, type NativeScript } from "@meshsdk/core";
import { BadRequestError } from "@/lib/errors";
import { csl } from "./csl";
import { decodeNativeScriptFromCsl } from "./nativeScriptUtils";
import { shapeFromDecoded, shapeKeyHashes, shapeProblem, templateScript, type TreasuryShape } from "./templates";
import type { ScriptType } from "./types";

export interface DecodedTreasuryScript {
  scriptCbor: string;
  paymentScript: NativeScript;
  /** The template and its groups. */
  shape: TreasuryShape;
  /** Every signer key in script order (base, recovery, co-signer). */
  keyHashes: string[];
  /** The base group's rule, for callers that only care about the base signers. */
  scriptType: ScriptType;
  required: number;
}

/**
 * Read a treasury script from its CBOR: one of the four template shapes
 * (`templates.ts`), rebuilt byte for byte. Anything else is refused, as is
 * a script whose re-encoding differs (its address could not be preserved).
 */
export function decodeTreasuryCbor(input: string): DecodedTreasuryScript {
  const scriptCbor = input.replace(/\s/g, "").toLowerCase();
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
      "Import supports a flat all, any or at-least multisig, a clawback, a lock-until or a co-signer script only",
    );
  }
  const problem = shapeProblem(shape);
  if (problem) throw new BadRequestError(problem);
  const paymentScript = templateScript(shape);
  // Re-encoding must preserve the exact bytes: changing encoding or key order
  // changes the script hash, so it would silently import a different wallet.
  if (serializeNativeScript(paymentScript).scriptCbor !== scriptCbor) {
    throw new BadRequestError("This script uses an unsupported CBOR encoding; its address cannot be preserved");
  }
  return {
    scriptCbor,
    paymentScript,
    shape,
    keyHashes: shapeKeyHashes(shape),
    scriptType: shape.base.scriptType,
    required: shape.base.required,
  };
}
