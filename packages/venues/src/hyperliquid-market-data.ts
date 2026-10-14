import { HYPERLIQUID_TESTNET_APP_URL } from "./hyperliquid";

const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";
const CURSOR_CREATED_AT = "1970-01-01T00:00:00.000Z";
const REST_REQUEST_INTERVAL_MS = 1_250;
let nextRequestAt = 0;

interface HyperliquidQuestion {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes: number[];
}

interface HyperliquidOutcome {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
  venue?: string;
}

interface HyperliquidOutcomeMetadata {
  outcomes: HyperliquidOutcome[];
  questions: HyperliquidQuestion[];
}

export interface HyperliquidOutcomeMarket {
  id: number;
  title: string;
  questionId?: string;
  outcomeSlug: string;
  canonicalUrl: string;
  resolved: boolean;
}

export interface HyperliquidPerpetualMarket {
  dex: string;
  symbol: string;
  canonicalUrl: string;
}

export async function listHyperliquidOutcomeMarkets(): Promise<
  HyperliquidOutcomeMarket[]
> {
  const metadata = parseOutcomeMetadata(
    await postInfo({ type: "outcomeMeta" }),
  );
  const questionByOutcome = new Map<number, HyperliquidQuestion>();
  const fallbackOutcomes = new Set<number>();
  const settledOutcomes = new Set<number>();

  for (const question of metadata.questions) {
    fallbackOutcomes.add(question.fallbackOutcome);
    for (const outcomeId of question.namedOutcomes) {
      questionByOutcome.set(outcomeId, question);
    }
    for (const outcomeId of question.settledNamedOutcomes) {
      settledOutcomes.add(outcomeId);
    }
  }

  return metadata.outcomes
    .flatMap((outcome) => {
      if (fallbackOutcomes.has(outcome.outcome)) return [];

      const question = questionByOutcome.get(outcome.outcome);
      const yesSide = outcome.sideSpecs.find(
        (side) =>
          side.name.slice(side.name.lastIndexOf(":") + 1).toLowerCase() ===
          "yes",
      );
      const hasNoSide = outcome.sideSpecs.some(
        (side) =>
          side.name.slice(side.name.lastIndexOf(":") + 1).toLowerCase() ===
          "no",
      );
      if (!yesSide || !hasNoSide) return [];

      const outcomeSlug = getOutcomeSlug(outcome, yesSide.name, question);
      const questionId = question ? String(question.question) : undefined;
      const canonicalUrl = questionId
        ? `${HYPERLIQUID_TESTNET_APP_URL}/trade/outcome/${encodeURIComponent(questionId)}/${outcome.outcome}`
        : `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(outcomeSlug)}`;
      const outcomeName = outcome.name.startsWith("template:")
        ? `Outcome ${outcome.outcome}`
        : outcome.name;
      const questionName = question?.name.trim();
      const title = questionName
        ? `${questionName}: ${outcomeName}`
        : (getDescriptionFields(outcome.description).shortName ?? outcomeName);

      return [
        {
          id: outcome.outcome,
          title,
          ...(questionId ? { questionId } : {}),
          outcomeSlug,
          canonicalUrl,
          resolved: settledOutcomes.has(outcome.outcome),
        },
      ];
    })
    .sort((left, right) => left.id - right.id);
}

export async function fetchRandomHyperliquidPerpetualMarket(): Promise<HyperliquidPerpetualMarket | null> {
  const dexes = shuffle(parsePerpDexes(await postInfo({ type: "perpDexs" })));
  for (const dex of dexes.slice(0, 10)) {
    const request = {
      type: "metaAndAssetCtxs",
      ...(dex ? { dex } : {}),
    };
    const markets = parsePerpetualMarketPage(await postInfo(request), dex);
    const market = chooseRandom(markets);
    if (market) return market;
  }
  return null;
}

async function postInfo(body: Record<string, string>): Promise<unknown> {
  let attempt = 0;
  while (true) {
    try {
      const requestTime = Date.now();
      const waitTime = Math.max(nextRequestAt - requestTime, 0);
      nextRequestAt =
        Math.max(requestTime, nextRequestAt) + REST_REQUEST_INTERVAL_MS;
      if (waitTime > 0) await delay(waitTime);

      const response = await fetch(HYPERLIQUID_TESTNET_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 429 && attempt < 2) {
        attempt += 1;
        await delay(60_000);
        continue;
      }
      if (
        !response.ok &&
        (response.status === 408 || response.status >= 500) &&
        attempt < 3
      ) {
        await delay(1_000 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      if (!response.ok) {
        throw new Error(`Hyperliquid API request failed (${response.status})`);
      }
      try {
        return await response.json();
      } catch {
        throw new Error("Hyperliquid returned an invalid response.");
      }
    } catch (cause) {
      if (cause instanceof TypeError && attempt < 3) {
        await delay(1_000 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  }
}

function parseOutcomeMetadata(value: unknown): HyperliquidOutcomeMetadata {
  if (
    !isRecord(value) ||
    !isUnknownArray(value.outcomes) ||
    !isUnknownArray(value.questions)
  ) {
    throw new Error("Hyperliquid returned invalid outcome metadata.");
  }

  const outcomes = value.outcomes.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const outcome = positiveInteger(entry.outcome);
    const name = string(entry.name);
    if (
      outcome === undefined ||
      name === undefined ||
      typeof entry.description !== "string" ||
      !isUnknownArray(entry.sideSpecs)
    ) {
      return [];
    }
    const sideSpecs = entry.sideSpecs.flatMap((side) =>
      isRecord(side) && typeof side.name === "string"
        ? [{ name: side.name }]
        : [],
    );
    return [
      {
        outcome,
        name,
        description: entry.description,
        sideSpecs,
        ...(typeof entry.venue === "string" ? { venue: entry.venue } : {}),
      },
    ];
  });

  const questions = value.questions.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const question = positiveInteger(entry.question);
    const name = string(entry.name);
    const fallbackOutcome = positiveInteger(entry.fallbackOutcome);
    const namedOutcomes = positiveIntegerArray(entry.namedOutcomes);
    const settledNamedOutcomes = positiveIntegerArray(
      entry.settledNamedOutcomes,
    );
    if (
      question === undefined ||
      name === undefined ||
      typeof entry.description !== "string" ||
      fallbackOutcome === undefined ||
      !namedOutcomes ||
      !settledNamedOutcomes
    ) {
      return [];
    }
    return [
      {
        question,
        name,
        description: entry.description,
        fallbackOutcome,
        namedOutcomes,
        settledNamedOutcomes,
      },
    ];
  });

  return { outcomes, questions };
}

function parsePerpDexes(value: unknown): string[] {
  if (!isUnknownArray(value)) {
    throw new Error("Hyperliquid returned invalid perp DEX metadata.");
  }
  const dexes = [""];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = string(entry.name);
    if (name && !dexes.includes(name)) dexes.push(name);
  }
  return dexes;
}

function parsePerpetualMarketPage(
  value: unknown,
  dex: string,
): HyperliquidPerpetualMarket[] {
  if (
    !isUnknownArray(value) ||
    !isRecord(value[0]) ||
    !isUnknownArray(value[1])
  ) {
    throw new Error("Hyperliquid returned invalid perp market data.");
  }
  const metadata = value[0];
  if (!isUnknownArray(metadata.universe)) {
    throw new Error("Hyperliquid returned invalid perp market data.");
  }

  return metadata.universe.flatMap((entry) => {
    if (!isRecord(entry) || entry.isDelisted === true) return [];
    const symbol = string(entry.name);
    if (!symbol) return [];

    return [
      {
        dex,
        symbol,
        canonicalUrl: `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(symbol)}`,
      },
    ];
  });
}

function chooseRandom<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  return values[Math.floor(Math.random() * values.length)];
}

function shuffle<T>(values: T[]): T[] {
  const shuffled = values.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];
    if (current === undefined || swap === undefined) continue;
    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function getOutcomeSlug(
  outcome: HyperliquidOutcome,
  side: string,
  question: HyperliquidQuestion | undefined,
) {
  if (outcome.name === "template:binaryPriceExternal") {
    return (
      getExternalPriceSlug(outcome, side) ?? fallbackOutcomeSlug(outcome, side)
    );
  }
  if (outcome.description.includes("class:priceBinary")) {
    return (
      getRecurringPriceSlug(outcome.description, side, 0) ??
      fallbackOutcomeSlug(outcome, side)
    );
  }
  if (question?.description.includes("class:priceBucket")) {
    return (
      getRecurringPriceSlug(
        question.description,
        side,
        question.namedOutcomes.indexOf(outcome.outcome),
      ) ?? fallbackOutcomeSlug(outcome, side)
    );
  }
  return [question?.name, outcome.name, side]
    .filter((part): part is string => Boolean(part))
    .map(slugify)
    .join("-");
}

function getExternalPriceSlug(outcome: HyperliquidOutcome, side: string) {
  const fields = getDescriptionFields(outcome.description);
  const time = fields.time?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  const month = time ? months[Number(time[2]) - 1] : undefined;
  if (
    !outcome.venue ||
    !fields.shortName ||
    !fields.threshold ||
    !time ||
    !month
  ) {
    return null;
  }
  const hour = Number(time[4]);
  const timeToken = `${hour % 12 || 12}${String(time[5]).padStart(2, "0")}`;
  const period = hour < 12 ? "am" : "pm";
  return `${outcome.venue}:${slugify(fields.shortName)}-above-${fields.threshold}-on-${month}-${Number(time[3])}-at-${timeToken}-${period}-utc-${getSideName(side)}`;
}

function getRecurringPriceSlug(
  description: string,
  side: string,
  bucketIndex: number,
) {
  const fields = getDescriptionFields(description);
  const underlying = fields.underlying;
  const expiry = fields.expiry;
  if (!underlying || !expiry) return null;
  const month = months[Number(expiry.slice(4, 6)) - 1];
  if (!month) return null;
  const date = `${month}-${expiry.slice(6, 8)}-${expiry.slice(9, 13)}`;

  if (fields.class === "priceBinary") {
    return fields.targetPrice
      ? `${underlying}-above-${fields.targetPrice}-${side}-${date}`.toLowerCase()
      : null;
  }
  if (fields.class === "priceBucket") {
    const prices = fields.priceThresholds?.split(",");
    if (prices?.length !== 2) return null;
    const range =
      bucketIndex === 0
        ? `below-${prices[0]}`
        : bucketIndex === 1
          ? `${prices[0]}-to-${prices[1]}`
          : `above-${prices[1]}`;
    return `${underlying}-price-range-${date}-${range}-${side}`.toLowerCase();
  }
  return null;
}

function fallbackOutcomeSlug(outcome: HyperliquidOutcome, side: string) {
  return `${slugify(outcome.name)}-${getSideName(side)}`;
}

function getDescriptionFields(description: string) {
  return Object.fromEntries(
    description.split("|").flatMap((part) => {
      const separator = part.indexOf(":");
      return separator > 0
        ? [[part.slice(0, separator), part.slice(separator + 1)]]
        : [];
    }),
  ) as Record<string, string>;
}

function getSideName(value: string) {
  return value.slice(value.lastIndexOf(":") + 1).toLowerCase();
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function positiveIntegerArray(value: unknown): number[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  const values = value.map(positiveInteger);
  return values.every((entry): entry is number => entry !== undefined)
    ? values
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

export { CURSOR_CREATED_AT as HYPERLIQUID_OUTCOME_CURSOR_CREATED_AT };
