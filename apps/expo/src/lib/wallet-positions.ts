import { type QueryClient } from "@tanstack/react-query";

import { type PerplOpenPosition } from "~/lib/venues/perpetual-markets/perpl/account";

export const walletPositionsQueryKey = ["wallet", "positions"] as const;

export interface PositionRow {
  id: string;
  market: string;
  side: string;
  size: string;
  detail?: string;
  perplPosition?: {
    position: PerplOpenPosition;
    marketSymbol: string;
    priceDecimals: number;
    sizeDecimals: number;
  };
  perplIdentity?: {
    size: number;
  };
  polymarketPosition?: {
    assetId: string;
    size: number;
  };
  tradeTarget?: {
    eventSlug: string;
    marketSlug: string;
    question: string;
    outcome: "yes" | "no";
  };
}

// Venue indexers lag behind fills, so positions are re-fetched repeatedly and
// local expectations bridge the gap until the venue reports the new state.
const LOCAL_STATE_TTL_MS = 90_000;
const REFRESH_DELAYS_MS = [1_500, 4_000, 8_000, 15_000, 30_000];
const SIZE_EPSILON = 1e-6;

const sizeCaps = new Map<string, { max: number; expiresAt: number }>();
const pendingRows = new Map<
  string,
  { owner: string; row: PositionRow; expiresAt: number }
>();
interface PerplToastExpectation {
  owner: string;
  id: string;
  marketSymbol: string;
  side: "Long" | "Short";
  size: number;
  expiresAt: number;
}
type PerplPositionToast =
  | { type: "close"; marketSymbol: string; side: "Long" | "Short" }
  | { type: "partial"; marketSymbol: string; side: "Long" | "Short" };
const perplToastExpectations = new Map<string, PerplToastExpectation>();
let pollUntil = 0;

function scopedKey(owner: string, id: string) {
  return `${owner.toLowerCase()}:${id}`;
}

export function expectPerplPositionClose(input: {
  owner: string;
  id: string;
  marketSymbol: string;
  side: "Long" | "Short";
  size: number;
}) {
  const key = `close:${scopedKey(input.owner, input.id)}`;
  perplToastExpectations.set(key, {
    ...input,
    expiresAt: Date.now() + LOCAL_STATE_TTL_MS,
  });
}

export function reconcilePerplPositionToasts(
  owner: string,
  rows: PositionRow[],
) {
  const now = Date.now();
  const notifications: PerplPositionToast[] = [];
  const ownerKey = owner.toLowerCase();
  for (const [key, expectation] of perplToastExpectations) {
    if (expectation.owner.toLowerCase() !== ownerKey) continue;
    if (expectation.expiresAt <= now) {
      perplToastExpectations.delete(key);
      continue;
    }
    const visible = rows.find(({ id }) => id === expectation.id);
    const partial =
      visible?.perplIdentity !== undefined &&
      visible.perplIdentity.size < expectation.size;
    if (!visible || partial) {
      notifications.push({
        type: visible ? "partial" : "close",
        marketSymbol: expectation.marketSymbol,
        side: expectation.side,
      });
      perplToastExpectations.delete(key);
    }
  }
  return notifications;
}

export function hasPendingPositionChanges() {
  const now = Date.now();
  for (const [key, entry] of sizeCaps) {
    if (entry.expiresAt <= now) sizeCaps.delete(key);
  }
  for (const [key, entry] of pendingRows) {
    if (entry.expiresAt <= now) pendingRows.delete(key);
  }
  return sizeCaps.size > 0 || pendingRows.size > 0 || pollUntil > now;
}

/** Records that a position should shrink to `maxSize` (0 removes it). */
export function capPosition(owner: string, id: string, maxSize: number) {
  pendingRows.delete(scopedKey(owner, id));
  sizeCaps.set(scopedKey(owner, id), {
    max: Math.max(0, maxSize),
    expiresAt: Date.now() + LOCAL_STATE_TTL_MS,
  });
  pollUntil = Math.max(pollUntil, Date.now() + LOCAL_STATE_TTL_MS / 3);
}

/** Records a position that should appear even if the venue has not listed it. */
export function addPendingPosition(owner: string, row: PositionRow) {
  sizeCaps.delete(scopedKey(owner, row.id));
  pendingRows.set(scopedKey(owner, row.id), {
    owner,
    row,
    expiresAt: Date.now() + LOCAL_STATE_TTL_MS,
  });
  pollUntil = Math.max(pollUntil, Date.now() + LOCAL_STATE_TTL_MS / 3);
}

/** Returns the size to display, or 0 when the position should be hidden. */
export function applyPositionCap(owner: string, id: string, size: number) {
  const key = scopedKey(owner, id);
  const cap = sizeCaps.get(key);
  if (!cap) return size;
  if (cap.expiresAt <= Date.now() || size <= cap.max + SIZE_EPSILON) {
    sizeCaps.delete(key);
    return size;
  }
  return cap.max;
}

/** Appends locally-known positions the venue has not reported yet. */
export function mergePendingPositions<T extends PositionRow>(
  owner: string,
  rows: T[],
): (T | PositionRow)[] {
  const now = Date.now();
  const merged: (T | PositionRow)[] = [...rows];
  const present = new Set(rows.map((row) => row.id));
  for (const [key, entry] of pendingRows) {
    if (entry.owner.toLowerCase() !== owner.toLowerCase()) continue;
    if (present.has(entry.row.id) || entry.expiresAt <= now) {
      pendingRows.delete(key);
      continue;
    }
    merged.push(entry.row);
  }
  return merged;
}

/** Keeps polling positions for a while, e.g. after opening a perp position. */
export function expectPositionChange() {
  pollUntil = Math.max(pollUntil, Date.now() + 45_000);
}

export function refreshWalletPositions(
  queryClient: QueryClient,
  extraKeys: readonly (readonly unknown[])[] = [],
) {
  const run = () => {
    void queryClient.invalidateQueries({ queryKey: walletPositionsQueryKey });
    for (const queryKey of extraKeys) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  run();
  for (const delay of REFRESH_DELAYS_MS) setTimeout(run, delay);
}

/**
 * Applies a size cap and drops fully closed rows from the cache. In-flight
 * fetches started before the cap would otherwise land afterwards and bring the
 * row back, so they are cancelled first.
 */
export async function applyClosedPosition(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  owner: string,
  id: string,
  remainingSize: number,
) {
  capPosition(owner, id, remainingSize);
  await queryClient.cancelQueries({ queryKey });
  if (remainingSize > 0) return;
  queryClient.setQueryData<{ items: { id: string }[] }>(
    queryKey,
    (current) =>
      current && {
        ...current,
        items: current.items.filter((item) => item.id !== id),
      },
  );
}
