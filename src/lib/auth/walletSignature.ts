// The login rule on top of Mesh's checkSignature: the CIP-30 signature must
// come from the address's own payment key. checkSignature also accepts, for
// a base address, a key that only matches the address's *stake* credential,
// so a stake key would authenticate base(anyone's payment credential, that
// stake key), or a base address whose payment part is a script. Treasury
// signing identifies a person by the payment key hash; login and ballots do too.
import { checkSignature, deserializeBech32Address, Ed25519PublicKey, getPublicKeyFromCoseKey } from "@meshsdk/core-cst";

/** True when the COSE_Key's Ed25519 key hashes to the address's payment key hash. */
export function signedByPaymentKey(address: string, coseKeyHex: string): boolean {
  try {
    const keyHash = Ed25519PublicKey.fromBytes(getPublicKeyFromCoseKey(coseKeyHex)).hash().hex();
    // "" unless the payment credential is a key hash (never for a script).
    const paymentKeyHash = deserializeBech32Address(address).pubKeyHash;
    return paymentKeyHash !== "" && paymentKeyHash.toLowerCase() === String(keyHash).toLowerCase();
  } catch {
    return false;
  }
}

/** A CIP-30 signData signature of exactly `text` by `address`'s payment key; false on any malformed input. */
export async function verifyWalletSignature(
  text: string,
  signed: { key: string; signature: string },
  address: string,
): Promise<boolean> {
  try {
    return (await checkSignature(text, signed, address)) && signedByPaymentKey(address, signed.key);
  } catch {
    return false;
  }
}
