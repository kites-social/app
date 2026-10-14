import { useRef, useState } from "react";
import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import { showToastable } from "react-native-toastable";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import { type Address, type Hash } from "viem";

import { MarketTransactionStatus } from "~/components/market-transaction-status";
import { Text } from "~/components/themed/text";
import { api } from "~/lib/utils/api";
import { formatTokenAmount } from "~/lib/utils/format-token";
import {
  monadTestnet,
  monadTestnetPublicClient,
  OUTCOME_TOKEN_DECIMALS,
  useMarketDetails,
  useMarketResolution,
} from "~/lib/web3";
import { PredictionMarketResolutionActions } from "./prediction-market-resolution-actions";

type MarketDetails = NonNullable<ReturnType<typeof useMarketDetails>["data"]>;
type Market = MarketDetails["market"];
type Resolution = NonNullable<ReturnType<typeof useMarketResolution>["data"]>;

export const MarketDateTime = ({
  deadline,
  currentTime,
  label,
  expiredLabel,
  spread = false,
  className = "",
}: {
  deadline: bigint;
  currentTime: bigint;
  label: React.ReactNode;
  expiredLabel?: React.ReactNode;
  spread?: boolean;
  className?: string;
}) => {
  const isPastDeadline = currentTime >= deadline;
  const dateTime =
    isPastDeadline && expiredLabel
      ? expiredLabel
      : formatMarketDateTime(deadline);

  return (
    <View
      className={`flex-row items-center ${spread ? "w-full justify-between" : ""} ${className}`}
    >
      <Text className="mr-1 text-xs text-neutral-500 dark:text-neutral-400">
        {label}
      </Text>
      <Text
        className="text-xs font-semibold text-neutral-700 dark:text-neutral-300"
        numberOfLines={1}
      >
        {dateTime}
      </Text>
    </View>
  );
};

export const MarketCountdown = ({
  deadline,
  currentTime,
  label,
  className = "",
}: {
  deadline: bigint;
  currentTime: bigint;
  label: React.ReactNode;
  className?: string;
}) => {
  const secondsRemaining = deadline - currentTime;
  const countdown =
    secondsRemaining <= BigInt(0) ? null : formatDuration(secondsRemaining);

  return (
    <View className={`flex-row items-center justify-between ${className}`}>
      <Text className="mr-3 text-xs text-neutral-500 dark:text-neutral-400">
        {label}
      </Text>
      <Text className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
        {countdown ?? <Trans>Deadline passed</Trans>}
      </Text>
    </View>
  );
};

export const MarketResolutionStatus = ({
  tradingEnded,
  resolution,
  resolutionLoading,
  resolutionError,
  onRetryResolution,
  currentTime,
}: {
  tradingEnded: boolean;
  resolution?: Resolution;
  resolutionLoading?: boolean;
  resolutionError?: boolean;
  onRetryResolution?: () => void;
  currentTime: bigint;
}) => {
  if (!tradingEnded) return null;

  if (!resolution) {
    return resolutionLoading ? (
      <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        <Trans>Checking resolution status...</Trans>
      </Text>
    ) : resolutionError ? (
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onRetryResolution}
        className="mt-2 self-start"
      >
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>Couldn&apos;t load resolution status. Tap to retry.</Trans>
        </Text>
      </TouchableOpacity>
    ) : (
      <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        <Trans>Awaiting resolution status</Trans>
      </Text>
    );
  }

  const phase = Number(resolution.phase);
  return (
    <View className="mt-2">
      <Text className="text-xs font-semibold text-amber-700 dark:text-amber-400">
        {phase === 0 ? (
          <Trans>Awaiting a resolution proposal</Trans>
        ) : (
          resolutionPhaseLabel(phase)
        )}
      </Text>
      {phase > 0 && resolution.proposedOutcome > 0 && (
        <View
          className={`mt-2 flex-row items-center self-start rounded-xl px-3 py-2 ${
            resolution.proposedOutcome === 1
              ? "bg-green-500/10"
              : resolution.proposedOutcome === 2
                ? "bg-red-500/10"
                : "bg-neutral-500/10"
          }`}
        >
          <View
            className={`mr-2 h-2 w-2 rounded-full ${
              resolution.proposedOutcome === 1
                ? "bg-green-500"
                : resolution.proposedOutcome === 2
                  ? "bg-red-500"
                  : "bg-neutral-500"
            }`}
          />
          <Text className="text-xs text-neutral-500 dark:text-neutral-400">
            <Trans>Proposed outcome</Trans>
          </Text>
          <Text
            className={`ml-2 text-sm font-bold ${
              resolution.proposedOutcome === 1
                ? "text-green-700 dark:text-green-400"
                : resolution.proposedOutcome === 2
                  ? "text-red-700 dark:text-red-400"
                  : "text-neutral-700 dark:text-neutral-200"
            }`}
          >
            {resolution.proposedOutcome === 1 ? (
              <Trans>YES</Trans>
            ) : resolution.proposedOutcome === 2 ? (
              <Trans>NO</Trans>
            ) : (
              <Trans>Cancelled</Trans>
            )}
          </Text>
        </View>
      )}
      {phase > 0 && resolution.deadline > BigInt(0) ? (
        <MarketCountdown
          deadline={resolution.deadline}
          currentTime={currentTime}
          label={<Trans>Time left in this step</Trans>}
          className="mt-1"
        />
      ) : phase > 0 ? (
        <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>Waiting for the current resolution step to begin</Trans>
        </Text>
      ) : null}
    </View>
  );
};

export const ResolvedMarketSummary = ({ market }: { market: Market }) => {
  const finalOutcome = Number(market.finalOutcome);
  const outcomeText =
    finalOutcome === 1 ? (
      <Trans>YES won</Trans>
    ) : finalOutcome === 2 ? (
      <Trans>NO won</Trans>
    ) : finalOutcome === 3 ? (
      <Trans>Market cancelled</Trans>
    ) : (
      <Trans>Outcome unavailable</Trans>
    );
  const outcomeColor =
    finalOutcome === 1
      ? "text-green-700 dark:text-green-400"
      : finalOutcome === 2
        ? "text-red-700 dark:text-red-400"
        : "text-neutral-600 dark:text-neutral-300";

  return (
    <View className="mt-2 flex-row items-center">
      <Text className="text-xs text-neutral-500 dark:text-neutral-400">
        <Trans>Resolved</Trans>
      </Text>
      <Text className={`ml-2 text-sm font-bold ${outcomeColor}`}>
        {outcomeText}
      </Text>
    </View>
  );
};

export const PredictionMarketResolution = ({
  account,
  marketAddress,
  market,
  resolution,
  resolutionLoading,
  resolutionError,
  tradingEnded,
  currentTime,
  onRetryResolution,
  onProposalConfirmed,
}: {
  account?: Address;
  marketAddress: Address;
  market: Market;
  resolution?: Resolution;
  resolutionLoading?: boolean;
  resolutionError?: boolean;
  tradingEnded: boolean;
  currentTime: bigint;
  onRetryResolution?: () => void;
  onProposalConfirmed?: () => void;
}) => {
  const theme = useTheme();

  if (!market.resolved) {
    return (
      <View
        className="mt-4 rounded-2xl border p-4"
        style={{
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
        }}
      >
        <Text className="text-base font-semibold">
          <Trans>Market resolution</Trans>
        </Text>
        <MarketResolutionStatus
          tradingEnded={tradingEnded}
          resolution={resolution}
          resolutionLoading={resolutionLoading}
          resolutionError={resolutionError}
          currentTime={currentTime}
          onRetryResolution={onRetryResolution}
        />
        {market.resolutionCriteria.trim().length > 0 && (
          <View className="mt-3 rounded-xl bg-neutral-100 p-3.5 dark:bg-neutral-800">
            <Text className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
              <Trans>Resolution criteria</Trans>
            </Text>
            <Text className="mt-1 text-sm">{market.resolutionCriteria}</Text>
          </View>
        )}
        <PredictionMarketResolutionActions
          account={account}
          marketAddress={marketAddress}
          market={market}
          resolution={resolution}
          currentTime={currentTime}
          onProposalConfirmed={onProposalConfirmed}
        />
      </View>
    );
  }

  return (
    <ResolvedMarketPanel
      account={account}
      marketAddress={marketAddress}
      market={market}
    />
  );
};

const ResolvedMarketPanel = ({
  account,
  marketAddress,
  market,
}: {
  account?: Address;
  marketAddress: Address;
  market: Market;
}) => {
  const theme = useTheme();
  const { _ } = useLingui();
  const queryClient = useQueryClient();
  const [pendingHash, setPendingHash] = useState<Hash | null>(null);
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const claim = api.markets.claimWinningShares.useMutation();
  const finalOutcome = Number(market.finalOutcome);
  const redeemableOutcome = finalOutcome === 1 || finalOutcome === 2;
  const winningOutcome = finalOutcome === 1 ? "YES" : "NO";
  const winningBalance =
    finalOutcome === 1
      ? market.accountYesBalance
      : finalOutcome === 2
        ? market.accountNoBalance
        : BigInt(0);
  const outcomeLabel =
    finalOutcome === 1 ? (
      <Trans>YES</Trans>
    ) : finalOutcome === 2 ? (
      <Trans>NO</Trans>
    ) : finalOutcome === 3 ? (
      <Trans>Cancelled</Trans>
    ) : (
      <Trans>Unavailable</Trans>
    );
  const outcomeColor =
    finalOutcome === 1
      ? "text-green-700 dark:text-green-400"
      : finalOutcome === 2
        ? "text-red-700 dark:text-red-400"
        : "text-neutral-600 dark:text-neutral-300";

  const waitForClaim = async (hash: Hash) => {
    setPendingHash(hash);
    let receipt;
    try {
      receipt = await monadTestnetPublicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
    } catch (error) {
      showToastable({
        title: _(msg`Claim still pending`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Check the transaction and try again.`),
        status: "warning",
      });
      return;
    }

    setPendingHash(null);
    if (receipt.status !== "success") {
      showToastable({
        title: _(msg`Winning shares not claimed`),
        message: _(msg`The claim transaction failed on-chain.`),
        status: "danger",
      });
      return;
    }

    showToastable({
      title: _(msg`Winnings claimed`),
      message: _(msg`Your winning shares were redeemed for USDC.`),
      status: "success",
    });
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "market", marketAddress],
      }),
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "balances"],
      }),
    ]);
  };

  const submitClaim = async () => {
    if (!account || busy || pendingHash || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      const result = await claim.mutateAsync({ marketAddress });
      await waitForClaim(result.transactionHash);
    } catch (error) {
      showToastable({
        title: _(msg`Winnings not claimed`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Please check your wallet and try again.`),
        status: "danger",
      });
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  const checkPending = async () => {
    if (!pendingHash || busy || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      await waitForClaim(pendingHash);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <View
      className="mt-4 rounded-2xl border p-4"
      style={{
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
      }}
    >
      <Text className="text-base font-semibold">
        <Trans>Market resolved</Trans>
      </Text>
      <Text className="mt-1 text-sm">
        <Trans>Final outcome</Trans>{" "}
        <Text className={`font-bold ${outcomeColor}`}>{outcomeLabel}</Text>
      </Text>

      {!redeemableOutcome ? (
        <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>
            Winning-share redemption is not available for this outcome.
          </Trans>
        </Text>
      ) : winningBalance > BigInt(0) ? (
        <View
          className="mt-4 flex-row items-center rounded-xl border px-3.5 py-3"
          style={{ borderColor: theme.colors.border }}
        >
          <View className="mr-3 min-w-0 flex-1">
            <Text className="text-sm font-semibold">
              <Trans>Winning shares ready</Trans>
            </Text>
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              {formatTokenAmount(winningBalance, OUTCOME_TOKEN_DECIMALS)}{" "}
              {winningOutcome} <Trans>shares</Trans>
            </Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={!account || busy}
            onPress={() => void (pendingHash ? checkPending() : submitClaim())}
            className="items-center rounded-xl border px-4 py-3"
            style={{
              borderColor: theme.colors.primary,
              backgroundColor: theme.colors.primary,
              opacity: busy ? 0.5 : 1,
            }}
          >
            <View className="flex-row items-center justify-center">
              {busy ? (
                <ActivityIndicator
                  size="small"
                  color="white"
                  className="mr-2"
                />
              ) : null}
              <Text className="text-sm font-semibold text-white">
                {pendingHash
                  ? _(msg`Check transaction`)
                  : _(msg`Claim winnings`)}
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      ) : account ? (
        <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>This wallet has no winning shares to claim.</Trans>
        </Text>
      ) : (
        <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>Configure a wallet to check for claimable winnings.</Trans>
        </Text>
      )}

      {pendingHash ? (
        <MarketTransactionStatus
          checking={busy}
          transactionHash={pendingHash}
        />
      ) : null}
    </View>
  );
};

const resolutionPhaseLabel = (phase: number): React.ReactNode => {
  switch (phase) {
    case 1:
      return <Trans>Proposal challenge period</Trans>;
    case 2:
      return <Trans>Council vote</Trans>;
    case 3:
      return <Trans>Council challenge period</Trans>;
    case 4:
      return <Trans>Outcome-holder vote</Trans>;
    case 5:
      return <Trans>Holder challenge period</Trans>;
    case 6:
      return <Trans>Attester vote</Trans>;
    case 7:
      return <Trans>Resolution finalized</Trans>;
    default:
      return <Trans>Resolution in progress</Trans>;
  }
};

const formatDuration = (seconds: bigint) => {
  const days = seconds / BigInt(86_400);
  const hours = (seconds % BigInt(86_400)) / BigInt(3_600);
  const minutes = (seconds % BigInt(3_600)) / BigInt(60);
  const remainingSeconds = seconds % BigInt(60);

  if (days > BigInt(0)) return `${days}d ${hours}h`;
  if (hours > BigInt(0)) return `${hours}h ${minutes}m`;
  if (minutes > BigInt(0)) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
};

const formatMarketDateTime = (timestamp: bigint) => {
  const date = new Date(Number(timestamp) * 1_000);
  const includeYear = date.getFullYear() !== new Date().getFullYear();

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
};
