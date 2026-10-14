import { getRandomBytes } from "expo-crypto";
import { AtpAgent } from "@atproto/api";
import {
  bytesToHex,
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";

import { resolvePdsFromDid } from "~/lib/utils/resolve-pds";

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

export interface WalletLinkProof {
  did: string;
  address: Address;
  nonce: Hex;
  issuedAt: number;
  audience: typeof WALLET_LINK_AUDIENCE;
  signature: Hex;
}

export interface PublicWalletLink {
  /** AT Protocol record revision, used for compare-and-swap updates. */
  cid: string;
  address: Address;
  proof: WalletLinkProof;
  createdAt: string;
}

type ParsedPublicWalletLink = Omit<PublicWalletLink, "cid">;

export async function createWalletLinkProof(
  account: LocalAccount<"mera">,
  did: string,
): Promise<WalletLinkProof> {
  const address = getAddress(account.address);
  const nonce = bytesToHex(getRandomBytes(32));
  const issuedAt = Math.floor(Date.now() / 1_000);
  const audience = WALLET_LINK_AUDIENCE;
  const signature = await account.signTypedData({
    domain: walletLinkDomain,
    types: walletLinkTypes,
    primaryType: "WalletLink",
    message: {
      did,
      address,
      nonce,
      issuedAt: BigInt(issuedAt),
      audience,
    },
  });
  return { did, address, nonce, issuedAt, audience, signature };
}

export async function resolvePublicWalletLink(
  agent: AtpAgent,
  did: string,
): Promise<PublicWalletLink | null> {
  const recordAgent =
    agent.session?.did === did
      ? agent
      : new AtpAgent({ service: await resolvePdsFromDid(did) });
  let value: unknown;
  let recordCid: string | undefined;
  try {
    const result = await recordAgent.com.atproto.repo.getRecord({
      repo: did,
      collection: WALLET_LINK_COLLECTION,
      rkey: WALLET_LINK_RKEY,
    });
    value = result.data.value;
    recordCid = result.data.cid;
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }

  const parsed = parseWalletLink(value, did);
  if (!parsed) return null;
  let recoveredAddress: Address;
  try {
    recoveredAddress = await recoverTypedDataAddress({
      domain: walletLinkDomain,
      types: walletLinkTypes,
      primaryType: "WalletLink",
      message: {
        did: parsed.proof.did,
        address: parsed.proof.address,
        nonce: parsed.proof.nonce,
        issuedAt: BigInt(parsed.proof.issuedAt),
        audience: parsed.proof.audience,
      },
      signature: parsed.proof.signature,
    });
  } catch {
    return null;
  }
  if (recoveredAddress.toLowerCase() !== parsed.address.toLowerCase()) {
    return null;
  }
  if (!recordCid) return null;
  return { ...parsed, cid: recordCid };
}

export async function publishPublicWalletLink(
  agent: AtpAgent,
  did: string,
  proof: WalletLinkProof,
  options?: { swapRecord?: string; createdAt?: string },
): Promise<string> {
  const record = {
    $type: WALLET_LINK_COLLECTION,
    version: 1,
    address: proof.address,
    createdAt:
      options?.createdAt ?? new Date(proof.issuedAt * 1_000).toISOString(),
    proof,
  };
  const result = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: WALLET_LINK_COLLECTION,
    rkey: WALLET_LINK_RKEY,
    record: record as never,
    ...(options?.swapRecord ? { swapRecord: options.swapRecord } : {}),
  });
  return result.data.cid;
}

export async function deletePublicWalletLinkIfMatches(
  agent: AtpAgent,
  did: string,
  expectedProof: WalletLinkProof,
): Promise<boolean> {
  const recordAgent =
    agent.session?.did === did
      ? agent
      : new AtpAgent({ service: await resolvePdsFromDid(did) });
  let value: unknown;
  let cid: string | undefined;
  try {
    const result = await recordAgent.com.atproto.repo.getRecord({
      repo: did,
      collection: WALLET_LINK_COLLECTION,
      rkey: WALLET_LINK_RKEY,
    });
    value = result.data.value;
    cid = result.data.cid;
  } catch (error) {
    if (isRecordNotFound(error)) return true;
    throw error;
  }

  const current = parseWalletLink(value, did);
  if (
    !cid ||
    !current ||
    current.address.toLowerCase() !== expectedProof.address.toLowerCase() ||
    current.proof.did !== expectedProof.did ||
    current.proof.address.toLowerCase() !==
      expectedProof.address.toLowerCase() ||
    current.proof.nonce.toLowerCase() !== expectedProof.nonce.toLowerCase() ||
    current.proof.issuedAt !== expectedProof.issuedAt ||
    current.proof.audience !== expectedProof.audience ||
    current.proof.signature.toLowerCase() !==
      expectedProof.signature.toLowerCase()
  ) {
    return false;
  }

  await recordAgent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: WALLET_LINK_COLLECTION,
    rkey: WALLET_LINK_RKEY,
    swapRecord: cid,
  });
  return true;
}

function parseWalletLink(
  value: unknown,
  did: string,
): ParsedPublicWalletLink | null {
  if (!isRecord(value) || value.$type !== WALLET_LINK_COLLECTION) return null;
  if (value.version !== 1 || typeof value.createdAt !== "string") return null;
  if (typeof value.address !== "string" || !isAddress(value.address)) {
    return null;
  }
  if (!isRecord(value.proof)) return null;
  const proof = value.proof;
  if (
    proof.did !== did ||
    typeof proof.address !== "string" ||
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
  if (!isAddress(proof.address)) return null;
  return {
    address: getAddress(value.address),
    createdAt: value.createdAt,
    proof: {
      did,
      address: getAddress(proof.address),
      nonce: proof.nonce as Hex,
      issuedAt: proof.issuedAt,
      audience: WALLET_LINK_AUDIENCE,
      signature: proof.signature as Hex,
    },
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
