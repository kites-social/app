import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/**
 * Derives the standard EVM BIP-44 private key from a passkey PRF output.
 *
 * The web app must use the same derivation path and account index for the two
 * platforms to arrive at the same address.
 *
 * @returns A fresh 32-byte private key. The caller owns the buffer and must
 * zero it with `.fill(0)` after use.
 */
export function deriveEvmPrivateKey(
  prfOutput: Uint8Array,
  index = 0,
): Uint8Array {
  const mnemonic = entropyToMnemonic(prfOutput, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);

    if (node.privateKey === null) {
      throw new Error("Derivation produced no private key");
    }

    return node.privateKey;
  } finally {
    seed.fill(0);
  }
}
