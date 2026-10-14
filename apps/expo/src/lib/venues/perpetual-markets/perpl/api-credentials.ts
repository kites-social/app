import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  getAddress,
  hashTypedData,
  hexToBytes,
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDefinition,
  type TypedDataDomain,
} from "viem";

import { PERPL_NETWORKS, PERPL_ORIGIN, type PerplNetwork } from "./network";

const SCOPE_MASK = 3;
const CREDENTIALS_KEY_PREFIX = "perpl.api-credentials.v1.";

ed.hashes.sha512Async = (message) =>
  Promise.resolve(new Uint8Array(sha512(message)));

export interface PerplApiCredentials {
  apiKey: string;
  privateKey: Hex;
}

interface ApiKeyPayload {
  typed_data: unknown;
  mac: string;
}

interface SigningTypedData {
  domain: TypedDataDomain;
  types: TypedData;
  primaryType: string;
  message: Record<string, unknown>;
}

export async function hasPerplApiCredentials(
  walletAddress: Address,
  network: PerplNetwork = "testnet",
) {
  return (await readStoredCredentials(walletAddress, network)) !== null;
}

export async function getPerplApiCredentials(
  walletAddress: Address,
  network: PerplNetwork = "testnet",
): Promise<PerplApiCredentials> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure Perpl credential storage is unavailable.");
  }
  const credentials = await readStoredCredentials(walletAddress, network);
  if (!credentials) {
    throw new Error("Enable Perpl API access before using account features.");
  }
  return credentials;
}

export async function enrollPerplApiKey(
  walletAddress: Address,
  signTypedData: (request: TypedDataDefinition<TypedData>) => Promise<Hex>,
  network: PerplNetwork = "testnet",
) {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure credential storage is unavailable on this device.");
  }
  if (await hasPerplApiCredentials(walletAddress, network)) {
    throw new Error("Perpl API access is already enabled for this wallet.");
  }

  const networkConfig = PERPL_NETWORKS[network];
  const address = getAddress(walletAddress);
  const privateKey = getRandomBytes(32);
  try {
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const payloadRequest = {
      chain_id: networkConfig.chainId,
      address,
      public_key: bytesToHex(publicKey),
      scope_mask: SCOPE_MASK,
      label: "Kites in-app trading",
    };
    const payload = parsePayload(
      await postJson(
        networkConfig.apiUrl,
        "/v1/api-key/payload",
        payloadRequest,
        "request",
      ),
    );
    const signingData = parseSigningTypedData(payload.typed_data);
    const signature = await signTypedData(signingData);
    const digest = hexToBytes(hashTypedData(signingData));
    const proofOfPossession = await ed.signAsync(digest, privateKey);

    const enrolled = parseEnrollment(
      await postJson(
        networkConfig.apiUrl,
        "/v1/api-key/enroll",
        {
          chain_id: networkConfig.chainId,
          address,
          typed_data: payload.typed_data,
          mac: payload.mac,
          signature,
          pop_signature: bytesToHex(proofOfPossession),
        },
        "enrollment",
      ),
    );

    await SecureStore.setItemAsync(
      credentialsKey(address, network),
      JSON.stringify({
        apiKey: enrolled.api_key,
        privateKey: bytesToHex(privateKey),
      } satisfies PerplApiCredentials),
    );
  } finally {
    privateKey.fill(0);
  }
}

async function postJson(
  apiUrl: string,
  path: string,
  body: Record<string, unknown>,
  operation: "request" | "enrollment",
): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PERPL_ORIGIN,
    },
    body: JSON.stringify(body),
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = undefined;
  }

  if (!response.ok) {
    const originHint =
      response.status === 401 || response.status === 403
        ? ` Confirm that Perpl accepts the Origin ${PERPL_ORIGIN}.`
        : "";
    throw new Error(
      `Perpl API-key ${operation} failed (${response.status}).${originHint}`,
    );
  }
  if (responseBody === undefined) {
    throw new Error(`Perpl returned invalid API-key ${operation} data.`);
  }
  return responseBody;
}

function parsePayload(value: unknown): ApiKeyPayload {
  if (
    !isRecord(value) ||
    !("typed_data" in value) ||
    !isRecord(value.typed_data) ||
    typeof value.mac !== "string" ||
    value.mac.length === 0
  ) {
    throw new Error("Perpl returned an invalid API-key signing payload.");
  }
  return {
    typed_data: value.typed_data,
    mac: value.mac,
  };
}

function parseSigningTypedData(value: unknown): SigningTypedData {
  if (
    !isRecord(value) ||
    !isRecord(value.domain) ||
    !isRecord(value.types) ||
    typeof value.primaryType !== "string" ||
    !isRecord(value.message)
  ) {
    throw new Error("Perpl returned invalid EIP-712 signing data.");
  }

  const domain = parseDomain(value.domain);
  const parsedTypes: Record<string, { name: string; type: string }[]> = {};
  for (const [typeName, fields] of Object.entries(value.types)) {
    if (!Array.isArray(fields)) {
      throw new Error("Perpl returned invalid EIP-712 type definitions.");
    }
    parsedTypes[typeName] = fields.map((field) => {
      if (
        !isRecord(field) ||
        typeof field.name !== "string" ||
        typeof field.type !== "string"
      ) {
        throw new Error("Perpl returned invalid EIP-712 type definitions.");
      }
      return { name: field.name, type: field.type };
    });
  }

  const { EIP712Domain: _domainType, ...signingTypes } = parsedTypes;
  if (!signingTypes[value.primaryType]) {
    throw new Error("Perpl returned an unsupported EIP-712 primary type.");
  }
  return {
    domain,
    types: signingTypes as unknown as TypedData,
    primaryType: value.primaryType,
    message: value.message,
  };
}

function parseDomain(value: Record<string, unknown>): TypedDataDomain {
  const domain: TypedDataDomain = {};
  if (value.name !== undefined) {
    if (typeof value.name !== "string") {
      throw new Error("Perpl returned an invalid EIP-712 domain.");
    }
    domain.name = value.name;
  }
  if (value.version !== undefined) {
    if (typeof value.version !== "string") {
      throw new Error("Perpl returned an invalid EIP-712 domain.");
    }
    domain.version = value.version;
  }
  if (value.chainId !== undefined) {
    domain.chainId = parseDomainChainId(value.chainId);
  }
  if (value.verifyingContract !== undefined) {
    if (typeof value.verifyingContract !== "string") {
      throw new Error("Perpl returned an invalid EIP-712 domain.");
    }
    domain.verifyingContract = value.verifyingContract as Address;
  }
  if (value.salt !== undefined) {
    if (typeof value.salt !== "string") {
      throw new Error("Perpl returned an invalid EIP-712 domain.");
    }
    domain.salt = value.salt as Hex;
  }
  if (
    Object.keys(value).some(
      (key) =>
        key !== "name" &&
        key !== "version" &&
        key !== "chainId" &&
        key !== "verifyingContract" &&
        key !== "salt",
    )
  ) {
    throw new Error("Perpl returned an unsupported EIP-712 domain.");
  }
  return domain;
}

function parseDomainChainId(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (
    typeof value === "string" &&
    (/^0x[0-9a-fA-F]+$/.test(value) || /^[0-9]+$/.test(value))
  ) {
    return BigInt(value);
  }
  throw new Error("Perpl returned an invalid EIP-712 domain.");
}

function parseEnrollment(value: unknown): { api_key: string } {
  const apiKeyInfo =
    isRecord(value) && isRecord(value.api_key) ? value.api_key : undefined;
  const apiKey =
    isRecord(value) && typeof value.api_key === "string"
      ? value.api_key
      : apiKeyInfo?.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      "Perpl enrollment response did not contain an API key identifier.",
    );
  }
  return { api_key: apiKey };
}

async function readStoredCredentials(
  walletAddress: Address,
  network: PerplNetwork,
) {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure Perpl credential storage is unavailable.");
  }
  const value = await SecureStore.getItemAsync(
    credentialsKey(walletAddress, network),
  );
  if (!value) return null;

  let credentials: unknown;
  try {
    credentials = JSON.parse(value);
  } catch {
    throw new Error("Stored Perpl credentials are invalid.");
  }
  if (
    !isRecord(credentials) ||
    typeof credentials.apiKey !== "string" ||
    credentials.apiKey.length === 0 ||
    typeof credentials.privateKey !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(credentials.privateKey)
  ) {
    throw new Error("Stored Perpl credentials are invalid.");
  }
  return {
    apiKey: credentials.apiKey,
    privateKey: credentials.privateKey as Hex,
  };
}

function credentialsKey(walletAddress: Address, network: PerplNetwork) {
  const suffix = walletAddress.toLowerCase();
  return `${CREDENTIALS_KEY_PREFIX}${network}.${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
