import {
  createSecp256k1SigningSession,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { type Address, type LocalAccount } from "viem";

import { deriveEvmPrivateKey } from "./derive";

/**
 * An in-memory, unlocked wallet. The signing session owns a copy of the
 * private key; `end()` zeroes it. Nothing here is persisted.
 */
export interface CustodySession {
  address: Address;
  account: LocalAccount<"mera">;
  session: Secp256k1SigningSession;
  /** Canonical unpadded base64url credential ID for the backing passkey. */
  credentialId: string;
}

/**
 * Turns a passkey PRF output into a signing session. The derived private key
 * is zeroed after the session copies it.
 */
export function createCustodySession(
  prfOutput: Uint8Array,
  credentialId: string,
): CustodySession {
  const privateKey = deriveEvmPrivateKey(prfOutput);
  try {
    const session = createSecp256k1SigningSession({ privateKey });
    const account = toViemAccount(session);
    return { address: account.address, account, session, credentialId };
  } finally {
    privateKey.fill(0);
  }
}
