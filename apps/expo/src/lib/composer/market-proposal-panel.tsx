import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  TouchableOpacity,
  View,
} from "react-native";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import DateTimePicker, {
  DateTimePickerAndroid,
} from "@react-native-community/datetimepicker";
import Slider from "@react-native-community/slider";
import { useTheme } from "@react-navigation/native";
import { parseUnits } from "viem";

import { Text } from "~/components/themed/text";
import { TextInput } from "~/components/themed/text-input";
import { api, type RouterOutputs } from "~/lib/utils/api";
import { sanitizeDecimalInput } from "~/lib/utils/decimal-input";
import { formatTokenAmount, formatUsdAmount } from "~/lib/utils/format-token";
import {
  COLLATERAL_TOKEN_DECIMALS,
  MARKET_FUNDING_TARGET_LABEL,
  MARKET_FUNDING_TARGET_USDC,
  MARKET_FUNDING_WINDOW_DAYS,
  MIN_TRADING_DURATION_DAYS,
  useErc20Balance,
  useMonBalance,
} from "~/lib/web3";
import {
  DEV_MARKET_MIN_TRADING_DURATION_MINUTES,
  DEV_MARKET_TRADING_DURATION_MINUTES,
  getDevelopmentResolutionDate,
  getMinimumResolutionDate,
  isResolutionDateValid,
  normalizeMarketContribution,
} from "./market-proposal";
import { useComposerState } from "./state";

export const MarketProposalPanel = ({
  createdMarket,
}: {
  createdMarket?: RouterOutputs["markets"]["create"] | null;
}) => {
  const theme = useTheme();
  const { _ } = useLingui();
  const [composerState, setComposerState] = useComposerState();
  const proposal = composerState.marketProposal;
  const wallet = api.wallet.mine.useQuery();
  const account = wallet.data?.address;
  const monBalance = useMonBalance(account);
  const collateralBalance = useErc20Balance(account);
  const locked = Boolean(createdMarket);
  const minimumResolutionDate = getMinimumResolutionDate();
  const resolutionDateIsValid = isResolutionDateValid(proposal.resolutionDate);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [pickerDate, setPickerDate] = useState(proposal.resolutionDate);

  useEffect(() => {
    if (!account) return;
    void monBalance.refetch();
    void collateralBalance.refetch();
  }, [account, collateralBalance.refetch, monBalance.refetch]);

  const updateProposal = (patch: Partial<typeof proposal>) => {
    setComposerState((state) => ({
      ...state,
      marketProposal: { ...state.marketProposal, ...patch },
    }));
  };

  const openResolutionDatePicker = () => {
    if (locked) return;
    Keyboard.dismiss();

    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: proposal.resolutionDate,
        mode: "date",
        minimumDate: minimumResolutionDate,
        onChange: (event, selectedDate) => {
          if (event.type !== "set" || !selectedDate) return;

          const selectedDay = new Date(proposal.resolutionDate);
          selectedDay.setFullYear(
            selectedDate.getFullYear(),
            selectedDate.getMonth(),
            selectedDate.getDate(),
          );
          DateTimePickerAndroid.open({
            value: selectedDay,
            mode: "time",
            onChange: (timeEvent, selectedTime) => {
              if (timeEvent.type !== "set" || !selectedTime) return;

              const resolutionDate = new Date(selectedDay);
              resolutionDate.setHours(
                selectedTime.getHours(),
                selectedTime.getMinutes(),
                0,
                0,
              );
              updateProposal({ resolutionDate });
            },
          });
        },
      });
      return;
    }

    setPickerDate(proposal.resolutionDate);
    setDatePickerVisible(true);
  };

  let contributionUnits: bigint | undefined;
  try {
    contributionUnits = parseUnits(
      normalizeMarketContribution(proposal.contribution),
      COLLATERAL_TOKEN_DECIMALS,
    );
  } catch {
    contributionUnits = undefined;
  }

  const maxContribution =
    collateralBalance.data === undefined
      ? undefined
      : collateralBalance.data <
          parseUnits(MARKET_FUNDING_TARGET_USDC, COLLATERAL_TOKEN_DECIMALS)
        ? collateralBalance.data
        : parseUnits(MARKET_FUNDING_TARGET_USDC, COLLATERAL_TOKEN_DECIMALS);
  const exceedsBalance =
    contributionUnits !== undefined &&
    collateralBalance.data !== undefined &&
    contributionUnits > collateralBalance.data;
  const exceedsTarget =
    contributionUnits !== undefined &&
    contributionUnits >
      parseUnits(MARKET_FUNDING_TARGET_USDC, COLLATERAL_TOKEN_DECIMALS);
  const contributionIsPositive =
    contributionUnits !== undefined && contributionUnits > BigInt(0);

  const retryBalances = () => {
    void wallet.refetch();
    void monBalance.refetch();
    void collateralBalance.refetch();
  };

  return (
    <View
      className="mx-4 mb-4 overflow-hidden rounded-2xl border"
      style={{
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
      }}
    >
      <View
        className="border-b px-4 py-3"
        style={{ borderColor: theme.colors.border }}
      >
        <Text className="text-base font-semibold">
          <Trans>Market terms</Trans>
        </Text>
        <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>
            A market is created on Monad Testnet by your linked wallet.
          </Trans>
        </Text>
      </View>

      <View className="gap-4 p-4">
        <View>
          <Text className="mb-1.5 text-sm font-medium">
            <Trans>Market question</Trans>
          </Text>
          <TextInput
            value={proposal.question}
            editable={!locked}
            maxLength={256}
            onChangeText={(question) => updateProposal({ question })}
            placeholder={_(msg`What will happen?`)}
            returnKeyType="next"
            className="rounded-xl border px-3.5 py-3 text-base"
            style={{ borderColor: theme.colors.border }}
          />
        </View>

        <View>
          <Text className="mb-1.5 text-sm font-medium">
            <Trans>Resolution criteria</Trans>
          </Text>
          <TextInput
            value={proposal.resolutionCriteria}
            editable={!locked}
            maxLength={2_000}
            multiline
            onChangeText={(resolutionCriteria) =>
              updateProposal({ resolutionCriteria })
            }
            placeholder={_(msg`How and when will this market be resolved?`)}
            textAlignVertical="top"
            className="min-h-20 rounded-xl border px-3.5 py-3 text-base"
            style={{ borderColor: theme.colors.border }}
          />
        </View>

        <View>
          <Text className="mb-1.5 text-sm font-medium">
            <Trans>Resolution Date</Trans>
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={_(msg`Select resolution date and time`)}
            accessibilityState={{ disabled: locked }}
            disabled={locked}
            onPress={openResolutionDatePicker}
            className="rounded-xl border px-3.5 py-3.5"
            style={{ borderColor: theme.colors.border }}
          >
            <Text className="text-base font-medium">
              {formatResolutionDate(proposal.resolutionDate)}
            </Text>
            <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Shown in your local time zone</Trans>
            </Text>
          </TouchableOpacity>
          {__DEV__ && !locked && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() =>
                updateProposal({
                  resolutionDate: getDevelopmentResolutionDate(),
                })
              }
              className="mt-2 self-start rounded-lg border px-3 py-2"
              style={{ borderColor: theme.colors.border }}
            >
              <Text primary className="text-sm font-medium">
                <Trans>
                  Set market end to {DEV_MARKET_TRADING_DURATION_MINUTES}{" "}
                  minutes from now
                </Trans>
              </Text>
            </TouchableOpacity>
          )}
          {!resolutionDateIsValid && (
            <Text className="mt-1 text-xs text-red-500">
              {__DEV__ ? (
                <Trans>
                  Choose a market end at least{" "}
                  {DEV_MARKET_MIN_TRADING_DURATION_MINUTES} minutes from now.
                </Trans>
              ) : (
                <Trans>
                  Choose a resolution date at least {MIN_TRADING_DURATION_DAYS}{" "}
                  days from now so trading stays open after funding closes.
                </Trans>
              )}
            </Text>
          )}
        </View>

        <View
          className="flex-row overflow-hidden rounded-xl border"
          style={{ borderColor: theme.colors.border }}
        >
          <View className="flex-1 px-3 py-2.5">
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Funding window</Trans>
            </Text>
            <Text className="mt-0.5 font-medium">
              {__DEV__ ? (
                <Trans>2 minutes (development)</Trans>
              ) : (
                <Trans>{MARKET_FUNDING_WINDOW_DAYS} days</Trans>
              )}
            </Text>
          </View>
          <View
            className="w-px"
            style={{ backgroundColor: theme.colors.border }}
          />
          <View className="flex-1 px-3 py-2.5">
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Funding target</Trans>
            </Text>
            <Text className="mt-0.5 font-medium">
              {MARKET_FUNDING_TARGET_LABEL}
            </Text>
          </View>
        </View>
        {__DEV__ && (
          <Text className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            <Trans>
              Development markets have a 2-minute funding window. The full
              funding target must be reached before trading can begin.
            </Trans>
          </Text>
        )}

        <View>
          <Text className="mb-2 text-sm font-medium">
            <Trans>Your available balances</Trans>
          </Text>
          <View
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: theme.colors.border }}
          >
            <BalanceLine
              symbol="MON"
              balance={
                monBalance.data === undefined
                  ? undefined
                  : formatTokenAmount(monBalance.data, 18)
              }
              isPending={
                wallet.isPending || (Boolean(account) && monBalance.isPending)
              }
              isError={
                wallet.isError ||
                (!wallet.isPending && !account) ||
                monBalance.isError
              }
            />
            <View
              className="mx-3 h-px"
              style={{ backgroundColor: theme.colors.border }}
            />
            <BalanceLine
              symbol="USDC"
              balance={
                collateralBalance.data === undefined
                  ? undefined
                  : formatUsdAmount(
                      collateralBalance.data,
                      COLLATERAL_TOKEN_DECIMALS,
                    )
              }
              isPending={
                wallet.isPending ||
                (Boolean(account) && collateralBalance.isPending)
              }
              isError={
                wallet.isError ||
                (!wallet.isPending && !account) ||
                collateralBalance.isError
              }
            />
          </View>
          {(wallet.isError ||
            monBalance.isError ||
            collateralBalance.isError) && (
            <TouchableOpacity
              onPress={retryBalances}
              className="mt-2 self-start"
            >
              <Text primary className="text-sm font-medium">
                <Trans>Retry loading balances</Trans>
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <View>
          <View className="mb-1.5 flex-row items-center justify-between">
            <Text className="text-sm font-medium">
              <Trans>Initial contribution (USDC)</Trans>
            </Text>
            {maxContribution !== undefined && !locked && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() =>
                  updateProposal({
                    contribution: formatTokenAmount(
                      maxContribution,
                      COLLATERAL_TOKEN_DECIMALS,
                      { useGrouping: false },
                    ),
                  })
                }
              >
                <Text primary className="text-sm font-medium">
                  <Trans>Use max</Trans>
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <View
            className="flex-row items-center rounded-xl border px-3.5"
            style={{ borderColor: theme.colors.border }}
          >
            <Text className="mr-2 font-medium">$</Text>
            <TextInput
              value={proposal.contribution}
              editable={!locked}
              keyboardType="decimal-pad"
              onChangeText={(contribution) =>
                updateProposal({
                  contribution: sanitizeDecimalInput(contribution, 6),
                })
              }
              placeholder="0"
              className="flex-1 py-2.5 text-base"
            />
          </View>
          <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            <Trans>
              Leave at 0 to create without contributing USDC. That path only
              needs MON for gas.
            </Trans>
          </Text>
          {(exceedsBalance ||
            exceedsTarget ||
            contributionUnits === undefined) && (
            <Text className="mt-1 text-xs text-red-500">
              {exceedsTarget ? (
                <Trans>
                  Contribution cannot exceed {MARKET_FUNDING_TARGET_LABEL}.
                </Trans>
              ) : exceedsBalance ? (
                <Trans>Contribution exceeds your available USDC balance.</Trans>
              ) : (
                <Trans>Enter a valid USDC amount with up to 6 decimals.</Trans>
              )}
            </Text>
          )}
        </View>

        {contributionIsPositive && (
          <View
            className="rounded-xl border p-3.5"
            style={{ borderColor: theme.colors.border }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold">
                <Trans>Initial outcome probability</Trans>
              </Text>
              <Text className="text-sm font-semibold">
                YES {proposal.yesProbabilityBps / 100}%
              </Text>
            </View>
            <Slider
              accessibilityLabel={_(msg`Initial YES probability`)}
              disabled={locked}
              minimumValue={0}
              maximumValue={10_000}
              step={100}
              value={proposal.yesProbabilityBps}
              onValueChange={(yesProbabilityBps) =>
                updateProposal({ yesProbabilityBps })
              }
              minimumTrackTintColor="#22c55e"
              maximumTrackTintColor="#ef4444"
              thumbTintColor={theme.colors.primary}
            />
            <View className="flex-row justify-between">
              <Text className="text-xs font-medium text-green-600 dark:text-green-400">
                YES {proposal.yesProbabilityBps / 100}%
              </Text>
              <Text className="text-xs font-medium text-red-600 dark:text-red-400">
                NO {(10_000 - proposal.yesProbabilityBps) / 100}%
              </Text>
            </View>
            <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>
                The selected contribution and probability are passed to the
                market contract. Exact YES/NO allocations are read from the
                confirmed market; this ABI has no preview calculation.
              </Trans>
            </Text>
          </View>
        )}

        {createdMarket && (
          <View
            className="rounded-xl border p-3.5"
            style={{ borderColor: theme.colors.border }}
          >
            {createdMarket.transactionStatus !== "confirmed" ? (
              <View className="mb-2 flex-row items-center">
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <View className="ml-3 flex-1">
                  <Text className="text-sm font-semibold">
                    <Trans>Transaction submitted</Trans>
                  </Text>
                  <Text className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    <Trans>Waiting for network confirmation...</Trans>
                  </Text>
                </View>
              </View>
            ) : null}
            <Text selectable className="text-xs">
              {createdMarket.marketAddress ?? createdMarket.marketTxHash}
            </Text>
            {createdMarket.approvalTxHash && (
              <Text
                selectable
                className="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
              >
                USDC approval: {createdMarket.approvalTxHash}
              </Text>
            )}
            {createdMarket.openingProbabilityBps !== null && (
              <Text className="mt-2 text-sm">
                On-chain opening probability:{" "}
                {createdMarket.openingProbabilityBps / 100}% YES
              </Text>
            )}
            {createdMarket.transactionStatus === "confirmed" &&
            createdMarket.yesAllocation !== null &&
            createdMarket.noAllocation !== null &&
            createdMarket.outcomeTokenDecimals !== null ? (
              <View className="mt-3 flex-row justify-between">
                <Allocation
                  label={_(msg`YES allocation`)}
                  amount={formatTokenAmount(
                    BigInt(createdMarket.yesAllocation),
                    createdMarket.outcomeTokenDecimals,
                  )}
                />
                <Allocation
                  label={_(msg`NO allocation`)}
                  amount={formatTokenAmount(
                    BigInt(createdMarket.noAllocation),
                    createdMarket.outcomeTokenDecimals,
                  )}
                />
              </View>
            ) : createdMarket.transactionStatus === "confirmed" &&
              contributionIsPositive ? (
              <Text className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                <Trans>
                  Allocation details could not be loaded. Open the market and
                  refresh its data.
                </Trans>
              </Text>
            ) : null}
            <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Retrying will not create another market.</Trans>
            </Text>
          </View>
        )}
      </View>
      {Platform.OS === "ios" && (
        <Modal
          visible={datePickerVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setDatePickerVisible(false)}
        >
          <View className="flex-1 justify-end bg-black/40">
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={_(msg`Close date picker`)}
              className="absolute inset-0"
              onPress={() => setDatePickerVisible(false)}
            />
            <View
              className="rounded-t-2xl px-4 pb-8 pt-4"
              style={{ backgroundColor: theme.colors.card }}
            >
              <View className="mb-2 flex-row items-center justify-between">
                <TouchableOpacity onPress={() => setDatePickerVisible(false)}>
                  <Text primary className="text-base">
                    <Trans>Cancel</Trans>
                  </Text>
                </TouchableOpacity>
                <Text className="text-base font-semibold">
                  <Trans>Resolution Date</Trans>
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    updateProposal({ resolutionDate: pickerDate });
                    setDatePickerVisible(false);
                  }}
                >
                  <Text primary className="text-base font-semibold">
                    <Trans>Done</Trans>
                  </Text>
                </TouchableOpacity>
              </View>
              <DateTimePicker
                value={pickerDate}
                mode="datetime"
                display="spinner"
                minimumDate={minimumResolutionDate}
                onChange={(event, selectedDate) => {
                  if (event.type === "set" && selectedDate) {
                    setPickerDate(selectedDate);
                  }
                }}
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
};

const formatResolutionDate = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

const BalanceLine = ({
  symbol,
  balance,
  isPending,
  isError,
}: {
  symbol: string;
  balance?: string;
  isPending: boolean;
  isError: boolean;
}) => (
  <View className="flex-row items-center justify-between px-3 py-2.5">
    <Text className="font-medium">{symbol}</Text>
    {isPending ? (
      <ActivityIndicator size="small" />
    ) : isError ? (
      <Text className="text-sm text-red-500">
        <Trans>Unavailable</Trans>
      </Text>
    ) : (
      <Text selectable className="text-sm">
        {balance ?? "—"}
      </Text>
    )}
  </View>
);

const Allocation = ({ label, amount }: { label: string; amount: string }) => (
  <View className="flex-1">
    <Text className="text-xs text-neutral-500 dark:text-neutral-400">
      {label}
    </Text>
    <Text selectable className="mt-0.5 font-semibold">
      {amount}
    </Text>
  </View>
);
