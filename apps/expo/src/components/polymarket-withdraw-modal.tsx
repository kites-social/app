import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  AndroidSoftInputModes,
  KeyboardAvoidingView,
  KeyboardController,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

import { Text } from "~/components/themed/text";
import {
  showWalletStatusToast,
  WalletStatusToast,
} from "~/components/toastable/toastable";
import { ActionButton, Card, InputWell, useUi } from "~/components/ui";
import { useAgent } from "~/lib/agent";
import { api } from "~/lib/utils/api";
import { sanitizeDecimalInput } from "~/lib/utils/decimal-input";
import {
  getPolymarketTokenBalance,
  polymarketFundingAdapter,
} from "~/lib/venues/funding";
import { createPolymarketApprovalTypedData } from "~/lib/venues/prediction-markets/polymarket/onboarding";
import { appChainBalancesQueryKey, web3BalancesQueryKey } from "~/lib/web3";
import {
  saveWalletActivity,
  walletActivityQueryKey,
  type WalletActivityStatus,
} from "~/lib/web3/activity";
import { useWallet } from "~/lib/web3/custody";

const pusdTransferAbi = [
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

export function PolymarketWithdrawModal({
  visible,
  walletAddress,
  depositWalletAddress,
  onClose,
  onComplete,
}: {
  visible: boolean;
  walletAddress: Address;
  depositWalletAddress?: Address;
  onClose: () => void;
  onComplete: () => void;
}) {
  const { _ } = useLingui();
  const theme = useTheme();
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const agent = useAgent();
  const queryClient = useQueryClient();
  const utils = api.useUtils();
  const prepareWithdrawal =
    api.wallet.preparePolymarketWithdrawal.useMutation();
  const submitWithdrawal = api.wallet.submitPolymarketWithdrawal.useMutation();
  const [amount, setAmount] = useState("");
  const [pendingWithdrawal, setPendingWithdrawal] = useState<{
    transactionID: string;
    amount: string;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const balance = useQuery({
    queryKey: ["wallet", "polymarket-venue-balance", depositWalletAddress],
    enabled: visible && Boolean(depositWalletAddress),
    staleTime: 15_000,
    queryFn: () => {
      if (!depositWalletAddress) {
        throw new Error("Set up your Polymarket deposit wallet first.");
      }
      return getPolymarketTokenBalance(depositWalletAddress);
    },
  });

  useEffect(() => {
    if (visible) {
      setAmount("");
      setReviewing(false);
      setError(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || Platform.OS !== "android") return;

    KeyboardController.setInputMode(
      AndroidSoftInputModes.SOFT_INPUT_ADJUST_RESIZE,
    );
    return () => KeyboardController.setDefaultMode();
  }, [visible]);

  const parsedAmount = (() => {
    try {
      return amount.trim()
        ? parseUnits(amount.trim(), polymarketFundingAdapter.token.decimals)
        : BigInt(0);
    } catch {
      return BigInt(0);
    }
  })();
  const validAmount =
    parsedAmount > BigInt(0) &&
    balance.data !== undefined &&
    parsedAmount <= balance.data;

  const saveWithdrawalActivity = (
    transactionID: string,
    status: WalletActivityStatus,
    withdrawalAmount: string,
  ) => {
    const did = agent.session?.did;
    if (!did) return;
    saveWalletActivity(did, {
      id: `polymarket-relayer:${transactionID}`,
      kind: "funding",
      status,
      title: `Withdraw Polymarket · ${withdrawalAmount} pUSD`,
      detail: "Polymarket deposit wallet → Kites wallet · Polygon",
      chainId: polygon.id,
      venue: "Polymarket",
    });
    void queryClient.invalidateQueries({
      queryKey: walletActivityQueryKey(did),
    });
  };

  const checkWithdrawal = async (withdrawal: {
    transactionID: string;
    amount: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      let attempt = 0;
      while (true) {
        let transaction: Awaited<
          ReturnType<typeof utils.wallet.polymarketWalletTransaction.fetch>
        >;
        try {
          transaction = await utils.wallet.polymarketWalletTransaction.fetch({
            transactionID: withdrawal.transactionID,
          });
        } catch {
          setError(
            _(
              msg`Could not refresh the withdrawal status. Retrying automatically.`,
            ),
          );
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4)),
            ),
          );
          attempt++;
          continue;
        }
        setError(null);
        const state = transaction?.state.toUpperCase();
        if (state === "STATE_CONFIRMED") {
          saveWithdrawalActivity(
            withdrawal.transactionID,
            "confirmed",
            withdrawal.amount,
          );
          setPendingWithdrawal(null);
          await queryClient.invalidateQueries({
            queryKey: ["wallet", "venue-balances"],
          });
          void queryClient.invalidateQueries({
            queryKey: appChainBalancesQueryKey,
          });
          void queryClient.invalidateQueries({
            queryKey: web3BalancesQueryKey,
          });
          void queryClient.invalidateQueries({
            queryKey: [
              "wallet",
              "polymarket-venue-balance",
              depositWalletAddress,
            ],
          });
          showWalletStatusToast({
            title: _(msg`Polymarket withdrawal confirmed`),
            message: _(msg`Your pUSD is back in your Kites wallet.`),
            status: "success",
          });
          onComplete();
          onClose();
          return;
        }
        if (state === "STATE_FAILED" || state === "STATE_INVALID") {
          saveWithdrawalActivity(
            withdrawal.transactionID,
            "failed",
            withdrawal.amount,
          );
          setPendingWithdrawal(null);
          const message =
            transaction?.errorMsg ?? _(msg`The withdrawal failed on Polygon.`);
          showWalletStatusToast({
            title: _(msg`Polymarket withdrawal failed`),
            message,
            status: "danger",
          });
          setError(message);
          return;
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4)),
          ),
        );
        attempt++;
      }
    } catch (cause) {
      showWalletStatusToast({
        title: _(msg`Could not check Polymarket withdrawal`),
        message:
          cause instanceof Error
            ? cause.message
            : _(msg`Try checking the withdrawal again shortly.`),
        status: "warning",
      });
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`Could not check the withdrawal status.`),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!depositWalletAddress || !validAmount || busy) return;
    setBusy(true);
    setError(null);
    showWalletStatusToast({
      title: _(msg`Polymarket withdrawal pending`),
      message: _(msg`Your Polymarket withdrawal is being submitted.`),
      status: "progress",
    });
    try {
      const session = await wallet.ensureUnlocked({
        existingAddress: walletAddress,
      });
      if (session.address.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error("Unlock the wallet linked to your Bluesky account.");
      }
      const prepared = await prepareWithdrawal.mutateAsync();
      if (
        prepared.depositWalletAddress.toLowerCase() !==
        depositWalletAddress.toLowerCase()
      ) {
        throw new Error(
          "The Polymarket deposit wallet has changed. Refresh and retry.",
        );
      }
      const data = encodeFunctionData({
        abi: pusdTransferAbi,
        functionName: "transfer",
        args: [walletAddress, parsedAmount],
      });
      const calls = [
        {
          target: polymarketFundingAdapter.token.address,
          value: "0",
          data,
        },
      ] satisfies { target: Address; value: string; data: Hex }[];
      const signature = await session.account.signTypedData(
        createPolymarketApprovalTypedData({
          depositWalletAddress,
          nonce: prepared.nonce,
          deadline: prepared.deadline,
          calls,
        }),
      );
      const result = await submitWithdrawal.mutateAsync({
        nonce: prepared.nonce,
        deadline: prepared.deadline,
        amount: amount.trim(),
        signature,
      });
      const withdrawal = {
        transactionID: result.transactionID,
        amount: amount.trim(),
      };
      setPendingWithdrawal(withdrawal);
      saveWithdrawalActivity(
        withdrawal.transactionID,
        "pending",
        withdrawal.amount,
      );
      void queryClient.invalidateQueries({
        queryKey: walletActivityQueryKey(agent.session?.did ?? ""),
      });
      await checkWithdrawal(withdrawal);
    } catch (cause) {
      showWalletStatusToast({
        title: _(msg`Polymarket withdrawal not completed`),
        message:
          cause instanceof Error
            ? cause.message
            : _(msg`The Polymarket withdrawal could not be submitted.`),
        status: "danger",
      });
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`The Polymarket withdrawal could not be submitted.`),
      );
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    Keyboard.dismiss();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View className="flex-1">
        <View className="absolute inset-0 bg-black/50" />
        <KeyboardAvoidingView
          className="flex-1"
          behavior="position"
          contentContainerStyle={{ flex: 1, justifyContent: "flex-end" }}
        >
          <View
            className="rounded-t-3xl p-5"
            style={{ backgroundColor: theme.colors.card, maxHeight: "90%" }}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                paddingBottom: Math.max(insets.bottom, 20),
              }}
            >
              <View className="mb-5 flex-row items-center justify-between">
                <Text className="mr-3 flex-1 text-xl font-semibold">
                  <Trans>Withdraw from Polymarket</Trans>
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={close}
                >
                  <Text className="text-base" style={{ color: ui.muted }}>
                    <Trans>Close</Trans>
                  </Text>
                </TouchableOpacity>
              </View>
              {pendingWithdrawal ? (
                <Card compact className="mb-4">
                  <Text className="text-sm font-semibold">
                    <Trans>Withdrawal submitted</Trans>
                  </Text>
                  <Text
                    className="mt-2 text-xs leading-5"
                    style={{ color: ui.muted }}
                  >
                    <Trans>
                      Waiting for Polygon confirmation. The status is checked
                      automatically.
                    </Trans>
                  </Text>
                </Card>
              ) : !depositWalletAddress ? (
                <Text className="py-5 text-sm" style={{ color: ui.negative }}>
                  <Trans>
                    Set up your Polymarket deposit wallet before withdrawing.
                  </Trans>
                </Text>
              ) : balance.isPending ? (
                <View className="items-center py-8">
                  <ActivityIndicator />
                </View>
              ) : balance.isError ? (
                <Text className="py-5 text-sm" style={{ color: ui.negative }}>
                  {balance.error.message}
                </Text>
              ) : (
                <>
                  <Text
                    className="mb-3 text-sm leading-5"
                    style={{ color: ui.muted }}
                  >
                    <Trans>
                      Transfer pUSD from your Polymarket deposit wallet back to
                      your Kites wallet on Polygon.
                    </Trans>
                  </Text>
                  <Card compact className="mb-4">
                    <Text className="text-[13px]" style={{ color: ui.muted }}>
                      <Trans>Available to withdraw</Trans>
                    </Text>
                    <Text className="mt-1 text-base font-semibold">
                      {formatBalance(balance.data)} pUSD
                    </Text>
                  </Card>
                  <View className="mb-2 flex-row items-center justify-between">
                    <Text className="text-sm font-medium">
                      <Trans>Amount</Trans>
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={_(msg`Withdraw maximum available`)}
                      disabled={balance.data <= BigInt(0) || busy}
                      onPress={() => {
                        setAmount(
                          formatUnits(
                            balance.data,
                            polymarketFundingAdapter.token.decimals,
                          ),
                        );
                        setReviewing(false);
                        setError(null);
                      }}
                    >
                      <Text
                        style={{
                          color:
                            balance.data > BigInt(0) ? ui.primary : ui.muted,
                          fontSize: 12,
                          fontWeight: "600",
                        }}
                      >
                        <Trans>MAX</Trans>
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <InputWell>
                    <TextInput
                      value={amount}
                      onChangeText={(value) => {
                        setAmount(sanitizeDecimalInput(value));
                        setReviewing(false);
                        setError(null);
                      }}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor={ui.placeholder}
                      className="min-w-0 flex-1 py-3.5 text-lg"
                      style={{ color: ui.text }}
                      editable={!busy}
                      accessibilityLabel={_(msg`Withdrawal amount`)}
                    />
                    <Text className="ml-3 text-base font-semibold">pUSD</Text>
                  </InputWell>
                  {reviewing ? (
                    <Card compact className="mb-0 mt-4">
                      <Text className="text-sm font-semibold">
                        {amount.trim()} pUSD · Polymarket → Kites wallet
                      </Text>
                      <Text
                        className="mt-2 text-xs leading-5"
                        style={{ color: ui.muted }}
                      >
                        <Trans>
                          Your wallet will sign a Polygon transfer from the
                          Polymarket deposit wallet back to your Kites wallet.
                        </Trans>
                      </Text>
                    </Card>
                  ) : null}
                </>
              )}
              {error ? (
                <Text className="mt-3 text-sm" style={{ color: ui.negative }}>
                  {error}
                </Text>
              ) : null}
              {!pendingWithdrawal ? (
                <ActionButton
                  disabled={busy || !validAmount}
                  loading={busy}
                  onPress={() => {
                    if (reviewing) void submit();
                    else {
                      Keyboard.dismiss();
                      setReviewing(true);
                    }
                  }}
                  className="mt-5"
                  label={
                    reviewing ? <Trans>Confirm</Trans> : <Trans>Review</Trans>
                  }
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
        <WalletStatusToast />
      </View>
    </Modal>
  );
}

function formatBalance(balance: bigint) {
  const [whole = "0", fraction = ""] = formatUnits(
    balance,
    polymarketFundingAdapter.token.decimals,
  ).split(".");
  return `${whole}.${fraction.slice(0, 4).padEnd(4, "0")}`;
}
