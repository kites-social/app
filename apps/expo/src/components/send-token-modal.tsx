import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import {
  AndroidSoftInputModes,
  KeyboardAvoidingView,
  KeyboardController,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type AppBskyActorDefs } from "@atproto/api";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react-native";
import { getAddress, isAddress, type Address, type Hash } from "viem";

import { Text } from "~/components/themed/text";
import { TextInput } from "~/components/themed/text-input";
import { showWalletStatusToast } from "~/components/toastable/toastable";
import {
  ActionButton,
  Card,
  continuousCorners,
  Divider,
  PillButton,
  radius,
  SectionLabel,
  StatRow,
  useUi,
} from "~/components/ui";
import { useAgent } from "~/lib/agent";
import { sanitizeDecimalInput } from "~/lib/utils/decimal-input";
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
import {
  resolvePublicWalletLink,
  sendAppToken,
  useWallet,
} from "~/lib/web3/custody";

export interface SendableToken {
  chainId: number;
  chainName: string;
  symbol: string;
  decimals: number;
  tokenAddress?: Address;
}

interface PendingTransfer {
  hash: Hash;
  token: SendableToken;
  amount: string;
  recipientLabel: string;
}

export const SendTokenModal = ({
  visible,
  token,
  senderAddress,
  onClose,
  onPendingChange,
}: {
  visible: boolean;
  token: SendableToken | null;
  senderAddress: Address;
  onClose: () => void;
  onPendingChange: (token: SendableToken | null) => void;
}) => {
  const { _ } = useLingui();
  const theme = useTheme();
  const ui = useUi();
  const { height: windowHeight } = useWindowDimensions();
  const inputStyle = {
    backgroundColor: ui.inset,
    borderColor: ui.border,
    borderWidth: 1,
    borderRadius: radius.input,
    ...continuousCorners,
  } as const;
  const insets = useSafeAreaInsets();
  const agent = useAgent();
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] =
    useState<AppBskyActorDefs.ProfileViewBasic | null>(null);
  const [directRecipient, setDirectRecipient] = useState<Address | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingTransfer, setPendingTransfer] =
    useState<PendingTransfer | null>(null);
  const pendingSuccessToast = useRef<{
    title: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    if (!visible || Platform.OS !== "android") return;

    KeyboardController.setInputMode(
      AndroidSoftInputModes.SOFT_INPUT_ADJUST_RESIZE,
    );
    return () => KeyboardController.setDefaultMode();
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return;
    }

    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hideSubscription = Keyboard.addListener(hideEvent, () =>
      setKeyboardHeight(0),
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [visible]);

  const term = debouncedSearch.replace(/^@/, "");
  const searchResults = useQuery({
    queryKey: ["wallet", "recipient-search", term],
    enabled: visible && !recipient && !directRecipient && term.length >= 2,
    queryFn: async () => {
      const result = await agent.searchActorsTypeahead({ term, limit: 8 });
      if (!result.success) throw new Error("Could not search for recipients.");
      return result.data.actors;
    },
  });
  const recipientWallet = useQuery({
    queryKey: ["wallet", "public-link", recipient?.did],
    enabled: visible && Boolean(recipient?.did),
    queryFn: async () => {
      if (!recipient?.did) return null;
      const link = await resolvePublicWalletLink(agent, recipient.did);
      return link?.address ?? null;
    },
  });
  const resolvedRecipientAddress = directRecipient ?? recipientWallet.data;
  const recipientLabel = directRecipient
    ? `Address ${shortAddress(directRecipient)}`
    : recipient
      ? `@${recipient.handle}`
      : "";
  const senderLabel = agent.session?.handle
    ? `@${agent.session.handle}`
    : `Address ${shortAddress(senderAddress)}`;
  const recipientSearchResults =
    searchResults.data?.filter(
      (profile) => profile.did !== agent.session?.did,
    ) ?? [];
  const modalMaxHeight =
    Platform.OS === "ios" && keyboardHeight > 0
      ? Math.max(0, windowHeight - keyboardHeight - insets.top)
      : "90%";
  const recipientResultsMaxHeight =
    keyboardHeight > 0 || searchFocused ? 112 : 220;

  const showTransferProgressToast = () =>
    showWalletStatusToast({
      title: _(msg`Sending transfer…`),
      message: _(msg`Please wait while your transfer is confirmed.`),
      status: "progress",
    });

  const showPendingSuccessToast = () => {
    const toast = pendingSuccessToast.current;
    if (!toast) return;

    pendingSuccessToast.current = null;
    showWalletStatusToast({ ...toast, status: "success" });
  };

  const checkTransfer = async (pending: PendingTransfer) => {
    setBusy(true);
    try {
      const receipt = await getAppPublicClient(
        pending.token.chainId,
      ).waitForTransactionReceipt({
        hash: pending.hash,
        timeout: 120_000,
      });
      if (receipt.status !== "success") {
        saveTransferActivity(pending, "failed");
        setPendingTransfer(null);
        onPendingChange(null);
        showWalletStatusToast({
          title: _(msg`Transfer failed`),
          message: _(msg`The transfer transaction failed on-chain.`),
          status: "danger",
        });
        return;
      }

      saveTransferActivity(pending, "confirmed");
      setPendingTransfer(null);
      onPendingChange(null);
      pendingSuccessToast.current = {
        title: _(msg`Transfer confirmed`),
        message: _(
          msg`Sent ${pending.amount} ${pending.token.symbol} to ${pending.recipientLabel}.`,
        ),
      };
      void queryClient.invalidateQueries({
        queryKey: appChainBalancesQueryKey,
      });
      void queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey });
      setRecipient(null);
      setDirectRecipient(null);
      setReviewing(false);
      setAmount("");
      setSearch("");
      setDebouncedSearch("");
      onClose();
      if (Platform.OS === "android") {
        setTimeout(showPendingSuccessToast, 350);
      }
    } catch {
      showWalletStatusToast({
        title: _(msg`Transfer still pending`),
        message: _(
          msg`The transaction is still waiting for network confirmation. Check again before sending another transfer.`,
        ),
        status: "warning",
      });
    } finally {
      setBusy(false);
    }
  };

  const submitTransfer = async () => {
    if (
      !token ||
      !resolvedRecipientAddress ||
      !amount ||
      pendingTransfer ||
      busy
    )
      return;
    setBusy(true);
    showTransferProgressToast();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    try {
      const session = await wallet.ensureUnlocked({
        existingAddress: senderAddress,
      });
      if (session.address.toLowerCase() !== senderAddress.toLowerCase()) {
        throw new Error(
          "The unlocked wallet does not match your account's linked address. Lock and unlock it again before sending.",
        );
      }
      const hash = await sendAppToken(session.account, {
        chainId: token.chainId,
        recipient: resolvedRecipientAddress,
        amount,
        decimals: token.decimals,
        tokenAddress: token.tokenAddress,
      });
      const pending = {
        hash,
        token,
        amount,
        recipientLabel,
      };
      saveTransferActivity(pending, "pending");
      setPendingTransfer(pending);
      onPendingChange(token);
      await checkTransfer(pending);
    } catch (error) {
      showWalletStatusToast({
        title: _(msg`Transfer not sent`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Please check your wallet and try again.`),
        status: "danger",
      });
      setBusy(false);
    }
  };

  const selectRecipient = (profile: AppBskyActorDefs.ProfileViewBasic) => {
    setRecipient(profile);
    setDirectRecipient(null);
    setSearch("");
    setDebouncedSearch("");
    setReviewing(false);
  };

  const close = () => {
    if (busy) return;
    setRecipient(null);
    setDirectRecipient(null);
    setSearch("");
    setDebouncedSearch("");
    setAmount("");
    setReviewing(false);
    onClose();
  };

  const canSubmit =
    Boolean(token) &&
    Boolean(resolvedRecipientAddress) &&
    resolvedRecipientAddress?.toLowerCase() !== senderAddress.toLowerCase() &&
    (Boolean(directRecipient) ||
      (!recipientWallet.isPending && !recipientWallet.isError)) &&
    amount.trim().length > 0 &&
    !busy &&
    !pendingTransfer;

  function saveTransferActivity(
    transfer: PendingTransfer,
    status: WalletActivityStatus,
  ) {
    const did = agent.session?.did;
    if (!did) return;
    saveWalletActivity(did, {
      id: `evm:${transfer.token.chainId}:${transfer.hash}`,
      kind: "send",
      status,
      title: `Sent ${transfer.amount} ${transfer.token.symbol}`,
      detail: `To ${transfer.recipientLabel} · ${transfer.token.chainName}`,
      chainId: transfer.token.chainId,
      transactionHash: transfer.hash,
    });
    void queryClient.invalidateQueries({
      queryKey: walletActivityQueryKey(did),
    });
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onDismiss={showPendingSuccessToast}
      onRequestClose={close}
    >
      <View className="flex-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={_(msg`Close send tokens window`)}
          className="absolute inset-0 bg-black/50"
          onPress={close}
        />
        <KeyboardAvoidingView
          className="flex-1"
          behavior="position"
          contentContainerStyle={{ flex: 1, justifyContent: "flex-end" }}
        >
          <View
            className="rounded-t-3xl px-5 pt-5"
            style={{
              backgroundColor: theme.colors.card,
              paddingBottom: Math.max(insets.bottom, 20),
              maxHeight: modalMaxHeight,
            }}
          >
            <View className="mb-5 flex-row items-center justify-between">
              <Text className="text-xl font-semibold">
                <Trans>Send {token?.symbol ?? "tokens"}</Trans>
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={_(msg`Close send tokens window`)}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={close}
                className="rounded-full p-2"
              >
                <XIcon size={20} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
            {pendingTransfer ? (
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: 320 }}
              >
                <Card compact className="mb-4">
                  <Text
                    className="text-sm leading-5"
                    style={{ color: ui.muted }}
                  >
                    <Trans>
                      Your {pendingTransfer.amount}{" "}
                      {pendingTransfer.token.symbol} transfer to{" "}
                      {pendingTransfer.recipientLabel} is waiting for
                      confirmation.
                    </Trans>
                  </Text>
                  <ActionButton
                    disabled={busy}
                    loading={busy}
                    onPress={() => {
                      showTransferProgressToast();
                      void checkTransfer(pendingTransfer);
                    }}
                    className="mt-4"
                    label={<Trans>Check transfer status</Trans>}
                  />
                </Card>
              </ScrollView>
            ) : (
              <>
                <View className="shrink-0">
                  <Text
                    className="mb-2 text-sm font-medium"
                    style={{ color: ui.muted }}
                  >
                    <Trans>Recipient</Trans>
                  </Text>
                  {recipient || directRecipient ? (
                    <Card compact className="mb-4">
                      <View className="flex-row items-center justify-between">
                        <View className="flex-1">
                          <Text className="font-semibold">
                            {recipient
                              ? (recipient.displayName ??
                                `@${recipient.handle}`)
                              : _(msg`External wallet address`)}
                          </Text>
                          <Text
                            className="mt-1 text-sm"
                            style={{ color: ui.muted }}
                          >
                            {recipient
                              ? `@${recipient.handle}`
                              : directRecipient}
                          </Text>
                        </View>
                        <TouchableOpacity
                          accessibilityRole="button"
                          onPress={() => {
                            setRecipient(null);
                            setDirectRecipient(null);
                            setAmount("");
                            setReviewing(false);
                          }}
                          className="rounded-full px-3 py-2"
                        >
                          <Text className="text-sm font-medium">
                            <Trans>Change</Trans>
                          </Text>
                        </TouchableOpacity>
                      </View>
                      {directRecipient ? (
                        <Text
                          className="mt-3 text-xs"
                          style={{ color: ui.muted }}
                        >
                          <Trans>
                            Transfers to this address cannot be reversed.
                          </Trans>
                        </Text>
                      ) : recipientWallet.isPending ? (
                        <ActivityIndicator className="mt-3 self-start" />
                      ) : recipientWallet.isError ? (
                        <View className="mt-3">
                          <Text
                            className="text-sm"
                            style={{ color: ui.negative }}
                          >
                            <Trans>
                              Could not check whether this user has a wallet.
                            </Trans>
                          </Text>
                          <PillButton
                            onPress={() => void recipientWallet.refetch()}
                            label={<Trans>Retry</Trans>}
                          />
                        </View>
                      ) : recipientWallet.data === null ? (
                        <Text
                          className="mt-3 text-sm leading-5"
                          style={{ color: ui.muted }}
                        >
                          <Trans>
                            This user has not set up a Kites wallet with an EVM
                            address, so they cannot receive tokens here yet.
                          </Trans>
                        </Text>
                      ) : recipientWallet.data === senderAddress ? (
                        <Text
                          className="mt-3 text-sm"
                          style={{ color: ui.muted }}
                        >
                          <Trans>This is your own wallet.</Trans>
                        </Text>
                      ) : (
                        <Text
                          className="mt-3 text-xs"
                          style={{ color: ui.muted }}
                        >
                          {recipientWallet.data}
                        </Text>
                      )}
                    </Card>
                  ) : (
                    <>
                      <TextInput
                        accessibilityLabel={_(
                          msg`Search recipient by handle or address`,
                        )}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={search}
                        onFocus={() => setSearchFocused(true)}
                        onBlur={() => setSearchFocused(false)}
                        onChangeText={(value) => {
                          setSearch(value);
                          setRecipient(null);
                          setDirectRecipient(
                            isAddress(value.trim())
                              ? getAddress(value.trim())
                              : null,
                          );
                          setReviewing(false);
                        }}
                        placeholder={_(msg`Search by handle or wallet address`)}
                        returnKeyType="search"
                        className="mb-2 px-4 py-3"
                        style={inputStyle}
                      />
                      {search.length === 0 ? (
                        <Text
                          className="mb-4 text-sm"
                          style={{ color: ui.muted }}
                        >
                          <Trans>Enter a Bluesky handle or EVM address.</Trans>
                        </Text>
                      ) : directRecipient ? (
                        <Text
                          className="mb-4 text-sm"
                          style={{ color: ui.muted }}
                        >
                          <Trans>Wallet address recognized.</Trans>
                        </Text>
                      ) : term.length < 2 ? (
                        <Text
                          className="mb-4 text-sm"
                          style={{ color: ui.muted }}
                        >
                          <Trans>Enter at least two characters.</Trans>
                        </Text>
                      ) : searchResults.isFetching ? (
                        <ActivityIndicator className="my-4" />
                      ) : searchResults.isError ? (
                        <Text
                          className="mb-4 text-sm"
                          style={{ color: ui.negative }}
                        >
                          <Trans>Could not search for users. Try again.</Trans>
                        </Text>
                      ) : (
                        <ScrollView
                          className="mb-4"
                          nestedScrollEnabled
                          keyboardShouldPersistTaps="handled"
                          style={{ maxHeight: recipientResultsMaxHeight }}
                        >
                          {recipientSearchResults.length ? (
                            recipientSearchResults.map((profile) => (
                              <TouchableOpacity
                                key={profile.did}
                                accessibilityRole="button"
                                onPress={() => selectRecipient(profile)}
                                className="border-b py-3"
                                style={{ borderColor: theme.colors.border }}
                              >
                                <Text className="font-semibold">
                                  {profile.displayName ?? `@${profile.handle}`}
                                </Text>
                                <Text
                                  className="mt-1 text-sm"
                                  style={{ color: ui.muted }}
                                >
                                  @{profile.handle}
                                </Text>
                              </TouchableOpacity>
                            ))
                          ) : (
                            <Text
                              className="py-3 text-sm"
                              style={{ color: ui.muted }}
                            >
                              <Trans>
                                No other users found for that handle.
                              </Trans>
                            </Text>
                          )}
                        </ScrollView>
                      )}
                    </>
                  )}
                </View>

                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  style={{ maxHeight: keyboardHeight > 0 ? 180 : 360 }}
                >
                  <Text
                    className="mb-2 mt-2 text-sm font-medium"
                    style={{ color: ui.muted }}
                  >
                    <Trans>Amount ({token?.symbol})</Trans>
                  </Text>
                  <TextInput
                    accessibilityLabel={_(msg`Amount to send`)}
                    editable={
                      Boolean(resolvedRecipientAddress) && !busy && !reviewing
                    }
                    keyboardType="decimal-pad"
                    value={amount}
                    onChangeText={(value) => {
                      setAmount(sanitizeDecimalInput(value, token?.decimals));
                      setReviewing(false);
                    }}
                    placeholder="0"
                    className="mb-4 px-4 py-3"
                    style={inputStyle}
                  />
                  <Text
                    className="mb-4 text-xs leading-5"
                    style={{ color: ui.muted }}
                  >
                    {token?.chainName}
                  </Text>
                  {reviewing && resolvedRecipientAddress ? (
                    <Card compact className="mb-4">
                      <SectionLabel className="mb-2">
                        <Trans>Review transfer</Trans>
                      </SectionLabel>
                      <StatRow
                        label={<Trans>You send</Trans>}
                        value={`${amount} ${token?.symbol}`}
                      />
                      <StatRow
                        label={<Trans>Network</Trans>}
                        value={token?.chainName}
                      />
                      <Divider />
                      <Text
                        className="text-xs leading-5"
                        style={{ color: ui.muted }}
                      >
                        {senderLabel} → {recipientLabel} ·{" "}
                        {resolvedRecipientAddress}
                      </Text>
                    </Card>
                  ) : null}
                </ScrollView>
                <ActionButton
                  disabled={!canSubmit}
                  loading={busy}
                  onPress={() =>
                    reviewing ? void submitTransfer() : setReviewing(true)
                  }
                  className="mb-2 mt-2"
                  label={
                    reviewing ? (
                      <Trans>Confirm and send</Trans>
                    ) : (
                      <Trans>Review transfer</Trans>
                    )
                  }
                />
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
};

function shortAddress(address: Address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}
