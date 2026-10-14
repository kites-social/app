import { store } from "~/lib/storage/storage";
import { getAppPublicClient } from "~/lib/web3";

export type WalletActivityStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed";

export interface WalletActivityEntry {
  id: string;
  kind: "send" | "trade" | "approval" | "funding";
  status: WalletActivityStatus;
  title: string;
  detail: string;
  chainId?: number;
  transactionHash?: string;
  venue?: string;
  createdAt: number;
  updatedAt: number;
}

const MAX_ACTIVITY_ITEMS = 200;

export const walletActivityQueryKey = (did: string) =>
  ["wallet", "activity", did] as const;

export function listWalletActivity(did: string): WalletActivityEntry[] {
  const raw = store.getString(activityKey(did));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isActivityEntry).sort((a, b) => b.createdAt - a.createdAt)
      : [];
  } catch {
    return [];
  }
}

export function saveWalletActivity(
  did: string,
  entry: Omit<WalletActivityEntry, "createdAt" | "updatedAt"> & {
    createdAt?: number;
  },
) {
  const now = Date.now();
  const existing = listWalletActivity(did);
  const previous = existing.find((item) => item.id === entry.id);
  const next: WalletActivityEntry = {
    ...entry,
    createdAt: entry.createdAt ?? previous?.createdAt ?? now,
    updatedAt: now,
  };
  const nextList = [next, ...existing.filter((item) => item.id !== entry.id)]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_ACTIVITY_ITEMS);
  store.set(activityKey(did), JSON.stringify(nextList));
  return next;
}

export async function refreshPendingWalletActivity(did: string) {
  const pending = listWalletActivity(did).filter(
    (item) =>
      item.status === "pending" &&
      item.transactionHash &&
      item.chainId !== undefined,
  );
  await Promise.allSettled(
    pending.map(async (item) => {
      if (!item.transactionHash || item.chainId === undefined) return;
      const receipt = await getAppPublicClient(
        item.chainId,
      ).getTransactionReceipt({ hash: item.transactionHash as `0x${string}` });
      saveWalletActivity(did, {
        ...item,
        status: receipt.status === "success" ? "confirmed" : "failed",
      });
    }),
  );
}

function activityKey(did: string) {
  return `wallet-activity:${did}`;
}

function isActivityEntry(value: unknown): value is WalletActivityEntry {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    (item.kind === "send" ||
      item.kind === "trade" ||
      item.kind === "approval" ||
      item.kind === "funding") &&
    (item.status === "pending" ||
      item.status === "submitted" ||
      item.status === "confirmed" ||
      item.status === "failed") &&
    typeof item.title === "string" &&
    typeof item.detail === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number"
  );
}
