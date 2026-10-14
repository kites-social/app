import { COLLATERAL_TOKEN_DECIMALS, OUTCOME_TOKEN_DECIMALS } from "./constants";

interface PoolReserves {
  reserveCollateral: bigint;
  reserveOutcome: bigint;
}

export const SPOT_PRICE_DECIMALS = 12;
const BPS_DENOMINATOR = BigInt(10_000);

export const getPoolSpotPrice = (pool: PoolReserves) => {
  if (pool.reserveCollateral <= BigInt(0) || pool.reserveOutcome <= BigInt(0)) {
    return undefined;
  }

  return (
    (pool.reserveCollateral *
      BigInt(10) ** BigInt(OUTCOME_TOKEN_DECIMALS + SPOT_PRICE_DECIMALS)) /
    (pool.reserveOutcome * BigInt(10) ** BigInt(COLLATERAL_TOKEN_DECIMALS))
  );
};

export const getCurrentYesProbabilityBps = (
  yesPool: PoolReserves,
  noPool: PoolReserves,
) => {
  if (
    yesPool.reserveCollateral <= BigInt(0) ||
    yesPool.reserveOutcome <= BigInt(0) ||
    noPool.reserveCollateral <= BigInt(0) ||
    noPool.reserveOutcome <= BigInt(0)
  ) {
    return undefined;
  }

  const yesWeight = yesPool.reserveCollateral * noPool.reserveOutcome;
  const noWeight = noPool.reserveCollateral * yesPool.reserveOutcome;
  const combinedWeight = yesWeight + noWeight;

  return combinedWeight > BigInt(0)
    ? (yesWeight * BPS_DENOMINATOR) / combinedWeight
    : undefined;
};
