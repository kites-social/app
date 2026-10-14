import { TRPCError } from "@trpc/server";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { z } from "zod";

import {
  COLLATERAL_DECIMALS,
  COLLATERAL_TOKEN_ADDRESS,
  MARKET_FACTORY_ADDRESS,
  OUTCOME_TOKEN_DECIMALS,
} from "../evm-config";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { decryptWalletPrivateKey } from "../wallet-crypto";

const marketTradeAbi = [
  {
    type: "function",
    name: "COLLATERAL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "FACTORY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "YES_TOKEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "NO_TOKEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "yesPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "noPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "resolved",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const poolTradeAbi = [
  {
    type: "function",
    name: "MARKET",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "COLLATERAL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "OUTCOME_TOKEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  {
    type: "function",
    name: "TRADING_END",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "initialLiquiditySeeded",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "swapExactCollateralForOutcome",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralIn", type: "uint256" },
      { name: "minOutcomeOut", type: "uint256" },
    ],
    outputs: [{ name: "outcomeOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "swapExactOutcomeForCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "outcomeIn", type: "uint256" },
      { name: "minCollateralOut", type: "uint256" },
    ],
    outputs: [{ name: "collateralOut", type: "uint256" }],
  },
] as const;

const erc20TradeAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

const addressSchema = z.string().refine(isAddress, "Invalid market address");

const tradeInput = z.object({
  marketAddress: addressSchema,
  outcome: z.enum(["yes", "no"]),
  action: z.enum(["buy", "sell"]),
  amount: z
    .string()
    .max(40)
    .regex(/^(?:\d+)(?:\.\d{1,18})?$/, "Enter a valid token amount"),
  slippageBps: z.number().int().min(1).max(10_000).default(500),
});
const executeTradeInput = tradeInput.extend({
  quotedAmountOut: z.string().regex(/^[1-9]\d{0,77}$/),
  minAmountOut: z.string().regex(/^(?:0|[1-9]\d{0,77})$/),
});

type TradeInput = z.infer<typeof tradeInput>;

interface TradeSnapshot {
  marketAddress: Address;
  poolAddress: Address;
  outcomeToken: Address;
  collateral: Address;
  inputDecimals: number;
  tradingEnd: bigint;
  balance: bigint;
  allowance: bigint;
  nativeBalance: bigint;
  amountIn: bigint;
}

const minimumAfterSlippage = (amountOut: bigint, slippageBps: number) =>
  (amountOut * (BigInt(10_000) - BigInt(slippageBps))) / BigInt(10_000);

const normalizeError = (error: unknown) =>
  error instanceof Error ? error.message : "The trade could not be completed.";

const swapFunctionName = (action: TradeInput["action"]) =>
  action === "buy"
    ? "swapExactCollateralForOutcome"
    : "swapExactOutcomeForCollateral";

const simulateOutputAmount = async (
  snapshot: TradeSnapshot,
  action: TradeInput["action"],
  account: Address,
) => {
  const { result } = await publicClient.simulateContract({
    account,
    address: snapshot.poolAddress,
    abi: poolTradeAbi,
    functionName: swapFunctionName(action),
    args: [snapshot.amountIn, BigInt(1)],
  });
  return result;
};

const readTradeSnapshot = async (
  input: TradeInput,
  account: Address,
): Promise<TradeSnapshot> => {
  const marketAddress = getAddress(input.marketAddress);
  const [collateral, factory, yesToken, noToken, yesPool, noPool, resolved] =
    await publicClient.multicall({
      contracts: [
        {
          address: marketAddress,
          abi: marketTradeAbi,
          functionName: "COLLATERAL",
        },
        {
          address: marketAddress,
          abi: marketTradeAbi,
          functionName: "FACTORY",
        },
        {
          address: marketAddress,
          abi: marketTradeAbi,
          functionName: "YES_TOKEN",
        },
        {
          address: marketAddress,
          abi: marketTradeAbi,
          functionName: "NO_TOKEN",
        },
        {
          address: marketAddress,
          abi: marketTradeAbi,
          functionName: "yesPool",
        },
        { address: marketAddress, abi: marketTradeAbi, functionName: "noPool" },
        {
          address: marketAddress,
          abi: marketTradeAbi,
          functionName: "resolved",
        },
      ] as const,
      allowFailure: false,
    });

  if (
    getAddress(collateral) !== COLLATERAL_TOKEN_ADDRESS ||
    getAddress(factory) !== MARKET_FACTORY_ADDRESS
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This is not a supported market from the configured factory using USDC collateral.",
    });
  }
  if (resolved) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This market has already resolved and can no longer be traded.",
    });
  }

  const poolAddress = getAddress(input.outcome === "yes" ? yesPool : noPool);
  const outcomeToken = getAddress(input.outcome === "yes" ? yesToken : noToken);
  const [poolMarket, poolCollateral, poolOutcome, tradingEnd, initialized] =
    await publicClient.multicall({
      contracts: [
        { address: poolAddress, abi: poolTradeAbi, functionName: "MARKET" },
        { address: poolAddress, abi: poolTradeAbi, functionName: "COLLATERAL" },
        {
          address: poolAddress,
          abi: poolTradeAbi,
          functionName: "OUTCOME_TOKEN",
        },
        {
          address: poolAddress,
          abi: poolTradeAbi,
          functionName: "TRADING_END",
        },
        {
          address: poolAddress,
          abi: poolTradeAbi,
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
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The market's pool configuration could not be verified.",
    });
  }
  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  if (!initialized || tradingEnd <= latestBlock.timestamp) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This market is not currently open for trading.",
    });
  }

  const inputDecimals =
    input.action === "buy" ? COLLATERAL_DECIMALS : OUTCOME_TOKEN_DECIMALS;
  let amountIn: bigint;
  try {
    amountIn = parseUnits(input.amount, inputDecimals);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Enter an amount with no more than ${inputDecimals} decimal places.`,
    });
  }
  if (amountIn <= BigInt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Trade amount must be greater than zero.",
    });
  }

  const inputToken =
    input.action === "buy" ? COLLATERAL_TOKEN_ADDRESS : outcomeToken;
  const [balance, allowance] = await publicClient.multicall({
    contracts: [
      {
        address: inputToken,
        abi: erc20TradeAbi,
        functionName: "balanceOf",
        args: [account],
      },
      {
        address: inputToken,
        abi: erc20TradeAbi,
        functionName: "allowance",
        args: [account, poolAddress],
      },
    ] as const,
    allowFailure: false,
  });
  const nativeBalance = await publicClient.getBalance({ address: account });

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

const loadSigningWallet = async (ctx: {
  db: {
    evmWallet: {
      findUnique: (args: { where: { userDid: string } }) => Promise<{
        address: string;
        encryptedPrivateKey: string | null;
        privateKeyNonce: string | null;
        encryptedDek: string | null;
        dekNonce: string | null;
        encryptionVersion: number | null;
      } | null>;
    };
  };
  session: { did: string };
}) => {
  const wallet = await ctx.db.evmWallet.findUnique({
    where: { userDid: ctx.session.did },
  });
  if (!wallet) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No EVM wallet is linked to this account yet.",
    });
  }

  if (
    wallet.encryptedPrivateKey === null ||
    wallet.privateKeyNonce === null ||
    wallet.encryptedDek === null ||
    wallet.dekNonce === null ||
    wallet.encryptionVersion === null
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This wallet is self-custodied on your device. Sign the trade in the app instead.",
    });
  }

  const address = getAddress(wallet.address);
  const privateKey = await decryptWalletPrivateKey(ctx.session.did, address, {
    encryptedPrivateKey: wallet.encryptedPrivateKey,
    privateKeyNonce: wallet.privateKeyNonce,
    encryptedDek: wallet.encryptedDek,
    dekNonce: wallet.dekNonce,
    encryptionVersion: wallet.encryptionVersion,
  });
  const account = privateKeyToAccount(privateKey);
  if (account.address !== address) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The linked wallet key does not match its stored address.",
    });
  }

  return { account, address };
};

export const tradesRouter = createTRPCRouter({
  approve: protectedProcedure
    .input(tradeInput)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadSigningWallet(ctx);
      const snapshot = await readTradeSnapshot(input, address);
      if (snapshot.balance < snapshot.amountIn) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            input.action === "buy"
              ? "Your USDC balance is lower than this trade amount."
              : "Your selected outcome-token balance is lower than this trade amount.",
        });
      }
      if (snapshot.nativeBalance === BigInt(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Your wallet needs MON on Monad Testnet to pay transaction gas.",
        });
      }
      if (snapshot.allowance >= snapshot.amountIn) {
        return { stage: "ready" as const, transactionHash: null };
      }

      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      try {
        if (snapshot.allowance > BigInt(0)) {
          const transactionHash = await walletClient.writeContract({
            address:
              input.action === "buy"
                ? snapshot.collateral
                : snapshot.outcomeToken,
            abi: erc20TradeAbi,
            functionName: "approve",
            args: [snapshot.poolAddress, BigInt(0)],
          });
          return { stage: "reset" as const, transactionHash };
        }

        const transactionHash = await walletClient.writeContract({
          address:
            input.action === "buy"
              ? snapshot.collateral
              : snapshot.outcomeToken,
          abi: erc20TradeAbi,
          functionName: "approve",
          args: [snapshot.poolAddress, snapshot.amountIn],
        });
        return { stage: "approval" as const, transactionHash };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Token approval could not be submitted: ${normalizeError(error)}`,
        });
      }
    }),

  execute: protectedProcedure
    .input(executeTradeInput)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadSigningWallet(ctx);
      const snapshot = await readTradeSnapshot(input, address);
      if (snapshot.balance < snapshot.amountIn) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Your trade-token balance changed and is now too low.",
        });
      }
      if (snapshot.nativeBalance === BigInt(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Your wallet needs MON on Monad Testnet to pay transaction gas.",
        });
      }
      if (snapshot.allowance < snapshot.amountIn) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Approve this token amount before submitting the trade.",
        });
      }

      const quotedAmountOut = BigInt(input.quotedAmountOut);
      const minAmountOut = BigInt(input.minAmountOut);
      const expectedMinimum = minimumAfterSlippage(
        quotedAmountOut,
        input.slippageBps,
      );
      if (quotedAmountOut <= BigInt(0) || minAmountOut !== expectedMinimum) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "The quote or slippage protection is invalid. Refresh and try again.",
        });
      }

      try {
        const exactOutput = await simulateOutputAmount(
          snapshot,
          input.action,
          address,
        );
        if (exactOutput <= BigInt(0)) {
          throw new Error("The pool returned no output for this amount.");
        }
        const executionMinimum =
          minimumAfterSlippage(exactOutput, input.slippageBps) > minAmountOut
            ? minimumAfterSlippage(exactOutput, input.slippageBps)
            : minAmountOut;
        if (exactOutput < executionMinimum) {
          throw new Error(
            "The quote changed beyond your slippage tolerance. Refresh and try again.",
          );
        }
        const { request } = await publicClient.simulateContract({
          account,
          address: snapshot.poolAddress,
          abi: poolTradeAbi,
          functionName: swapFunctionName(input.action),
          args: [snapshot.amountIn, executionMinimum],
        });
        const walletClient = createWalletClient({
          account,
          chain: monadTestnet,
          transport: http(),
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
            input.action === "buy"
              ? OUTCOME_TOKEN_DECIMALS
              : COLLATERAL_DECIMALS,
        };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `The swap could not be submitted. The quote may have changed; refresh and try again. ${normalizeError(error)}`,
        });
      }
    }),
});
