import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { XIcon } from "lucide-react-native";
import { type Address } from "viem";

import { Text } from "~/components/themed/text";

type RecoveryStep = "choice" | "warning" | "confirm" | "created";

export const WalletPasskeyRecoveryModal = ({
  visible,
  oldAddress,
  isBusy,
  onClose,
  onRetryUnlock,
  onReplace,
}: {
  visible: boolean;
  oldAddress: Address;
  isBusy: boolean;
  onClose: () => void;
  onRetryUnlock: (existingAddress: Address) => Promise<boolean>;
  onReplace: (existingAddress: Address) => Promise<Address>;
}) => {
  const { _ } = useLingui();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const wasVisible = useRef(false);
  const [step, setStep] = useState<RecoveryStep>("choice");
  const [originalAddress, setOriginalAddress] = useState(oldAddress);
  const [acknowledged, setAcknowledged] = useState(false);
  const [createdAddress, setCreatedAddress] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setOriginalAddress(oldAddress);
      setStep("choice");
      setAcknowledged(false);
      setCreatedAddress(null);
      setError(null);
    }
    wasVisible.current = visible;
  }, [oldAddress, visible]);

  const close = () => {
    if (!isBusy) onClose();
  };

  const moveTo = (next: RecoveryStep) => {
    setError(null);
    setAcknowledged(false);
    setStep(next);
  };

  const retryUnlock = async () => {
    if (isBusy) return;
    setError(null);
    try {
      if (await onRetryUnlock(originalAddress)) {
        onClose();
        return;
      }
    } catch {
      // Keep the explicit replacement choice available if the retry itself
      // cannot finish, such as when the wallet-link refresh also fails.
    }
    setError(
      _(
        msg`That passkey did not unlock the linked wallet. Your Bluesky wallet link is unchanged. Try a synced passkey on another device, or choose the replacement option below.`,
      ),
    );
  };

  const createReplacement = async () => {
    if (!acknowledged || isBusy) return;
    setError(null);
    try {
      const address = await onReplace(originalAddress);
      setCreatedAddress(address);
      setStep("created");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : _(
              msg`The replacement wallet could not be created. Please try again.`,
            ),
      );
    }
  };

  const primaryButton = (
    label: ReactNode,
    onPress: () => void,
    disabled = false,
  ) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || isBusy, busy: isBusy }}
      disabled={disabled || isBusy}
      onPress={onPress}
      className="mt-4 items-center rounded-full px-4 py-3"
      style={{
        backgroundColor: theme.colors.primary,
        opacity: disabled || isBusy ? 0.55 : 1,
      }}
    >
      {isBusy ? (
        <ActivityIndicator color="white" />
      ) : (
        <Text className="text-center font-semibold text-white">{label}</Text>
      )}
    </TouchableOpacity>
  );

  const secondaryButton = (label: ReactNode, onPress: () => void) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: isBusy }}
      disabled={isBusy}
      onPress={onPress}
      className="mt-3 items-center rounded-full border px-4 py-3"
      style={{ borderColor: theme.colors.border }}
    >
      <Text className="text-center font-semibold">{label}</Text>
    </TouchableOpacity>
  );

  const addressCard = (label: ReactNode, address: Address) => (
    <View
      className="mt-4 rounded-2xl border p-3"
      style={{
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </Text>
      <Text selectable className="mt-2 font-mono text-xs leading-5">
        {address}
      </Text>
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={_(msg`Close wallet recovery`)}
          disabled={isBusy}
          className="absolute inset-0 bg-black/50"
          onPress={close}
        />
        <View
          className="rounded-t-3xl px-5 pt-5"
          style={{
            backgroundColor: theme.colors.card,
            paddingBottom: Math.max(insets.bottom, 20),
            maxHeight: "92%",
          }}
        >
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="text-xl font-semibold">
              {step === "created" ? (
                <Trans>Replacement wallet</Trans>
              ) : (
                <Trans>Passkey access</Trans>
              )}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={_(msg`Close wallet recovery`)}
              accessibilityState={{ disabled: isBusy }}
              disabled={isBusy}
              onPress={close}
              className="rounded-full p-2"
            >
              <XIcon size={20} color={theme.colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 10 }}
          >
            {step === "choice" && (
              <>
                <Text className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                  <Trans>Choose what to do next</Trans>
                </Text>
                <Text className="text-2xl font-semibold leading-8">
                  <Trans>Can you still use the original passkey?</Trans>
                </Text>
                <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                  <Trans>
                    Your signed-in Bluesky account points to the wallet shown
                    below. Only its original passkey can unlock that address.
                  </Trans>
                </Text>
                {addressCard(
                  _(msg`Current Bluesky wallet link`),
                  originalAddress,
                )}
                {error && (
                  <Text
                    accessibilityLiveRegion="polite"
                    className="mt-3 rounded-xl bg-red-50 p-3 text-sm leading-5 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                  >
                    {error}
                  </Text>
                )}
                <View className="mt-4 rounded-2xl bg-neutral-100 p-4 dark:bg-neutral-800">
                  <Text className="font-semibold">
                    <Trans>Try another device or passkey</Trans>
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                    <Trans>
                      A synced copy may still unlock the same wallet.
                    </Trans>
                  </Text>
                  {primaryButton(_(msg`Try the original wallet`), retryUnlock)}
                </View>
                <View className="mt-3 rounded-2xl bg-neutral-100 p-4 dark:bg-neutral-800">
                  <Text className="font-semibold">
                    <Trans>Create a replacement wallet</Trans>
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                    <Trans>
                      This creates a different key and address. It does not
                      recover the original wallet.
                    </Trans>
                  </Text>
                  {secondaryButton(_(msg`Review what this means`), () =>
                    moveTo("warning"),
                  )}
                </View>
              </>
            )}

            {step === "warning" && (
              <>
                <Text className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                  <Trans>Before you continue</Trans>
                </Text>
                <Text className="text-2xl font-semibold leading-8">
                  <Trans>A new wallet won’t restore the old one</Trans>
                </Text>
                <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                  <Trans>
                    Your Bluesky wallet link currently points to this address:
                  </Trans>
                </Text>
                {addressCard(_(msg`Original wallet address`), originalAddress)}
                <View className="mt-4 rounded-2xl bg-orange-50 p-4 dark:bg-orange-950/40">
                  <Text className="font-semibold text-orange-950 dark:text-orange-100">
                    <Trans>Funds and positions stay with the old address</Trans>
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-orange-950 dark:text-orange-100">
                    <Trans>
                      A replacement has a different private key. It cannot
                      access, move, or restore funds or positions associated
                      with this address. Kites cannot recover the old private
                      key for you.
                    </Trans>
                  </Text>
                </View>
                <Text className="mt-3 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                  <Trans>
                    If you continue, the new address will replace the address
                    shown on your Bluesky wallet link. The old address and its
                    assets remain separate.
                  </Trans>
                </Text>
                {primaryButton(_(msg`Continue to confirmation`), () =>
                  moveTo("confirm"),
                )}
                {secondaryButton(_(msg`Go back`), () => moveTo("choice"))}
              </>
            )}

            {step === "confirm" && (
              <>
                <Text className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                  <Trans>Confirm replacement</Trans>
                </Text>
                <Text className="text-2xl font-semibold leading-8">
                  <Trans>Create a different wallet?</Trans>
                </Text>
                <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                  <Trans>
                    A new passkey will create a new address and replace the
                    address shown on your Bluesky wallet link.
                  </Trans>
                </Text>
                {addressCard(_(msg`Current linked address`), originalAddress)}
                <View className="mt-3 flex-row justify-between border-b border-neutral-200 py-3 dark:border-neutral-700">
                  <Text className="text-sm text-neutral-500 dark:text-neutral-400">
                    <Trans>After replacement</Trans>
                  </Text>
                  <Text className="ml-4 flex-1 text-right text-sm font-semibold">
                    <Trans>New address from a new passkey</Trans>
                  </Text>
                </View>
                <View className="flex-row justify-between border-b border-neutral-200 py-3 dark:border-neutral-700">
                  <Text className="text-sm text-neutral-500 dark:text-neutral-400">
                    <Trans>Old funds and positions</Trans>
                  </Text>
                  <Text className="ml-4 flex-1 text-right text-sm font-semibold">
                    <Trans>Stay with the old address</Trans>
                  </Text>
                </View>
                <View className="mt-4 rounded-2xl bg-orange-50 p-4 dark:bg-orange-950/40">
                  <Text className="font-semibold text-orange-950 dark:text-orange-100">
                    <Trans>This does not transfer anything</Trans>
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-orange-950 dark:text-orange-100">
                    <Trans>
                      The new wallet cannot access, move, or recover funds or
                      positions at the old address.
                    </Trans>
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="checkbox"
                  accessibilityState={{
                    checked: acknowledged,
                    disabled: isBusy,
                  }}
                  disabled={isBusy}
                  onPress={() => setAcknowledged((value) => !value)}
                  className="mt-4 flex-row items-start"
                >
                  <View
                    className="mr-3 mt-0.5 h-5 w-5 items-center justify-center rounded border"
                    style={{
                      borderColor: acknowledged
                        ? theme.colors.primary
                        : theme.colors.border,
                      backgroundColor: acknowledged
                        ? theme.colors.primary
                        : "transparent",
                    }}
                  >
                    {acknowledged && (
                      <Text className="text-xs font-bold text-white">✓</Text>
                    )}
                  </View>
                  <Text className="flex-1 text-sm leading-5">
                    <Trans>
                      I understand this creates a new wallet and does not
                      restore access to funds or positions at the old address.
                    </Trans>
                  </Text>
                </TouchableOpacity>
                {error && (
                  <Text
                    accessibilityLiveRegion="polite"
                    className="mt-3 text-sm leading-5 text-red-700 dark:text-red-400"
                  >
                    {error}
                  </Text>
                )}
                {primaryButton(
                  isBusy
                    ? _(msg`Creating replacement wallet…`)
                    : _(msg`Create replacement wallet`),
                  () => void createReplacement(),
                  !acknowledged,
                )}
                {secondaryButton(_(msg`Not now`), () => moveTo("warning"))}
              </>
            )}

            {step === "created" && createdAddress && (
              <>
                <View className="mb-4 h-12 w-12 items-center justify-center rounded-2xl bg-green-100 dark:bg-green-950">
                  <Text className="text-xl font-bold text-green-700 dark:text-green-300">
                    ✓
                  </Text>
                </View>
                <Text className="text-2xl font-semibold leading-8">
                  <Trans>Your new wallet is ready</Trans>
                </Text>
                <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                  <Trans>
                    Your Bluesky wallet link now points to this new address.
                  </Trans>
                </Text>
                {addressCard(_(msg`New linked wallet`), createdAddress)}
                {addressCard(_(msg`Previous wallet address`), originalAddress)}
                <View className="mt-4 rounded-2xl bg-orange-50 p-4 dark:bg-orange-950/40">
                  <Text className="font-semibold text-orange-950 dark:text-orange-100">
                    <Trans>The original wallet is still separate</Trans>
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-orange-950 dark:text-orange-100">
                    <Trans>
                      This new address does not restore or contain funds or
                      positions associated with the old address.
                    </Trans>
                  </Text>
                </View>
                {primaryButton(_(msg`Done`), onClose)}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};
