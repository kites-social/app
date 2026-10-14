import { getRandomBytes } from "expo-crypto";
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, toBytes, type Address } from "viem";

import {
  getPerplApiCredentials,
  hasPerplApiCredentials,
} from "./api-credentials";
import { logPerplPositions } from "./logging";
import { PERPL_NETWORKS } from "./network";

export interface PerplAccount {
  id: number;
  balance: string;
  lockedBalance: string;
  frozen: boolean;
  allowsForwarding: boolean;
  lastForwardedRequestId?: number;
}

export interface PerplAccountSummary {
  address: string;
  accounts: PerplAccount[];
  snapshotBlock?: number;
}

export interface PerplOpenPosition {
  id: number;
  accountId: number;
  marketId: number;
  requestId?: number;
  side: "Long" | "Short";
  collateral: string;
  entryPrice: number;
  entryPriceRemainder?: number;
  size: number;
  leverage: number;
}

export class PerplCredentialsMissingError extends Error {
  constructor() {
    super("Enable Perpl API access to view account details.");
    this.name = "PerplCredentialsMissingError";
  }
}

export class PerplExchangeAccountMissingError extends Error {
  constructor() {
    super("No Perpl exchange account exists for this wallet yet.");
    this.name = "PerplExchangeAccountMissingError";
  }
}

export async function fetchPerplAccountSummary(
  walletAddress: Address,
): Promise<PerplAccountSummary> {
  if (!(await hasPerplApiCredentials(walletAddress))) {
    throw new PerplCredentialsMissingError();
  }

  const response = await signedPerplRequest(
    walletAddress,
    "GET",
    "/v1/trading/wallet",
  );
  if (response.status === 404) {
    throw new PerplExchangeAccountMissingError();
  }
  if (!response.ok) {
    throw new Error(
      `Unable to load Perpl account details (${response.status}).`,
    );
  }

  const data: unknown = await readJson(response, "account details");
  return parseAccountSummary(data);
}

export async function fetchPerplOpenPositions(
  walletAddress: Address,
): Promise<PerplOpenPosition[]> {
  if (!(await hasPerplApiCredentials(walletAddress))) {
    logPerplPositions("credentials_missing");
    throw new PerplCredentialsMissingError();
  }
  logPerplPositions("request_started", {
    chainId: PERPL_NETWORKS.testnet.chainId,
    endpoint: "/v1/trading/positions",
  });
  let response: Response;
  try {
    response = await signedPerplRequest(
      walletAddress,
      "GET",
      "/v1/trading/positions",
    );
  } catch (cause) {
    logPerplPositions("request_failed", { stage: "transport" });
    throw cause;
  }
  if (!response.ok) {
    logPerplPositions("request_failed", { status: response.status });
    throw new Error(`Unable to load Perpl positions (${response.status}).`);
  }
  let value: unknown;
  try {
    value = await readJson(response, "positions");
  } catch (cause) {
    logPerplPositions("response_invalid_json");
    throw cause;
  }
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.d)
      ? value.d
      : null;
  if (!rows) {
    logPerplPositions("response_invalid_shape", {
      rootType: Array.isArray(value) ? "array" : typeof value,
      rootKeys: isRecord(value) ? Object.keys(value) : [],
    });
    throw new Error("Perpl returned invalid position data.");
  }

  const invalidRows: Record<string, number> = {};
  const positions: PerplOpenPosition[] = [];
  for (const row of rows) {
    const invalidReason = getInvalidPositionReason(row);
    if (invalidReason) {
      invalidRows[invalidReason] = (invalidRows[invalidReason] ?? 0) + 1;
      continue;
    }
    if (!isRecord(row)) continue;
    positions.push({
      id: row.pid as number,
      accountId: row.acc as number,
      marketId: row.mkt as number,
      ...(typeof row.rq === "number" && Number.isSafeInteger(row.rq)
        ? { requestId: row.rq }
        : {}),
      side: row.sd === 1 ? "Long" : "Short",
      collateral: row.c as string,
      entryPrice: row.ep as number,
      ...(typeof row.epr === "number" && Number.isFinite(row.epr)
        ? { entryPriceRemainder: row.epr }
        : {}),
      size: row.s as number,
      leverage: (row.lv as number) / 100,
    });
  }

  const snapshotType = isRecord(value) ? value.mt : undefined;
  const snapshotBlock = isRecord(value) ? value.sn : undefined;
  logPerplPositions("response_parsed", {
    snapshotType,
    snapshotBlock,
    rowCount: rows.length,
    positionCount: positions.length,
    positionReferences: positions.map(({ id, marketId, requestId }) => ({
      positionId: id,
      marketId,
      requestId,
    })),
    invalidRows,
  });
  if (Object.keys(invalidRows).length > 0) {
    throw new Error("Perpl returned position data in an unsupported format.");
  }
  return positions;
}

export async function signedPerplRequest(
  walletAddress: Address,
  method: "GET" | "POST",
  target: string,
  payload?: Record<string, unknown>,
) {
  const credentials = await getPerplApiCredentials(walletAddress);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const nonce = encodeBase64Url(getRandomBytes(16));
  const bodyHash = bytesToHex(sha256(toBytes(body)));
  const canonical = [
    PERPL_NETWORKS.testnet.chainId,
    method,
    target,
    timestamp,
    nonce,
    bodyHash.slice(2),
  ].join("\n");
  const signature = await ed.signAsync(
    toBytes(canonical),
    hexToBytes(credentials.privateKey),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${PERPL_NETWORKS.testnet.apiUrl}${target}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        "X-API-Key": credentials.apiKey,
        "X-API-Timestamp": timestamp,
        "X-API-Nonce": nonce,
        "X-API-Signature": encodeBase64Url(signature),
      },
      ...(payload === undefined ? {} : { body }),
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`Perpl request timed out (${method} ${target}).`);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

function parseAccountSummary(value: unknown): PerplAccountSummary {
  if (
    !isRecord(value) ||
    typeof value.addr !== "string" ||
    !Array.isArray(value.as)
  ) {
    throw new Error("Perpl returned invalid account details.");
  }
  return {
    address: value.addr,
    accounts: value.as.map(parseAccount),
    ...(typeof value.sn === "number" && Number.isSafeInteger(value.sn)
      ? { snapshotBlock: value.sn }
      : {}),
  };
}

function parseAccount(value: unknown): PerplAccount {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.b !== "string" ||
    !/^-?\d+$/.test(value.b) ||
    typeof value.lb !== "string" ||
    !/^-?\d+$/.test(value.lb) ||
    typeof value.fr !== "boolean" ||
    typeof value.fw !== "boolean"
  ) {
    throw new Error("Perpl returned invalid exchange account data.");
  }
  return {
    id: value.id,
    balance: value.b,
    lockedBalance: value.lb,
    frozen: value.fr,
    allowsForwarding: value.fw,
    ...(typeof value.lfr === "number" &&
    Number.isFinite(value.lfr) &&
    value.lfr >= 0
      ? { lastForwardedRequestId: value.lfr }
      : {}),
  };
}

async function readJson(
  response: Response,
  responseName: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Perpl returned invalid ${responseName}.`);
  }
}

function getInvalidPositionReason(value: unknown): string | undefined {
  if (!isRecord(value)) return "row_not_object";
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid)) {
    return "invalid_position_id";
  }
  if (typeof value.acc !== "number" || !Number.isSafeInteger(value.acc)) {
    return "invalid_account_id";
  }
  if (typeof value.mkt !== "number" || !Number.isSafeInteger(value.mkt)) {
    return "invalid_market_id";
  }
  if (value.sd !== 1 && value.sd !== 2) return "invalid_side";
  if (typeof value.c !== "string") return "invalid_collateral";
  if (typeof value.ep !== "number") return "invalid_entry_price";
  if (typeof value.s !== "number") return "invalid_size";
  if (typeof value.lv !== "number") return "invalid_leverage";
  if (value.st !== undefined && value.st !== 1) return "position_not_open";
  return undefined;
}

function encodeBase64Url(bytes: Uint8Array) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    encoded +=
      second === undefined
        ? "="
        : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : alphabet[third & 0x3f];
  }
  return encoded.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
