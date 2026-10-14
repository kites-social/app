import { TRPCError } from "@trpc/server";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { z } from "zod";

import { Prisma } from "@kites-social/db";

import {
  COLLATERAL_DECIMALS,
  COLLATERAL_TOKEN_ADDRESS,
  MARKET_FACTORY_ADDRESS,
} from "../evm-config";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { decryptWalletPrivateKey } from "../wallet-crypto";

const FUNDING_TARGET = parseUnits("10000", COLLATERAL_DECIMALS);
const FUNDING_WINDOW_SECONDS = 5 * 24 * 60 * 60;
const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const DEV_FUNDING_WINDOW_SECONDS = 2 * 60;
const DEV_TRADING_END_BUFFER_SECONDS = 60;
const DEV_MIN_TRADING_DURATION_SECONDS =
  DEV_FUNDING_WINDOW_SECONDS + DEV_TRADING_END_BUFFER_SECONDS;

const getMarketFundingDeadline = (
  tradingEnd: bigint,
  nowSeconds = Math.floor(Date.now() / 1_000),
) => {
  const now = BigInt(nowSeconds);

  if (IS_DEVELOPMENT) {
    if (tradingEnd < now + BigInt(DEV_MIN_TRADING_DURATION_SECONDS)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "In development, the market end must be at least 3 minutes from now.",
      });
    }

    const preferredDeadline = now + BigInt(DEV_FUNDING_WINDOW_SECONDS);
    const latestSafeDeadline =
      tradingEnd - BigInt(DEV_TRADING_END_BUFFER_SECONDS);
    return preferredDeadline < latestSafeDeadline
      ? preferredDeadline
      : latestSafeDeadline;
  }

  const fundingDeadline = now + BigInt(FUNDING_WINDOW_SECONDS);
  if (tradingEnd <= fundingDeadline) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Trading must end after the 5-day funding window.",
    });
  }

  return fundingDeadline;
};

const createParamsComponents = [
  { name: "fundingTarget", type: "uint256" },
  { name: "fundingDeadline", type: "uint256" },
  { name: "tradingEnd", type: "uint256" },
  { name: "question", type: "string" },
  { name: "resolutionCriteria", type: "string" },
] as const;

const marketFactoryAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: createParamsComponents,
      },
    ],
    outputs: [{ name: "market", type: "address" }],
  },
  {
    type: "function",
    name: "createAndContribute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: createParamsComponents,
      },
      { name: "contribution", type: "uint256" },
      { name: "yesProbabilityBps", type: "uint16" },
    ],
    outputs: [{ name: "market", type: "address" }],
  },

  {
    type: "event",
    name: "MarketCreated",
    anonymous: false,
    inputs: [
      { name: "market", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "yesToken", type: "address", indexed: false },
      { name: "noToken", type: "address", indexed: false },
      { name: "question", type: "string", indexed: false },
    ],
  },
] as const;

const marketRegistryAbi = [
  {
    type: "function",
    name: "creatorMarketCount",
    stateMutability: "view",
    inputs: [{ name: "creator", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorMarketAt",
    stateMutability: "view",
    inputs: [
      { name: "creator", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const marketReadAbi = [
  {
    type: "function",
    name: "yesAllocationOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "noAllocationOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "openingProbabilityBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
] as const;

const erc20Abi = [
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
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const marketFundingAbi = [
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
    name: "FUNDING_TARGET",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "FUNDING_DEADLINE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalContributions",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "contributionOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allocationClaimed",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "contribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "yesProbabilityBps", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimAllocation",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
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
    name: "resolved",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "yesWon",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "finalOutcome",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "RESOLUTION_HUB",
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
    name: "redeemOutcomeToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "outcomeToken", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "syncFundingState",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

const resolutionHubAbi = [
  {
    type: "function",
    name: "resolutions",
    stateMutability: "view",
    inputs: [{ name: "market", type: "address" }],
    outputs: [
      { name: "phase", type: "uint8" },
      { name: "proposedOutcome", type: "uint8" },
      { name: "firstDisputeOutcome", type: "uint8" },
      { name: "councilOutcome", type: "uint8" },
      { name: "secondDisputeOutcome", type: "uint8" },
      { name: "holderOutcome", type: "uint8" },
      { name: "finalOutcome", type: "uint8" },
      { name: "resolver", type: "address" },
      { name: "firstDisputer", type: "address" },
      { name: "secondDisputer", type: "address" },
      { name: "finalEscalator", type: "address" },
      { name: "deadline", type: "uint64" },
      { name: "attesterVoteStartedAt", type: "uint64" },
      { name: "holderSnapshot", type: "uint48" },
      { name: "holderSnapshotSupply", type: "uint256" },
      { name: "resolverBond", type: "uint256" },
      { name: "firstDisputeBond", type: "uint256" },
      { name: "secondDisputeBond", type: "uint256" },
      { name: "councilVotesCast", type: "uint256" },
      { name: "holderVotesCast", type: "uint256" },
      { name: "attesterVotesCast", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "settings",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "resolverBondAmount", type: "uint256" },
      { name: "initialDisputeBondAmount", type: "uint256" },
      { name: "escalatorBondAmount", type: "uint256" },
      { name: "minimumFinalEscalatorBalance", type: "uint256" },
      { name: "initialChallengePeriod", type: "uint64" },
      { name: "councilVotingPeriod", type: "uint64" },
      { name: "councilChallengePeriod", type: "uint64" },
      { name: "holderVotingPeriod", type: "uint64" },
      { name: "finalEscalationPeriod", type: "uint64" },
      { name: "attesterVotingPeriod", type: "uint64" },
      { name: "attesterReplacementDelay", type: "uint64" },
      { name: "councilQuorumBps", type: "uint16" },
      { name: "councilApprovalBps", type: "uint16" },
      { name: "holderQuorumBps", type: "uint16" },
      { name: "holderApprovalBps", type: "uint16" },
      { name: "attesterQuorumBps", type: "uint16" },
      { name: "attesterApprovalBps", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "proposeResolution",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "outcome", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeUnchallengedProposal",
    stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }],
    outputs: [],
  },
] as const;

const contributionSchema = z
  .string()
  .max(32)
  .regex(
    /^(?:\d+)(?:\.\d{1,6})?$/,
    "Enter a USDC amount with up to 6 decimals",
  );

const createMarketSchema = z.object({
  question: z.string().trim().min(1).max(256),
  resolutionCriteria: z.string().trim().min(1).max(2_000),
  tradingEnd: z.number().int().positive().safe(),
  contribution: contributionSchema,
  yesProbabilityBps: z.number().int().min(0).max(10_000),
});

const postMarketAddressSchema = z.string().refine(isAddress, {
  message: "Enter a valid EVM market address",
});
const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

const fundingMarketAddressSchema = z.string().refine(isAddress, {
  message: "Enter a valid EVM market address",
});
const contributeToMarketSchema = z.object({
  marketAddress: fundingMarketAddressSchema,
  amount: contributionSchema,
  yesProbabilityBps: z.number().int().min(0).max(10_000),
});
const claimFundingSchema = z.object({
  marketAddress: fundingMarketAddressSchema,
  action: z.enum(["allocation", "refund"]),
});
const claimWinningSharesSchema = z.object({
  marketAddress: fundingMarketAddressSchema,
});
const proposeResolutionSchema = z.object({
  marketAddress: fundingMarketAddressSchema,
  outcome: z.enum(["YES", "NO", "CANCELLED"]),
});
const finalizeUnchallengedProposalSchema = z.object({
  marketAddress: fundingMarketAddressSchema,
});

const loadMarketSigningWallet = async (ctx: {
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
        "This wallet is self-custodied on your device. Sign this action in the app instead.",
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

const readFundingMarket = async (marketAddress: Address) => {
  const [
    collateral,
    factory,
    fundingTarget,
    fundingDeadline,
    totalContributions,
  ] = await publicClient.multicall({
    contracts: [
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "COLLATERAL",
      },
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "FACTORY",
      },
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "FUNDING_TARGET",
      },
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "FUNDING_DEADLINE",
      },
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "totalContributions",
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

  return { fundingTarget, fundingDeadline, totalContributions };
};

const readResolutionState = async (
  marketAddress: Address,
  balanceAccount?: Address,
) => {
  const [resolutionHub, tradingEnd, resolved] = await publicClient.multicall({
    contracts: [
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "RESOLUTION_HUB",
      },
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "TRADING_END",
      },
      {
        address: marketAddress,
        abi: marketFundingAbi,
        functionName: "resolved",
      },
    ] as const,
    allowFailure: false,
  });
  const hubAddress = getAddress(resolutionHub);
  if (hubAddress === zeroAddress) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This market does not have a configured resolution hub.",
    });
  }

  const resolutionCalls = [
    {
      address: hubAddress,
      abi: resolutionHubAbi,
      functionName: "resolutions",
      args: [marketAddress],
    },
    {
      address: hubAddress,
      abi: resolutionHubAbi,
      functionName: "settings",
    },
  ] as const;
  const result = balanceAccount
    ? await publicClient.multicall({
        contracts: [
          ...resolutionCalls,
          {
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [balanceAccount],
          },
        ] as const,
        allowFailure: false,
      })
    : await publicClient.multicall({
        contracts: resolutionCalls,
        allowFailure: false,
      });
  const [resolution, settings] = result;
  const collateralBalance = result[2];

  return {
    hubAddress,
    tradingEnd,
    resolved,
    phase: resolution[0],
    firstDisputer: resolution[8],
    deadline: resolution[11],
    resolverBondAmount: settings[0],
    collateralBalance,
  };
};

const requireResolutionEligibleMarket = async (
  marketAddress: Address,
  balanceAccount?: Address,
) => {
  const [funding, resolution, latestBlock] = await Promise.all([
    readFundingMarket(marketAddress),
    readResolutionState(marketAddress, balanceAccount),
    publicClient.getBlock({ blockTag: "latest" }),
  ]);
  if (funding.totalContributions < funding.fundingTarget) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This market did not graduate from its funding phase.",
    });
  }
  if (resolution.tradingEnd > latestBlock.timestamp) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This market is still trading.",
    });
  }
  if (resolution.resolved) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This market has already been resolved.",
    });
  }

  return { ...resolution, chainTimestamp: latestBlock.timestamp };
};

const requireNativeGas = async (address: Address) => {
  const nativeBalance = await publicClient.getBalance({ address });
  if (nativeBalance === BigInt(0)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your wallet needs MON on Monad Testnet to pay transaction gas.",
    });
  }
};

const normalizeFundingError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The funding action could not be completed.";

export const marketsRouter = createTRPCRouter({
  contribute: protectedProcedure
    .input(contributeToMarketSchema)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadMarketSigningWallet(ctx);
      const marketAddress = getAddress(input.marketAddress);
      const amount = parseUnits(input.amount, COLLATERAL_DECIMALS);
      if (amount <= BigInt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Contribution must be greater than zero USDC.",
        });
      }

      const market = await readFundingMarket(marketAddress);
      const now = BigInt(Math.floor(Date.now() / 1_000));
      if (market.fundingDeadline <= now) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This market's funding period has ended.",
        });
      }
      if (market.totalContributions >= market.fundingTarget) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This market has already reached its funding goal.",
        });
      }
      const remaining = market.fundingTarget - market.totalContributions;
      if (amount > remaining) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Contribution exceeds the remaining funding goal.",
        });
      }

      await requireNativeGas(address);
      const [balance, allowance] = await publicClient.multicall({
        contracts: [
          {
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          },
          {
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, marketAddress],
          },
        ] as const,
        allowFailure: false,
      });
      if (balance < amount) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Your USDC balance is lower than the selected contribution.",
        });
      }

      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      try {
        if (allowance < amount) {
          if (allowance > BigInt(0)) {
            const resetHash = await walletClient.writeContract({
              address: COLLATERAL_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "approve",
              args: [marketAddress, BigInt(0)],
            });
            const resetReceipt = await publicClient.waitForTransactionReceipt({
              hash: resetHash,
            });
            if (resetReceipt.status !== "success") {
              throw new Error("Could not reset the USDC allowance.");
            }
          }

          const approvalHash = await walletClient.writeContract({
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [marketAddress, amount],
          });
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
          });
          if (approvalReceipt.status !== "success") {
            throw new Error("The USDC approval transaction failed.");
          }
        }

        const latestMarket = await readFundingMarket(marketAddress);
        const latestNow = BigInt(Math.floor(Date.now() / 1_000));
        if (
          latestMarket.fundingDeadline <= latestNow ||
          latestMarket.totalContributions >= latestMarket.fundingTarget ||
          amount > latestMarket.fundingTarget - latestMarket.totalContributions
        ) {
          throw new Error(
            "The remaining funding changed while preparing your contribution. Refresh and try again.",
          );
        }

        const transactionHash = await walletClient.writeContract({
          address: marketAddress,
          abi: marketFundingAbi,
          functionName: "contribute",
          args: [amount, input.yesProbabilityBps],
        });
        return { transactionHash, amount: amount.toString() };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `The contribution could not be submitted: ${normalizeFundingError(error)}`,
        });
      }
    }),

  claimFunding: protectedProcedure
    .input(claimFundingSchema)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadMarketSigningWallet(ctx);
      const marketAddress = getAddress(input.marketAddress);
      const market = await readFundingMarket(marketAddress);
      await requireNativeGas(address);

      const [contribution, allocationClaimed] = await publicClient.multicall({
        contracts: [
          {
            address: marketAddress,
            abi: marketFundingAbi,
            functionName: "contributionOf",
            args: [address],
          },
          {
            address: marketAddress,
            abi: marketFundingAbi,
            functionName: "allocationClaimed",
            args: [address],
          },
        ] as const,
        allowFailure: false,
      });
      if (contribution <= BigInt(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "There is no market contribution to claim.",
        });
      }

      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      try {
        if (input.action === "allocation") {
          if (allocationClaimed) {
            throw new Error(
              "Your outcome-token allocation has already been claimed.",
            );
          }
          const transactionHash = await walletClient.writeContract({
            address: marketAddress,
            abi: marketFundingAbi,
            functionName: "claimAllocation",
          });
          return { transactionHash };
        }

        const now = BigInt(Math.floor(Date.now() / 1_000));
        if (
          market.fundingDeadline > now ||
          market.totalContributions >= market.fundingTarget
        ) {
          throw new Error("A refund is not available for this market yet.");
        }
        const syncHash = await walletClient.writeContract({
          address: marketAddress,
          abi: marketFundingAbi,
          functionName: "syncFundingState",
        });
        const syncReceipt = await publicClient.waitForTransactionReceipt({
          hash: syncHash,
        });
        if (syncReceipt.status !== "success") {
          throw new Error("Could not finalize the failed funding round.");
        }
        const transactionHash = await walletClient.writeContract({
          address: marketAddress,
          abi: marketFundingAbi,
          functionName: "claimRefund",
        });
        return { transactionHash };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `The claim could not be submitted: ${normalizeFundingError(error)}`,
        });
      }
    }),

  proposeResolution: protectedProcedure
    .input(proposeResolutionSchema)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadMarketSigningWallet(ctx);
      const marketAddress = getAddress(input.marketAddress);
      const resolution = await requireResolutionEligibleMarket(marketAddress);
      if (resolution.phase !== 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A resolution proposal already exists for this market.",
        });
      }

      const bondAmount = resolution.resolverBondAmount;
      await requireNativeGas(address);
      const [balance, allowance] = await publicClient.multicall({
        contracts: [
          {
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          },
          {
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, resolution.hubAddress],
          },
        ] as const,
        allowFailure: false,
      });
      if (balance < bondAmount) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Your USDC balance is lower than the required resolver bond.",
        });
      }

      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      try {
        if (allowance < bondAmount) {
          if (allowance > BigInt(0)) {
            const resetHash = await walletClient.writeContract({
              address: COLLATERAL_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "approve",
              args: [resolution.hubAddress, BigInt(0)],
            });
            const resetReceipt = await publicClient.waitForTransactionReceipt({
              hash: resetHash,
            });
            if (resetReceipt.status !== "success") {
              throw new Error("Could not reset the USDC allowance.");
            }
          }

          const approvalHash = await walletClient.writeContract({
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [resolution.hubAddress, bondAmount],
          });
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
          });
          if (approvalReceipt.status !== "success") {
            throw new Error("The USDC approval transaction failed.");
          }
        }

        const latest = await requireResolutionEligibleMarket(
          marketAddress,
          address,
        );
        if (
          latest.phase !== 0 ||
          latest.hubAddress !== resolution.hubAddress ||
          latest.resolverBondAmount !== bondAmount
        ) {
          throw new Error(
            "The market resolution state or required bond changed. Refresh and try again.",
          );
        }
        if (
          latest.collateralBalance === undefined ||
          latest.collateralBalance < bondAmount
        ) {
          throw new Error(
            "Your USDC balance no longer covers the resolver bond.",
          );
        }

        const outcome =
          input.outcome === "YES" ? 1 : input.outcome === "NO" ? 2 : 3;
        const { request } = await publicClient.simulateContract({
          account,
          address: resolution.hubAddress,
          abi: resolutionHubAbi,
          functionName: "proposeResolution",
          args: [marketAddress, outcome],
        });
        const transactionHash = await walletClient.writeContract(request);
        return { transactionHash };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `The resolution proposal could not be submitted: ${normalizeFundingError(error)}`,
        });
      }
    }),

  finalizeUnchallengedProposal: protectedProcedure
    .input(finalizeUnchallengedProposalSchema)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadMarketSigningWallet(ctx);
      const marketAddress = getAddress(input.marketAddress);
      const resolution = await requireResolutionEligibleMarket(marketAddress);
      if (
        resolution.phase !== 1 ||
        resolution.deadline === BigInt(0) ||
        resolution.deadline > resolution.chainTimestamp ||
        resolution.firstDisputer !== zeroAddress
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This proposal cannot be finalized yet: it must be unchallenged and past its challenge deadline.",
        });
      }

      await requireNativeGas(address);
      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      try {
        const latest = await requireResolutionEligibleMarket(marketAddress);
        if (
          latest.phase !== 1 ||
          latest.deadline === BigInt(0) ||
          latest.deadline > latest.chainTimestamp ||
          latest.firstDisputer !== zeroAddress ||
          latest.hubAddress !== resolution.hubAddress
        ) {
          throw new Error(
            "The proposal is no longer eligible for permissionless finalization.",
          );
        }

        const { request } = await publicClient.simulateContract({
          account,
          address: resolution.hubAddress,
          abi: resolutionHubAbi,
          functionName: "finalizeUnchallengedProposal",
          args: [marketAddress],
        });
        const transactionHash = await walletClient.writeContract(request);
        return { transactionHash };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `The resolution could not be finalized: ${normalizeFundingError(error)}`,
        });
      }
    }),

  claimWinningShares: protectedProcedure
    .input(claimWinningSharesSchema)
    .mutation(async ({ ctx, input }) => {
      const { account, address } = await loadMarketSigningWallet(ctx);
      const marketAddress = getAddress(input.marketAddress);
      await readFundingMarket(marketAddress);
      await requireNativeGas(address);

      const [resolved, finalOutcome, yesToken, noToken] =
        await publicClient.multicall({
          contracts: [
            {
              address: marketAddress,
              abi: marketFundingAbi,
              functionName: "resolved",
            },
            {
              address: marketAddress,
              abi: marketFundingAbi,
              functionName: "finalOutcome",
            },
            {
              address: marketAddress,
              abi: marketFundingAbi,
              functionName: "YES_TOKEN",
            },
            {
              address: marketAddress,
              abi: marketFundingAbi,
              functionName: "NO_TOKEN",
            },
          ] as const,
          allowFailure: false,
        });

      if (!resolved) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This market has not been resolved yet.",
        });
      }
      if (finalOutcome !== 1 && finalOutcome !== 2) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This market was cancelled or has no redeemable winning outcome.",
        });
      }

      const winningToken = getAddress(finalOutcome === 1 ? yesToken : noToken);
      const [amountResult, allowanceResult] = await publicClient.multicall({
        contracts: [
          {
            address: winningToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          },
          {
            address: winningToken,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, marketAddress],
          },
        ] as const,
        allowFailure: true,
      });
      if (amountResult.status !== "success") throw amountResult.error;
      const amount = amountResult.result;
      if (amount <= BigInt(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Your wallet has no winning shares to claim.",
        });
      }

      if (allowanceResult.status !== "success") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Winning shares could not be claimed: ${normalizeFundingError(allowanceResult.error)}`,
        });
      }
      const allowance = allowanceResult.result;
      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      try {
        if (allowance < amount) {
          if (allowance > BigInt(0)) {
            const resetHash = await walletClient.writeContract({
              address: winningToken,
              abi: erc20Abi,
              functionName: "approve",
              args: [marketAddress, BigInt(0)],
            });
            const resetReceipt = await publicClient.waitForTransactionReceipt({
              hash: resetHash,
            });
            if (resetReceipt.status !== "success") {
              throw new Error("Could not reset the winning-share allowance.");
            }
          }

          const approvalHash = await walletClient.writeContract({
            address: winningToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [marketAddress, amount],
          });
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
          });
          if (approvalReceipt.status !== "success") {
            throw new Error("The winning-share approval transaction failed.");
          }
        }

        const { request } = await publicClient.simulateContract({
          account,
          address: marketAddress,
          abi: marketFundingAbi,
          functionName: "redeemOutcomeToken",
          args: [winningToken, amount],
        });
        const transactionHash = await walletClient.writeContract(request);
        return { transactionHash, amount: amount.toString() };
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Winning shares could not be claimed: ${normalizeFundingError(error)}`,
        });
      }
    }),

  create: protectedProcedure
    .input(createMarketSchema)
    .mutation(async ({ ctx, input }) => {
      const tradingEnd = BigInt(input.tradingEnd);
      if (IS_DEVELOPMENT) getMarketFundingDeadline(tradingEnd);

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
            "This wallet is self-custodied on your device. Sign this action in the app instead.",
        });
      }

      const contribution = parseUnits(input.contribution, COLLATERAL_DECIMALS);
      const initialFundingDeadline = getMarketFundingDeadline(tradingEnd);
      if (contribution > FUNDING_TARGET) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "The contribution cannot exceed the $10,000 USDC funding target.",
        });
      }

      const address = getAddress(wallet.address);
      const privateKey = await decryptWalletPrivateKey(
        ctx.session.did,
        address,
        {
          encryptedPrivateKey: wallet.encryptedPrivateKey,
          privateKeyNonce: wallet.privateKeyNonce,
          encryptedDek: wallet.encryptedDek,
          dekNonce: wallet.dekNonce,
          encryptionVersion: wallet.encryptionVersion,
        },
      );
      const account = privateKeyToAccount(privateKey);
      const walletClient = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });

      const nativeBalance = await publicClient.getBalance({ address });
      if (nativeBalance === BigInt(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Your wallet needs MON on Monad Testnet to pay transaction gas.",
        });
      }

      let approvalTxHash: `0x${string}` | null = null;
      if (contribution > BigInt(0)) {
        const [balance, allowance] = await publicClient.multicall({
          contracts: [
            {
              address: COLLATERAL_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: COLLATERAL_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, MARKET_FACTORY_ADDRESS],
            },
          ] as const,
          allowFailure: false,
        });

        if (balance < contribution) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Your USDC balance is lower than the selected contribution.",
          });
        }

        if (allowance < contribution) {
          if (allowance > BigInt(0)) {
            const resetHash = await walletClient.writeContract({
              address: COLLATERAL_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "approve",
              args: [MARKET_FACTORY_ADDRESS, BigInt(0)],
            });
            const resetReceipt = await publicClient.waitForTransactionReceipt({
              hash: resetHash,
            });
            if (resetReceipt.status !== "success") {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "Could not reset the collateral token allowance.",
              });
            }
          }

          approvalTxHash = await walletClient.writeContract({
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [MARKET_FACTORY_ADDRESS, contribution],
          });
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalTxHash,
          });
          if (approvalReceipt.status !== "success") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The collateral approval transaction failed.",
            });
          }
        }
      }

      const fundingDeadline = IS_DEVELOPMENT
        ? getMarketFundingDeadline(tradingEnd)
        : initialFundingDeadline;
      const params = {
        fundingTarget: FUNDING_TARGET,
        fundingDeadline,
        tradingEnd,
        question: input.question,
        resolutionCriteria: input.resolutionCriteria,
      };
      const marketTxHash =
        contribution === BigInt(0)
          ? await walletClient.writeContract({
              address: MARKET_FACTORY_ADDRESS,
              abi: marketFactoryAbi,
              functionName: "createMarket",
              args: [params],
            })
          : await walletClient.writeContract({
              address: MARKET_FACTORY_ADDRESS,
              abi: marketFactoryAbi,
              functionName: "createAndContribute",
              args: [params, contribution, input.yesProbabilityBps],
            });

      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash: marketTxHash,
        });
      } catch {
        return {
          marketAddress: null,
          marketTxHash,
          approvalTxHash,
          transactionStatus: "pending" as const,
          contribution: contribution.toString(),
          yesProbabilityBps: input.yesProbabilityBps,
          yesAllocation: null,
          noAllocation: null,
          outcomeTokenDecimals: null,
          openingProbabilityBps: null,
        };
      }

      if (receipt.status !== "success") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The market creation transaction reverted.",
        });
      }

      const createdMarket = parseEventLogs({
        abi: marketFactoryAbi,
        logs: receipt.logs,
        eventName: "MarketCreated",
        strict: false,
      }).find(
        (event) =>
          event.address.toLowerCase() ===
            MARKET_FACTORY_ADDRESS.toLowerCase() &&
          event.args.creator?.toLowerCase() === address.toLowerCase(),
      );
      if (!createdMarket?.args.market) {
        return {
          marketAddress: null,
          marketTxHash,
          approvalTxHash,
          transactionStatus: "pending" as const,
          contribution: contribution.toString(),
          yesProbabilityBps: input.yesProbabilityBps,
          yesAllocation: null,
          noAllocation: null,
          outcomeTokenDecimals: null,
          openingProbabilityBps: null,
        };
      }
      const marketAddress: Address = createdMarket.args.market;
      const yesTokenAddress = createdMarket.args.yesToken;

      let yesAllocation: string | null = null;
      let noAllocation: string | null = null;
      let outcomeTokenDecimals: number | null = null;
      let openingProbabilityBps: number | null = null;
      if (
        marketAddress &&
        createdMarket &&
        yesTokenAddress &&
        contribution > BigInt(0)
      ) {
        try {
          const [yesAmount, noAmount, decimals, openingProbability] =
            await publicClient.multicall({
              contracts: [
                {
                  address: marketAddress,
                  abi: marketReadAbi,
                  functionName: "yesAllocationOf",
                  args: [address],
                },
                {
                  address: marketAddress,
                  abi: marketReadAbi,
                  functionName: "noAllocationOf",
                  args: [address],
                },
                {
                  address: yesTokenAddress,
                  abi: erc20Abi,
                  functionName: "decimals",
                },
                {
                  address: marketAddress,
                  abi: marketReadAbi,
                  functionName: "openingProbabilityBps",
                },
              ] as const,
              allowFailure: false,
            });
          yesAllocation = yesAmount.toString();
          noAllocation = noAmount.toString();
          outcomeTokenDecimals = Number(decimals);
          openingProbabilityBps = Number(openingProbability);
        } catch {
          // The market transaction is already final; do not turn a read failure
          // into a client retry that could create a second market.
        }
      }

      return {
        marketAddress,
        marketTxHash,
        approvalTxHash,
        transactionStatus: "confirmed" as const,
        contribution: contribution.toString(),
        yesProbabilityBps: input.yesProbabilityBps,
        yesAllocation,
        noAllocation,
        outcomeTokenDecimals,
        openingProbabilityBps,
      };
    }),

  confirm: protectedProcedure
    .input(z.object({ marketTxHash: transactionHashSchema }))
    .mutation(async ({ ctx, input }) => {
      const wallet = await ctx.db.evmWallet.findUnique({
        where: { userDid: ctx.session.did },
        select: { address: true },
      });
      if (!wallet) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No EVM wallet is linked to this account yet.",
        });
      }

      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({
          hash: input.marketTxHash as `0x${string}`,
        });
      } catch {
        return { marketAddress: null, transactionStatus: "pending" as const };
      }

      if (receipt.status !== "success") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The market transaction did not succeed.",
        });
      }

      const createdMarket = parseEventLogs({
        abi: marketFactoryAbi,
        logs: receipt.logs,
        eventName: "MarketCreated",
        strict: false,
      }).find((event) => {
        const creator = event.args.creator;
        return (
          event.address.toLowerCase() ===
            MARKET_FACTORY_ADDRESS.toLowerCase() &&
          creator !== undefined &&
          creator.toLowerCase() === wallet.address.toLowerCase()
        );
      });
      const createdMarketAddress = createdMarket?.args.market;
      if (!createdMarketAddress) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "The transaction does not show this wallet creating a market through the configured factory.",
        });
      }

      return {
        marketAddress: getAddress(createdMarketAddress),
        transactionStatus: "confirmed" as const,
      };
    }),

  associatePost: protectedProcedure
    .input(
      z.object({
        postUri: z.string().min(1).max(512),
        postCid: z.string().min(1).max(100),
        marketAddress: postMarketAddressSchema,
        marketTxHash: transactionHashSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const postUriMatch =
        /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(input.postUri);
      if (!postUriMatch) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A valid Kites post URI is required.",
        });
      }

      const wallet = await ctx.db.evmWallet.findUnique({
        where: { userDid: ctx.session.did },
        select: { address: true },
      });
      if (!wallet) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No EVM wallet is linked to this account yet.",
        });
      }

      const marketAddress = getAddress(input.marketAddress);
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({
          hash: input.marketTxHash as `0x${string}`,
        });
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "The market transaction could not be verified on Monad Testnet.",
        });
      }

      if (receipt.status !== "success") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The market transaction did not succeed.",
        });
      }

      const createdMarket = parseEventLogs({
        abi: marketFactoryAbi,
        logs: receipt.logs,
        eventName: "MarketCreated",
        strict: false,
      }).find((event) => {
        const { market, creator } = event.args;
        return (
          event.address.toLowerCase() ===
            MARKET_FACTORY_ADDRESS.toLowerCase() &&
          market !== undefined &&
          creator !== undefined &&
          market.toLowerCase() === marketAddress.toLowerCase() &&
          creator.toLowerCase() === wallet.address.toLowerCase()
        );
      });
      if (!createdMarket) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "The transaction does not show this wallet creating that market through the configured factory.",
        });
      }

      const select = {
        postUri: true,
        marketAddress: true,
        chainId: true,
        marketTxHash: true,
        ownerDid: true,
      } as const;
      const matchesRequestedLink = (link: {
        marketAddress: string;
        chainId: number;
        marketTxHash: string;
        ownerDid: string;
      }) =>
        link.marketAddress.toLowerCase() === marketAddress.toLowerCase() &&
        link.chainId === monadTestnet.id &&
        link.marketTxHash.toLowerCase() === input.marketTxHash.toLowerCase() &&
        link.ownerDid === ctx.session.did;
      const conflict = () =>
        new TRPCError({
          code: "CONFLICT",
          message:
            "This post or market is already associated with a different record.",
        });

      const [existingPost, existingMarket] = await Promise.all([
        ctx.db.marketPost.findUnique({
          where: { postUri: input.postUri },
          select,
        }),
        ctx.db.marketPost.findUnique({
          where: {
            chainId_marketAddress: {
              chainId: monadTestnet.id,
              marketAddress,
            },
          },
          select,
        }),
      ]);
      if (existingPost) {
        if (!matchesRequestedLink(existingPost)) throw conflict();
        return existingPost;
      }
      if (existingMarket) throw conflict();

      try {
        return await ctx.db.marketPost.create({
          data: {
            postUri: input.postUri,
            postCid: input.postCid,
            marketAddress,
            chainId: monadTestnet.id,
            marketTxHash: input.marketTxHash,
            ownerDid: ctx.session.did,
          },
          select,
        });
      } catch (error) {
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
        ) {
          throw error;
        }

        const [postAfterRace, marketAfterRace] = await Promise.all([
          ctx.db.marketPost.findUnique({
            where: { postUri: input.postUri },
            select,
          }),
          ctx.db.marketPost.findUnique({
            where: {
              chainId_marketAddress: {
                chainId: monadTestnet.id,
                marketAddress,
              },
            },
            select,
          }),
        ]);
        if (postAfterRace && matchesRequestedLink(postAfterRace)) {
          return postAfterRace;
        }
        if (marketAfterRace || postAfterRace) throw conflict();
        throw error;
      }
    }),

  byPostUris: publicProcedure
    .input(
      z.object({
        postUris: z.array(z.string().min(1).max(512)).min(1).max(1000),
      }),
    )
    .query(async ({ ctx, input }) => {
      const links = await ctx.db.marketPost.findMany({
        where: {
          chainId: monadTestnet.id,
          postUri: { in: [...new Set(input.postUris)] },
        },
        select: { postUri: true, marketAddress: true, chainId: true },
      });
      return links.map((link) => ({
        ...link,
        marketAddress: getAddress(link.marketAddress),
      }));
    }),

  byMarketAddresses: publicProcedure
    .input(
      z.object({
        marketAddresses: z.array(postMarketAddressSchema).min(1).max(1000),
      }),
    )
    .query(async ({ ctx, input }) => {
      const marketAddresses = [
        ...new Set(input.marketAddresses.map((address) => getAddress(address))),
      ];
      const links = await ctx.db.marketPost.findMany({
        where: {
          chainId: monadTestnet.id,
          marketAddress: { in: marketAddresses },
        },
        select: { postUri: true, marketAddress: true, createdAt: true },
      });

      return links.map((link) => ({
        postUri: link.postUri,
        marketAddress: getAddress(link.marketAddress),
        associationCreatedAt: link.createdAt.toISOString(),
      }));
    }),

  byCreatorDid: publicProcedure
    .input(
      z.object({
        creatorDid: z.string().min(1).max(512),
        cursor: z.number().int().nonnegative().nullish(),
        limit: z.number().int().min(1).max(25).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wallet = await ctx.db.evmWallet.findUnique({
        where: { userDid: input.creatorDid },
        select: { address: true },
      });
      if (!wallet) {
        return { items: [], nextCursor: null, totalCount: 0 };
      }

      const creatorAddress = getAddress(wallet.address);
      const count = await publicClient.readContract({
        address: MARKET_FACTORY_ADDRESS,
        abi: marketRegistryAbi,
        functionName: "creatorMarketCount",
        args: [creatorAddress],
      });
      const totalCount = Number(count);
      if (!Number.isSafeInteger(totalCount)) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The creator market count is too large to paginate.",
        });
      }

      const end = Math.min(input.cursor ?? totalCount, totalCount);
      const start = Math.max(end - input.limit, 0);
      const creatorIndices = Array.from(
        { length: end - start },
        (_, offset) => end - offset - 1,
      );
      const contracts = creatorIndices.map(
        (index) =>
          ({
            address: MARKET_FACTORY_ADDRESS,
            abi: marketRegistryAbi,
            functionName: "creatorMarketAt",
            args: [creatorAddress, BigInt(index)],
          }) as const,
      );
      const marketAddresses: Address[] = contracts.length
        ? await publicClient.multicall({
            contracts,
            allowFailure: false,
          })
        : [];

      const links = marketAddresses.length
        ? await ctx.db.marketPost.findMany({
            where: {
              chainId: monadTestnet.id,
              marketAddress: { in: marketAddresses },
            },
            select: { marketAddress: true, postUri: true, createdAt: true },
          })
        : [];
      const linksByAddress = new Map(
        links.map((link) => [link.marketAddress.toLowerCase(), link]),
      );

      return {
        items: marketAddresses.map((marketAddress, offset) => {
          const link = linksByAddress.get(marketAddress.toLowerCase());
          return {
            marketAddress: getAddress(marketAddress),
            postUri: link?.postUri ?? null,
            associationCreatedAt: link?.createdAt.toISOString() ?? null,
            creatorIndex: end - offset - 1,
          };
        }),
        nextCursor: start > 0 ? start : null,
        totalCount,
      };
    }),
});
