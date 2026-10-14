import { useEffect, useState } from "react";
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
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
import { formatUnits, type Address, type Hash } from "viem";

import { Text } from "~/components/themed/text";
import {
  showWalletStatusToast,
  WalletStatusToast,
} from "~/components/toastable/toastable";
import {
  ActionButton,
  Card,
  InputWell,
  SectionLabel,
  useUi,
} from "~/components/ui";
import { useAgent } from "~/lib/agent";
import { sanitizeDecimalInput } from "~/lib/utils/decimal-input";
import { formatTokenAmount } from "~/lib/utils/format-token";
import {
  getPolymarketTokenBalance,
  polymarketFundingAdapter,
  quotePolymarketFunding,
  sendToPolymarket,
  type PolymarketFundingQuote,
} from "~/lib/venues/funding";
import {
  appChainBalancesQueryKey,
  getAppPublicClient,
  web3BalancesQueryKey,
} from "~/lib/web3";
import {
  saveWalletActivity,
  walletActivityQueryKey,
  type WalletActivityStatus,
} from "~/lib/web3/activity";
import { useWallet } from "~/lib/web3/custody";

export function VenueFundingModal({
  visible,
  sourceAddress,
  destinationAddress,
  onClose,
  onSetup,
  onDepositToWallet,
}: {
  visible: boolean;
  sourceAddress?: Address;
  destinationAddress?: Address;
  onClose: () => void;
  onSetup?: () => void;
  onDepositToWallet?: () => void;
}) {
  const { _ } = useLingui();
  const theme = useTheme();
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const agent = useAgent();
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<PolymarketFundingQuote | null>(null);
  const [pendingHash, setPendingHash] = useState<Hash | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availableBalance = useQuery({
    queryKey: ["wallet", "polymarket-funding-source-balance", sourceAddress],
    enabled: visible && Boolean(sourceAddress && destinationAddress),
    staleTime: 15_000,
    queryFn: () => {
      if (!sourceAddress) {
        throw new Error("Set up your Kites wallet to view its pUSD balance.");
      }
      return getPolymarketTokenBalance(sourceAddress);
    },
  });

  useEffect(() => {
    if (!visible) {
      setAmount("");
      setQuote(null);
      setReviewing(false);
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || Platform.OS !== "android") return;

    KeyboardController.setInputMode(
      AndroidSoftInputModes.SOFT_INPUT_ADJUST_RESIZE,
    );
    return () => KeyboardController.setDefaultMode();
  }, [visible]);

  const reviewFunding = async () => {
    if (!sourceAddress || !destinationAddress || !amount.trim() || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    try {
      const nextQuote = await quotePolymarketFunding(
        sourceAddress,
        destinationAddress,
        amount.trim(),
      );
      setQuote(nextQuote);
      if (!nextQuote.hasEnoughToken) {
        setError(_(msg`Your Kites wallet does not have enough pUSD.`));
      } else if (!nextQuote.hasEnoughGas) {
        setError(
          _(msg`Your Polygon POL balance may not cover the network fee.`),
        );
      } else {
        setError(null);
        setReviewing(true);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`Could not quote this transfer.`),
      );
    } finally {
      setBusy(false);
    }
  };

  const checkPending = async (hash: Hash) => {
    setBusy(true);
    try {
      const publicClient = getAppPublicClient(
        polymarketFundingAdapter.sourceChainId,
      );
      let attempt = 0;
      let warned = false;
      const receipt = await (async () => {
        while (true) {
          try {
            return await publicClient.waitForTransactionReceipt({
              hash,
              timeout: 0,
            });
          } catch {
            if (!warned) {
              showWalletStatusToast({
                title: _(msg`Polymarket deposit still pending`),
                message: _(
                  msg`Your deposit is submitted. We will keep checking its status automatically.`,
                ),
                status: "warning",
              });
              warned = true;
            }
            setError(
              _(
                msg`The deposit is still pending. Its status will update automatically.`,
              ),
            );
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4)),
              ),
            );
            attempt++;
          }
        }
      })();
      const status: WalletActivityStatus =
        receipt.status === "success" ? "confirmed" : "failed";
      saveFundingActivity(hash, status);
      setPendingHash(null);
      void queryClient.invalidateQueries({
        queryKey: appChainBalancesQueryKey,
      });
      void queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey });
      void queryClient.invalidateQueries({
        queryKey: [
          "wallet",
          "polymarket-funding-source-balance",
          sourceAddress,
        ],
      });
      void queryClient.invalidateQueries({
        queryKey: ["wallet", "venue-balances"],
      });
      if (receipt.status === "success") {
        showWalletStatusToast({
          title: _(msg`Polymarket funding confirmed`),
          message: _(
            msg`Your pUSD transfer arrived at the Polymarket deposit wallet.`,
          ),
          status: "success",
        });
        onClose();
      } else {
        showWalletStatusToast({
          title: _(msg`Polymarket deposit failed`),
          message: _(msg`The transfer failed on Polygon.`),
          status: "danger",
        });
        setError(_(msg`The transfer failed on Polygon.`));
      }
    } catch (cause) {
      showWalletStatusToast({
        title: _(msg`Could not update Polymarket deposit status`),
        message:
          cause instanceof Error
            ? cause.message
            : _(msg`The submitted transaction is still recorded as pending.`),
        status: "warning",
      });
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`The transaction is still recorded as pending.`),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitFunding = async () => {
    if (!sourceAddress || !destinationAddress || !quote || busy || pendingHash)
      return;
    if (!quote.hasEnoughToken || !quote.hasEnoughGas) return;

    setBusy(true);
    setError(null);
    showWalletStatusToast({
      title: _(msg`Polymarket deposit pending`),
      message: _(msg`Your pUSD transfer is being submitted.`),
      status: "progress",
    });
    try {
      const session = await wallet.ensureUnlocked({
        existingAddress: sourceAddress,
      });
      if (session.address.toLowerCase() !== sourceAddress.toLowerCase()) {
        throw new Error("Unlock the wallet linked to your Bluesky account.");
      }
      const hash = await sendToPolymarket(
        session.account,
        destinationAddress,
        amount.trim(),
      );
      setPendingHash(hash);
      saveFundingActivity(hash, "pending");
      void queryClient.invalidateQueries({
        queryKey: walletActivityQueryKey(agent.session?.did ?? ""),
      });
      await checkPending(hash);
    } catch (cause) {
      showWalletStatusToast({
        title: _(msg`Polymarket deposit not completed`),
        message:
          cause instanceof Error
            ? cause.message
            : _(msg`The transfer could not be submitted.`),
        status: "danger",
      });
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`The transfer could not be submitted.`),
      );
      setBusy(false);
    }
  };

  function saveFundingActivity(hash: Hash, status: WalletActivityStatus) {
    const did = agent.session?.did;
    if (!did) return;
    saveWalletActivity(did, {
      id: `evm:${polymarketFundingAdapter.sourceChainId}:${hash}`,
      kind: "funding",
      status,
      title: `Fund Polymarket · ${amount.trim()} pUSD`,
      detail: "Kites wallet → Polymarket deposit wallet · Polygon",
      chainId: polymarketFundingAdapter.sourceChainId,
      transactionHash: hash,
      venue: "Polymarket",
    });
    void queryClient.invalidateQueries({
      queryKey: walletActivityQueryKey(did),
    });
  }

  const close = () => {
    if (busy) return;
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={_(msg`Close funding window`)}
          className="absolute inset-0 bg-black/50"
          onPress={close}
        />
        <KeyboardAvoidingView
          className="flex-1"
          behavior="position"
          contentContainerStyle={{ flex: 1, justifyContent: "flex-end" }}
        >
          <View
            className="rounded-t-3xl p-5"
            style={{
              backgroundColor: theme.colors.card,
              maxHeight: "90%",
            }}
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
                  <Trans>Deposit to Polymarket</Trans>
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

              {!destinationAddress ? (
                <>
                  <Text
                    className="text-sm leading-5"
                    style={{ color: ui.muted }}
                  >
                    <Trans>
                      Set up the Polymarket deposit wallet before moving funds.
                    </Trans>
                  </Text>
                  {onSetup ? (
                    <ActionButton
                      onPress={onSetup}
                      className="mt-4"
                      label={<Trans>Set up Polymarket</Trans>}
                    />
                  ) : null}
                </>
              ) : !sourceAddress ? (
                <>
                  <Text
                    className="text-sm leading-5"
                    style={{ color: ui.muted }}
                  >
                    <Trans>Set up your Kites wallet to fund Polymarket.</Trans>
                  </Text>
                  {onSetup ? (
                    <ActionButton
                      onPress={onSetup}
                      className="mt-4"
                      label={<Trans>Set up Kites wallet</Trans>}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <Text
                    className="mb-3 text-sm leading-5"
                    style={{ color: ui.muted }}
                  >
                    <Trans>
                      Move pUSD from your Kites wallet into your Polymarket
                      deposit wallet. Trading funds remain at Polymarket until
                      you withdraw them.
                    </Trans>
                  </Text>
                  <Card compact className="mb-4">
                    <Text className="text-[13px]" style={{ color: ui.muted }}>
                      <Trans>Available to deposit</Trans>
                    </Text>
                    <Text className="mt-1 text-base font-semibold">
                      {availableBalance.data === undefined
                        ? availableBalance.isPending
                          ? _(msg`Loading...`)
                          : _(msg`Unavailable`)
                        : `${formatTokenAmount(
                            availableBalance.data,
                            polymarketFundingAdapter.token.decimals,
                          )} pUSD`}
                    </Text>
                  </Card>
                  {availableBalance.isError ? (
                    <Text
                      className="mb-3 text-xs"
                      style={{ color: ui.negative }}
                    >
                      <Trans>
                        Could not refresh your Kites wallet balance.
                      </Trans>
                    </Text>
                  ) : null}

                  {pendingHash ? (
                    <Card compact className="mb-4">
                      <Text className="text-sm font-semibold">
                        <Trans>Deposit submitted</Trans>
                      </Text>
                      <Text
                        className="mt-2 text-xs leading-5"
                        style={{ color: ui.muted }}
                      >
                        <Trans>
                          Waiting for Polygon confirmation. The status is
                          checked automatically.
                        </Trans>
                      </Text>
                    </Card>
                  ) : null}

                  {!pendingHash && !reviewing ? (
                    <>
                      <View className="mb-2 flex-row items-center justify-between">
                        <Text className="text-sm font-medium">
                          <Trans>Amount</Trans>
                        </Text>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={_(
                            msg`Use maximum available balance`,
                          )}
                          disabled={
                            busy ||
                            Boolean(pendingHash) ||
                            availableBalance.data === undefined ||
                            availableBalance.data <= BigInt(0)
                          }
                          onPress={() => {
                            if (availableBalance.data === undefined) return;
                            setAmount(
                              formatUnits(
                                availableBalance.data,
                                polymarketFundingAdapter.token.decimals,
                              ),
                            );
                            setQuote(null);
                            setReviewing(false);
                            setError(null);
                          }}
                        >
                          <Text
                            style={{
                              color:
                                availableBalance.data &&
                                availableBalance.data > BigInt(0)
                                  ? ui.primary
                                  : ui.muted,
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
                          editable={!busy && !pendingHash}
                          onChangeText={(value) => {
                            setAmount(sanitizeDecimalInput(value));
                            setQuote(null);
                            setReviewing(false);
                            setError(null);
                          }}
                          keyboardType="decimal-pad"
                          placeholder="0.00"
                          placeholderTextColor={ui.placeholder}
                          className="min-w-0 flex-1 py-3.5 text-lg"
                          style={{ color: ui.text }}
                        />
                        <Text className="ml-3 text-base font-semibold">
                          pUSD
                        </Text>
                      </InputWell>
                    </>
                  ) : null}
                  {!pendingHash && reviewing && quote ? (
                    <Card compact className="mb-0 mt-4">
                      <SectionLabel className="mb-3">
                        <Trans>Review deposit</Trans>
                      </SectionLabel>
                      <DetailRow
                        label={_(msg`Amount`)}
                        value={`${amount.trim()} pUSD`}
                      />
                      <DetailRow
                        label={_(msg`From`)}
                        value={shortAddress(sourceAddress)}
                        detail="Kites wallet · Polygon"
                      />
                      <DetailRow
                        label={_(msg`To`)}
                        value={shortAddress(destinationAddress)}
                        detail="Polymarket deposit wallet · Polygon"
                      />
                      <DetailRow
                        label={_(msg`Network fee (estimated)`)}
                        value={`${quote.estimatedNetworkFee ?? "—"} POL`}
                      />
                      <DetailRow
                        label={_(msg`Route`)}
                        value="Polygon → Polygon · Direct"
                      />
                      <Text
                        className="mt-2 text-xs leading-5"
                        style={{ color: ui.muted }}
                      >
                        <Trans>
                          The fee is paid in POL from your Kites wallet.
                        </Trans>
                      </Text>
                    </Card>
                  ) : null}

                  {error ? (
                    <Text
                      className="mt-3 text-sm leading-5"
                      style={{ color: ui.negative }}
                    >
                      {error}
                    </Text>
                  ) : null}
                  {quote &&
                  !quote.hasEnoughToken &&
                  onDepositToWallet &&
                  !pendingHash ? (
                    <ActionButton
                      variant="outline"
                      disabled={busy}
                      onPress={onDepositToWallet}
                      className="mt-3"
                      label={<Trans>Deposit into Kites wallet</Trans>}
                    />
                  ) : null}
                  {!pendingHash ? (
                    <ActionButton
                      disabled={
                        busy ||
                        !amount.trim() ||
                        (reviewing &&
                          (!quote?.hasEnoughToken || !quote.hasEnoughGas))
                      }
                      loading={busy}
                      className="mt-5"
                      onPress={() => {
                        if (reviewing) void submitFunding();
                        else void reviewFunding();
                      }}
                      label={
                        reviewing ? (
                          <Trans>Confirm</Trans>
                        ) : (
                          <Trans>Review</Trans>
                        )
                      }
                    />
                  ) : null}
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
        <WalletStatusToast />
      </View>
    </Modal>
  );
}

function DetailRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  const ui = useUi();

  return (
    <View className="mb-2 flex-row items-start justify-between gap-3 last:mb-0">
      <Text className="text-[13px]" style={{ color: ui.muted }}>
        {label}
      </Text>
      <View className="flex-1 items-end">
        <Text className="text-right text-[13px] font-semibold">{value}</Text>
        {detail ? (
          <Text
            className="mt-0.5 text-right text-xs"
            style={{ color: ui.muted }}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function shortAddress(address: Address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}
