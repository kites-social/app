import {
  type PerpetualMarketReference,
  type PredictionMarketReference,
  type Venue,
} from "./types";

export const HYPERLIQUID_VENUE_ID = "hyperliquid";
export const HYPERLIQUID_TESTNET_APP_URL =
  "https://app.hyperliquid-testnet.xyz";

export const hyperliquidVenue: Venue = {
  id: HYPERLIQUID_VENUE_ID,
  name: "Hyperliquid",
  marketType: "perpetual",
  supportedMarketTypes: ["prediction", "perpetual"],
};

export function parseHyperliquidPerpetualMarketUrl(
  value: string,
): PerpetualMarketReference | null {
  const parsed = parseHyperliquidUrl(value);
  if (!parsed || parsed.searchParams.get("type") === "outcome") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== "trade") return null;
  const marketId = segments[1] || parsed.searchParams.get("coin") || "BTC";
  if (marketId === "outcome" || marketId === "prediction") return null;
  if (isOutcomeSlug(decodeURIComponent(marketId))) return null;

  return {
    marketType: "perpetual",
    venue: HYPERLIQUID_VENUE_ID,
    url: parsed.toString(),
    marketId: decodeURIComponent(marketId),
  };
}

export function parseHyperliquidPredictionMarketUrl(
  value: string,
): PredictionMarketReference | null {
  const parsed = parseHyperliquidUrl(value);
  if (!parsed) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  let questionId: string | undefined;
  let outcomeId: string | undefined;

  if (
    (segments[0] === "outcome" || segments[0] === "prediction") &&
    segments[1]
  ) {
    questionId = segments[1];
    outcomeId = segments[2];
  } else if (segments[0] === "trade" && segments[1] === "outcome") {
    questionId =
      segments[2] ?? parsed.searchParams.get("question") ?? undefined;
    outcomeId = segments[3] ?? parsed.searchParams.get("outcome") ?? undefined;
  } else if (
    segments[0] === "trade" &&
    parsed.searchParams.get("type") === "outcome"
  ) {
    questionId = parsed.searchParams.get("question") ?? undefined;
    outcomeId = parsed.searchParams.get("outcome") ?? undefined;
    if (!questionId) return null;
  } else if (
    segments[0] === "trade" &&
    segments[1] &&
    isOutcomeSlug(decodeURIComponent(segments[1]))
  ) {
    questionId = `outcome:${decodeURIComponent(segments[1])}`;
  } else {
    return null;
  }

  if (!questionId) return null;
  return {
    marketType: "prediction",
    venue: HYPERLIQUID_VENUE_ID,
    url: parsed.toString(),
    marketId: decodeURIComponent(questionId),
    ...(outcomeId ? { subMarketId: decodeURIComponent(outcomeId) } : {}),
  };
}

// Outcome (HIP-4) slugs look like `of:<name>-yes`; perps are `SYMBOL` or `dex:SYMBOL`.
function isOutcomeSlug(value: string) {
  return /^of:/i.test(value) || /-(?:yes|no)$/i.test(value);
}

function parseHyperliquidUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.port === "" &&
      parsed.hostname === "app.hyperliquid-testnet.xyz"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
