import { useRef, useState } from "react";
import {
  ActivityIndicator,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { showToastable } from "react-native-toastable";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import Slider from "@react-native-community/slider";
import { useTheme } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, type Address, type Hash } from "viem";

import { MarketTransactionStatus } from "~/components/market-transaction-status";
import { Text } from "~/components/themed/text";
import { api } from "~/lib/utils/api";
import { sanitizeDecimalInput } from "~/lib/utils/decimal-input";
import { formatTokenAmount, formatUsdAmount } from "~/lib/utils/format-token";
import {
  COLLATERAL_TOKEN_DECIMALS,
  monadTestnet,
  monadTestnetPublicClient,
  OUTCOME_TOKEN_DECIMALS,
  useErc20Balance,
  useMarketDetails,
  useMonBalance,
} from "~/lib/web3";

type MarketDetails = NonNullable<ReturnType<typeof useMarketDetails>["data"]>;
type FundingMarket = MarketDetails["market"];
type ClaimAction = "allocation" | "refund";

export const PredictionMarketFunding = ({
  account,
  marketAddress,
  market,
  graduated,
  currentTime,
  fundingFailed,
  onRefundClaimed,
}: {
  account?: Address;
  marketAddress: Address;
  market: FundingMarket;
  graduated: boolean;
  currentTime: bigint;
  fundingFailed: boolean;
  onRefundClaimed: () => void;
}) => {
  const theme = useTheme();
  const { _ } = useLingui();
  const queryClient = useQueryClient();
  const collateralBalance = useErc20Balance(account, market.collateral);
  const monBalance = useMonBalance(account);
  const [amount, setAmount] = useState("");
  const [reviewingContribution, setReviewingContribution] = useState(false);
  const [yesProbabilityBps, setYesProbabilityBps] = useState(
    Number(market.openingProbabilityBps),
  );
  const [pendingHash, setPendingHash] = useState<Hash | null>(null);
  const [pendingClaimAction, setPendingClaimAction] =
    useState<ClaimAction | null>(null);
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const contribute = api.markets.contribute.useMutation();
  const claimFunding = api.markets.claimFunding.useMutation();

  const remaining =
    market.fundingTarget > market.totalContributions
      ? market.fundingTarget - market.totalContributions
      : BigInt(0);
  const fundingOpen =
    !graduated &&
    !market.resolved &&
    market.fundingDeadline > currentTime &&
    remaining > BigInt(0);
  const hasContribution = market.accountContribution > BigInt(0);
  const amountRaw = parseContribution(amount);
  const hasEnoughUsdc =
    amountRaw !== null &&
    collateralBalance.data !== undefined &&
    collateralBalance.data >= amountRaw;
  const hasGas = monBalance.data !== undefined && monBalance.data > BigInt(0);
  const contributionIsValid = Boolean(
    account &&
    fundingOpen &&
    amountRaw !== null &&
    amountRaw > BigInt(0) &&
    amountRaw <= remaining &&
    hasEnoughUsdc &&
    hasGas &&
    !busy &&
    !pendingHash,
  );
  const canReviewContribution = contributionIsValid && !reviewingContribution;

  const waitForTransaction = async (
    hash: Hash,
    claimAction?: ClaimAction,
  ): Promise<boolean> => {
    setPendingHash(hash);
    setPendingClaimAction(claimAction ?? null);
    let receipt;
    try {
      receipt = await monadTestnetPublicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
    } catch (error) {
      showToastable({
        title: _(msg`Transaction still pending`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Check the transaction and try again.`),
        status: "warning",
      });
      return false;
    }

    if (receipt.status !== "success") {
      setPendingHash(null);
      setPendingClaimAction(null);
      showToastable({
        title: _(msg`Funding action not completed`),
        message: _(msg`The funding transaction failed on-chain.`),
        status: "danger",
      });
      return false;
    }

    setPendingHash(null);
    setPendingClaimAction(null);
    if (!claimAction) setAmount("");
    showToastable({
      title: claimAction
        ? _(msg`Claim confirmed`)
        : _(msg`Contribution confirmed`),
      message: claimAction
        ? _(msg`Your market claim is confirmed on-chain.`)
        : _(msg`Your contribution is confirmed on-chain.`),
      status: "success",
    });
    if (!claimAction) setReviewingContribution(false);
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "market", marketAddress],
      }),
      queryClient.invalidateQueries({
        queryKey: ["web3", monadTestnet.id, "balances"],
      }),
    ]);
    return true;
  };

  const submitContribution = async () => {
    if (
      !contributionIsValid ||
      !account ||
      amountRaw === null ||
      actionInFlight.current
    ) {
      return;
    }
    actionInFlight.current = true;
    setBusy(true);
    try {
      const result = await contribute.mutateAsync({
        marketAddress,
        amount,
        yesProbabilityBps,
      });
      await waitForTransaction(result.transactionHash);
    } catch (error) {
      showToastable({
        title: _(msg`Contribution not completed`),
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

  const submitClaim = async (action: ClaimAction) => {
    if (!account || busy || pendingHash || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    let claimConfirmed = false;
    try {
      const result = await claimFunding.mutateAsync({ marketAddress, action });
      claimConfirmed = await waitForTransaction(result.transactionHash, action);
    } catch (error) {
      showToastable({
        title: _(msg`Claim not completed`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Please check your wallet and try again.`),
        status: "danger",
      });
    } finally {
      actionInFlight.current = false;
      setBusy(false);
      if (claimConfirmed && action === "refund") onRefundClaimed();
    }
  };

  const checkPendingTransaction = async () => {
    if (!pendingHash || busy || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    const claimAction = pendingClaimAction ?? undefined;
    let transactionConfirmed = false;
    try {
      transactionConfirmed = await waitForTransaction(pendingHash, claimAction);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
      if (transactionConfirmed && claimAction === "refund") {
        onRefundClaimed();
      }
    }
  };

  if (graduated) {
    if (!hasContribution || market.accountAllocationClaimed) return null;

    return (
      <>
        <View
          className="mt-4 flex-row items-center rounded-xl border px-3.5 py-3"
          style={{
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
          }}
        >
          <View className="mr-3 min-w-0 flex-1">
            <Text className="text-sm font-semibold">
              <Trans>Outcome tokens ready</Trans>
            </Text>
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Claim your YES/NO allocation</Trans>
            </Text>
          </View>
          <FundingButton
            primary
            className=""
            disabled={busy}
            loading={busy}
            onPress={() =>
              void (pendingHash
                ? checkPendingTransaction()
                : submitClaim("allocation"))
            }
            title={
              busy
                ? _(msg`Submitting...`)
                : pendingHash
                  ? _(msg`Check transaction`)
                  : _(msg`Claim tokens`)
            }
          />
        </View>
        {pendingHash ? (
          <MarketTransactionStatus
            checking={busy}
            transactionHash={pendingHash ?? undefined}
          />
        ) : null}
      </>
    );
  }

  return (
    <View
      className="mt-4 rounded-2xl border p-4"
      style={{
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
      }}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold">
          {fundingFailed ? (
            <Trans>Market did not graduate</Trans>
          ) : (
            <Trans>Market funding</Trans>
          )}
        </Text>
        <Text className="text-xs font-semibold text-amber-700 dark:text-amber-400">
          {fundingFailed ? (
            <Trans>Funding ended</Trans>
          ) : (
            <Trans>Pre-market</Trans>
          )}
        </Text>
      </View>

      <MarketFundingProgress
        totalContributions={market.totalContributions}
        fundingTarget={market.fundingTarget}
        fundingFailed={fundingFailed}
      />

      {hasContribution && (
        <View
          className="mt-4 rounded-xl border p-3.5"
          style={{ borderColor: theme.colors.border }}
        >
          <Text className="text-sm font-semibold">
            <Trans>Your contribution</Trans>
          </Text>
          <Text className="mt-1 text-sm">
            {formatUsdAmount(
              market.accountContribution,
              COLLATERAL_TOKEN_DECIMALS,
            )}{" "}
            USDC
          </Text>
          {fundingFailed ? (
            <Text className="mt-2 text-xs text-amber-800 dark:text-amber-300">
              <Trans>
                The funding deadline passed before the goal was reached. Your
                contribution can be reclaimed below.
              </Trans>
            </Text>
          ) : market.accountYesAllocation > BigInt(0) ||
            market.accountNoAllocation > BigInt(0) ? (
            <View className="mt-2 flex-row">
              <FundingAllocation
                label={_(msg`YES shares`)}
                amount={formatTokenAmount(
                  market.accountYesAllocation,
                  OUTCOME_TOKEN_DECIMALS,
                  { maxFractionDigits: 4 },
                )}
              />
              <FundingAllocation
                label={_(msg`NO shares`)}
                amount={formatTokenAmount(
                  market.accountNoAllocation,
                  OUTCOME_TOKEN_DECIMALS,
                  { maxFractionDigits: 4 },
                )}
              />
            </View>
          ) : (
            <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>
                Exact YES and NO share allocations are calculated by the market
                contract and will appear here when available.
              </Trans>
            </Text>
          )}
          {fundingFailed && (
            <FundingButton
              primary
              className="mt-3"
              disabled={busy || Boolean(pendingHash)}
              loading={busy}
              onPress={() => void submitClaim("refund")}
              title={_(msg`Reclaim USDC`)}
            />
          )}
        </View>
      )}

      {fundingOpen && (
        <View className="mt-4">
          <Text className="mb-1.5 text-sm font-semibold">
            <Trans>Contribute USDC</Trans>
          </Text>
          <View
            className="flex-row items-center rounded-xl border px-3.5"
            style={{ borderColor: theme.colors.border }}
          >
            <Text className="mr-2 text-base font-medium">$</Text>
            <TextInput
              accessibilityLabel={_(msg`USDC contribution amount`)}
              editable={
                Boolean(account) &&
                !busy &&
                !pendingHash &&
                !reviewingContribution
              }
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={(value) =>
                setAmount(sanitizeDecimalInput(value, 6))
              }
              placeholder="0.00"
              className="flex-1 py-2.5 text-base text-black dark:text-white"
              placeholderTextColor={theme.dark ? "#737373" : "#a3a3a3"}
            />
            <Text className="text-sm font-medium">USDC</Text>
          </View>
          <View className="mt-1 flex-row justify-between">
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Available</Trans>{" "}
              {collateralBalance.data === undefined
                ? "—"
                : formatUsdAmount(
                    collateralBalance.data,
                    COLLATERAL_TOKEN_DECIMALS,
                  )}
            </Text>
          </View>
          {amountRaw !== null && amountRaw > remaining && (
            <Text className="mt-1 text-xs text-red-500">
              <Trans>Amount exceeds the remaining funding goal.</Trans>
            </Text>
          )}
          {amountRaw !== null &&
            amountRaw > BigInt(0) &&
            collateralBalance.data !== undefined &&
            amountRaw > collateralBalance.data && (
              <Text className="mt-1 text-xs text-red-500">
                <Trans>Amount exceeds your available USDC balance.</Trans>
              </Text>
            )}

          <View
            className="mt-4 rounded-xl border p-3.5"
            style={{ borderColor: theme.colors.border }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold">
                <Trans>Set YES probability</Trans>
              </Text>
              <Text className="text-sm font-semibold">
                YES {yesProbabilityBps / 100}%
              </Text>
            </View>
            <Slider
              accessibilityLabel={_(msg`YES probability for your contribution`)}
              disabled={
                !account ||
                busy ||
                Boolean(pendingHash) ||
                reviewingContribution
              }
              minimumValue={0}
              maximumValue={10_000}
              step={100}
              value={yesProbabilityBps}
              onValueChange={setYesProbabilityBps}
              minimumTrackTintColor="#22c55e"
              maximumTrackTintColor="#ef4444"
              thumbTintColor={theme.colors.primary}
            />
            <View className="flex-row justify-between">
              <Text className="text-xs font-medium text-green-700 dark:text-green-400">
                YES {yesProbabilityBps / 100}%
              </Text>
              <Text className="text-xs font-medium text-red-700 dark:text-red-400">
                NO {(10_000 - yesProbabilityBps) / 100}%
              </Text>
            </View>
            <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>
                Your USDC amount and selected probability are sent to the
                market.
              </Trans>
            </Text>
          </View>

          {reviewingContribution && (
            <View
              className="mt-4 rounded-xl border p-3.5"
              style={{ borderColor: theme.colors.primary }}
            >
              <Text className="text-sm font-semibold">
                <Trans>Review your contribution</Trans>
              </Text>
              <Text className="mt-1 text-sm">
                {formatUsdAmount(
                  amountRaw ?? BigInt(0),
                  COLLATERAL_TOKEN_DECIMALS,
                )}{" "}
                USDC
              </Text>
              <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                YES {yesProbabilityBps / 100}% / NO{" "}
                {(10_000 - yesProbabilityBps) / 100}%
              </Text>
              <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                <Trans>
                  Confirming will transfer this USDC amount from your wallet.
                  Your outcome tokens will be available for claim once the
                  market graduates.
                </Trans>
              </Text>
              <View className="mt-3 flex-row items-center">
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={busy || Boolean(pendingHash)}
                  onPress={() => setReviewingContribution(false)}
                  className="mr-3 rounded-full border px-4 py-2.5"
                  style={{ borderColor: theme.colors.border }}
                >
                  <Text primary className="text-sm font-semibold">
                    <Trans>Edit</Trans>
                  </Text>
                </TouchableOpacity>
                <View className="flex-1">
                  <FundingButton
                    primary
                    className=""
                    disabled={!contributionIsValid}
                    loading={busy}
                    onPress={() => void submitContribution()}
                    title={
                      busy
                        ? _(msg`Submitting...`)
                        : _(msg`Confirm contribution`)
                    }
                  />
                </View>
              </View>
            </View>
          )}
          {!reviewingContribution && (
            <FundingButton
              primary
              className="mt-3"
              disabled={!canReviewContribution}
              onPress={() => setReviewingContribution(true)}
              title={_(msg`Review contribution`)}
            />
          )}
          {!account && (
            <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Wallet not configured</Trans>
            </Text>
          )}
          {account && monBalance.data === BigInt(0) && (
            <Text className="mt-2 text-xs text-red-500">
              <Trans>Your wallet needs MON to pay transaction gas.</Trans>
            </Text>
          )}
        </View>
      )}

      {pendingHash && (
        <>
          <MarketTransactionStatus
            checking={busy}
            transactionHash={pendingHash ?? undefined}
          />
          <FundingButton
            primary
            className="mt-3"
            disabled={busy}
            loading={busy}
            onPress={() => void checkPendingTransaction()}
            title={_(msg`Check transaction`)}
          />
        </>
      )}
    </View>
  );
};

export const MarketFundingProgress = ({
  totalContributions,
  fundingTarget,
  fundingFailed = false,
}: {
  totalContributions: bigint;
  fundingTarget: bigint;
  fundingFailed?: boolean;
}) => {
  const remaining =
    fundingTarget > totalContributions
      ? fundingTarget - totalContributions
      : BigInt(0);
  const progressPercent =
    fundingTarget > BigInt(0)
      ? Math.min(
          100,
          Number((totalContributions * BigInt(10_000)) / fundingTarget) / 100,
        )
      : 0;

  return (
    <View className="mt-3">
      <View className="mb-1 flex-row items-end justify-between">
        <View>
          <Text className="text-xs text-neutral-500 dark:text-neutral-400">
            <Trans>Raised</Trans>
          </Text>
          <Text className="text-sm font-semibold">
            {formatUsdAmount(totalContributions, COLLATERAL_TOKEN_DECIMALS, {
              maxFractionDigits: 2,
            })}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-xs text-neutral-500 dark:text-neutral-400">
            {fundingFailed ? (
              <Trans>Funding goal</Trans>
            ) : (
              <Trans>To graduate</Trans>
            )}
          </Text>
          <Text className="text-sm font-semibold">
            {formatUsdAmount(
              fundingFailed ? fundingTarget : remaining,
              COLLATERAL_TOKEN_DECIMALS,
              {
                maxFractionDigits: 2,
              },
            )}
          </Text>
        </View>
      </View>
      <View
        accessible
        accessibilityLabel={
          fundingFailed
            ? `Funding ended: ${formatUsdAmount(totalContributions, COLLATERAL_TOKEN_DECIMALS)} raised toward a goal of ${formatUsdAmount(fundingTarget, COLLATERAL_TOKEN_DECIMALS)}`
            : `Funding progress: ${formatUsdAmount(totalContributions, COLLATERAL_TOKEN_DECIMALS)} raised, ${formatUsdAmount(remaining, COLLATERAL_TOKEN_DECIMALS)} needed to graduate`
        }
        className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
      >
        <View
          className="h-full rounded-full bg-green-500"
          style={{ width: `${progressPercent}%` }}
        />
      </View>
      {fundingFailed && (
        <Text className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300">
          <Trans>
            The funding period expired before the goal was reached. This market
            will not graduate.
          </Trans>
        </Text>
      )}
    </View>
  );
};

const FundingAllocation = ({
  label,
  amount,
}: {
  label: string;
  amount: string;
}) => (
  <View className="flex-1">
    <Text className="text-xs text-neutral-500 dark:text-neutral-400">
      {label}
    </Text>
    <Text className="mt-0.5 text-sm font-semibold">{amount}</Text>
  </View>
);

const FundingButton = ({
  className,
  disabled,
  onPress,
  primary = false,
  loading = false,
  title,
}: {
  className: string;
  disabled: boolean;
  onPress: () => void;
  primary?: boolean;
  loading?: boolean;
  title: string;
}) => {
  const theme = useTheme();

  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={
        primary
          ? {
              borderColor: theme.colors.primary,
              backgroundColor: theme.colors.primary,
            }
          : undefined
      }
      className={`items-center rounded-xl border px-4 py-2.5 ${className} ${disabled ? "opacity-50" : ""}`}
    >
      <View className="flex-row items-center justify-center">
        {loading ? <ActivityIndicator size="small" color="white" /> : null}
        <Text
          className={`${loading ? "ml-2" : ""}text-sm font-semibold text-white`}
        >
          {title}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

const parseContribution = (amount: string) => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) return null;
  try {
    return parseUnits(amount, COLLATERAL_TOKEN_DECIMALS);
  } catch {
    return null;
  }
};
