import {
  type AllMidsResponse,
  type OutcomeMetaResponse,
} from "@nktkas/hyperliquid/api/info";

import {
  type PredictionEventSnapshot,
  type PredictionMarketSnapshot,
} from "@kites-social/venues";

import {
  hyperliquidSubscriptionClient,
  requestHyperliquidInfo,
  type ISubscription,
} from "./client";

type OutcomeMetadata = OutcomeMetaResponse;

interface EventListener {
  questionId: string;
  onUpdate: (event: PredictionEventSnapshot) => void;
  onError?: (error: Error) => void;
}

interface Runtime {
  listeners: Set<EventListener>;
  metadata?: OutcomeMetadata;
  mids?: Record<string, string>;
  midSubscription?: ISubscription;
  metadataSubscription?: ISubscription;
  subscriptionRequest?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
}

const runtime: Runtime = {
  listeners: new Set(),
  reconnectAttempt: 0,
};

export const hyperliquidPredictionMarketVenue = {
  id: "hyperliquid",
  name: "Hyperliquid",
  marketType: "prediction" as const,
  fetchEvent,
  subscribeToEvent,
};

export async function fetchEvent(
  questionId: string,
): Promise<PredictionEventSnapshot> {
  const [metadata, mids] = await Promise.all([
    requestHyperliquidInfo<OutcomeMetadata>({ type: "outcomeMeta" }),
    requestHyperliquidInfo<AllMidsResponse>({ type: "allMids" }),
  ]);
  runtime.metadata = metadata;
  runtime.mids = mids;
  return mapEvent(metadata, mids, questionId);
}

export function subscribeToEvent(
  questionId: string,
  onUpdate: (event: PredictionEventSnapshot) => void,
  onError?: (error: Error) => void,
) {
  const listener = { questionId, onUpdate, onError };
  runtime.listeners.add(listener);
  void ensureSubscriptions();

  return () => {
    runtime.listeners.delete(listener);
    if (runtime.listeners.size > 0) return;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    runtime.reconnectAttempt = 0;
    const midSubscription = runtime.midSubscription;
    const metadataSubscription = runtime.metadataSubscription;
    runtime.midSubscription = undefined;
    runtime.metadataSubscription = undefined;
    if (midSubscription) void midSubscription.unsubscribe();
    if (metadataSubscription) void metadataSubscription.unsubscribe();
  };
}

function ensureSubscriptions() {
  if (runtime.listeners.size === 0 || runtime.subscriptionRequest) return;
  runtime.subscriptionRequest = (async () => {
    const [metadata, mids] = await Promise.all([
      requestHyperliquidInfo<OutcomeMetadata>({ type: "outcomeMeta" }),
      requestHyperliquidInfo<AllMidsResponse>({ type: "allMids" }),
    ]);
    runtime.metadata = metadata;
    runtime.mids = mids;
    emitAllEvents();
    if (runtime.listeners.size === 0) return;

    if (!runtime.midSubscription) {
      runtime.midSubscription = await hyperliquidSubscriptionClient.allMids(
        (event) => {
          runtime.mids = event.mids;
          emitAllEvents();
        },
        { onError: handleSubscriptionError },
      );
    }
    if (!runtime.metadataSubscription) {
      runtime.metadataSubscription =
        await hyperliquidSubscriptionClient.outcomeMetaUpdates(
          () => {
            void refreshSubscribedEvents();
          },
          { onError: handleSubscriptionError },
        );
    }
    runtime.reconnectAttempt = 0;
  })()
    .catch((cause: unknown) => {
      notifyError(toError(cause));
      scheduleReconnect();
    })
    .finally(() => {
      runtime.subscriptionRequest = undefined;
    });
}

function handleSubscriptionError(cause: Error) {
  runtime.midSubscription = undefined;
  runtime.metadataSubscription = undefined;
  notifyError(toError(cause));
  scheduleReconnect();
}

async function refreshSubscribedEvents() {
  try {
    const [metadata, mids] = await Promise.all([
      requestHyperliquidInfo<OutcomeMetadata>({ type: "outcomeMeta" }),
      requestHyperliquidInfo<AllMidsResponse>({ type: "allMids" }),
    ]);
    runtime.metadata = metadata;
    runtime.mids = mids;
    emitAllEvents();
  } catch (cause) {
    notifyError(toError(cause));
  }
}

function emitAllEvents() {
  if (!runtime.metadata || !runtime.mids) return;
  for (const listener of runtime.listeners) {
    try {
      listener.onUpdate(
        mapEvent(runtime.metadata, runtime.mids, listener.questionId),
      );
    } catch (cause) {
      listener.onError?.(toError(cause));
    }
  }
}

function scheduleReconnect() {
  if (runtime.listeners.size === 0 || runtime.reconnectTimer) return;
  const delay = Math.min(1_000 * 2 ** runtime.reconnectAttempt, 30_000);
  runtime.reconnectAttempt += 1;
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = undefined;
    void ensureSubscriptions();
  }, delay);
}

function notifyError(error: Error) {
  for (const listener of runtime.listeners) listener.onError?.(error);
}

function mapEvent(
  metadata: OutcomeMetadata,
  mids: Record<string, string>,
  eventId: string,
): PredictionEventSnapshot {
  if (eventId.startsWith("outcome:")) {
    const market = findOutcomeBySlug(
      metadata,
      eventId.slice("outcome:".length),
    );
    if (!market) {
      throw new Error(`Hyperliquid prediction outcome not found: ${eventId}`);
    }
    if (market.question) {
      const event = mapQuestionEvent(metadata, mids, market.question);
      return {
        ...event,
        markets: event.markets.filter(
          (item) => item.slug === String(market.outcome.outcome),
        ),
      };
    }
    const snapshot = mapOutcomeMarket(market.outcome, undefined, mids);
    return {
      title: getOutcomeTitle(market.outcome),
      markets: snapshot ? [snapshot] : [],
    };
  }

  const question = metadata.questions.find(
    (item) => String(item.question) === eventId,
  );
  if (!question) {
    throw new Error(`Hyperliquid prediction question not found: ${eventId}`);
  }

  return mapQuestionEvent(metadata, mids, question);
}

function mapQuestionEvent(
  metadata: OutcomeMetadata,
  mids: Record<string, string>,
  question: OutcomeMetadata["questions"][number],
): PredictionEventSnapshot {
  const outcomesById = new Map(
    metadata.outcomes.map((outcome) => [outcome.outcome, outcome]),
  );
  const markets = question.namedOutcomes.flatMap((outcomeId) => {
    const outcome = outcomesById.get(outcomeId);
    if (!outcome) return [];
    const market = mapOutcomeMarket(
      outcome,
      question,
      mids,
      question.settledNamedOutcomes.includes(outcomeId),
    );
    return market ? [market] : [];
  });

  return {
    title: question.name || `Hyperliquid question ${question.question}`,
    markets,
  };
}

function mapOutcomeMarket(
  outcome: OutcomeMetadata["outcomes"][number],
  question: OutcomeMetadata["questions"][number] | undefined,
  mids: Record<string, string>,
  isResolved = false,
): PredictionMarketSnapshot | null {
  const yesIndex = outcome.sideSpecs.findIndex(
    (side) => getSideName(side.name) === "yes",
  );
  const noIndex = outcome.sideSpecs.findIndex(
    (side) => getSideName(side.name) === "no",
  );
  const yesSide = outcome.sideSpecs[yesIndex];
  const noSide = outcome.sideSpecs[noIndex];
  if (yesIndex < 0 || noIndex < 0 || !yesSide || !noSide) {
    return null;
  }
  const yesSlug = getOutcomeSlug(outcome, yesSide.name, question);
  const noSlug = getOutcomeSlug(outcome, noSide.name, question);
  return {
    slug: String(outcome.outcome),
    question: getOutcomeQuestion(outcome, question),
    ...(yesSlug ? { yesVenueSlug: yesSlug } : {}),
    ...(noSlug ? { noVenueSlug: noSlug } : {}),
    yesProbability: parseProbability(
      mids[`#${outcome.outcome * 10 + yesIndex}`],
    ),
    noProbability: parseProbability(mids[`#${outcome.outcome * 10 + noIndex}`]),
    yesAssetId: String(100_000_000 + outcome.outcome * 10 + yesIndex),
    noAssetId: String(100_000_000 + outcome.outcome * 10 + noIndex),
    isClosed: isResolved,
    isResolved,
    winningOutcome: null,
  };
}

function findOutcomeBySlug(metadata: OutcomeMetadata, slug: string) {
  for (const outcome of metadata.outcomes) {
    const question = metadata.questions.find((item) =>
      item.namedOutcomes.includes(outcome.outcome),
    );
    if (
      metadata.questions.some(
        (item) => item.fallbackOutcome === outcome.outcome,
      )
    ) {
      continue;
    }
    for (const side of outcome.sideSpecs) {
      if (
        getOutcomeSlug(outcome, side.name, question).toLowerCase() ===
        slug.toLowerCase()
      ) {
        return { outcome, question };
      }
    }
  }
}

function getOutcomeSlug(
  outcome: OutcomeMetadata["outcomes"][number],
  side: string,
  question: OutcomeMetadata["questions"][number] | undefined,
) {
  if (outcome.name === "template:binaryPriceExternal") {
    return getExternalPriceSlug(outcome, side) ?? "";
  }
  if (outcome.description.includes("class:priceBinary")) {
    return getRecurringPriceSlug(outcome.description, side, 0) ?? "";
  }
  if (question?.description.includes("class:priceBucket")) {
    return (
      getRecurringPriceSlug(
        question.description,
        side,
        question.namedOutcomes.indexOf(outcome.outcome),
      ) ?? ""
    );
  }
  return [question?.name, outcome.name, side]
    .filter((part): part is string => Boolean(part))
    .map(slugify)
    .join("-");
}

function getSideName(value: string) {
  return value.slice(value.lastIndexOf(":") + 1).toLowerCase();
}

function getOutcomeTitle(outcome: OutcomeMetadata["outcomes"][number]) {
  if (outcome.name === "template:binaryPriceExternal") {
    return (
      getDescriptionFields(outcome.description).shortName ?? "Prediction market"
    );
  }
  return outcome.name || "Prediction market";
}

function getOutcomeQuestion(
  outcome: OutcomeMetadata["outcomes"][number],
  question: OutcomeMetadata["questions"][number] | undefined,
) {
  if (outcome.name === "template:binaryPriceExternal") {
    const fields = getDescriptionFields(outcome.description);
    const time = fields.time?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    const month = time ? months[Number(time[2]) - 1] : undefined;
    if (fields.shortName && fields.threshold && time && month) {
      const hour = Number(time[4]);
      const minute = Number(time[5]);
      const hour12 = hour % 12 || 12;
      const timeLabel = `${hour12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"} UTC`;
      return `${fields.shortName} above ${fields.threshold} on ${month} ${Number(time[3])}, ${time[1]} at ${timeLabel}`;
    }
  }
  return outcome.name || question?.name || "Prediction market";
}

function getExternalPriceSlug(
  outcome: OutcomeMetadata["outcomes"][number],
  side: string,
) {
  const fields = getDescriptionFields(outcome.description);
  const time = fields.time?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  const month = time ? months[Number(time[2]) - 1] : undefined;
  const venue = getOutcomeVenue(outcome);
  if (!venue || !fields.shortName || !fields.threshold || !time || !month) {
    return null;
  }
  const hour = Number(time[4]);
  const minute = Number(time[5]);
  const hour12 = hour % 12 || 12;
  const timeToken = `${hour12}${String(minute).padStart(2, "0")}`;
  const period = hour < 12 ? "am" : "pm";
  return `${venue}:${slugify(fields.shortName)}-above-${fields.threshold}-on-${month}-${Number(time[3])}-at-${timeToken}-${period}-utc-${getSideName(side)}`;
}

function getOutcomeVenue(outcome: OutcomeMetadata["outcomes"][number]) {
  return "venue" in outcome && typeof outcome.venue === "string"
    ? outcome.venue
    : undefined;
}

function getRecurringPriceSlug(
  description: string,
  side: string,
  bucketIndex: number,
) {
  const fields = getDescriptionFields(description);
  const assetClass = fields.class;
  const underlying = fields.underlying;
  const expiry = fields.expiry;
  if (!assetClass || !underlying || !expiry) return null;
  const month = months[Number(expiry.slice(4, 6)) - 1];
  if (!month) return null;
  const date = `${month}-${expiry.slice(6, 8)}-${expiry.slice(9, 13)}`;

  if (assetClass === "priceBinary") {
    const targetPrice = fields.targetPrice;
    return targetPrice
      ? `${underlying}-above-${targetPrice}-${side}-${date}`.toLowerCase()
      : null;
  }
  if (assetClass === "priceBucket") {
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

function getDescriptionFields(description: string) {
  return Object.fromEntries(
    description.split("|").map((part) => {
      const separator = part.indexOf(":");
      return [part.slice(0, separator), part.slice(separator + 1)];
    }),
  ) as Record<string, string>;
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

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseProbability(value: string | undefined) {
  if (value === undefined) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 && price <= 1
    ? price * 100
    : null;
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}
