import { type PerpetualMarketReference, type Venue } from "../types";

export type PerplNetwork = "testnet";

export const perplTickerMarkets = {
  BTC: "BTC",
  ETH: "ETH",
  PUMP: "PUMP",
  LIT: "LIT",
  MON: "MON",
  NEAR: "NEAR",
  SOL: "SOL",
  ZEC: "ZEC",
} as const;

export type PerplTicker = keyof typeof perplTickerMarkets;

export const perplVenue: Venue = {
  id: "perpl",
  name: "Perpl",
  marketType: "perpetual",
};

export function getPerplMarketIdForTicker(ticker: string): string | undefined {
  const normalized = ticker.toUpperCase();
  return Object.entries(perplTickerMarkets).find(
    ([symbol]) => symbol === normalized,
  )?.[1];
}

export function parsePerplMarketUrl(
  value: string,
): PerpetualMarketReference | null {
  try {
    const parsed = parsePerplUrl(value);
    if (!parsed) return null;

    const segments = parsed.url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "trade" || !segments[1]) return null;

    return {
      marketType: "perpetual",
      venue: perplVenue.id,
      url: parsed.url.toString(),
      marketId: decodeURIComponent(segments[1]).toUpperCase(),
    };
  } catch {
    return null;
  }
}

export function getPerplNetwork(value: string): PerplNetwork | null {
  try {
    return parsePerplUrl(value)?.network ?? null;
  } catch {
    return null;
  }
}

function parsePerplUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.hostname !== "testnet.perpl.xyz"
  ) {
    return null;
  }
  return { url, network: "testnet" as const };
}
