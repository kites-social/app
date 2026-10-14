import * as SecureStore from "expo-secure-store";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import {
  getAddress,
  isHex,
  maxUint256,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

import {
  type VenueOnboardingContext,
  type VenueOnboardingProvider,
  type VenueOnboardingStep,
} from "@kites-social/venues";

import { getAppChain } from "~/lib/web3";

const CLOB_API = "https://clob.polymarket.com";
const CREDENTIALS_KEY_PREFIX = "polymarket.clob.credentials.v1.";
const PENDING_APPROVAL_KEY_PREFIX = "polymarket.approvals.transaction.v1.";
const COLLATERAL_SYNC_KEY_PREFIX = "polymarket.collateral-sync.v1.";
const PENDING_INITIAL_DEPOSIT_KEY_PREFIX =
  "polymarket.initial-deposit.transaction.v1.";
const PUSD = getAddress("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
const POSITION_MANAGER = getAddress(
  "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
);
const CONDITIONAL_TOKENS = getAddress(
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
);
const V2_EXCHANGE = getAddress("0xe3333700cA9d93003F00f0F71f8515005F6c00Aa");
const STANDARD_EXCHANGE = getAddress(
  "0xE111180000d2663C0091e4f400237545B87B996B",
);
const NEG_RISK_EXCHANGE = getAddress(
  "0xe2222d279d744050d28e00520010520000310F59",
);
const NEG_RISK_ADAPTER = getAddress(
  "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
);

const erc20ApprovalAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const erc1155ApprovalAbi = [
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface PolymarketApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

class InvalidStoredPolymarketCredentialsError extends Error {
  constructor() {
    super("Stored Polymarket credentials are invalid.");
    this.name = "InvalidStoredPolymarketCredentialsError";
  }
}

const credentialSetupRuns = new Map<string, Promise<void>>();

const initialDepositKey = (
  walletAddress: Address,
  depositWalletAddress: Address,
) =>
  `${PENDING_INITIAL_DEPOSIT_KEY_PREFIX}${getAddress(walletAddress).toLowerCase()}.${getAddress(depositWalletAddress).toLowerCase()}`;

export async function getPendingPolymarketInitialDepositTransaction(
  walletAddress: Address,
  depositWalletAddress: Address,
): Promise<Hash | null> {
  const key = initialDepositKey(walletAddress, depositWalletAddress);
  const value = await SecureStore.getItemAsync(key);
  if (!value) return null;
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    await SecureStore.deleteItemAsync(key);
    console.warn(
      "Discarded invalid Polymarket initial-deposit transaction hash.",
    );
    return null;
  }
  return value;
}

export function savePendingPolymarketInitialDepositTransaction(
  walletAddress: Address,
  depositWalletAddress: Address,
  hash: Hash,
) {
  return SecureStore.setItemAsync(
    initialDepositKey(walletAddress, depositWalletAddress),
    hash,
  );
}

export function clearPendingPolymarketInitialDepositTransaction(
  walletAddress: Address,
  depositWalletAddress: Address,
) {
  return SecureStore.deleteItemAsync(
    initialDepositKey(walletAddress, depositWalletAddress),
  );
}

const polymarketOnboarding: VenueOnboardingProvider = {
  getSteps: async ({ walletAddress, depositWalletAddress }) => {
    if (!walletAddress || !depositWalletAddress) {
      return [createAccountStep(await SecureStore.isAvailableAsync())];
    }

    const signer = getAddress(walletAddress);
    const secureStorageAvailable = await SecureStore.isAvailableAsync();
    const [hasCredentials, hasTradingApprovals, hasCollateralAllowanceSync] =
      await Promise.all([
        secureStorageAvailable && hasStoredCredentials(signer),
        hasPolymarketTradingApprovals(getAddress(depositWalletAddress)),
        secureStorageAvailable && hasCollateralAllowanceSynced(signer),
      ]);
    if (
      !hasCredentials ||
      !hasTradingApprovals ||
      !hasCollateralAllowanceSync
    ) {
      return [
        finishSetupStep(
          secureStorageAvailable,
          hasCredentials,
          hasTradingApprovals,
          hasCollateralAllowanceSync,
        ),
      ];
    }

    return [
      {
        id: "account-ready",
        title: "Polymarket account ready",
        description: "Your deposit wallet and trading permissions are set up.",
        kind: "action",
        status: "complete",
        chainId: polygon.id,
        chainName: polygon.name,
      },
      {
        id: "deposit",
        title: "Fund Polymarket",
        description: "Your Polymarket account is ready for a pUSD deposit.",
        kind: "deposit",
        status: "waiting",
        chainId: polygon.id,
        chainName: polygon.name,
        actionLabel: "Deposit",
      },
    ];
  },
  runStep: async (stepId, context) => {
    if (!context.walletAddress) {
      throw new Error("Create or unlock your Kites wallet before continuing.");
    }
    const signer = getAddress(context.walletAddress);

    if (stepId !== "clob-authentication") {
      throw new Error(`Unknown Polymarket onboarding step: ${stepId}`);
    }
    const key = credentialsKey(signer);
    const existingRun = credentialSetupRuns.get(key);
    if (existingRun) return existingRun;

    const run = (async () => {
      if (await hasStoredCredentials(signer, true)) return;
      if (!context.signTypedData) {
        throw new Error("Unlock your passkey to enable Polymarket trading.");
      }
      if (!(await SecureStore.isAvailableAsync())) {
        throw new Error(
          "Secure credential storage is unavailable on this device.",
        );
      }

      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await context.signTypedData({
        domain: {
          name: "ClobAuthDomain",
          version: "1",
          chainId: polygon.id,
        },
        types: {
          ClobAuth: [
            { name: "address", type: "address" },
            { name: "timestamp", type: "string" },
            { name: "nonce", type: "uint256" },
            { name: "message", type: "string" },
          ],
        },
        primaryType: "ClobAuth",
        message: {
          address: signer,
          timestamp,
          nonce: BigInt(0),
          message: "This message attests that I control the given wallet",
        },
      });
      const headers = {
        POLY_ADDRESS: signer,
        POLY_SIGNATURE: signature,
        POLY_TIMESTAMP: timestamp,
        POLY_NONCE: "0",
      };
      const deriveResponse = await fetch(`${CLOB_API}/auth/derive-api-key`, {
        headers,
      });
      const credentials =
        deriveResponse.ok ||
        (deriveResponse.status !== 400 && deriveResponse.status !== 404)
          ? await readCredentials(deriveResponse)
          : await createClobCredentials(headers);
      await SecureStore.setItemAsync(key, JSON.stringify(credentials));
    })().finally(() => {
      if (credentialSetupRuns.get(key) === run) {
        credentialSetupRuns.delete(key);
      }
    });
    credentialSetupRuns.set(key, run);
    return run;
  },
};

async function hasStoredCredentials(
  walletAddress: Address,
  clearInvalid = false,
) {
  const key = credentialsKey(walletAddress);
  const value = await SecureStore.getItemAsync(key);
  if (!value) return false;
  try {
    parseStoredCredentials(value);
    return true;
  } catch (error) {
    if (!(error instanceof InvalidStoredPolymarketCredentialsError)) {
      throw error;
    }
    if (clearInvalid) {
      if ((await SecureStore.getItemAsync(key)) === value) {
        await SecureStore.deleteItemAsync(key);
      }
      console.warn("Discarded invalid stored Polymarket credentials.");
    }
    return false;
  }
}

async function createClobCredentials(
  headers: Record<string, string>,
): Promise<PolymarketApiCredentials> {
  const response = await fetch(`${CLOB_API}/auth/api-key`, {
    method: "POST",
    headers,
  });
  return readCredentials(response);
}

async function readCredentials(
  response: Response,
): Promise<PolymarketApiCredentials> {
  if (!response.ok) {
    throw new Error(`Polymarket authentication failed (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!isClobCredentials(body) || !isValidBase64Secret(body.secret)) {
    throw new Error("Polymarket returned invalid API credentials.");
  }
  return body;
}

function isClobCredentials(value: unknown): value is PolymarketApiCredentials {
  return (
    typeof value === "object" &&
    value !== null &&
    "apiKey" in value &&
    typeof value.apiKey === "string" &&
    value.apiKey.length > 0 &&
    "secret" in value &&
    typeof value.secret === "string" &&
    value.secret.length > 0 &&
    "passphrase" in value &&
    typeof value.passphrase === "string" &&
    value.passphrase.length > 0
  );
}

function credentialsKey(walletAddress: Address) {
  return `${CREDENTIALS_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

export async function getPolymarketApiCredentials(
  walletAddress: Address,
): Promise<PolymarketApiCredentials> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure Polymarket credential storage is unavailable.");
  }
  const value = await SecureStore.getItemAsync(credentialsKey(walletAddress));
  if (!value) {
    throw new Error("Enable Polymarket trading before placing an order.");
  }
  return parseStoredCredentials(value);
}

export async function getOrRefreshPolymarketApiCredentials(
  walletAddress: Address,
  signTypedData?: VenueOnboardingContext["signTypedData"],
) {
  try {
    return await getPolymarketApiCredentials(walletAddress);
  } catch (error) {
    if (
      !(error instanceof InvalidStoredPolymarketCredentialsError) ||
      !signTypedData
    ) {
      throw error;
    }
    await polymarketOnboarding.runStep("clob-authentication", {
      walletAddress: getAddress(walletAddress),
      signTypedData,
    });
    return getPolymarketApiCredentials(walletAddress);
  }
}

export function createPolymarketL2Signature(secret: string, message: string) {
  const digest = hmac(sha256, decodeBase64(secret), message);
  return encodeBase64(digest).replace(/\+/g, "-").replace(/\//g, "_");
}

export async function syncPolymarketCollateralAllowance(
  walletAddress: Address,
  signTypedData?: VenueOnboardingContext["signTypedData"],
) {
  await syncPolymarketAllowance(
    walletAddress,
    "COLLATERAL",
    undefined,
    signTypedData,
  );
}

export async function syncPolymarketConditionalAllowance(
  walletAddress: Address,
  tokenId: string,
  positionSystem: "ctf" | "protocol-v2",
  signTypedData?: VenueOnboardingContext["signTypedData"],
) {
  if (!/^\d+$/.test(tokenId)) {
    throw new Error("Polymarket returned an invalid outcome token.");
  }
  await syncPolymarketAllowance(
    walletAddress,
    positionSystem === "protocol-v2" ? "CONDITIONAL-V2" : "CONDITIONAL",
    tokenId,
    signTypedData,
  );
}

async function syncPolymarketAllowance(
  walletAddress: Address,
  assetType: "COLLATERAL" | "CONDITIONAL" | "CONDITIONAL-V2",
  tokenId?: string,
  signTypedData?: VenueOnboardingContext["signTypedData"],
) {
  const signer = getAddress(walletAddress);
  const credentials = await getOrRefreshPolymarketApiCredentials(
    signer,
    signTypedData,
  );
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const path = "/balance-allowance/update";
  const url = new URL(`${CLOB_API}${path}`);
  url.searchParams.set("asset_type", assetType);
  if (tokenId) url.searchParams.set("token_id", tokenId);
  url.searchParams.set("signature_type", "3");

  const response = await fetch(url, {
    headers: {
      POLY_ADDRESS: signer,
      POLY_SIGNATURE: createPolymarketL2Signature(
        credentials.secret,
        `${timestamp}GET${path}`,
      ),
      POLY_TIMESTAMP: timestamp,
      POLY_API_KEY: credentials.apiKey,
      POLY_PASSPHRASE: credentials.passphrase,
    },
  });
  if (!response.ok) {
    throw new Error(`Polymarket allowance sync failed (${response.status}).`);
  }
  if (assetType === "COLLATERAL") {
    await SecureStore.setItemAsync(collateralSyncKey(signer), "true");
  }
}

async function hasCollateralAllowanceSynced(walletAddress: Address) {
  return (
    (await SecureStore.getItemAsync(collateralSyncKey(walletAddress))) ===
    "true"
  );
}

export async function getPendingPolymarketApprovalTransaction(
  walletAddress: Address,
) {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure Polymarket setup storage is unavailable.");
  }
  return SecureStore.getItemAsync(pendingApprovalKey(walletAddress));
}

export async function savePendingPolymarketApprovalTransaction(
  walletAddress: Address,
  transactionID: string,
) {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure Polymarket setup storage is unavailable.");
  }
  await SecureStore.setItemAsync(
    pendingApprovalKey(walletAddress),
    transactionID,
  );
}

export async function clearPendingPolymarketApprovalTransaction(
  walletAddress: Address,
) {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure Polymarket setup storage is unavailable.");
  }
  await SecureStore.deleteItemAsync(pendingApprovalKey(walletAddress));
}

export function createPolymarketApprovalTypedData(input: {
  depositWalletAddress: Address;
  nonce: string;
  deadline: string;
  calls: {
    target: Address;
    value: string;
    data: Hex;
  }[];
}) {
  return {
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: polygon.id,
      verifyingContract: getAddress(input.depositWalletAddress),
    },
    types: {
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      Batch: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "calls", type: "Call[]" },
      ],
    },
    primaryType: "Batch",
    message: {
      wallet: getAddress(input.depositWalletAddress),
      nonce: BigInt(input.nonce),
      deadline: BigInt(input.deadline),
      calls: input.calls.map((call) => ({
        target: getAddress(call.target),
        value: BigInt(call.value),
        data: call.data,
      })),
    },
  } as const;
}

export async function hasPolymarketTradingApprovals(walletAddress: Address) {
  const client = getAppChain(polygon.id).publicClient;
  const wallet = getAddress(walletAddress);
  const [
    v2Allowance,
    standardAllowance,
    negRiskAllowance,
    v2PositionApproval,
    standardPositionApproval,
    negRiskPositionApproval,
    negRiskAdapterAllowance,
    negRiskAdapterPositionApproval,
  ] = await client.multicall({
    contracts: [
      {
        address: PUSD,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, V2_EXCHANGE],
      },
      {
        address: PUSD,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, STANDARD_EXCHANGE],
      },
      {
        address: PUSD,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, NEG_RISK_EXCHANGE],
      },
      {
        address: POSITION_MANAGER,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, V2_EXCHANGE],
      },
      {
        address: CONDITIONAL_TOKENS,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, STANDARD_EXCHANGE],
      },
      {
        address: CONDITIONAL_TOKENS,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, NEG_RISK_EXCHANGE],
      },
      {
        address: PUSD,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, NEG_RISK_ADAPTER],
      },
      {
        address: CONDITIONAL_TOKENS,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, NEG_RISK_ADAPTER],
      },
    ] as const,
    allowFailure: false,
  });
  return (
    v2Allowance >= maxUint256 &&
    standardAllowance >= maxUint256 &&
    negRiskAllowance >= maxUint256 &&
    v2PositionApproval &&
    standardPositionApproval &&
    negRiskPositionApproval &&
    negRiskAdapterAllowance >= maxUint256 &&
    negRiskAdapterPositionApproval
  );
}

function parseStoredCredentials(value: string): PolymarketApiCredentials {
  let credentials: unknown;
  try {
    credentials = JSON.parse(value);
  } catch {
    throw new InvalidStoredPolymarketCredentialsError();
  }
  if (
    !isClobCredentials(credentials) ||
    !isValidBase64Secret(credentials.secret)
  ) {
    throw new InvalidStoredPolymarketCredentialsError();
  }
  return credentials;
}

function isValidBase64Secret(value: string) {
  try {
    return decodeBase64(value).length > 0;
  } catch (error) {
    if (error instanceof InvalidStoredPolymarketCredentialsError) return false;
    throw error;
  }
}

function createAccountStep(
  secureStorageAvailable: boolean,
): VenueOnboardingStep {
  return {
    id: "create-account",
    title: "Create your Polymarket account",
    description: secureStorageAvailable
      ? "Set up your Polymarket wallet, then deposit."
      : "Secure credential storage is unavailable on this device, so a Polymarket account cannot be set up here.",
    kind: "action",
    status: secureStorageAvailable ? "action-required" : "blocked",
    chainId: polygon.id,
    chainName: polygon.name,
    actionLabel: secureStorageAvailable ? "Create account" : undefined,
  };
}

function finishSetupStep(
  secureStorageAvailable: boolean,
  hasCredentials: boolean,
  hasTradingApprovals: boolean,
  hasCollateralAllowanceSync: boolean,
): VenueOnboardingStep {
  const missing: string[] = [];
  if (!hasCredentials) missing.push("trading access");
  if (!hasTradingApprovals) missing.push("trading approvals");
  if (!hasCollateralAllowanceSync) missing.push("allowance sync");
  return {
    id: "finish-setup",
    title: "Finish Polymarket setup",
    description: secureStorageAvailable
      ? `Complete ${missing.join(" and ")}. Missing trading approvals grant Polymarket's trading contracts maximum pUSD allowance and outcome-token access; no funds move until you deposit.`
      : "Secure credential storage is unavailable on this device.",
    kind: "action",
    status: secureStorageAvailable ? "action-required" : "blocked",
    chainId: polygon.id,
    chainName: polygon.name,
    actionLabel: secureStorageAvailable ? "Finish setup" : undefined,
  };
}

function pendingApprovalKey(walletAddress: Address) {
  return `${PENDING_APPROVAL_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

function collateralSyncKey(walletAddress: Address) {
  return `${COLLATERAL_SYNC_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

function decodeBase64(value: string) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = /=+$/.exec(base64)?.[0].length ?? 0;
  const normalized = padding ? base64.slice(0, -padding) : base64;
  if (
    !normalized ||
    padding > 2 ||
    !/^[A-Za-z0-9+/]+$/.test(normalized) ||
    normalized.length % 4 === 1 ||
    (padding > 0 &&
      (base64.length % 4 !== 0 ||
        padding !== (4 - (normalized.length % 4)) % 4))
  ) {
    throw new InvalidStoredPolymarketCredentialsError();
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) {
      throw new InvalidStoredPolymarketCredentialsError();
    }
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) {
    throw new InvalidStoredPolymarketCredentialsError();
  }
  return Uint8Array.from(bytes);
}

function encodeBase64(bytes: Uint8Array) {
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
  return encoded;
}

export { polymarketOnboarding };
