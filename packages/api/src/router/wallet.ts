import { TRPCError } from "@trpc/server";
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";
import { z } from "zod";

import { Prisma } from "@kites-social/db";

import { resolveAtprotoWalletAddress } from "../atproto-wallet-link";
import {
  deployPolymarketWallet,
  getDeployedPolymarketWalletAddress,
  getPolymarketPusdBalance,
  getPolymarketRelayerTransaction,
  getPolymarketWalletNonce,
  getPolymarketWalletTransaction,
  isAllowedPolymarketApprovalCall,
  MAX_POLYMARKET_APPROVAL_CALLS_PER_BATCH,
  POLYMARKET_PUSD_ADDRESS,
  preparePolymarketTradingApprovals,
  submitPolymarketTradingApprovals,
  submitPolymarketWalletCalls,
  type PolymarketWalletCall,
} from "../polymarket-relayer";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  ensureInitialFunding,
  ensurePolymarketInitialFunding,
} from "../wallet-provisioning";

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "Invalid EVM wallet address");

const walletLinkProofSchema = z.object({
  nonce: z.string().regex(/^0x[\da-fA-F]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  audience: z.literal("social.kites.wallet.link"),
  signature: z.string().regex(/^0x[\da-fA-F]{130}$/),
});

const walletLinkDomain = {
  name: "Kites Wallet Link",
  version: "1",
  chainId: 1,
} as const;

const walletLinkTypes = {
  WalletLink: [
    { name: "did", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "audience", type: "string" },
  ],
} as const;

const polymarketApprovalInput = z.object({
  nonce: z.string().regex(/^\d{1,78}$/),
  deadline: z.string().regex(/^\d{1,78}$/),
  signature: z.string().regex(/^0x[\da-fA-F]{130}$/),
  calls: z
    .array(
      z.object({
        target: addressSchema,
        value: z.literal("0"),
        data: z.string().regex(/^0x(?:[\da-fA-F]{2})+$/),
      }),
    )
    .min(1)
    .max(MAX_POLYMARKET_APPROVAL_CALLS_PER_BATCH),
});

const polymarketWithdrawalInput = z.object({
  nonce: z.string().regex(/^\d{1,78}$/),
  deadline: z.string().regex(/^\d{1,78}$/),
  amount: z.string().regex(/^\d{1,72}(?:\.\d{1,6})?$/),
  signature: z.string().regex(/^0x[\da-fA-F]{130}$/),
});

const polymarketPusdAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const polymarketBatchTypes = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
} as const;

async function verifyWalletLinkProof(input: {
  did: string;
  address: Address;
  proof: z.infer<typeof walletLinkProofSchema>;
}) {
  const now = Math.floor(Date.now() / 1_000);
  if (input.proof.issuedAt > now + 60 || input.proof.issuedAt < now - 600) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The wallet link signature has expired. Sign a new challenge.",
    });
  }

  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: walletLinkDomain,
      types: walletLinkTypes,
      primaryType: "WalletLink",
      message: {
        did: input.did,
        address: input.address,
        nonce: input.proof.nonce as Hex,
        issuedAt: BigInt(input.proof.issuedAt),
        audience: input.proof.audience,
      },
      signature: input.proof.signature as Hex,
    });
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The wallet link signature is invalid.",
    });
  }
  if (getAddress(signer) !== input.address) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "The signature does not prove control of this wallet address.",
    });
  }
}

export const walletRouter = createTRPCRouter({
  /** Uses the Bluesky link as the wallet source; the DB adds Polymarket metadata. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const { did } = ctx.session;
    const address = await resolveAtprotoWalletAddress(did);
    if (!address) return null;

    const wallet = await ctx.db.evmWallet.findUnique({
      where: { address },
      select: {
        userDid: true,
        polymarketDepositWalletAddress: true,
        initialFundingComplete: true,
        initialFundingLockAt: true,
      },
    });

    return {
      address,
      did,
      registered: wallet?.userDid === did,
      polymarketDepositWalletAddress:
        wallet?.userDid === did && wallet.polymarketDepositWalletAddress
          ? getAddress(wallet.polymarketDepositWalletAddress)
          : null,
      initialFundingStatus:
        wallet?.userDid !== did
          ? null
          : wallet.initialFundingComplete
            ? ("complete" as const)
            : wallet.initialFundingLockAt
              ? ("pending" as const)
              : ("needed" as const),
    };
  }),

  /** Starts or resumes idempotent Monad testnet funding without delaying wallet creation. */
  ensureInitialFunding: protectedProcedure.mutation(async ({ ctx }) => {
    const { did } = ctx.session;
    const address = await resolveAtprotoWalletAddress(did);
    if (!address) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Link your Kites wallet before requesting testnet funding.",
      });
    }
    const wallet = await ctx.db.evmWallet.findUnique({
      where: { address },
      select: {
        userDid: true,
        initialFundingComplete: true,
        initialFundingLockAt: true,
      },
    });
    if (wallet?.userDid !== did) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Register your Kites wallet before requesting testnet funding.",
      });
    }
    if (wallet.initialFundingComplete) return { status: "complete" as const };

    const funded = await runInitialFunding(ctx.db, did, getAddress(address));
    if (funded) return { status: "complete" as const };

    const latest = await ctx.db.evmWallet.findUnique({
      where: { address },
      select: { initialFundingComplete: true, initialFundingLockAt: true },
    });
    return {
      status: latest?.initialFundingComplete
        ? ("complete" as const)
        : latest?.initialFundingLockAt
          ? ("pending" as const)
          : ("retryable" as const),
    };
  }),

  ensurePolymarketInitialFunding: protectedProcedure.mutation(
    async ({ ctx }) => {
      const { did } = ctx.session;
      const address = await resolveAtprotoWalletAddress(did);
      if (!address) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Link your Kites wallet before requesting Polygon funding.",
        });
      }

      const wallet = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          userDid: true,
          polymarketDepositWalletAddress: true,
          polymarketInitialFundingComplete: true,
          polymarketInitialFundingLockAt: true,
          polymarketInitialDepositComplete: true,
        },
      });
      if (wallet?.userDid !== did) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Register your Kites wallet before requesting Polygon funding.",
        });
      }
      if (!wallet.polymarketDepositWalletAddress) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Deploy your Polymarket deposit wallet before requesting Polygon funding.",
        });
      }
      if (wallet.polymarketInitialDepositComplete) {
        return { status: "complete" as const, depositComplete: true };
      }
      if (wallet.polymarketInitialFundingComplete) {
        return { status: "complete" as const, depositComplete: false };
      }

      await runPolymarketInitialFunding(ctx.db, did, getAddress(address));

      const latest = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          polymarketInitialFundingComplete: true,
          polymarketInitialFundingLockAt: true,
          polymarketInitialDepositComplete: true,
        },
      });
      return {
        status: latest?.polymarketInitialFundingComplete
          ? ("complete" as const)
          : latest?.polymarketInitialFundingLockAt
            ? ("pending" as const)
            : ("retryable" as const),
        depositComplete: latest?.polymarketInitialDepositComplete ?? false,
      };
    },
  ),

  completePolymarketInitialDeposit: protectedProcedure.mutation(
    async ({ ctx }) => {
      const { did } = ctx.session;
      const address = await resolveAtprotoWalletAddress(did);
      if (!address) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Link your Kites wallet before confirming the Polymarket deposit.",
        });
      }

      const wallet = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          userDid: true,
          polymarketDepositWalletAddress: true,
          polymarketInitialDepositComplete: true,
        },
      });
      if (wallet?.userDid !== did) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Register your Kites wallet before confirming the Polymarket deposit.",
        });
      }
      if (!wallet.polymarketDepositWalletAddress) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Deploy your Polymarket deposit wallet before confirming its funding.",
        });
      }
      if (wallet.polymarketInitialDepositComplete) {
        return { status: "complete" as const };
      }

      const depositBalance = await getPolymarketPusdBalance(
        getAddress(wallet.polymarketDepositWalletAddress),
      );
      if (depositBalance < parseUnits("0.01", 6)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "The initial 0.01 pUSD deposit has not arrived in your Polymarket wallet yet.",
        });
      }

      const completed = await ctx.db.evmWallet.updateMany({
        where: {
          address,
          userDid: did,
          polymarketInitialDepositComplete: false,
        },
        data: { polymarketInitialDepositComplete: true },
      });
      if (completed.count !== 1) {
        const latest = await ctx.db.evmWallet.findUnique({
          where: { address },
          select: { polymarketInitialDepositComplete: true },
        });
        if (!latest?.polymarketInitialDepositComplete) {
          throw new Error("Could not mark the Polymarket deposit complete");
        }
      }
      return { status: "complete" as const };
    },
  ),

  polymarketDepositWallet: protectedProcedure.query(async ({ ctx }) => {
    const { did } = ctx.session;
    const address = await resolveAtprotoWalletAddress(did);
    if (!address) return { status: "missing" as const };

    const wallet = await ctx.db.evmWallet.findUnique({
      where: { address },
      select: {
        id: true,
        userDid: true,
        polymarketDepositWalletAddress: true,
        polymarketDepositWalletTransactionId: true,
        polymarketDepositWalletDeployStartedAt: true,
      },
    });
    if (!wallet || wallet.userDid !== did)
      return { status: "missing" as const };
    if (wallet.polymarketDepositWalletAddress) {
      return {
        status: "deployed" as const,
        address: getAddress(wallet.polymarketDepositWalletAddress),
      };
    }

    const transactionID = wallet.polymarketDepositWalletTransactionId;
    if (!transactionID) {
      const lockIsActive =
        wallet.polymarketDepositWalletDeployStartedAt !== null &&
        wallet.polymarketDepositWalletDeployStartedAt.getTime() >
          Date.now() - 120_000;
      return {
        status: lockIsActive ? ("pending" as const) : ("not-created" as const),
      };
    }

    const transaction = await getPolymarketRelayerTransaction(transactionID);
    if (!transaction) return { status: "pending" as const };
    const state = transaction.state.toUpperCase();
    if (state === "STATE_CONFIRMED") {
      const depositWalletAddress =
        transaction.proxyAddress ??
        (await getDeployedPolymarketWalletAddress(address));
      if (!depositWalletAddress) return { status: "pending" as const };
      await ctx.db.evmWallet.updateMany({
        where: {
          id: wallet.id,
          polymarketDepositWalletTransactionId: transactionID,
        },
        data: {
          polymarketDepositWalletAddress: depositWalletAddress,
          polymarketDepositWalletTransactionId: null,
          polymarketDepositWalletDeployStartedAt: null,
        },
      });
      return {
        status: "deployed" as const,
        address: depositWalletAddress,
      };
    }
    if (state === "STATE_FAILED" || state === "STATE_INVALID") {
      await ctx.db.evmWallet.updateMany({
        where: {
          id: wallet.id,
          polymarketDepositWalletTransactionId: transactionID,
        },
        data: {
          polymarketDepositWalletTransactionId: null,
          polymarketDepositWalletDeployStartedAt: null,
        },
      });
      return {
        status: "failed" as const,
        error:
          transaction.errorMsg ?? "Polymarket could not deploy the wallet.",
      };
    }
    return { status: "pending" as const };
  }),

  preparePolymarketTradingApprovals: protectedProcedure.mutation(
    async ({ ctx }) => {
      const { did } = ctx.session;
      const address = await resolveAtprotoWalletAddress(did);
      if (!address) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Link your Kites wallet before setting up Polymarket.",
        });
      }
      const wallet = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          userDid: true,
          polymarketDepositWalletAddress: true,
        },
      });
      if (wallet?.userDid !== did || !wallet.polymarketDepositWalletAddress) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Deploy your Polymarket deposit wallet first.",
        });
      }

      const signerAddress = getAddress(address);
      const depositWalletAddress = getAddress(
        wallet.polymarketDepositWalletAddress,
      );
      const result = await preparePolymarketTradingApprovals(
        signerAddress,
        depositWalletAddress,
      );
      if (result.status === "complete") {
        return { status: result.status, depositWalletAddress };
      }
      return {
        status: result.status,
        depositWalletAddress,
        nonce: result.nonce,
        deadline: String(Math.floor(Date.now() / 1_000) + 600),
        calls: result.calls,
      };
    },
  ),

  submitPolymarketTradingApprovals: protectedProcedure
    .input(polymarketApprovalInput)
    .mutation(async ({ ctx, input }) => {
      const { did } = ctx.session;
      const address = await resolveAtprotoWalletAddress(did);
      if (!address) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Link your Kites wallet before setting up Polymarket.",
        });
      }
      const wallet = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          userDid: true,
          polymarketDepositWalletAddress: true,
        },
      });
      if (wallet?.userDid !== did || !wallet.polymarketDepositWalletAddress) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Deploy your Polymarket deposit wallet first.",
        });
      }

      const signerAddress = getAddress(address);
      const depositWalletAddress = getAddress(
        wallet.polymarketDepositWalletAddress,
      );
      const calls = input.calls.map((call) => ({
        target: getAddress(call.target),
        value: call.value,
        data: call.data as Hex,
      })) satisfies PolymarketWalletCall[];
      if (
        calls.some((call) => !isAllowedPolymarketApprovalCall(call)) ||
        new Set(calls.map((call) => `${call.target}:${call.data}`)).size !==
          calls.length
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The requested Polymarket approval batch is invalid.",
        });
      }
      const now = Math.floor(Date.now() / 1_000);
      const deadline = Number(input.deadline);
      if (
        !Number.isSafeInteger(deadline) ||
        deadline <= now ||
        deadline > now + 900
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The Polymarket approval signature has expired.",
        });
      }

      let recoveredAddress: Address;
      try {
        recoveredAddress = getAddress(
          await recoverTypedDataAddress({
            domain: {
              name: "DepositWallet",
              version: "1",
              chainId: polygon.id,
              verifyingContract: depositWalletAddress,
            },
            types: polymarketBatchTypes,
            primaryType: "Batch",
            message: {
              wallet: depositWalletAddress,
              nonce: BigInt(input.nonce),
              deadline: BigInt(input.deadline),
              calls: calls.map((call) => ({
                target: call.target,
                value: BigInt(call.value),
                data: call.data,
              })),
            },
            signature: input.signature as Hex,
          }),
        );
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The Polymarket approval signature is invalid.",
        });
      }
      if (recoveredAddress !== signerAddress) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "The signature does not authorize this wallet.",
        });
      }

      const transactionID = await submitPolymarketTradingApprovals({
        signerAddress,
        depositWalletAddress,
        nonce: input.nonce,
        deadline: input.deadline,
        signature: input.signature as Hex,
        calls,
      });
      return { transactionID };
    }),

  preparePolymarketWithdrawal: protectedProcedure.mutation(async ({ ctx }) => {
    const { did } = ctx.session;
    const address = await resolveAtprotoWalletAddress(did);
    if (!address) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Link your Kites wallet before withdrawing Polymarket funds.",
      });
    }
    const wallet = await ctx.db.evmWallet.findUnique({
      where: { address },
      select: {
        userDid: true,
        polymarketDepositWalletAddress: true,
      },
    });
    if (wallet?.userDid !== did || !wallet.polymarketDepositWalletAddress) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Set up your Polymarket deposit wallet before withdrawing.",
      });
    }

    return {
      depositWalletAddress: getAddress(wallet.polymarketDepositWalletAddress),
      nonce: await getPolymarketWalletNonce(getAddress(address)),
      deadline: String(Math.floor(Date.now() / 1_000) + 600),
    };
  }),

  submitPolymarketWithdrawal: protectedProcedure
    .input(polymarketWithdrawalInput)
    .mutation(async ({ ctx, input }) => {
      const { did } = ctx.session;
      const address = await resolveAtprotoWalletAddress(did);
      if (!address) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Link your Kites wallet before withdrawing Polymarket funds.",
        });
      }
      const wallet = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          userDid: true,
          polymarketDepositWalletAddress: true,
        },
      });
      if (wallet?.userDid !== did || !wallet.polymarketDepositWalletAddress) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Set up your Polymarket deposit wallet before withdrawing.",
        });
      }

      const signerAddress = getAddress(address);
      const depositWalletAddress = getAddress(
        wallet.polymarketDepositWalletAddress,
      );
      const now = Math.floor(Date.now() / 1_000);
      const deadline = Number(input.deadline);
      if (
        !Number.isSafeInteger(deadline) ||
        deadline <= now ||
        deadline > now + 900
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The Polymarket withdrawal signature has expired.",
        });
      }

      let amount: bigint;
      try {
        amount = parseUnits(input.amount, 6);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter a valid pUSD withdrawal amount.",
        });
      }
      if (amount <= BigInt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The pUSD withdrawal amount must be greater than zero.",
        });
      }
      if (amount > (await getPolymarketPusdBalance(depositWalletAddress))) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The Polymarket wallet does not have enough pUSD.",
        });
      }

      const calls: PolymarketWalletCall[] = [
        {
          target: POLYMARKET_PUSD_ADDRESS,
          value: "0",
          data: encodeFunctionData({
            abi: polymarketPusdAbi,
            functionName: "transfer",
            args: [signerAddress, amount],
          }),
        },
      ];
      let recoveredAddress: Address;
      try {
        recoveredAddress = getAddress(
          await recoverTypedDataAddress({
            domain: {
              name: "DepositWallet",
              version: "1",
              chainId: polygon.id,
              verifyingContract: depositWalletAddress,
            },
            types: polymarketBatchTypes,
            primaryType: "Batch",
            message: {
              wallet: depositWalletAddress,
              nonce: BigInt(input.nonce),
              deadline: BigInt(input.deadline),
              calls: calls.map((call) => ({
                target: call.target,
                value: BigInt(call.value),
                data: call.data,
              })),
            },
            signature: input.signature as Hex,
          }),
        );
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The Polymarket withdrawal signature is invalid.",
        });
      }
      if (recoveredAddress !== signerAddress) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "The signature does not authorize this wallet.",
        });
      }

      const transactionID = await submitPolymarketWalletCalls({
        signerAddress,
        depositWalletAddress,
        nonce: input.nonce,
        deadline: input.deadline,
        signature: input.signature as Hex,
        calls,
        metadata: "Withdraw pUSD to Kites wallet",
      });
      return { transactionID };
    }),

  polymarketWalletTransaction: protectedProcedure
    .input(z.object({ transactionID: z.string().min(1).max(200) }))
    .query(async ({ input }) =>
      getPolymarketWalletTransaction(input.transactionID),
    ),

  deployPolymarketDepositWallet: protectedProcedure.mutation(
    async ({ ctx }) => {
      const { did } = ctx.session;
      const address = await resolveAtprotoWalletAddress(did);
      if (!address) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Link your Kites wallet in Bluesky before setting up Polymarket.",
        });
      }

      const wallet = await ctx.db.evmWallet.findUnique({
        where: { address },
        select: {
          id: true,
          userDid: true,
          polymarketDepositWalletAddress: true,
          polymarketDepositWalletTransactionId: true,
        },
      });
      if (!wallet || wallet.userDid !== did) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Register your Bluesky-linked Kites wallet before setting up Polymarket.",
        });
      }
      if (wallet.polymarketDepositWalletAddress) {
        return {
          status: "deployed" as const,
          address: getAddress(wallet.polymarketDepositWalletAddress),
        };
      }
      if (wallet.polymarketDepositWalletTransactionId) {
        return { status: "pending" as const };
      }

      const lockExpiredBefore = new Date(Date.now() - 120_000);
      const claimed = await ctx.db.evmWallet.updateMany({
        where: {
          id: wallet.id,
          polymarketDepositWalletTransactionId: null,
          OR: [
            { polymarketDepositWalletDeployStartedAt: null },
            {
              polymarketDepositWalletDeployStartedAt: {
                lt: lockExpiredBefore,
              },
            },
          ],
        },
        data: { polymarketDepositWalletDeployStartedAt: new Date() },
      });
      if (claimed.count === 0) return { status: "pending" as const };

      try {
        const transactionID = await deployPolymarketWallet(address);
        await ctx.db.evmWallet.updateMany({
          where: {
            id: wallet.id,
            polymarketDepositWalletTransactionId: null,
          },
          data: {
            polymarketDepositWalletTransactionId: transactionID,
            polymarketDepositWalletDeployStartedAt: null,
          },
        });
        return { status: "pending" as const };
      } catch (error) {
        await ctx.db.evmWallet.updateMany({
          where: { id: wallet.id, polymarketDepositWalletTransactionId: null },
          data: { polymarketDepositWalletDeployStartedAt: null },
        });
        throw error;
      }
    },
  ),

  /** Links a wallet only after its owner signs a fresh, DID-bound challenge. */
  register: protectedProcedure
    .input(z.object({ address: addressSchema, proof: walletLinkProofSchema }))
    .mutation(async ({ ctx, input }) => {
      const { did } = ctx.session;
      const address = getAddress(input.address);
      await verifyWalletLinkProof({ did, address, proof: input.proof });

      // This row only indexes venue metadata. The caller publishes the signed
      // ATProto link first, and venue reads resolve that record as authority.
      // Avoid a second DID lookup here: a transient resolver outage must not
      // block setup after the wallet link has already been published.

      let created = false;
      try {
        await ctx.db.$transaction(async (transaction) => {
          await transaction.user.upsert({
            where: { did },
            create: { did },
            update: {},
          });

          const concurrentWallet = await transaction.evmWallet.findUnique({
            where: { userDid: did },
            select: { id: true, address: true },
          });
          if (concurrentWallet) {
            if (getAddress(concurrentWallet.address) === address) return;

            // The Bluesky record is the active-wallet authority. Keep the old
            // row and its venue metadata, but detach it from this DID so the
            // signed, current address can become the active row.
            await transaction.evmWallet.update({
              where: { id: concurrentWallet.id },
              data: { userDid: null },
            });
          }

          const walletAtAddress = await transaction.evmWallet.findUnique({
            where: { address },
            select: { id: true, userDid: true },
          });
          if (walletAtAddress?.userDid && walletAtAddress.userDid !== did) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This wallet address is already linked to another account.",
            });
          }

          if (walletAtAddress) {
            if (walletAtAddress.userDid === null) {
              await transaction.evmWallet.update({
                where: { id: walletAtAddress.id },
                data: { userDid: did },
              });
            }
            return;
          }

          await transaction.evmWallet.create({
            data: {
              userDid: did,
              address,
              initialFundingComplete: false,
            },
          });
          created = true;
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This wallet address is already linked to another account.",
          });
        }
        throw error;
      }

      if (!created) {
        const linked = await ctx.db.evmWallet.findUnique({
          where: { userDid: did },
          select: { address: true },
        });
        if (!linked) {
          throw new Error("Wallet disappeared during registration");
        }
        return { address: getAddress(linked.address), created: false };
      }

      return { address, created: true };
    }),
});

/**
 * Best-effort testnet funding. Registration and custody must not fail just
 * because the treasury is temporarily unavailable, so a funding error is
 * logged and surfaced as `funded: false`; the next `register` call retries.
 */
const runInitialFunding = async (
  db: Parameters<typeof ensureInitialFunding>[0],
  did: string,
  address: Parameters<typeof ensureInitialFunding>[2],
): Promise<boolean> => {
  try {
    return await ensureInitialFunding(db, did, address);
  } catch (error) {
    console.error(
      `Initial wallet funding failed for ${address}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};

const runPolymarketInitialFunding = async (
  db: Parameters<typeof ensurePolymarketInitialFunding>[0],
  did: string,
  address: Parameters<typeof ensurePolymarketInitialFunding>[2],
): Promise<boolean> => {
  try {
    return await ensurePolymarketInitialFunding(db, did, address);
  } catch (error) {
    console.error(
      `Initial Polymarket wallet funding failed for ${address}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};
