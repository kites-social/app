import {
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hash,
  type LocalAccount,
} from "viem";
import { monadTestnet } from "viem/chains";

import { constantProductPoolAbi } from "../abis/constant-product-pool";
import { erc20Abi } from "../abis/erc20";
import { MarketAbi } from "../abis/market";
import { monadTestnetPublicClient } from "../client";
import {
  COLLATERAL_TOKEN_ADDRESS,
  COLLATERAL_TOKEN_DECIMALS,
  MARKET_FACTORY_ADDRESS,
  OUTCOME_TOKEN_DECIMALS,
} from "../constants";

export type TradeOutcome = "yes" | "no";
export type TradeAction = "buy" | "sell";

export interface ClientTradeIntent {
  marketAddress: Address;
  outcome: TradeOutcome;
  action: TradeAction;
  /** Human-readable amount, in the input token's decimals. */
  amount: string;
  slippageBps: number;
  /** Exact output the client quoted, used to reject stale quotes server-side style. */
  quotedAmountOut: string;
  /** Client-computed minimum after slippage. */
  minAmountOut: string;
}

export type TradeApprovalResult =
  | { stage: "ready"; transactionHash: null }
  | { stage: "reset" | "approval"; transactionHash: Hash };

export interface TradeExecutionResult {
  transactionHash: Hash;
  poolAddress: Address;
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  inputDecimals: number;
  outputDecimals: number;
}

interface TradeSnapshot {
  marketAddress: Address;
  poolAddress: Address;
  outcomeToken: Address;
  collateral: Address;
  inputDecimals: number;
  balance: bigint;
  allowance: bigint;
  nativeBalance: bigint;
  amountIn: bigint;
  tradingEnd: bigint;
}

const swapFunctionName = (action: TradeAction) =>
  action === "buy"
    ? "swapExactCollateralForOutcome"
    : "swapExactOutcomeForCollateral";

const minimumAfterSlippage = (amountOut: bigint, slippageBps: number) =>
  (amountOut * (BigInt(10_000) - BigInt(slippageBps))) / BigInt(10_000);

const requireSigningAccount = (
  account: LocalAccount<"mera">,
): LocalAccount<"mera"> => {
  if (!account.signTransaction) {
    throw new Error("The wallet session cannot sign transactions.");
  }
  return account;
};

const readTradeSnapshot = async (
  intent: ClientTradeIntent,
  account: Address,
): Promise<TradeSnapshot> => {
  const marketAddress = getAddress(intent.marketAddress);
  const [collateral, factory, yesToken, noToken, yesPool, noPool, resolved] =
    await monadTestnetPublicClient.multicall({
      contracts: [
        {
          address: marketAddress,
          abi: MarketAbi,
          functionName: "COLLATERAL",
        },
        {
          address: marketAddress,
          abi: MarketAbi,
          functionName: "FACTORY",
        },
        {
          address: marketAddress,
          abi: MarketAbi,
          functionName: "YES_TOKEN",
        },
        {
          address: marketAddress,
          abi: MarketAbi,
          functionName: "NO_TOKEN",
        },
        { address: marketAddress, abi: MarketAbi, functionName: "yesPool" },
        { address: marketAddress, abi: MarketAbi, functionName: "noPool" },
        { address: marketAddress, abi: MarketAbi, functionName: "resolved" },
      ] as const,
      allowFailure: false,
    });

  if (
    getAddress(collateral) !== COLLATERAL_TOKEN_ADDRESS ||
    getAddress(factory) !== MARKET_FACTORY_ADDRESS
  ) {
    throw new Error(
      "This is not a supported market from the configured factory using USDC collateral.",
    );
  }
  if (resolved) {
    throw new Error(
      "This market has already resolved and can no longer be traded.",
    );
  }

  const poolAddress = getAddress(intent.outcome === "yes" ? yesPool : noPool);
  const outcomeToken = getAddress(intent.outcome === "yes" ? yesToken : noToken);
  const [poolMarket, poolCollateral, poolOutcome, tradingEnd, initialized] =
    await monadTestnetPublicClient.multicall({
      contracts: [
        {
          address: poolAddress,
          abi: constantProductPoolAbi,
          functionName: "MARKET",
        },
        {
          address: poolAddress,
          abi: constantProductPoolAbi,
          functionName: "COLLATERAL",
        },
        {
          address: poolAddress,
          abi: constantProductPoolAbi,
          functionName: "OUTCOME_TOKEN",
        },
        {
          address: poolAddress,
          abi: constantProductPoolAbi,
          functionName: "TRADING_END",
        },
        {
          address: poolAddress,
          abi: constantProductPoolAbi,
          functionName: "initialLiquiditySeeded",
        },
      ] as const,
      allowFailure: false,
    });

  if (
    getAddress(poolMarket) !== marketAddress ||
    getAddress(poolCollateral) !== COLLATERAL_TOKEN_ADDRESS ||
    getAddress(poolOutcome) !== outcomeToken
  ) {
    throw new Error("The market's pool configuration could not be verified.");
  }
  const latestBlock = await monadTestnetPublicClient.getBlock({
    blockTag: "latest",
  });
  if (!initialized || tradingEnd <= latestBlock.timestamp) {
    throw new Error("This market is not currently open for trading.");
  }

  const inputDecimals =
    intent.action === "buy" ? COLLATERAL_TOKEN_DECIMALS : OUTCOME_TOKEN_DECIMALS;
  let amountIn: bigint;
  try {
    amountIn = parseUnits(intent.amount, inputDecimals);
  } catch {
    throw new Error(
      `Enter an amount with no more than ${inputDecimals} decimal places.`,
    );
  }
  if (amountIn <= BigInt(0)) {
    throw new Error("Trade amount must be greater than zero.");
  }

  const inputToken =
    intent.action === "buy" ? COLLATERAL_TOKEN_ADDRESS : outcomeToken;
  const [balance, allowance] = await monadTestnetPublicClient.multicall({
    contracts: [
      {
        address: inputToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      },
      {
        address: inputToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, poolAddress],
      },
    ] as const,
    allowFailure: false,
  });
  const nativeBalance = await monadTestnetPublicClient.getBalance({
    address: account,
  });

  return {
    marketAddress,
    poolAddress,
    outcomeToken,
    collateral: COLLATERAL_TOKEN_ADDRESS,
    inputDecimals,
    tradingEnd,
    balance,
    allowance,
    nativeBalance,
    amountIn,
  };
};

const assertTradeFunds = (snapshot: TradeSnapshot, action: TradeAction) => {
  if (snapshot.balance < snapshot.amountIn) {
    throw new Error(
      action === "buy"
        ? "Your USDC balance is lower than this trade amount."
        : "Your selected outcome-token balance is lower than this trade amount.",
    );
  }
  if (snapshot.nativeBalance === BigInt(0)) {
    throw new Error(
      "Your wallet needs MON on Monad Testnet to pay transaction gas.",
    );
  }
};

/**
 * Ensures the pool can spend the trade's input token. Mirrors the previous
 * server flow: reset a non-zero allowance to zero first on some tokens, then
 * approve the exact amount.
 */
export async function approveTrade(
  account: LocalAccount<"mera">,
  intent: ClientTradeIntent,
): Promise<TradeApprovalResult> {
  const snapshot = await readTradeSnapshot(intent, account.address);
  assertTradeFunds(snapshot, intent.action);

  if (snapshot.allowance >= snapshot.amountIn) {
    return { stage: "ready", transactionHash: null };
  }

  const walletClient = createWalletClient({
    account: requireSigningAccount(account),
    chain: monadTestnet,
    transport: http(),
  });
  const token =
    intent.action === "buy"
      ? COLLATERAL_TOKEN_ADDRESS
      : snapshot.outcomeToken;

  try {
    if (snapshot.allowance > BigInt(0)) {
      const transactionHash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [snapshot.poolAddress, BigInt(0)],
      });
      return { stage: "reset", transactionHash };
    }

    const transactionHash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [snapshot.poolAddress, snapshot.amountIn],
    });
    return { stage: "approval", transactionHash };
  } catch (error) {
    throw new Error(
      `Token approval could not be submitted: ${normalizeTradeError(error)}`,
    );
  }
}

/** Verifies the quote against a fresh simulation, then submits the swap. */
export async function executeTrade(
  account: LocalAccount<"mera">,
  intent: ClientTradeIntent,
): Promise<TradeExecutionResult> {
  const snapshot = await readTradeSnapshot(intent, account.address);
  assertTradeFunds(snapshot, intent.action);

  if (snapshot.allowance < snapshot.amountIn) {
    throw new Error("Approve this token amount before submitting the trade.");
  }

  const quotedAmountOut = BigInt(intent.quotedAmountOut);
  const minAmountOut = BigInt(intent.minAmountOut);
  const expectedMinimum = minimumAfterSlippage(
    quotedAmountOut,
    intent.slippageBps,
  );
  if (quotedAmountOut <= BigInt(0) || minAmountOut !== expectedMinimum) {
    throw new Error(
      "The quote or slippage protection is invalid. Refresh and try again.",
    );
  }

  const walletClient = createWalletClient({
    account: requireSigningAccount(account),
    chain: monadTestnet,
    transport: http(),
  });

  try {
    const { result: exactOutput } =
      await monadTestnetPublicClient.simulateContract({
        account: account.address,
        address: snapshot.poolAddress,
        abi: constantProductPoolAbi,
        functionName: swapFunctionName(intent.action),
        args: [snapshot.amountIn, BigInt(1)],
      });
    if (exactOutput <= BigInt(0)) {
      throw new Error("The pool returned no output for this amount.");
    }

    const simulatedMinimum = minimumAfterSlippage(
      exactOutput,
      intent.slippageBps,
    );
    const executionMinimum =
      simulatedMinimum > minAmountOut ? simulatedMinimum : minAmountOut;
    if (exactOutput < executionMinimum) {
      throw new Error(
        "The quote changed beyond your slippage tolerance. Refresh and try again.",
      );
    }

    const { request } = await monadTestnetPublicClient.simulateContract({
      account: account.address,
      address: snapshot.poolAddress,
      abi: constantProductPoolAbi,
      functionName: swapFunctionName(intent.action),
      args: [snapshot.amountIn, executionMinimum],
    });

    const transactionHash = await walletClient.writeContract(request);
    return {
      transactionHash,
      poolAddress: snapshot.poolAddress,
      amountIn: snapshot.amountIn.toString(),
      expectedAmountOut: exactOutput.toString(),
      minAmountOut: executionMinimum.toString(),
      inputDecimals: snapshot.inputDecimals,
      outputDecimals:
        intent.action === "buy"
          ? OUTCOME_TOKEN_DECIMALS
          : COLLATERAL_TOKEN_DECIMALS,
    };
  } catch (error) {
    throw new Error(
      `The swap could not be submitted. The quote may have changed; refresh and try again. ${normalizeTradeError(error)}`,
    );
  }
}

const normalizeTradeError = (error: unknown) =>
  error instanceof Error ? error.message : "The trade could not be completed.";
