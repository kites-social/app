import { AtpAgent } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import {
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

import { PLC_DIRECTORY_URL } from "./atproto-urls";

export const WALLET_LINK_COLLECTION = "social.kites.wallet.link";
export const WALLET_LINK_RKEY = "self";
export const WALLET_LINK_AUDIENCE = "social.kites.wallet.link";

const walletLinkDomain = {
  name: "Kites Wallet Link",
  version: "1",
  chainId: 1,
} as const;

const walletLinkTypes = {
  WalletLink: [
    { name: "did", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "audience", type: "string" },
  ],
} as const;

const didResolver = new IdResolver({
  timeout: 5_000,
  plcUrl: PLC_DIRECTORY_URL,
});

/** Reads and verifies the wallet address published in a DID's ATProto repo. */
export async function resolveAtprotoWalletAddress(
  did: string,
): Promise<Address | null> {
  const identity = await didResolver.did.resolveAtprotoData(did);
  const agent = new AtpAgent({ service: identity.pds });

  let value: unknown;
  try {
    const result = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: WALLET_LINK_COLLECTION,
      rkey: WALLET_LINK_RKEY,
    });
    value = result.data.value;
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }

  const proof = parseWalletLink(value, did);
  if (!proof) return null;

  try {
    const recoveredAddress = await recoverTypedDataAddress({
      domain: walletLinkDomain,
      types: walletLinkTypes,
      primaryType: "WalletLink",
      message: {
        did: proof.did,
        address: proof.address,
        nonce: proof.nonce,
        issuedAt: BigInt(proof.issuedAt),
        audience: proof.audience,
      },
      signature: proof.signature,
    });
    return recoveredAddress.toLowerCase() === proof.address.toLowerCase()
      ? proof.address
      : null;
  } catch {
    return null;
  }
}

interface ParsedWalletLinkProof {
  did: string;
  address: Address;
  nonce: Hex;
  issuedAt: number;
  audience: typeof WALLET_LINK_AUDIENCE;
  signature: Hex;
}

function parseWalletLink(
  value: unknown,
  did: string,
): ParsedWalletLinkProof | null {
  if (
    !isRecord(value) ||
    value.$type !== WALLET_LINK_COLLECTION ||
    value.version !== 1 ||
    typeof value.address !== "string" ||
    !isAddress(value.address) ||
    !isRecord(value.proof)
  ) {
    return null;
  }

  const proof = value.proof;
  if (
    proof.did !== did ||
    typeof proof.address !== "string" ||
    !isAddress(proof.address) ||
    proof.address.toLowerCase() !== value.address.toLowerCase() ||
    typeof proof.nonce !== "string" ||
    !/^0x[\da-fA-F]{64}$/.test(proof.nonce) ||
    typeof proof.issuedAt !== "number" ||
    !Number.isSafeInteger(proof.issuedAt) ||
    proof.audience !== WALLET_LINK_AUDIENCE ||
    typeof proof.signature !== "string" ||
    !/^0x[\da-fA-F]{130}$/.test(proof.signature)
  ) {
    return null;
  }

  return {
    did,
    address: getAddress(value.address),
    nonce: proof.nonce as Hex,
    issuedAt: proof.issuedAt,
    audience: WALLET_LINK_AUDIENCE,
    signature: proof.signature as Hex,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordNotFound(error: unknown) {
  return (
    isRecord(error) &&
    (error.error === "RecordNotFound" ||
      error.status === 404 ||
      (isRecord(error.cause) && error.cause.status === 404))
  );
}
