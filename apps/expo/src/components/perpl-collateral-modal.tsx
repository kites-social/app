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
import { Trans } from "@lingui/macro";
import { useTheme } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type Address,
} from "viem";

import { Text } from "~/components/themed/text";
import {
  showWalletStatusToast,
  WalletStatusToast,
} from "~/components/toastable/toastable";
import { ActionButton, Card, InputWell, useUi } from "~/components/ui";
import { useAgent } from "~/lib/agent";
import {
  depositPerplCollateralOnChain,
  fetchPerplProtocolConfig,
  withdrawPerplCollateralOnChain,
} from "~/lib/venues/perpetual-markets/perpl/protocol";
import { erc20Abi, getAppChain } from "~/lib/web3";
import {
  saveWalletActivity,
  walletActivityQueryKey,
} from "~/lib/web3/activity";
import { useWallet } from "~/lib/web3/custody";

type CollateralMode = "deposit" | "withdraw";

export function PerplCollateralModal({
  visible,
  mode,
  walletAddress,
  availableBalance,
  onClose,
  onComplete,
}: {
  visible: boolean;
  mode: CollateralMode;
  walletAddress: Address;
  availableBalance: bigint;
  onClose: () => void;
  onComplete: () => void;
}) {
  const theme = useTheme();
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const agent = useAgent();
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useQuery({
    queryKey: ["venues", "perpetual", "perpl", "protocol-config"],
    queryFn: fetchPerplProtocolConfig,
    enabled: visible,
    staleTime: 60_000,
  });
  const sourceBalance = useQuery({
    queryKey: [
      "wallet",
      "perpl-collateral-source-balance",
      walletAddress,
      config.data?.collateralAddress,
    ],
    enabled: visible && mode === "deposit" && Boolean(config.data),
    staleTime: 15_000,
    queryFn: () => {
      if (!config.data)
        throw new Error("Perpl protocol configuration is unavailable.");
      return getAppChain(config.data.chainId).publicClient.readContract({
        address: config.data.collateralAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      });
    },
  });
  const minimum =
    config.data &&
    (mode === "deposit"
      ? config.data.minDepositAmount
      : config.data.minWithdrawAmount);

  useEffect(() => {
    if (visible) {
      setAmount("");
      setReviewing(false);
      setError(null);
    }
  }, [visible, mode]);

  useEffect(() => {
    if (!visible || Platform.OS !== "android") return;

    KeyboardController.setInputMode(
      AndroidSoftInputModes.SOFT_INPUT_ADJUST_RESIZE,
    );
    return () => KeyboardController.setDefaultMode();
  }, [visible]);

  const submit = async () => {
    if (!config.data || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    showWalletStatusToast({
      title:
        mode === "deposit" ? "Depositing to Perpl…" : "Withdrawing from Perpl…",
      message: "Please wait while your transaction is submitted and confirmed.",
      status: "progress",
    });
    try {
      const session = await wallet.ensureUnlocked({
        existingAddress: walletAddress,
        userName: agent.session?.handle ?? "Kites wallet",
      });
      if (session.address.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error("Unlock the wallet linked to your Bluesky account.");
      }
      const sendTransaction = async (
        chainId: number,
        transaction: { to: Address; data: `0x${string}`; value?: bigint },
      ) => {
        const chain = getAppChain(chainId);
        return createWalletClient({
          account: session.account,
          chain: chain.chain,
          transport: http(),
        }).sendTransaction(transaction);
      };
      const onTransaction = (transaction: {
        chainId: number;
        hash: `0x${string}`;
        kind: "approval" | "funding";
        status: "pending" | "submitted" | "confirmed" | "failed";
        title: string;
        detail: string;
      }) => {
        const did = agent.session?.did;
        if (!did) return;
        saveWalletActivity(did, {
          id: `tx:${transaction.chainId}:${transaction.hash}`,
          kind: transaction.kind,
          status: transaction.status,
          title: transaction.title,
          detail: transaction.detail,
          chainId: transaction.chainId,
          transactionHash: transaction.hash,
          venue: "Perpl",
        });
        void queryClient.invalidateQueries({
          queryKey: walletActivityQueryKey(did),
        });
      };

      if (mode === "deposit") {
        await depositPerplCollateralOnChain(
          { walletAddress: session.address, sendTransaction, onTransaction },
          amount,
        );
      } else {
        await withdrawPerplCollateralOnChain({
          walletAddress: session.address,
          amount,
          availableBalance,
          sendTransaction,
          onTransaction,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["wallet", "venue-balances"],
        }),
        queryClient.invalidateQueries({ queryKey: ["wallet", "activity"] }),
        queryClient.invalidateQueries({
          queryKey: ["venues", "perpetual", "perpl", "account"],
        }),
      ]);
      showWalletStatusToast({
        title:
          mode === "deposit"
            ? "Perpl deposit confirmed"
            : "Perpl withdrawal confirmed",
        message:
          mode === "deposit"
            ? "The collateral is available at Perpl."
            : "The collateral has returned to your Kites wallet.",
        status: "success",
      });
      onComplete();
      onClose();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not update Perpl collateral.";
      showWalletStatusToast({
        title:
          mode === "deposit"
            ? "Perpl deposit not completed"
            : "Perpl withdrawal not completed",
        message,
        status: "danger",
      });
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const validAmount = (() => {
    if (
      !config.data ||
      minimum === undefined ||
      !/^\d+(?:\.\d*)?$/.test(amount)
    ) {
      return false;
    }
    try {
      const parsed = parseUnits(amount, config.data.collateralDecimals);
      return (
        parsed >= minimum && (mode === "deposit" || parsed <= availableBalance)
      );
    } catch {
      return false;
    }
  })();
  const maximumAmount =
    mode === "deposit" ? sourceBalance.data : availableBalance;
  const canUseMaximum =
    maximumAmount !== undefined &&
    minimum !== undefined &&
    maximumAmount >= minimum;

  const setMaximumAmount = () => {
    if (!config.data || !canUseMaximum || maximumAmount === undefined) return;
    setAmount(formatUnits(maximumAmount, config.data.collateralDecimals));
    setReviewing(false);
    setError(null);
  };

  const close = () => {
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
                  {mode === "deposit"
                    ? "Deposit to Perpl"
                    : "Withdraw from Perpl"}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={close}
                >
                  <Text className="text-base" style={{ color: ui.muted }}>
                    Close
                  </Text>
                </TouchableOpacity>
              </View>

              {config.isPending ? (
                <View className="items-center py-8">
                  <ActivityIndicator />
                </View>
              ) : config.isError ? (
                <Text className="py-5 text-sm" style={{ color: ui.negative }}>
                  {config.error.message}
                </Text>
              ) : config.data && minimum !== undefined ? (
                <>
                  <Text
                    className="mb-3 text-sm leading-5"
                    style={{ color: ui.muted }}
                  >
                    {mode === "deposit"
                      ? `Transfer collateral from your Kites wallet to Perpl on ${config.data.collateralSymbol} · Monad testnet.`
                      : `Withdraw collateral from Perpl to your Kites wallet on Monad testnet.`}
                  </Text>
                  <Card compact className="mb-4">
                    <Text className="text-[13px]" style={{ color: ui.muted }}>
                      {mode === "deposit" ? (
                        <Trans>Available to deposit</Trans>
                      ) : (
                        <Trans>Available to withdraw</Trans>
                      )}
                    </Text>
                    <Text className="mt-1 text-base font-semibold">
                      {mode === "deposit"
                        ? sourceBalance.data === undefined
                          ? sourceBalance.isPending
                            ? "Loading..."
                            : "Unavailable"
                          : `${formatUnits(sourceBalance.data, config.data.collateralDecimals)} ${config.data.collateralSymbol}`
                        : `${formatUnits(availableBalance, config.data.collateralDecimals)} ${config.data.collateralSymbol}`}
                    </Text>
                  </Card>
                  {mode === "deposit" && sourceBalance.isError ? (
                    <Text
                      className="mb-3 text-xs"
                      style={{ color: ui.negative }}
                    >
                      {sourceBalance.error.message}
                    </Text>
                  ) : null}
                  <View className="mb-2 flex-row items-center justify-between">
                    <Text className="text-sm font-medium">
                      <Trans>Amount</Trans>
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Use maximum available Perpl amount"
                      disabled={!canUseMaximum || busy}
                      onPress={setMaximumAmount}
                    >
                      <Text
                        style={{
                          color: canUseMaximum ? ui.primary : ui.muted,
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
                        setAmount(value.replace(/[^0-9.]/g, ""));
                        setReviewing(false);
                        setError(null);
                      }}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor={ui.placeholder}
                      className="min-w-0 flex-1 py-3.5 text-lg"
                      style={{ color: ui.text }}
                      editable={!busy}
                      accessibilityLabel={
                        mode === "deposit"
                          ? "Deposit amount"
                          : "Withdrawal amount"
                      }
                    />
                    <Text className="ml-3 text-base font-semibold">
                      {config.data.collateralSymbol}
                    </Text>
                  </InputWell>
                  <Text className="mt-2 text-xs" style={{ color: ui.muted }}>
                    Minimum{" "}
                    {formatUnits(minimum, config.data.collateralDecimals)}{" "}
                    {config.data.collateralSymbol} · MON is needed for network
                    fees.
                  </Text>
                  {reviewing && (
                    <Card compact className="mb-0 mt-4">
                      <Text className="text-sm font-semibold">
                        {mode === "deposit"
                          ? `${amount} ${config.data.collateralSymbol} · Kites wallet → Perpl`
                          : `${amount} ${config.data.collateralSymbol} · Perpl → Kites wallet`}
                      </Text>
                      <Text
                        className="mt-2 text-xs leading-5"
                        style={{ color: ui.muted }}
                      >
                        {mode === "deposit"
                          ? "Kites will request an exact token approval if needed, then submit the deposit."
                          : "This submits an on-chain withdrawal. Funds return to your Kites wallet on Monad testnet."}
                      </Text>
                    </Card>
                  )}
                </>
              ) : null}

              {error && (
                <Text className="mt-3 text-sm" style={{ color: ui.negative }}>
                  {error}
                </Text>
              )}
              <ActionButton
                disabled={
                  busy ||
                  config.isPending ||
                  config.isError ||
                  !config.data ||
                  !validAmount
                }
                loading={busy}
                onPress={() => {
                  if (!reviewing) {
                    Keyboard.dismiss();
                    setReviewing(true);
                  } else {
                    void submit();
                  }
                }}
                className="mt-5"
                label={reviewing ? "Confirm" : "Review"}
              />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
        <WalletStatusToast />
      </View>
    </Modal>
  );
}
