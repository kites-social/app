import { useCallback, useEffect, useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { showToastable } from "react-native-toastable";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { ChevronDown, ChevronUp, CopyIcon } from "lucide-react-native";
import { zeroAddress, type Address } from "viem";

import {
  MarketFundingProgress,
  PredictionMarketFunding,
} from "~/components/prediction-market-funding";
import {
  MarketDateTime,
  MarketResolutionStatus,
  PredictionMarketResolution,
  ResolvedMarketSummary,
} from "~/components/prediction-market-resolution";
import { Text } from "~/components/themed/text";
import { MarketTradeButton } from "~/components/widgets/markets/trade-button";
import { useHaptics } from "~/lib/hooks/preferences";
import { api } from "~/lib/utils/api";
import { formatTokenAmount, formatUsdAmount } from "~/lib/utils/format-token";
import {
  COLLATERAL_TOKEN_DECIMALS,
  OUTCOME_TOKEN_DECIMALS,
  useErc20Balance,
  useMarketDetails,
} from "~/lib/web3";
import {
  useChainTimestamp,
  useMarketResolution,
} from "~/lib/web3/hooks/market";
import {
  getCurrentYesProbabilityBps,
  getPoolSpotPrice,
  SPOT_PRICE_DECIMALS,
} from "~/lib/web3/market-pricing";

export const PredictionMarketCard = ({
  marketAddress,
  compact = false,
  sourcePostUri,
  sourcePostCid,
}: {
  marketAddress: Address;
  compact?: boolean;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) => {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [tradingEnded, setTradingEnded] = useState(false);
  const chainTimestampQuery = useChainTimestamp();
  const chainTimestamp = chainTimestampQuery.data;
  const wallet = api.wallet.mine.useQuery();
  const accountAddress = wallet.data?.address;
  const marketQuery = useMarketDetails(
    marketAddress,
    accountAddress ?? zeroAddress,
    15_000,
  );
  const marketDetails = marketQuery.data;
  const market = marketDetails?.market;
  const pools = marketDetails?.pools;
  const graduated = Boolean(
    pools?.yesPool.initialLiquiditySeeded ||
    pools?.noPool.initialLiquiditySeeded,
  );
  const resolutionQuery = useMarketResolution(
    marketAddress,
    market?.resolutionHub,
    tradingEnded && !market?.resolved,
    tradingEnded && !market?.resolved ? 15_000 : false,
  );

  useEffect(() => {
    setTradingEnded(
      Boolean(
        market &&
        graduated &&
        chainTimestamp !== undefined &&
        market.tradingEnd <= chainTimestamp,
      ),
    );
  }, [chainTimestamp, graduated, marketAddress, market?.tradingEnd]);

  const displayTimestamp =
    chainTimestamp ?? BigInt(Math.floor(Date.now() / 1_000));
  const fundingFailed = Boolean(
    market &&
    !graduated &&
    !market.resolved &&
    market.fundingDeadline <= displayTimestamp &&
    market.totalContributions < market.fundingTarget,
  );
  const retryResolution = useCallback(() => {
    void resolutionQuery.refetch();
  }, [resolutionQuery.refetch]);

  const hasError = marketQuery.isError;
  const isLoading = marketQuery.isPending;

  const retry = () => {
    void marketQuery.refetch();
  };

  const handlePress = () => {
    if (hasError) {
      retry();
      return;
    }

    setExpanded((previous) => !previous);
  };
  const collapseMarket = useCallback(() => setExpanded(false), []);

  const yesProbabilityBps =
    market && graduated && pools
      ? getCurrentYesProbabilityBps(pools.yesPool, pools.noPool)
      : market
        ? BigInt(market.openingProbabilityBps)
        : undefined;
  const yesProbability =
    yesProbabilityBps === undefined
      ? undefined
      : Math.min(100, Math.max(0, Number(yesProbabilityBps) / 100));
  const noProbability =
    yesProbability === undefined ? undefined : 100 - yesProbability;

  return (
    <View
      className={`${compact ? "mt-3" : "ml-14 mr-3 mt-3"} overflow-hidden rounded-[13px] border px-3`}
      style={{
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
      }}
    >
      <TouchableOpacity
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={handlePress}
        className="py-3 pr-8"
      >
        {market ? (
          <>
            <Text
              numberOfLines={3}
              className="text-[15px] font-semibold leading-5"
            >
              {market.question}
            </Text>
            {!graduated ? (
              <>
                <MarketFundingProgress
                  totalContributions={market.totalContributions}
                  fundingTarget={market.fundingTarget}
                  fundingFailed={fundingFailed}
                />
              </>
            ) : market.resolved ? (
              <ResolvedMarketSummary market={market} />
            ) : tradingEnded ? (
              <MarketResolutionStatus
                tradingEnded
                currentTime={displayTimestamp}
                resolution={resolutionQuery.data}
                resolutionLoading={resolutionQuery.isPending}
                resolutionError={resolutionQuery.isError}
                onRetryResolution={retryResolution}
              />
            ) : chainTimestamp === undefined ? (
              <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                <Trans>Checking trading status...</Trans>
              </Text>
            ) : (
              <>
                <View className="mt-3 flex-row items-center justify-between">
                  <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                    <Trans>Probability</Trans>
                  </Text>
                  <MarketDateTime
                    deadline={market.tradingEnd}
                    currentTime={displayTimestamp}
                    label={<Trans>Market ends</Trans>}
                  />
                </View>
                <View className="mt-2">
                  <View
                    className="h-2.5 flex-row overflow-hidden rounded-full"
                    accessibilityLabel={
                      yesProbability === undefined ||
                      noProbability === undefined
                        ? "Probability unavailable"
                        : `Probability: ${formatPercent(yesProbability)}% yes, ${formatPercent(noProbability)}% no`
                    }
                  >
                    <View
                      className="h-full bg-green-500"
                      style={{ width: `${yesProbability ?? 0}%` }}
                    />
                    <View
                      className="h-full bg-red-500"
                      style={{ width: `${noProbability ?? 0}%` }}
                    />
                  </View>
                  <View className="mt-1 flex-row justify-between">
                    <Text className="text-xs font-semibold text-green-700 dark:text-green-400">
                      <Trans>YES</Trans>{" "}
                      {yesProbability === undefined
                        ? "—"
                        : `${formatPercent(yesProbability)}%`}
                    </Text>
                    <Text className="text-xs font-semibold text-red-700 dark:text-red-400">
                      <Trans>NO</Trans>{" "}
                      {noProbability === undefined
                        ? "—"
                        : `${formatPercent(noProbability)}%`}
                    </Text>
                  </View>
                </View>
              </>
            )}
          </>
        ) : hasError ? (
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market data couldn&apos;t be loaded. Tap to retry.</Trans>
          </Text>
        ) : isLoading ? (
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Loading prediction market...</Trans>
          </Text>
        ) : (
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market details aren&apos;t available yet.</Trans>
          </Text>
        )}
        <View className="absolute right-0 top-3">
          {expanded ? (
            <ChevronUp size={18} color={theme.colors.text} />
          ) : (
            <ChevronDown size={18} color={theme.colors.text} />
          )}
        </View>
      </TouchableOpacity>

      {expanded && market && pools && marketDetails && (
        <View className="pb-4">
          <View
            className="border-t pt-4"
            style={{ borderColor: theme.colors.border }}
          >
            <View className="mb-2 flex-row">
              <CopyableMarketDetail
                className="flex-1"
                label={<Trans>Market creator</Trans>}
                address={market.creator}
                kind="creator"
              />
              <View style={{ width: 32 }} />
              <CopyableMarketDetail
                className="flex-1"
                label={<Trans>Market address</Trans>}
                address={marketAddress}
                kind="market"
              />
            </View>

            <PredictionMarketFunding
              account={accountAddress}
              marketAddress={marketAddress}
              market={market}
              graduated={graduated}
              currentTime={displayTimestamp}
              fundingFailed={fundingFailed}
              onRefundClaimed={collapseMarket}
            />
            {graduated && (tradingEnded || market.resolved) ? (
              <PredictionMarketResolution
                account={accountAddress}
                marketAddress={marketAddress}
                market={market}
                resolution={resolutionQuery.data}
                resolutionLoading={resolutionQuery.isPending}
                resolutionError={resolutionQuery.isError}
                currentTime={displayTimestamp}
                tradingEnded={tradingEnded}
                onRetryResolution={retryResolution}
                onProposalConfirmed={collapseMarket}
              />
            ) : graduated && chainTimestamp !== undefined ? (
              <>
                <MarketDateTime
                  deadline={market.tradingEnd}
                  currentTime={displayTimestamp}
                  label={<Trans>Market ends</Trans>}
                  spread
                  className="mt-3"
                />
                <MarketTradingPanel
                  account={accountAddress}
                  marketAddress={marketAddress}
                  market={market}
                  pools={pools}
                  sourcePostUri={sourcePostUri}
                  sourcePostCid={sourcePostCid}
                />
              </>
            ) : graduated ? (
              <Text className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                <Trans>Checking trading status...</Trans>
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
};

type MarketDetails = NonNullable<ReturnType<typeof useMarketDetails>["data"]>;

const MarketTradingPanel = ({
  account,
  marketAddress,
  market,
  pools,
  sourcePostUri,
  sourcePostCid,
}: {
  account?: Address;
  marketAddress: Address;
  market: MarketDetails["market"];
  pools: MarketDetails["pools"];
  sourcePostUri?: string;
  sourcePostCid?: string;
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { _ } = useLingui();
  const collateralBalance = useErc20Balance(account, market.collateral);
  const collateralBalanceText: React.ReactNode = !account ? (
    <Trans>Wallet not configured</Trans>
  ) : collateralBalance.isError ? (
    <Trans>Unable to load</Trans>
  ) : collateralBalance.isPending ? (
    <Trans>Loading...</Trans>
  ) : (
    formatUsdAmount(
      collateralBalance.data ?? BigInt(0),
      COLLATERAL_TOKEN_DECIMALS,
    )
  );
  const yesPrice = formatPoolSpotPrice(
    pools.yesPool.reserveCollateral,
    pools.yesPool.reserveOutcome,
  );
  const noPrice = formatPoolSpotPrice(
    pools.noPool.reserveCollateral,
    pools.noPool.reserveOutcome,
  );

  return (
    <View className="mt-4">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-base font-semibold">
          <Trans>Trade market</Trans>
        </Text>
        <Text className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
          {account ? (
            <Trans>Wallet {shortAddress(account)}</Trans>
          ) : (
            <Trans>No wallet address</Trans>
          )}
        </Text>
      </View>

      <View
        className="flex-row items-center justify-between border-b px-1 py-3"
        style={{ borderColor: theme.colors.border }}
      >
        <Text className="text-sm font-medium">
          <Trans>Your USDC</Trans>
        </Text>
        <Text className="ml-2 text-sm font-semibold">
          {collateralBalanceText}
        </Text>
      </View>

      <OutcomeTradeRow
        balance={
          account
            ? formatTokenAmount(
                market.accountYesBalance,
                OUTCOME_TOKEN_DECIMALS,
              )
            : undefined
        }
        outcome="YES"
        price={yesPrice}
        tone="yes"
        borderColor={theme.colors.border}
      />
      <OutcomeTradeRow
        balance={
          account
            ? formatTokenAmount(market.accountNoBalance, OUTCOME_TOKEN_DECIMALS)
            : undefined
        }
        outcome="NO"
        price={noPrice}
        tone="no"
        borderColor={theme.colors.border}
      />
      <MarketTradeButton
        marketName={market.question}
        venues={[
          {
            name: _(msg`Prediction market`),
            actions: [
              {
                label: _(msg`Buy YES`),
                onPress: () =>
                  router.push({
                    pathname: "/market-trade",
                    params: {
                      marketAddress,
                      outcome: "yes",
                      action: "buy",
                      sourcePostUri,
                      sourcePostCid,
                    },
                  }),
              },
              {
                label: _(msg`Sell YES`),
                onPress: () =>
                  router.push({
                    pathname: "/market-trade",
                    params: {
                      marketAddress,
                      outcome: "yes",
                      action: "sell",
                      sourcePostUri,
                      sourcePostCid,
                    },
                  }),
              },
              {
                label: _(msg`Buy NO`),
                onPress: () =>
                  router.push({
                    pathname: "/market-trade",
                    params: {
                      marketAddress,
                      outcome: "no",
                      action: "buy",
                      sourcePostUri,
                      sourcePostCid,
                    },
                  }),
              },
              {
                label: _(msg`Sell NO`),
                onPress: () =>
                  router.push({
                    pathname: "/market-trade",
                    params: {
                      marketAddress,
                      outcome: "no",
                      action: "sell",
                      sourcePostUri,
                      sourcePostCid,
                    },
                  }),
              },
            ],
          },
        ]}
      />
    </View>
  );
};

const OutcomeTradeRow = ({
  balance,
  borderColor,
  outcome,
  price,
  tone,
}: {
  balance?: string;
  borderColor: string;
  outcome: "YES" | "NO";
  price?: string;
  tone: "yes" | "no";
}) => {
  const outcomeColor =
    tone === "yes"
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400";

  return (
    <View
      className="mt-2 flex-row items-center border-b px-1 py-3"
      style={{ borderColor }}
    >
      <Text className={`w-10 text-sm font-bold ${outcomeColor}`}>
        {outcome === "YES" ? <Trans>YES</Trans> : <Trans>NO</Trans>}
      </Text>
      <View className="min-w-0 flex-1 px-2">
        <Text className="text-sm font-semibold" numberOfLines={1}>
          <Text className="font-normal text-neutral-500 dark:text-neutral-400">
            <Trans>Price:</Trans>{" "}
          </Text>
          {price ? <>{price}</> : <Trans>No liquidity</Trans>}
        </Text>
        <Text
          className="text-xs text-neutral-500 dark:text-neutral-400"
          numberOfLines={1}
        >
          {balance === undefined ? (
            <Trans>Balance unavailable</Trans>
          ) : (
            <Trans>Balance: {balance}</Trans>
          )}
        </Text>
      </View>
    </View>
  );
};

const CopyableMarketDetail = ({
  address,
  className,
  kind,
  label,
}: {
  address: Address;
  className: string;
  kind: "creator" | "market";
  label: React.ReactNode;
}) => {
  const theme = useTheme();
  const haptics = useHaptics();
  const { _ } = useLingui();

  const copyAddress = async () => {
    try {
      await Clipboard.setStringAsync(address);
      haptics.impact();
      showToastable({
        message: _(msg`Address copied`),
        status: "success",
      });
    } catch {
      showToastable({
        message: _(msg`Could not copy address`),
        status: "danger",
      });
    }
  };

  return (
    <View className={`min-w-0 ${className}`}>
      <Text className="text-xs text-neutral-500 dark:text-neutral-400">
        {label}
      </Text>
      <View className="mt-0.5 flex-row items-center">
        <Text
          numberOfLines={1}
          className="min-w-0 flex-1 text-sm text-neutral-500 dark:text-neutral-400"
        >
          {shortAddress(address)}
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={
            kind === "creator"
              ? _(msg`Copy creator address`)
              : _(msg`Copy market address`)
          }
          hitSlop={8}
          onPress={() => void copyAddress()}
          className="ml-1 p-1"
        >
          <CopyIcon size={14} color={theme.colors.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
};

const formatPercent = (value: number) => value.toFixed(2).replace(/\.?0+$/, "");

const formatPoolSpotPrice = (
  reserveCollateral: bigint,
  reserveOutcome: bigint,
) => {
  const scaledPrice = getPoolSpotPrice({ reserveCollateral, reserveOutcome });

  return scaledPrice === undefined
    ? undefined
    : formatUsdAmount(scaledPrice, SPOT_PRICE_DECIMALS, {
        maxFractionDigits: 6,
      });
};

const shortAddress = (address: Address) =>
  `${address.slice(0, 6)}...${address.slice(-4)}`;
