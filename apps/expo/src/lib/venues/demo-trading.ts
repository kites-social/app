import {
  getAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";

/**
 * Development-only Mera-shaped signing stub. Its signatures and serialized
 * transactions are deliberately invalid and must never be broadcast.
 */
export type DemoMeraAccount = Pick<
  LocalAccount<"mera">,
  "address" | "signMessage" | "signTransaction" | "signTypedData"
>;

const DEMO_ADDRESS = getAddress("0x000000000000000000000000000000000000dEaD");
const DEMO_DELAY_MS = 300;
let sequence = 0;

export type DemoTradeVenue =
  | "hyperliquid-perpetuals"
  | "hyperliquid-outcomes"
  | "perpl"
  | "polymarket";

export const DEMO_TRADE_VENUE_NAMES: Record<DemoTradeVenue, string> = {
  "hyperliquid-perpetuals": "Hyperliquid Perpetuals",
  "hyperliquid-outcomes": "Hyperliquid Outcomes",
  perpl: "Perpl",
  polymarket: "Polymarket",
};

export const DEMO_TRADING_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_DEMO_TRADING !== "0";

export interface DemoTradeIntent {
  venue: DemoTradeVenue;
  marketType: "prediction" | "perpetual";
  marketId: string;
  side: "buy" | "sell";
  amount: string;
  outcome?: "yes" | "no";
  orderType?: "market" | "limit";
  leverage?: number;
}

export interface DemoTradeReceipt {
  id: string;
  hash: Hex;
  venue: DemoTradeVenue;
  status: "confirmed";
  signer: Address;
  signaturePreview: string;
  intent: DemoTradeIntent;
  createdAt: number;
}

export type DemoTradeStage = "signing" | "submitting" | "confirmed";

export type DemoTradeHistoryEntry = DemoTradeReceipt;

const demoCalls: { method: string; digest: Hex; createdAt: number }[] = [];
const demoTradeHistory: DemoTradeHistoryEntry[] = [];

/** Implements the viem account methods exposed by Mera's toViemAccount(). */
export const demoMeraAccount: DemoMeraAccount = {
  address: DEMO_ADDRESS,
  signMessage: async ({ message }) => demoSignature("signMessage", message),
  signTransaction: async (transaction) =>
    demoSignature("signTransaction", transaction),
  signTypedData: async (request) => demoSignature("signTypedData", request),
};

/** Runs a complete signing/submission/confirmation flow without network I/O. */
export async function executeDemoTrade(
  intent: DemoTradeIntent,
  onStage?: (stage: DemoTradeStage) => void,
): Promise<DemoTradeReceipt> {
  const amount = Number(intent.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a trade amount greater than zero.");
  }
  if (!intent.marketId.trim()) {
    throw new Error("Choose a market before submitting a demo order.");
  }
  if (
    intent.marketType === "perpetual" &&
    (!Number.isInteger(intent.leverage) ||
      (intent.leverage ?? 0) < 1 ||
      (intent.leverage ?? 0) > 100)
  ) {
    throw new Error("Choose leverage from 1× to 100×.");
  }

  onStage?.("signing");
  const nonce = BigInt(Date.now()) * BigInt(1_000) + BigInt(++sequence);
  const signature = await demoMeraAccount.signTypedData({
    domain: { name: "Kites Demo Trading", version: "1", chainId: 1 },
    types: {
      DemoOrder: [
        { name: "venue", type: "string" },
        { name: "marketType", type: "string" },
        { name: "marketId", type: "string" },
        { name: "side", type: "string" },
        { name: "outcome", type: "string" },
        { name: "amount", type: "string" },
        { name: "orderType", type: "string" },
        { name: "leverage", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "DemoOrder",
    message: {
      venue: intent.venue,
      marketType: intent.marketType,
      marketId: intent.marketId,
      side: intent.side,
      outcome: intent.outcome ?? "",
      amount: intent.amount,
      orderType: intent.orderType ?? "market",
      leverage: BigInt(intent.leverage ?? 1),
      nonce,
    },
  });

  await delay(DEMO_DELAY_MS);
  onStage?.("submitting");
  await delay(DEMO_DELAY_MS);

  const createdAt = Date.now();
  const id = `DEMO-${intent.venue.toUpperCase()}-${createdAt}-${sequence}`;
  const hash = keccak256(toBytes(`${id}:${signature}`));
  const receipt: DemoTradeReceipt = {
    id,
    hash,
    venue: intent.venue,
    status: "confirmed",
    signer: demoMeraAccount.address,
    signaturePreview: `${signature.slice(0, 18)}…`,
    intent: { ...intent },
    createdAt,
  };
  demoTradeHistory.unshift(receipt);
  onStage?.("confirmed");
  return receipt;
}

export function getDemoMeraCalls() {
  return demoCalls.map((call) => ({ ...call }));
}

export function getDemoTradeHistory() {
  return demoTradeHistory.map((entry) => ({ ...entry }));
}

export function resetDemoTradingHistory() {
  demoCalls.length = 0;
  demoTradeHistory.length = 0;
  sequence = 0;
}

function demoSignature(method: string, value: unknown): Hex {
  const digest = keccak256(toBytes(stableSerialize(value)));
  demoCalls.push({ method, digest, createdAt: Date.now() });
  // 65-byte shape for UI and call-path tests only; it is not a valid signature.
  return `0x${digest.slice(2)}${digest.slice(2)}1b` as Hex;
}

function stableSerialize(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? `${item.toString()}n` : item,
    ) ?? String(value)
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
