import { useRef, useState } from "react";
import { ActivityIndicator, Alert, TouchableOpacity, View } from "react-native";
import { showToastable } from "react-native-toastable";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import { zeroAddress, type Address, type Hash } from "viem";

import { MarketTransactionStatus } from "~/components/market-transaction-status";
import { Text } from "~/components/themed/text";
import { api } from "~/lib/utils/api";
import { formatUsdAmount } from "~/lib/utils/format-token";
import {
  COLLATERAL_TOKEN_DECIMALS,
  monadTestnet,
  monadTestnetPublicClient,
  useMarketDetails,
  useMarketResolution,
} from "~/lib/web3";

type Market = NonNullable<
  ReturnType<typeof useMarketDetails>["data"]
>["market"];
type Resolution = NonNullable<ReturnType<typeof useMarketResolution>["data"]>;
type ResolutionOutcome = "YES" | "NO" | "CANCELLED";

export const PredictionMarketResolutionActions = ({
  account,
  marketAddress,
  market,
  resolution,
  currentTime,
  onProposalConfirmed,
}: {
  account?: Address;
  marketAddress: Address;
  market: Market;
  resolution?: Resolution;
  currentTime: bigint;
  onProposalConfirmed?: () => void;
}) => {
  const theme = useTheme();
  const { _ } = useLingui();
  const queryClient = useQueryClient();
  const [pendingHash, setPendingHash] = useState<Hash | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "proposal" | "finalize" | null
  >(null);
  const [pendingOutcome, setPendingOutcome] =
    useState<ResolutionOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const propose = api.markets.proposeResolution.useMutation();
  const finalize = api.markets.finalizeUnchallengedProposal.useMutation();
  const phase = resolution ? Number(resolution.phase) : -1;
  const bondAmount = resolution?.resolverBondAmount ?? BigInt(0);
  const bondText = formatUsdAmount(bondAmount, COLLATERAL_TOKEN_DECIMALS);
  const canFinalize = Boolean(
    resolution &&
    phase === 1 &&
    resolution.deadline > BigInt(0) &&
    resolution.deadline <= currentTime &&
    resolution.firstDisputer === zeroAddress,
  );

  const invalidateResolutionData = async () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "market", marketAddress],
      }),
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "market-resolution", marketAddress],
      }),
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "balances"],
      }),
    ]);

  const waitForResolutionTransaction = async (
    hash: Hash,
    action: "proposal" | "finalize",
  ): Promise<"confirmed" | "failed" | "pending"> => {
    setPendingHash(hash);
    setPendingAction(action);
    let receipt;
    try {
      receipt = await monadTestnetPublicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
    } catch {
      return "pending";
    }

    setPendingHash(null);
    setPendingAction(null);
    if (receipt.status !== "success") {
      setPendingOutcome(null);
      showToastable({
        title: _(msg`Resolution action failed`),
        message: _(msg`The transaction failed on-chain.`),
        status: "danger",
      });
      await invalidateResolutionData();
      return "failed";
    }

    setPendingOutcome(null);
    showToastable({
      title:
        action === "proposal"
          ? _(msg`Resolution proposed`)
          : _(msg`Market resolution finalized`),
      message:
        action === "proposal"
          ? _(msg`The proposal is now in its challenge period.`)
          : _(msg`The market outcome is finalized on-chain.`),
      status: "success",
    });
    if (action === "proposal") onProposalConfirmed?.();
    await invalidateResolutionData();
    return "confirmed";
  };

  const runAction = async (
    action: "proposal" | "finalize",
    outcome?: ResolutionOutcome,
  ) => {
    if (!account || busy || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setPendingOutcome(action === "proposal" ? (outcome ?? "YES") : null);
    try {
      const result =
        action === "proposal"
          ? await propose.mutateAsync({
              marketAddress,
              outcome: outcome ?? "YES",
            })
          : await finalize.mutateAsync({ marketAddress });
      await waitForResolutionTransaction(result.transactionHash, action);
    } catch (error) {
      setPendingOutcome(null);
      showToastable({
        title:
          action === "proposal"
            ? _(msg`Resolution not proposed`)
            : _(msg`Resolution not finalized`),
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
    if (!pendingHash || !pendingAction || busy || actionInFlight.current)
      return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      await waitForResolutionTransaction(pendingHash, pendingAction);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  const confirmProposal = (outcome: ResolutionOutcome) => {
    const outcomeLabel = outcome === "CANCELLED" ? _(msg`Cancelled`) : outcome;
    Alert.alert(
      _(msg`Propose ${outcomeLabel}?`),
      _(
        msg`A ${bondText} USDC resolver bond is required. The contract determines whether the bond is returned or slashed.`,
      ),
      [
        { text: _(msg`Cancel`), style: "cancel" },
        {
          text: _(msg`Propose ${outcomeLabel}`),
          onPress: () => void runAction("proposal", outcome),
        },
      ],
    );
  };

  if (!resolution || market.resolved) return null;

  return (
    <View
      className="mt-3 border-t pt-3"
      style={{ borderColor: theme.colors.border }}
    >
      {phase === 0 || (pendingHash !== null && pendingAction === "proposal") ? (
        <>
          <Text className="text-sm font-semibold">
            <Trans>Propose the market outcome</Trans>
          </Text>

          <View
            className="mt-3 flex-row items-center justify-between rounded-xl border px-3.5 py-3"
            style={{ borderColor: theme.colors.border }}
          >
            <Text className="text-sm">
              <Trans>Resolver bond</Trans>
            </Text>
            <Text className="text-sm font-semibold">{bondText} USDC</Text>
          </View>
          <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            <Trans>
              The resolver bond may be returned or slashed under the
              market&apos;s rules.
            </Trans>
          </Text>
          {account ? (
            <View className="mt-3 flex-row">
              <ResolutionActionButton
                label={_(msg`YES`)}
                loading={busy && pendingOutcome === "YES"}
                disabled={
                  busy || Boolean(pendingHash && pendingOutcome !== "YES")
                }
                color="#16a34a"
                onPress={() =>
                  void (pendingHash && pendingAction === "proposal"
                    ? checkPending()
                    : confirmProposal("YES"))
                }
                compact
              />
              <ResolutionActionButton
                label={_(msg`NO`)}
                loading={busy && pendingOutcome === "NO"}
                disabled={
                  busy || Boolean(pendingHash && pendingOutcome !== "NO")
                }
                color="#dc2626"
                onPress={() =>
                  void (pendingHash && pendingAction === "proposal"
                    ? checkPending()
                    : confirmProposal("NO"))
                }
                className="ml-2"
                compact
              />
              <ResolutionActionButton
                label={_(msg`Cancelled`)}
                loading={busy && pendingOutcome === "CANCELLED"}
                disabled={
                  busy || Boolean(pendingHash && pendingOutcome !== "CANCELLED")
                }
                color="#6b7280"
                onPress={() =>
                  void (pendingHash && pendingAction === "proposal"
                    ? checkPending()
                    : confirmProposal("CANCELLED"))
                }
                className="ml-2"
                compact
              />
            </View>
          ) : (
            <Text className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Configure a linked wallet to propose an outcome.</Trans>
            </Text>
          )}
        </>
      ) : canFinalize ? (
        <View>
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            <Trans>
              The proposal was not challenged before its deadline. Anyone can
              now finalize it.
            </Trans>
          </Text>
          {account ? (
            <ResolutionActionButton
              label={_(msg`Finalize resolution`)}
              loading={busy && canFinalize}
              disabled={
                busy || Boolean(pendingHash && pendingAction !== "finalize")
              }
              color={theme.colors.primary}
              onPress={() =>
                void (pendingHash ? checkPending() : runAction("finalize"))
              }
              className="mt-3 self-start"
            />
          ) : (
            <Text className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>
                Configure a linked wallet to finalize this proposal.
              </Trans>
            </Text>
          )}
        </View>
      ) : phase === 1 && resolution.firstDisputer !== zeroAddress ? (
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>
            This proposal was challenged and cannot be finalized as
            unchallenged.
          </Trans>
        </Text>
      ) : null}
      {pendingHash ? (
        <MarketTransactionStatus
          checking={busy}
          transactionHash={pendingHash}
        />
      ) : null}
    </View>
  );
};

const ResolutionActionButton = ({
  label,
  disabled,
  color,
  onPress,
  className = "",
  compact = false,
  loading = false,
}: {
  label: string;
  disabled: boolean;
  color: string;
  onPress: () => void;
  className?: string;
  compact?: boolean;
  loading?: boolean;
}) => (
  <TouchableOpacity
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    className={`items-center rounded-xl ${compact ? "min-w-0 flex-1 px-1.5 py-2.5" : "px-4 py-3"} ${className}`}
    style={{ backgroundColor: color, opacity: disabled ? 0.5 : 1 }}
  >
    <View className="flex-row items-center justify-center">
      {loading ? (
        <ActivityIndicator
          size="small"
          color="white"
          className={compact ? "mr-1" : "mr-2"}
        />
      ) : null}
      <Text
        className={`font-semibold text-white ${compact ? "text-xs" : "text-sm"}`}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  </TouchableOpacity>
);
