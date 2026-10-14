import { useCallback, useEffect, useRef, useState } from "react";
import { getRandomBytes } from "expo-crypto";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type LocalAccount,
} from "viem";
import { polygon } from "viem/chains";

import {
  subscribeToPolymarketOrderBook,
  type PolymarketOrderBookSnapshot,
} from "@kites-social/venues/src/prediction-markets/polymarket";
import { type PredictionMarketSnapshot } from "@kites-social/venues/src/types";

import { getAppChain } from "~/lib/web3/chains";
import {
  createPolymarketL2Signature,
  getOrRefreshPolymarketApiCredentials,
} from "./onboarding";

const CLOB_API = "https://clob.polymarket.com";
const PRICE_SCALE = BigInt(1_000_000);
const AMOUNT_SCALE = BigInt(1_000_000);
export const POLYMARKET_SHARE_DECIMALS = 6;
export const POLYMARKET_MINIMUM_SHARES_RAW = parseUnits(
  "5",
  POLYMARKET_SHARE_DECIMALS,
);
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ORDER_TYPE =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const EIP712_DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
  TypedDataSign: [
    { name: "contents", type: "Order" },
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

interface TradeInput {
  account: LocalAccount<"mera">;
  signerAddress: Address;
  depositWalletAddress: Address;
  market: PredictionMarketSnapshot;
  orderBook: OrderBook;
  outcome: "yes" | "no";
  action: "buy" | "sell";
  amount: string;
  slippageBps: number;
}

interface TradeResult {
  orderId: string;
  status: string;
  tradeIds: string[];
  transactionHashes: string[];
}

export interface OrderBook {
  asks: BookLevel[];
  bids: BookLevel[];
  minOrderSize: bigint;
  tickSize: bigint;
  version: string | null;
  negRisk: boolean;
}

interface StreamedOrderBook {
  assetId: string;
  levels: Pick<OrderBook, "bids" | "asks">;
}

interface BookLevel {
  price: bigint;
  size: bigint;
}

const positionBalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const CONDITIONAL_TOKENS = getAddress(
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
);
const POSITION_MANAGER = getAddress(
  "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
);

export async function getPolymarketOutcomeBalance(
  walletAddress: Address,
  assetId: string,
  positionSystem: "ctf" | "protocol-v2",
) {
  if (!/^\d+$/.test(assetId)) {
    throw new Error("Polymarket returned an invalid outcome token.");
  }
  return getAppChain(polygon.id).publicClient.readContract({
    address:
      positionSystem === "protocol-v2" ? POSITION_MANAGER : CONDITIONAL_TOKENS,
    abi: positionBalanceAbi,
    functionName: "balanceOf",
    args: [getAddress(walletAddress), BigInt(assetId)],
  });
}

export function usePolymarketTrade() {
  const executeTrade = useCallback(
    async (input: TradeInput): Promise<TradeResult> => {
      const signerAddress = getAddress(input.signerAddress);
      const depositWalletAddress = getAddress(input.depositWalletAddress);
      if (getAddress(input.account.address) !== signerAddress) {
        throw new Error("Unlock the wallet linked to your Polymarket account.");
      }
      if (
        !Number.isInteger(input.slippageBps) ||
        input.slippageBps < 0 ||
        input.slippageBps > 10_000
      ) {
        throw new Error("Choose a valid slippage tolerance.");
      }
      const market = input.market;
      if (market.isClosed || market.isResolved) {
        throw new Error(
          "This Polymarket market is no longer accepting orders.",
        );
      }
      const assetId =
        input.outcome === "yes" ? market.yesAssetId : market.noAssetId;
      if (!assetId || !/^\d+$/.test(assetId)) {
        throw new Error("This market does not have a valid outcome token.");
      }

      const credentials = await getOrRefreshPolymarketApiCredentials(
        signerAddress,
        (request) => input.account.signTypedData(request),
      );
      const book = input.orderBook;
      const amount = parseAmount(input.amount, book, input.action);
      const execution = createMarketOrder(amount, book, input);
      const domain = getOrderDomain(book);
      const timestamp = BigInt(Date.now());
      const salt = createOrderSalt();
      const order = {
        salt: BigInt(salt),
        maker: depositWalletAddress,
        signer: depositWalletAddress,
        tokenId: BigInt(assetId),
        makerAmount: execution.makerAmount,
        takerAmount: execution.takerAmount,
        side: input.action === "buy" ? 0 : 1,
        signatureType: 3,
        timestamp,
        metadata: ZERO_BYTES32,
        builder: ZERO_BYTES32,
      } as const;
      const typedData = {
        domain,
        types: ORDER_TYPES,
        primaryType: "TypedDataSign",
        message: {
          contents: order,
          name: "DepositWallet",
          version: "1",
          chainId: BigInt(polygon.id),
          verifyingContract: depositWalletAddress,
          salt: ZERO_BYTES32,
        },
      } as const;
      const innerSignature = await input.account.signTypedData(typedData);
      const signature = wrapDepositWalletSignature(
        domain,
        order,
        innerSignature,
      );
      const body = JSON.stringify({
        deferExec: false,
        order: {
          builder: ZERO_BYTES32,
          expiration: "0",
          maker: depositWalletAddress,
          makerAmount: execution.makerAmount.toString(),
          metadata: ZERO_BYTES32,
          salt,
          side: input.action.toUpperCase(),
          signature,
          signatureType: 3,
          signer: depositWalletAddress,
          takerAmount: execution.takerAmount.toString(),
          timestamp: timestamp.toString(),
          tokenId: assetId,
        },
        orderType: "FAK",
        owner: credentials.apiKey,
      });
      const requestTimestamp = String(Math.floor(Date.now() / 1000));
      const requestPath = "/order";
      const requestSignature = createPolymarketL2Signature(
        credentials.secret,
        `${requestTimestamp}POST${requestPath}${body}`,
      );
      const response = await fetch(`${CLOB_API}${requestPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          POLY_ADDRESS: signerAddress,
          POLY_API_KEY: credentials.apiKey,
          POLY_PASSPHRASE: credentials.passphrase,
          POLY_SIGNATURE: requestSignature,
          POLY_TIMESTAMP: requestTimestamp,
        },
        body,
      });
      const result = await readOrderResponse(response);
      if (result.success !== true) {
        throw new Error(
          typeof result.errorMsg === "string" && result.errorMsg
            ? result.errorMsg
            : "Polymarket rejected the order.",
        );
      }
      if (typeof result.orderID !== "string" || !result.orderID) {
        throw new Error(
          "Polymarket accepted the order without returning its ID.",
        );
      }
      return {
        orderId: result.orderID,
        status: typeof result.status === "string" ? result.status : "accepted",
        tradeIds: asStringArray(result.tradeIDs),
        transactionHashes: asStringArray(result.transactionsHashes),
      };
    },
    [],
  );

  return { executeTrade };
}

export async function fetchPolymarketOrderBook(
  assetId: string,
): Promise<OrderBook> {
  const url = new URL(`${CLOB_API}/book`);
  url.searchParams.set("token_id", assetId);
  const response = await fetch(url);
  const value: unknown = await readJson(response, "Polymarket order book");
  if (!response.ok) {
    throw new Error(
      `Unable to load the Polymarket order book (${response.status}).`,
    );
  }
  if (!isRecord(value)) {
    throw new Error("Polymarket returned an invalid order book.");
  }
  const tickSize = parseDecimal(value.tick_size);
  const minOrderSize = parseDecimal(value.min_order_size);
  if (
    tickSize === null ||
    tickSize <= BigInt(0) ||
    minOrderSize === null ||
    minOrderSize <= BigInt(0)
  ) {
    throw new Error("Polymarket returned invalid market trading constraints.");
  }
  return {
    asks: parseBookLevels(value.asks),
    bids: parseBookLevels(value.bids),
    minOrderSize,
    tickSize,
    version: typeof value.version === "string" ? value.version : null,
    negRisk: value.neg_risk === true,
  };
}

export function usePolymarketOrderBook(assetId?: string, enabled = true) {
  const queryClient = useQueryClient();
  const [streamError, setStreamError] = useState<Error>();
  const latestStreamBook = useRef<StreamedOrderBook | undefined>(undefined);
  const [streamBook, setStreamBook] = useState<StreamedOrderBook>();
  const queryKey = ["polymarket-order-book", assetId] as const;
  const query = useQuery<OrderBook>({
    queryKey,
    enabled: enabled && Boolean(assetId),
    staleTime: 0,
    refetchInterval: enabled && assetId ? 30_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      if (!assetId) {
        throw new Error("Load a Polymarket outcome before trading.");
      }
      const orderBook = await fetchPolymarketOrderBook(assetId);
      const latestBook = latestStreamBook.current;
      return latestBook?.assetId === assetId
        ? { ...orderBook, ...latestBook.levels }
        : orderBook;
    },
  });

  useEffect(() => {
    latestStreamBook.current = undefined;
    setStreamBook(undefined);
    if (!enabled || !assetId) {
      setStreamError(undefined);
      return;
    }
    setStreamError(undefined);
    return subscribeToPolymarketOrderBook(
      assetId,
      (book) => {
        const streamedBook = {
          assetId,
          levels: parseStreamOrderBook(book),
        };
        latestStreamBook.current = streamedBook;
        setStreamBook(streamedBook);
        setStreamError(undefined);
        queryClient.setQueryData<OrderBook>(
          ["polymarket-order-book", assetId],
          (current) =>
            current ? { ...current, ...streamedBook.levels } : current,
        );
      },
      (error) => {
        latestStreamBook.current = undefined;
        setStreamBook(undefined);
        setStreamError(error);
      },
    );
  }, [assetId, enabled, queryClient]);

  const displayBook =
    enabled && streamBook && streamBook.assetId === assetId
      ? streamBook.levels
      : query.data;
  return { ...query, streamError, displayBook };
}

export async function checkPolymarketTradingEligibility(
  action: TradeInput["action"],
): Promise<true> {
  const response = await fetch("https://polymarket.com/api/geoblock");
  const value: unknown = await readJson(response, "Polymarket eligibility");
  if (!response.ok) {
    throw new Error(
      `Unable to verify Polymarket trading eligibility (${response.status}).`,
    );
  }
  if (!isRecord(value) || typeof value.blocked !== "boolean") {
    throw new Error("Polymarket returned invalid trading eligibility data.");
  }
  if (value.blocked && action === "buy") {
    const country =
      typeof value.country === "string" ? value.country.trim() : "";
    const region = typeof value.region === "string" ? value.region.trim() : "";
    const location = [country, region].filter(Boolean).join("-");
    throw new Error(
      `Polymarket does not allow opening trades from your location${location ? ` (${location})` : ""}.`,
    );
  }
  return true;
}

function parseAmount(
  value: string,
  book: OrderBook,
  action: TradeInput["action"],
) {
  if (!/^(?:\d+)(?:\.\d+)?$/.test(value)) {
    throw new Error("Enter a valid trade amount.");
  }
  let rawAmount: bigint;
  try {
    rawAmount = parseUnits(value, 6);
  } catch {
    throw new Error("Enter an amount with no more than 6 decimal places.");
  }
  if (rawAmount <= BigInt(0)) {
    throw new Error("Trade amount must be greater than zero.");
  }
  const supportedDecimals =
    action === "buy" ? Math.min(6, priceDecimals(book.tickSize) + 2) : 2;
  const roundedAmount = floorToDecimals(rawAmount, supportedDecimals);
  if (roundedAmount !== rawAmount) {
    throw new Error(
      `This market supports up to ${supportedDecimals} decimal places for this amount.`,
    );
  }
  return rawAmount;
}

function createMarketOrder(
  amount: bigint,
  book: OrderBook,
  input: Pick<TradeInput, "action" | "slippageBps">,
) {
  const sizeDecimals = 2;
  const amountDecimals = Math.min(
    6,
    priceDecimals(book.tickSize) + sizeDecimals,
  );
  const liquidityPrice = getLiquidityPrice(
    input.action === "buy" ? book.asks : book.bids,
    amount,
    input.action,
  );
  const slippageAdjustedPrice =
    input.action === "buy"
      ? ceilDiv(
          liquidityPrice * BigInt(10_000 + input.slippageBps),
          BigInt(10_000),
        )
      : (liquidityPrice * BigInt(10_000 - input.slippageBps)) / BigInt(10_000);
  const limitPrice =
    input.action === "buy"
      ? roundUpToStep(slippageAdjustedPrice, book.tickSize)
      : roundDownToStep(slippageAdjustedPrice, book.tickSize);
  const boundedPrice =
    input.action === "buy"
      ? limitPrice > PRICE_SCALE
        ? PRICE_SCALE
        : limitPrice
      : limitPrice < book.tickSize
        ? book.tickSize
        : limitPrice;
  if (boundedPrice <= BigInt(0) || boundedPrice > PRICE_SCALE) {
    throw new Error(
      "The market has no executable price at this slippage setting.",
    );
  }

  const makerAmount =
    input.action === "buy"
      ? floorToDecimals(amount, amountDecimals)
      : floorToDecimals(amount, sizeDecimals);
  const takerAmount =
    input.action === "buy"
      ? floorToDecimals(
          (makerAmount * PRICE_SCALE) / boundedPrice,
          sizeDecimals,
        )
      : floorToDecimals(
          (makerAmount * boundedPrice) / PRICE_SCALE,
          amountDecimals,
        );
  const shareAmount = input.action === "buy" ? takerAmount : makerAmount;
  const minimumOrderSize =
    book.minOrderSize > POLYMARKET_MINIMUM_SHARES_RAW
      ? book.minOrderSize
      : POLYMARKET_MINIMUM_SHARES_RAW;
  if (shareAmount < minimumOrderSize) {
    throw new Error(
      `The minimum Polymarket order size is ${formatUnits6(minimumOrderSize)} shares.`,
    );
  }
  if (makerAmount <= BigInt(0) || takerAmount <= BigInt(0)) {
    throw new Error(
      "The amount is too small to meet this market's order precision.",
    );
  }
  return {
    makerAmount,
    takerAmount,
  };
}

function getLiquidityPrice(
  levels: BookLevel[],
  amount: bigint,
  action: TradeInput["action"],
) {
  const orderedLevels = levels
    .slice()
    .sort((left, right) =>
      action === "buy"
        ? left.price < right.price
          ? -1
          : left.price > right.price
            ? 1
            : 0
        : left.price > right.price
          ? -1
          : left.price < right.price
            ? 1
            : 0,
    );
  let available = BigInt(0);
  for (const level of orderedLevels) {
    available +=
      action === "buy" ? (level.price * level.size) / PRICE_SCALE : level.size;
    if (available >= amount) return level.price;
  }
  const worstAvailablePrice = orderedLevels[orderedLevels.length - 1]?.price;
  if (worstAvailablePrice !== undefined) return worstAvailablePrice;
  throw new Error("There is no liquidity available for this outcome.");
}

function getOrderDomain(book: OrderBook) {
  let version: string;
  let verifyingContract: Address;
  if (book.version === "v2") {
    version = "3";
    verifyingContract = getAddress(
      "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
    );
  } else {
    version = "2";
    verifyingContract = getAddress(
      book.negRisk
        ? "0xe2222d279d744050d28e00520010520000310F59"
        : "0xE111180000d2663C0091e4f400237545B87B996B",
    );
  }
  return {
    name: "Polymarket CTF Exchange",
    version,
    chainId: polygon.id,
    verifyingContract,
  } as const;
}

function wrapDepositWalletSignature(
  domain: ReturnType<typeof getOrderDomain>,
  order: {
    salt: bigint;
    maker: Address;
    signer: Address;
    tokenId: bigint;
    makerAmount: bigint;
    takerAmount: bigint;
    side: number;
    signatureType: number;
    timestamp: bigint;
    metadata: typeof ZERO_BYTES32;
    builder: typeof ZERO_BYTES32;
  },
  innerSignature: `0x${string}`,
) {
  const appDomainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        keccak256(toHex(EIP712_DOMAIN_TYPE)),
        keccak256(toHex(domain.name)),
        keccak256(toHex(domain.version)),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
  const contentsHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        keccak256(toHex(ORDER_TYPE)),
        order.salt,
        order.maker,
        order.signer,
        order.tokenId,
        order.makerAmount,
        order.takerAmount,
        order.side,
        order.signatureType,
        order.timestamp,
        order.metadata,
        order.builder,
      ],
    ),
  );
  return concatHex([
    innerSignature,
    appDomainSeparator,
    contentsHash,
    toHex(ORDER_TYPE),
    toHex(ORDER_TYPE.length, { size: 2 }),
  ]);
}

function createOrderSalt() {
  return getRandomBytes(6).reduce((value, byte) => value * 256 + byte, 0);
}

function parseBookLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((level) => {
    if (!isRecord(level)) return [];
    const price = parseDecimal(level.price);
    const size = parseDecimal(level.size);
    return price !== null &&
      price > BigInt(0) &&
      price <= PRICE_SCALE &&
      size !== null &&
      size > BigInt(0)
      ? [{ price, size }]
      : [];
  });
}

function parseStreamOrderBook(
  book: PolymarketOrderBookSnapshot,
): Pick<OrderBook, "bids" | "asks"> {
  return {
    bids: parseStreamBookLevels(book.bids),
    asks: parseStreamBookLevels(book.asks),
  };
}

function parseStreamBookLevels(
  levels: PolymarketOrderBookSnapshot["bids"],
): BookLevel[] {
  return levels.flatMap((level) => {
    const price = parseDecimal(level.price);
    const size = parseDecimal(level.size);
    return price !== null &&
      price > BigInt(0) &&
      price <= PRICE_SCALE &&
      size !== null &&
      size > BigInt(0)
      ? [{ price, size }]
      : [];
  });
}

function parseDecimal(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    return parseUnits(String(value), 6);
  } catch {
    return null;
  }
}

function priceDecimals(tickSize: bigint) {
  const normalized = formatUnits6(tickSize)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return normalized.split(".")[1]?.length ?? 0;
}

function floorToDecimals(value: bigint, decimals: number) {
  const precision = BigInt(10) ** BigInt(6 - decimals);
  return (value / precision) * precision;
}

function roundUpToStep(value: bigint, step: bigint) {
  return ceilDiv(value, step) * step;
}

function roundDownToStep(value: bigint, step: bigint) {
  return (value / step) * step;
}

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - BigInt(1)) / divisor;
}

function formatUnits6(value: bigint) {
  const whole = (value / AMOUNT_SCALE).toString();
  const fraction = (value % AMOUNT_SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} returned an invalid response (${response.status}).`,
    );
  }
}

async function readOrderResponse(response: Response) {
  const value = await readJson(response, "Polymarket");
  if (!isRecord(value)) {
    throw new Error("Polymarket returned an invalid order response.");
  }
  if (!response.ok) {
    const errorMessage = [value.errorMsg, value.error, value.message].find(
      (message): message is string =>
        typeof message === "string" && message.trim().length > 0,
    );
    throw new Error(
      errorMessage ??
        `Polymarket order submission failed (${response.status}).`,
    );
  }
  return value;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
