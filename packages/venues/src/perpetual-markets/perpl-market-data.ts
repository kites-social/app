import { type PerplNetwork } from "./perpl";

const PERPL_NETWORKS: Record<PerplNetwork, { apiUrl: string }> = {
  testnet: { apiUrl: "https://testnet.perpl.xyz/api" },
};

interface PerplMarketConfig {
  id: number;
  symbol: string;
}

export interface PerplMarket {
  id: number;
  symbol: string;
  canonicalUrl: string;
}

export async function fetchRandomPerplMarket(): Promise<PerplMarket | null> {
  const apiUrl = PERPL_NETWORKS.testnet.apiUrl;
  const context = await fetchJson(
    `${apiUrl}/v1/pub/context`,
    "Perpl market context",
  );
  if (!isRecord(context) || !Array.isArray(context.markets)) {
    throw new Error("Perpl returned invalid market configuration.");
  }

  const markets = context.markets.flatMap(parseMarketConfig);
  const market = chooseRandom(markets);
  return market
    ? {
        ...market,
        canonicalUrl: `https://testnet.perpl.xyz/trade/${encodeURIComponent(market.symbol)}`,
      }
    : null;
}

function parseMarketConfig(value: unknown): PerplMarketConfig[] {
  if (!isRecord(value)) return [];
  if (isRecord(value.config) && value.config.is_open === false) return [];
  const id = positiveInteger(value.id);
  const symbol = nonEmptyString(value.symbol);
  return id === undefined || !symbol ? [] : [{ id, symbol }];
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} request failed (${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned an invalid response.`);
  }
  return body;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chooseRandom<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  return values[Math.floor(Math.random() * values.length)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
