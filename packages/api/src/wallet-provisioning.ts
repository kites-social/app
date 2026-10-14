import { type Address, type Hash } from "viem";

import { type PrismaClient } from "@kites-social/db";

import { fundNewWallet, fundPolymarketWallet } from "./wallet-funding";

const FUNDING_LOCK_TIMEOUT_MS = 10 * 60 * 1_000;
const ADMIN_NONCE_LOCK_TIMEOUT_MS = 60 * 1_000;
const ADMIN_NONCE_LOCK_WAIT_MS = 30 * 1_000;
const ADMIN_NONCE_LOCK_IDS = {
  monad: "monad-testnet-admin",
  polygon: "polygon-mainnet-admin",
} as const;

type FundingDb = Pick<PrismaClient, "evmWallet" | "evmFundingNonceLock">;

async function withAdminNonceLock<T>(
  db: FundingDb,
  lockId: string,
  action: () => Promise<T>,
): Promise<T> {
  await db.evmFundingNonceLock.upsert({
    where: { id: lockId },
    create: { id: lockId },
    update: {},
  });

  const deadline = Date.now() + ADMIN_NONCE_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const lockAt = new Date();
    const staleBefore = new Date(
      lockAt.getTime() - ADMIN_NONCE_LOCK_TIMEOUT_MS,
    );
    const claim = await db.evmFundingNonceLock.updateMany({
      where: {
        id: lockId,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      data: { lockedAt: lockAt },
    });
    if (claim.count === 1) {
      try {
        return await action();
      } finally {
        await db.evmFundingNonceLock
          .updateMany({
            where: { id: lockId, lockedAt: lockAt },
            data: { lockedAt: null },
          })
          .catch(() => undefined);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for the admin wallet nonce lock");
}

/**
 * Sends the one-time testnet MON + USDC grant to a freshly provisioned wallet.
 *
 * Serializes admin-wallet nonce use across API instances and records each
 * transaction hash before broadcasting so a retry can resume rather than
 * double-spend. Returns `true` when this call performed the funding.
 */
export async function ensureInitialFunding(
  db: FundingDb,
  did: string,
  address: Address,
): Promise<boolean> {
  const withMonadAdminNonceLock = <T>(action: () => Promise<T>) =>
    withAdminNonceLock(db, ADMIN_NONCE_LOCK_IDS.monad, action);

  const state = await db.evmWallet.findUnique({
    where: { userDid: did },
    select: { initialFundingComplete: true },
  });
  if (!state) throw new Error("Wallet disappeared during provisioning");
  if (state.initialFundingComplete) return false;

  const lockAt = new Date();
  const lockExpiredBefore = new Date(
    lockAt.getTime() - FUNDING_LOCK_TIMEOUT_MS,
  );
  const claim = await db.evmWallet.updateMany({
    where: {
      userDid: did,
      initialFundingComplete: false,
      OR: [
        { initialFundingLockAt: null },
        { initialFundingLockAt: { lt: lockExpiredBefore } },
      ],
    },
    data: { initialFundingLockAt: lockAt },
  });
  if (claim.count === 0) {
    const latest = await db.evmWallet.findUnique({
      where: { userDid: did },
      select: { initialFundingComplete: true },
    });
    if (!latest) throw new Error("Wallet disappeared during provisioning");
    if (latest.initialFundingComplete) return false;
    throw new Error("Initial wallet funding is already in progress");
  }

  const saveMonTxHash = async (hash: Hash | null) => {
    const result = await db.evmWallet.updateMany({
      where: {
        userDid: did,
        initialFundingComplete: false,
        initialFundingLockAt: lockAt,
      },
      data: { initialMonFundingTxHash: hash },
    });
    if (result.count !== 1) throw new Error("Lost wallet funding lock");
  };
  const saveUsdcTxHash = async (hash: Hash | null) => {
    const result = await db.evmWallet.updateMany({
      where: {
        userDid: did,
        initialFundingComplete: false,
        initialFundingLockAt: lockAt,
      },
      data: { initialUsdcFundingTxHash: hash },
    });
    if (result.count !== 1) throw new Error("Lost wallet funding lock");
  };

  try {
    const fundingProgress = await db.evmWallet.findUniqueOrThrow({
      where: { userDid: did },
      select: {
        initialMonFundingTxHash: true,
        initialUsdcFundingTxHash: true,
      },
    });

    await fundNewWallet(address, {
      monTxHash: fundingProgress.initialMonFundingTxHash,
      usdcTxHash: fundingProgress.initialUsdcFundingTxHash,
      saveMonTxHash,
      saveUsdcTxHash,
      withAdminNonceLock: withMonadAdminNonceLock,
    });

    const completed = await db.evmWallet.updateMany({
      where: {
        userDid: did,
        initialFundingComplete: false,
        initialFundingLockAt: lockAt,
      },
      data: { initialFundingComplete: true, initialFundingLockAt: null },
    });
    if (completed.count !== 1) {
      const latest = await db.evmWallet.findUnique({
        where: { userDid: did },
        select: { initialFundingComplete: true },
      });
      if (!latest?.initialFundingComplete) {
        throw new Error("Could not mark initial wallet funding complete");
      }
    }

    return true;
  } catch (error) {
    await db.evmWallet
      .updateMany({
        where: {
          userDid: did,
          initialFundingComplete: false,
          initialFundingLockAt: lockAt,
        },
        data: { initialFundingLockAt: null },
      })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Sends the one-time Polygon POL + pUSD grant for Polymarket onboarding.
 */
export async function ensurePolymarketInitialFunding(
  db: FundingDb,
  did: string,
  address: Address,
): Promise<boolean> {
  const withPolygonAdminNonceLock = <T>(action: () => Promise<T>) =>
    withAdminNonceLock(db, ADMIN_NONCE_LOCK_IDS.polygon, action);

  const state = await db.evmWallet.findUnique({
    where: { userDid: did },
    select: { polymarketInitialFundingComplete: true },
  });
  if (!state) throw new Error("Wallet disappeared during Polymarket funding");
  if (state.polymarketInitialFundingComplete) return false;

  const lockAt = new Date();
  const lockExpiredBefore = new Date(
    lockAt.getTime() - FUNDING_LOCK_TIMEOUT_MS,
  );
  const claim = await db.evmWallet.updateMany({
    where: {
      userDid: did,
      polymarketInitialFundingComplete: false,
      OR: [
        { polymarketInitialFundingLockAt: null },
        { polymarketInitialFundingLockAt: { lt: lockExpiredBefore } },
      ],
    },
    data: { polymarketInitialFundingLockAt: lockAt },
  });
  if (claim.count === 0) {
    const latest = await db.evmWallet.findUnique({
      where: { userDid: did },
      select: { polymarketInitialFundingComplete: true },
    });
    if (!latest)
      throw new Error("Wallet disappeared during Polymarket funding");
    if (latest.polymarketInitialFundingComplete) return false;
    throw new Error("Polymarket wallet funding is already in progress");
  }

  const savePolTxHash = async (hash: Hash | null) => {
    const result = await db.evmWallet.updateMany({
      where: {
        userDid: did,
        polymarketInitialFundingComplete: false,
        polymarketInitialFundingLockAt: lockAt,
      },
      data: { polymarketInitialPolFundingTxHash: hash },
    });
    if (result.count !== 1) throw new Error("Lost Polymarket funding lock");
  };
  const savePusdTxHash = async (hash: Hash | null) => {
    const result = await db.evmWallet.updateMany({
      where: {
        userDid: did,
        polymarketInitialFundingComplete: false,
        polymarketInitialFundingLockAt: lockAt,
      },
      data: { polymarketInitialPusdFundingTxHash: hash },
    });
    if (result.count !== 1) throw new Error("Lost Polymarket funding lock");
  };

  try {
    const fundingProgress = await db.evmWallet.findUniqueOrThrow({
      where: { userDid: did },
      select: {
        polymarketInitialPolFundingTxHash: true,
        polymarketInitialPusdFundingTxHash: true,
      },
    });

    await fundPolymarketWallet(address, {
      polTxHash: fundingProgress.polymarketInitialPolFundingTxHash,
      pusdTxHash: fundingProgress.polymarketInitialPusdFundingTxHash,
      savePolTxHash,
      savePusdTxHash,
      withAdminNonceLock: withPolygonAdminNonceLock,
    });

    const completed = await db.evmWallet.updateMany({
      where: {
        userDid: did,
        polymarketInitialFundingComplete: false,
        polymarketInitialFundingLockAt: lockAt,
      },
      data: {
        polymarketInitialFundingComplete: true,
        polymarketInitialFundingLockAt: null,
      },
    });
    if (completed.count !== 1) {
      const latest = await db.evmWallet.findUnique({
        where: { userDid: did },
        select: { polymarketInitialFundingComplete: true },
      });
      if (!latest?.polymarketInitialFundingComplete) {
        throw new Error("Could not mark Polymarket wallet funding complete");
      }
    }

    return true;
  } catch (error) {
    await db.evmWallet
      .updateMany({
        where: {
          userDid: did,
          polymarketInitialFundingComplete: false,
          polymarketInitialFundingLockAt: lockAt,
        },
        data: { polymarketInitialFundingLockAt: null },
      })
      .catch(() => undefined);
    throw error;
  }
}
