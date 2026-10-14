import { getAddress, type Address } from "viem";

import {
  fetchPerplAccountSummary,
  fetchPerplOpenPositions,
  signedPerplRequest,
  type PerplAccount,
  type PerplOpenPosition,
} from "./account";
import { logPerplTrade } from "./logging";
import { type PerplOrderBookSnapshot } from "./market-data";
import { PERPL_NETWORKS } from "./network";

export interface PerplTradeMarket {
  id: number;
  symbol: string;
  price: number;
  priceDecimals: number;
  sizeDecimals: number;
  orderTtlBlocks: number;
  maxLeverage: number;
  maxSlippageBps: number;
  maxNegativePnlCollateralBps: number;
  isOpen: boolean;
}

export interface PerplTradeAccount extends PerplAccount {
  availableBalance: number;
  currentBlock?: number;
}

export interface PerplOrderOutcome {
  orderStatus?: number;
  orderStatusName?: string;
  statusReasonName?: string;
  failureReasonName?: string;
  requestedSizeScaled?: number;
  filledSizeScaled?: number;
  terminal: boolean;
}

const lastRequestIds = new Map<string, number>();

export async function fetchPerplTradeMarket(
  symbol: string,
): Promise<PerplTradeMarket> {
  const config = PERPL_NETWORKS.testnet;
  const contextResponse = await fetch(`${config.apiUrl}/v1/pub/context`);
  if (!contextResponse.ok) {
    throw new Error(
      `Unable to load Perpl testnet markets (${contextResponse.status}).`,
    );
  }
  const context: unknown = await readJson(contextResponse);
  if (!isRecord(context) || !Array.isArray(context.markets)) {
    throw new Error("Perpl returned invalid market information.");
  }
  const normalizedSymbol = normalizeSymbol(symbol);
  const rawMarket = context.markets.find(
    (market) =>
      isRecord(market) &&
      normalizeSymbol(
        readString(market.symbol) ?? readString(market.name) ?? "",
      ) === normalizedSymbol,
  );
  if (!isRecord(rawMarket)) {
    throw new Error(`${normalizedSymbol} is unavailable on Perpl testnet.`);
  }
  const marketConfig = isRecord(rawMarket.config) ? rawMarket.config : {};
  const id = readInteger(rawMarket.id);
  const priceDecimals = readInteger(marketConfig.price_decimals);
  const sizeDecimals = readInteger(marketConfig.size_decimals);
  const orderTtlBlocks = readInteger(rawMarket.order_ttl_blocks);
  const initialMargin = readPositiveNumber(marketConfig.initial_margin);
  const maxSlippageBps = readInteger(rawMarket.order_max_market_slippage_bps);
  const maxNegativePnlCollateralBps = readInteger(
    rawMarket.order_max_neg_pnl_collat_bps,
  );
  const isOpen = marketConfig.is_open === true;
  if (
    id === undefined ||
    id <= 0 ||
    priceDecimals === undefined ||
    sizeDecimals === undefined ||
    orderTtlBlocks === undefined ||
    orderTtlBlocks <= 0 ||
    initialMargin === undefined ||
    maxSlippageBps === undefined ||
    maxNegativePnlCollateralBps === undefined ||
    priceDecimals < 0 ||
    sizeDecimals < 0 ||
    priceDecimals > 18 ||
    sizeDecimals > 18
  ) {
    throw new Error("Perpl returned incomplete trading limits.");
  }

  const tickerResponse = await fetch(
    `${config.apiUrl}/v1/market-data/${id}/ticker`,
  );
  if (!tickerResponse.ok) {
    throw new Error(
      `Unable to load the Perpl price (${tickerResponse.status}).`,
    );
  }
  const ticker: unknown = await readJson(tickerResponse);
  if (!isRecord(ticker) || !isRecord(ticker.d)) {
    throw new Error("Perpl returned invalid price information.");
  }
  const state = ticker.d[String(id)];
  if (!isRecord(state)) {
    throw new Error("Perpl has no current price for this market.");
  }
  const rawPrice = readPositiveNumber(state.mrk ?? state.mid);
  if (rawPrice === undefined) {
    throw new Error("Perpl returned an invalid market price.");
  }
  const price = rawPrice / 10 ** priceDecimals;
  const maxLeverage = Math.floor(10_000 / initialMargin);
  if (!Number.isFinite(price) || price <= 0 || maxLeverage < 1) {
    throw new Error("Perpl returned invalid market limits.");
  }

  return {
    id,
    symbol: normalizedSymbol,
    price,
    priceDecimals,
    sizeDecimals,
    orderTtlBlocks,
    maxLeverage,
    maxSlippageBps: Math.min(maxSlippageBps, 100),
    maxNegativePnlCollateralBps: Math.min(maxNegativePnlCollateralBps, 100),
    isOpen,
  };
}

export async function fetchPerplOrderBook(
  market: Pick<PerplTradeMarket, "id" | "priceDecimals" | "sizeDecimals">,
): Promise<PerplOrderBookSnapshot> {
  const config = PERPL_NETWORKS.testnet;
  const url = new URL(`${config.apiUrl}/v1/market-data/${market.id}/book`);
  url.searchParams.set("levels", "20");
  const response = await fetch(url);
  const body: unknown = await readJson(response);
  if (!response.ok) {
    throw new Error(`Unable to load Perpl order book (${response.status}).`);
  }
  if (!isRecord(body) || !Array.isArray(body.bid) || !Array.isArray(body.ask)) {
    throw new Error("Perpl returned invalid order book data.");
  }

  return {
    bids: parsePerplOrderBookLevels(
      body.bid,
      market.priceDecimals,
      market.sizeDecimals,
    ).sort((left, right) => right.price - left.price),
    asks: parsePerplOrderBookLevels(
      body.ask,
      market.priceDecimals,
      market.sizeDecimals,
    ).sort((left, right) => left.price - right.price),
  };
}

export async function fetchPerplTradeAccount(
  walletAddress: Address,
): Promise<PerplTradeAccount[]> {
  const summary = await fetchPerplAccountSummary(walletAddress);
  if (getAddress(summary.address) !== getAddress(walletAddress)) {
    throw new Error("Perpl returned account data for a different wallet.");
  }
  return summary.accounts.map((account) => {
    const availableRaw =
      BigInt(account.balance) - BigInt(account.lockedBalance);
    return {
      ...account,
      availableBalance: Number(availableRaw) / 1_000_000,
      ...(summary.snapshotBlock !== undefined
        ? { currentBlock: summary.snapshotBlock }
        : {}),
    };
  });
}

export async function placePerplMarketOrder(input: {
  walletAddress: Address;
  market: PerplTradeMarket;
  account: PerplTradeAccount;
  side: "long" | "short";
  notionalUsd: number;
  leverage: number;
}) {
  const orderContext = {
    marketId: input.market.id,
    marketSymbol: input.market.symbol,
    accountId: input.account.id,
    side: input.side,
    notionalUsd: input.notionalUsd,
    leverage: input.leverage,
  };
  logPerplTrade("order_preflight_started", orderContext);
  if (!input.market.isOpen) {
    logPerplTrade("order_preflight_rejected", {
      ...orderContext,
      reason: "market_closed",
    });
    throw new Error("This Perpl market is not accepting orders.");
  }
  if (input.account.frozen || !input.account.allowsForwarding) {
    logPerplTrade("order_preflight_rejected", {
      ...orderContext,
      reason: input.account.frozen ? "account_frozen" : "forwarding_disabled",
    });
    throw new Error(
      "Enable one-click order forwarding on your Perpl account before trading.",
    );
  }
  if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0) {
    logPerplTrade("order_preflight_rejected", {
      ...orderContext,
      reason: "invalid_notional",
    });
    throw new Error("Enter a valid order size.");
  }
  if (
    !Number.isInteger(input.leverage) ||
    input.leverage < 1 ||
    input.leverage > input.market.maxLeverage
  ) {
    logPerplTrade("order_preflight_rejected", {
      ...orderContext,
      reason: "invalid_leverage",
      maxLeverage: input.market.maxLeverage,
    });
    throw new Error(
      `Choose leverage between 1× and ${input.market.maxLeverage}×.`,
    );
  }
  const collateralNeeded = input.notionalUsd / input.leverage;
  if (collateralNeeded > input.account.availableBalance) {
    logPerplTrade("order_preflight_rejected", {
      ...orderContext,
      reason: "insufficient_collateral",
      collateralNeeded,
      availableBalance: input.account.availableBalance,
    });
    throw new Error(
      "The Perpl account does not have enough available collateral for this order.",
    );
  }

  const size = Math.floor(
    (input.notionalUsd / input.market.price) * 10 ** input.market.sizeDecimals,
  );
  if (!Number.isSafeInteger(size) || size <= 0) {
    logPerplTrade("order_preflight_rejected", {
      ...orderContext,
      reason: "size_below_market_precision",
      size,
      sizeDecimals: input.market.sizeDecimals,
      markPrice: input.market.price,
    });
    throw new Error("The order size is below Perpl's market precision.");
  }
  const requestId = createPerplRequestId(
    input.walletAddress,
    input.account.id,
    input.account.lastForwardedRequestId,
  );
  const order = {
    rq: requestId,
    mkt: input.market.id,
    acc: input.account.id,
    t: input.side === "long" ? 1 : 2,
    p: 0,
    s: size,
    ms: input.market.maxSlippageBps,
    mnp: input.market.maxNegativePnlCollateralBps,
    fl: 4,
    lv: input.leverage * 100,
    lb: 0,
  };
  const submittedOrderContext = {
    ...orderContext,
    requestId,
    sizeScaled: size,
    sizeDecimals: input.market.sizeDecimals,
    markPrice: input.market.price,
    actualNotionalUsd:
      (size / 10 ** input.market.sizeDecimals) * input.market.price,
    collateralNeeded,
    availableBalance: input.account.availableBalance,
    orderType: input.side === "long" ? "OpenLong" : "OpenShort",
    orderTypeCode: order.t,
    orderFlags: order.fl,
    orderFlagName: "ImmediateOrCancel",
    limitPrice: order.p,
    lastExecutionBlock: order.lb,
    leverageHundredths: order.lv,
    maxSlippageBps: order.ms,
    maxNegativePnlCollateralBps: order.mnp,
  };
  logPerplTrade("order_request_prepared", submittedOrderContext);

  let response: Response;
  try {
    response = await signedPerplRequest(
      input.walletAddress,
      "POST",
      "/v1/trading/orders",
      { d: [order] },
    );
  } catch (cause) {
    logPerplTrade("order_request_failed", {
      ...submittedOrderContext,
      stage: "transport",
    });
    throw cause;
  }

  let result: unknown;
  try {
    result = await readJson(response);
  } catch (cause) {
    logPerplTrade("order_response_invalid_json", {
      ...submittedOrderContext,
      httpStatus: response.status,
    });
    throw cause;
  }
  if (!response.ok) {
    logPerplTrade("order_http_rejected", {
      ...submittedOrderContext,
      httpStatus: response.status,
    });
    throw new Error(
      `Perpl rejected the order request (${response.status}). Try again after refreshing the account.`,
    );
  }
  if (!isRecord(result) || !isRecord(result.status)) {
    logPerplTrade("order_response_invalid_shape", {
      ...submittedOrderContext,
      rootKeys: isRecord(result) ? Object.keys(result) : [],
    });
    throw new Error("Perpl returned an invalid order response.");
  }
  const batchCode = readInteger(result.status.code);
  const statuses = Array.isArray(result.statuses) ? result.statuses : [];
  const firstStatus = statuses[0];
  const orderCode = isRecord(firstStatus)
    ? readInteger(firstStatus.code)
    : undefined;
  const orderError =
    isRecord(firstStatus) && typeof firstStatus.error === "string"
      ? firstStatus.error
      : undefined;
  logPerplTrade("order_response_received", {
    ...submittedOrderContext,
    httpStatus: response.status,
    messageType: result.mt,
    batchCode,
    orderCode,
    orderError,
  });
  if (batchCode !== 0 || !isRecord(firstStatus) || orderCode !== 0) {
    const detail =
      orderError !== undefined
        ? orderError
        : typeof result.status.error === "string"
          ? result.status.error
          : "Perpl did not accept this order.";
    logPerplTrade("order_forwarding_rejected", {
      ...submittedOrderContext,
      batchCode,
      orderCode,
      error: detail,
    });
    throw new Error(detail);
  }
  logPerplTrade("order_accepted_for_forwarding", submittedOrderContext);
  return { requestId, size: size / 10 ** input.market.sizeDecimals };
}

export async function closePerplPosition(input: {
  walletAddress: Address;
  position: PerplOpenPosition;
  marketSymbol: string;
}) {
  const [accounts, market, openPositions] = await Promise.all([
    fetchPerplTradeAccount(input.walletAddress),
    fetchPerplTradeMarket(input.marketSymbol),
    fetchPerplOpenPositions(input.walletAddress),
  ]);
  const position = openPositions.find(({ id }) => id === input.position.id);
  if (!position) {
    throw new Error(
      "This Perpl position is no longer open. Refresh positions.",
    );
  }
  if (
    position.accountId !== input.position.accountId ||
    position.marketId !== input.position.marketId ||
    position.side !== input.position.side
  ) {
    throw new Error(
      "This Perpl position changed. Refresh positions and try again.",
    );
  }
  const account = accounts.find(({ id }) => id === position.accountId);
  const context = {
    positionId: position.id,
    marketId: position.marketId,
    marketSymbol: market.symbol,
    accountId: position.accountId,
    side: position.side,
    sizeScaled: position.size,
  };
  logPerplTrade("close_preflight_started", context);

  if (market.id !== position.marketId) {
    throw new Error("Perpl market data did not match this position.");
  }
  if (!market.isOpen) {
    throw new Error("This Perpl market is not accepting close orders.");
  }
  if (!account) {
    throw new Error("The Perpl account for this position could not be found.");
  }
  if (account.frozen || !account.allowsForwarding) {
    throw new Error(
      "Enable one-click order forwarding on your Perpl account before closing this position.",
    );
  }
  if (!Number.isSafeInteger(position.size) || position.size <= 0) {
    throw new Error("Perpl returned an invalid position size.");
  }
  if (account.currentBlock === undefined) {
    throw new Error("Perpl did not return a current block. Refresh and retry.");
  }
  const lastExecutionBlock = account.currentBlock + market.orderTtlBlocks;
  if (!Number.isSafeInteger(lastExecutionBlock)) {
    throw new Error("Perpl returned an invalid order expiry block.");
  }

  const requestId = createPerplRequestId(
    input.walletAddress,
    account.id,
    account.lastForwardedRequestId,
  );
  const order = {
    rq: requestId,
    mkt: market.id,
    acc: account.id,
    t: position.side === "Long" ? 3 : 4,
    p: 0,
    s: position.size,
    ms: market.maxSlippageBps,
    mnp: market.maxNegativePnlCollateralBps,
    fl: 4,
    lp: position.id,
    lv: 0,
    lb: lastExecutionBlock,
  };
  const submittedOrderContext = {
    ...context,
    requestId,
    orderType: position.side === "Long" ? "CloseLong" : "CloseShort",
    orderTypeCode: order.t,
    orderFlags: order.fl,
    orderFlagName: "ImmediateOrCancel",
    linkedPositionId: order.lp,
    limitPrice: order.p,
    sizeDecimals: market.sizeDecimals,
    lastExecutionBlock,
    leverageHundredths: order.lv,
  };
  logPerplTrade("close_order_request_prepared", submittedOrderContext);

  let response: Response;
  try {
    response = await signedPerplRequest(
      input.walletAddress,
      "POST",
      "/v1/trading/orders",
      { d: [order] },
    );
  } catch (cause) {
    logPerplTrade("close_order_request_failed", {
      ...submittedOrderContext,
      stage: "transport",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }

  let result: unknown;
  try {
    result = await readJson(response);
  } catch (cause) {
    logPerplTrade("close_order_response_invalid_json", {
      ...submittedOrderContext,
      httpStatus: response.status,
    });
    throw cause;
  }
  if (!response.ok) {
    throw new Error(
      `Perpl rejected the close request (${response.status}). Refresh the position and try again.`,
    );
  }
  if (!isRecord(result) || !isRecord(result.status)) {
    throw new Error("Perpl returned an invalid close order response.");
  }
  const batchCode = readInteger(result.status.code);
  const statuses = Array.isArray(result.statuses) ? result.statuses : [];
  const firstStatus = statuses[0];
  const orderCode = isRecord(firstStatus)
    ? readInteger(firstStatus.code)
    : undefined;
  const orderError =
    isRecord(firstStatus) && typeof firstStatus.error === "string"
      ? firstStatus.error
      : undefined;
  logPerplTrade("close_order_response_received", {
    ...submittedOrderContext,
    httpStatus: response.status,
    batchCode,
    orderCode,
    orderError,
  });
  if (batchCode !== 0 || !isRecord(firstStatus) || orderCode !== 0) {
    const detail =
      orderError ??
      (typeof result.status.error === "string"
        ? result.status.error
        : "Perpl did not accept the close order.");
    logPerplTrade("close_order_forwarding_rejected", {
      ...submittedOrderContext,
      batchCode,
      orderCode,
      error: detail,
    });
    throw new Error(detail);
  }

  logPerplTrade("close_order_accepted_for_forwarding", submittedOrderContext);
  return { requestId };
}

export async function observePerplOrderOutcome(
  walletAddress: Address,
  requestId: number,
): Promise<PerplOrderOutcome | undefined> {
  const delaysMs = [0, 400, 600, 800, 1_000, 1_500, 2_500, 4_000, 6_000, 8_000];
  let lastOrder: Record<string, unknown> | undefined;
  let lastOutcome: PerplOrderOutcome | undefined;

  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    const delayMs = delaysMs[attempt] ?? 0;
    if (delayMs > 0) await wait(delayMs);

    let response: Response;
    try {
      response = await signedPerplRequest(
        walletAddress,
        "GET",
        "/v1/trading/order-history?count=100",
      );
    } catch (cause) {
      logPerplTrade("order_outcome_lookup_failed", {
        requestId,
        attempt: attempt + 1,
        stage: "transport",
        error: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }

    if (!response.ok) {
      logPerplTrade("order_outcome_lookup_failed", {
        requestId,
        attempt: attempt + 1,
        httpStatus: response.status,
      });
      continue;
    }

    let page: unknown;
    try {
      page = await readJson(response);
    } catch (cause) {
      logPerplTrade("order_outcome_lookup_failed", {
        requestId,
        attempt: attempt + 1,
        stage: "response_json",
        error: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }

    if (!isRecord(page) || !Array.isArray(page.d)) {
      logPerplTrade("order_outcome_lookup_invalid_shape", {
        requestId,
        attempt: attempt + 1,
        rootKeys: isRecord(page) ? Object.keys(page) : [],
      });
      return;
    }

    const order = page.d.find(
      (row: unknown) => isRecord(row) && readInteger(row.rq) === requestId,
    );
    if (!isRecord(order)) continue;
    lastOrder = order;

    const outcome = {
      requestId,
      attempt: attempt + 1,
      orderId: readInteger(order.oid),
      marketId: readInteger(order.mkt),
      accountId: readInteger(order.acc),
      orderStatus: readInteger(order.st),
      orderStatusName: getOrderStatusName(readInteger(order.st)),
      statusReason: readInteger(order.sr),
      statusReasonName: getOrderStatusReasonName(readInteger(order.sr)),
      failureReason: readInteger(order.fr),
      failureReasonName: getOrderFailureReasonName(readInteger(order.fr)),
      requestedSizeScaled: readInteger(order.os),
      filledSizeScaled: readInteger(order.fs),
      fillPriceScaled: readInteger(order.fp),
    };
    logPerplTrade("order_outcome_received", outcome);
    const status = outcome.orderStatus;
    const terminal =
      status !== undefined && ![0, 1, 2, 3, 8, 9].includes(status);
    lastOutcome = {
      ...(status !== undefined ? { orderStatus: status } : {}),
      ...(outcome.orderStatusName
        ? { orderStatusName: outcome.orderStatusName }
        : {}),
      ...(outcome.statusReasonName
        ? { statusReasonName: outcome.statusReasonName }
        : {}),
      ...(outcome.failureReasonName
        ? { failureReasonName: outcome.failureReasonName }
        : {}),
      ...(outcome.requestedSizeScaled !== undefined
        ? { requestedSizeScaled: outcome.requestedSizeScaled }
        : {}),
      ...(outcome.filledSizeScaled !== undefined
        ? { filledSizeScaled: outcome.filledSizeScaled }
        : {}),
      terminal,
    };

    // IOC orders should settle quickly. Continue polling while the exchange
    // still reports a pending/open/partially-filled state so the final result
    // and any settlement failure are visible in device logs.
    if (terminal) return lastOutcome;
  }

  if (lastOrder) {
    logPerplTrade("order_outcome_still_pending", {
      requestId,
      orderStatus: readInteger(lastOrder.st),
      statusReason: readInteger(lastOrder.sr),
      filledSizeScaled: readInteger(lastOrder.fs),
    });
  } else {
    logPerplTrade("order_outcome_not_found", {
      requestId,
      attempts: delaysMs.length,
    });
  }
  return lastOutcome;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Perpl returned invalid trading data.");
  }
}

function normalizeSymbol(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/-PERP$/, "");
}

function readInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function readPositiveNumber(value: unknown) {
  const number =
    typeof value === "string" || typeof value === "number"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parsePerplOrderBookLevels(
  value: unknown[],
  priceDecimals: number,
  sizeDecimals: number,
): PerplOrderBookSnapshot["bids"] {
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const price = readInteger(entry.p);
    const size = readInteger(entry.s);
    const orders = readInteger(entry.o);
    if (
      price === undefined ||
      price <= 0 ||
      size === undefined ||
      size <= 0 ||
      (orders !== undefined && orders <= 0)
    ) {
      return [];
    }
    return [
      {
        price: price / 10 ** priceDecimals,
        size: size / 10 ** sizeDecimals,
        ...(orders === undefined ? {} : { orders }),
      },
    ];
  });
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolves as soon as either the order history reports a final result or the
 * open positions show the expected change, whichever happens first. Position
 * polling is faster than order history, which can lag the exchange.
 */
export async function waitForPerplOrderResult(input: {
  walletAddress: Address;
  requestId: number;
  positionsReflectOrder: (positions: PerplOpenPosition[]) => boolean;
  timeoutMs?: number;
  retryOnRequestIdTooLow?: () => Promise<{ requestId: number }>;
}): Promise<
  | {
      source: "order";
      outcome: PerplOrderOutcome;
      requestId: number;
    }
  | {
      source: "positions";
      positions: PerplOpenPosition[];
      requestId: number;
    }
  | undefined
> {
  const waitForRequest = async (requestId: number) => {
    let settled = false;
    const deadline = Date.now() + (input.timeoutMs ?? 30_000);

    const pollPositions = async () => {
      while (!settled && Date.now() < deadline) {
        try {
          const positions = await fetchPerplOpenPositions(input.walletAddress);
          if (input.positionsReflectOrder(positions)) {
            return { source: "positions" as const, positions, requestId };
          }
        } catch {
          // Transient failures are retried until the deadline.
        }
        await wait(300);
      }
      return undefined;
    };
    const pollOrder = async () => {
      const outcome = await observePerplOrderOutcome(
        input.walletAddress,
        requestId,
      ).catch(() => undefined);
      return outcome?.terminal
        ? { source: "order" as const, outcome, requestId }
        : undefined;
    };

    return new Promise<
      | Awaited<ReturnType<typeof pollPositions>>
      | Awaited<ReturnType<typeof pollOrder>>
    >((resolve) => {
      let remaining = 2;
      for (const poll of [pollPositions(), pollOrder()]) {
        void poll.then((result) => {
          if (result) {
            settled = true;
            resolve(result);
          } else if (--remaining === 0) {
            resolve(undefined);
          }
        });
      }
    });
  };

  const result = await waitForRequest(input.requestId);
  if (
    result?.source !== "order" ||
    result.outcome.statusReasonName !== "OrderDescIdTooLow" ||
    !input.retryOnRequestIdTooLow
  ) {
    return result;
  }

  logPerplTrade("order_request_id_retry_started", {
    requestId: result.requestId,
    statusReasonName: result.outcome.statusReasonName,
  });
  let retry: { requestId: number };
  try {
    retry = await input.retryOnRequestIdTooLow();
  } catch (cause) {
    logPerplTrade("order_request_id_retry_failed", {
      requestId: result.requestId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
  if (retry.requestId <= result.requestId) {
    throw new Error("Perpl order retry must use a new request ID.");
  }
  logPerplTrade("order_request_id_retry_submitted", {
    previousRequestId: result.requestId,
    requestId: retry.requestId,
  });
  return waitForRequest(retry.requestId);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function getOrderStatusName(status: number | undefined) {
  return status === undefined
    ? undefined
    : ((
        {
          0: "Unspecified",
          1: "Pending",
          2: "Open",
          3: "PartiallyFilled",
          4: "Filled",
          5: "Canceled",
          6: "Expired",
          7: "Failed",
          8: "Untriggered",
          9: "Triggered",
          10: "Executed",
        } as Record<number, string>
      )[status] ?? "Unknown");
}

function getOrderStatusReasonName(reason: number | undefined) {
  return reason === undefined
    ? undefined
    : ((
        {
          15: "ForwardingReverted",
          16: "ImmediateOrCancelExecuted",
          17: "ImmediateOrderUnderMinimum",
          32: "OrderDescIdTooLow",
          34: "OrderForwardingNotAllowed",
          35: "OrderPlaced",
          36: "OrderPostFailed",
          43: "TakerOrderFilled",
          44: "TakerOrderSettlementFailed",
        } as Record<number, string>
      )[reason] ?? "OtherOrUnmapped");
}

export function getPerplOrderFailureMessage(
  outcome: PerplOrderOutcome | undefined,
  fallback: string,
) {
  if (outcome?.statusReasonName === "OrderDescIdTooLow") {
    return "Perpl rejected the order because its request ID was stale. Refresh your Perpl account and try again.";
  }
  return (
    outcome?.failureReasonName ??
    outcome?.statusReasonName ??
    outcome?.orderStatusName ??
    fallback
  );
}

function createPerplRequestId(
  walletAddress: Address,
  accountId: number,
  lastForwardedRequestId?: number,
) {
  const key = `${walletAddress.toLowerCase()}:${accountId}`;
  const previousRequestId = lastRequestIds.get(key) ?? 0;
  // Perpl's last forwarded ID is a small counter; timestamp-sized IDs get
  // rejected as OrderDescIdTooLow, so continue from it as the docs recommend.
  const requestId =
    Math.max(lastForwardedRequestId ?? 0, previousRequestId) + 1;
  logPerplTrade("request_id_generated", {
    accountId,
    requestId,
    lastForwardedRequestId,
    previousRequestId,
  });
  if (!Number.isFinite(requestId)) {
    throw new Error("Could not generate a valid Perpl request ID.");
  }
  lastRequestIds.set(key, requestId);
  return requestId;
}

function getOrderFailureReasonName(reason: number | undefined) {
  return reason === undefined
    ? undefined
    : ((
        {
          1: "InsufficientBalance",
          2: "InsufficientCollateralIncrease",
          3: "InsufficientCollateralInvert",
          4: "NoPositionToClose",
          5: "PerpetualSolvency",
          6: "NegativePositionValue",
          7: "ReferencePriceStale",
          8: "ExceedsMaxNegPnlCollat",
          9: "Other",
        } as Record<number, string>
      )[reason] ?? "Unknown");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
