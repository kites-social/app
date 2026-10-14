import { useState } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { BlurView } from "expo-blur";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import { showWalletStatusToast } from "~/components/toastable/toastable";
import { WalletPasskeyRecoveryModal } from "~/components/wallet-passkey-recovery-modal";
import {
  ActionButton,
  continuousCorners,
  radius,
  useUi,
} from "~/components/ui";
import { useOptionalAgent } from "~/lib/agent";
import { useWallet } from "~/lib/web3/custody";
import { resolvePublicWalletLink } from "~/lib/web3/custody/wallet-link";

export const WalletLockedOverlay = ({
  bottomInset,
}: {
  bottomInset: number;
}) => {
  const { _ } = useLingui();
  const theme = useTheme();
  const ui = useUi();
  const agent = useOptionalAgent();
  const custodyWallet = useWallet();
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const did = agent?.session?.did;
  const walletLink = useQuery({
    queryKey: ["wallet", "public-link", did],
    enabled: Boolean(did),
    queryFn: () => {
      if (!agent || !did) {
        throw new Error("Sign in before checking your wallet link.");
      }
      return resolvePublicWalletLink(agent, did);
    },
  });
  const account = walletLink.data?.address;

  if (
    !did ||
    !account ||
    walletLink.isError ||
    (custodyWallet.isUnlocked && !recoveryVisible)
  ) {
    return null;
  }

  const setupWallet = async () => {
    setIsUnlocking(true);
    showWalletStatusToast({
      title: _(msg`Unlocking wallet…`),
      message: _(msg`Please wait while your wallet unlocks.`),
      status: "progress",
    });
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      await custodyWallet.ensureUnlocked({
        existingAddress: account,
        userName: agent.session?.handle ?? "Kites wallet",
      });
      showWalletStatusToast({
        title: _(msg`Wallet unlocked`),
        message: _(msg`Your wallet is ready to use.`),
        status: "success",
      });
    } catch (error) {
      console.error("Wallet unlock failed:", error);
      showWalletStatusToast({
        title: _(msg`Wallet unlock failed`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Please try unlocking your wallet again.`),
        status: "danger",
      });
    } finally {
      setIsUnlocking(false);
    }
  };
  const isBusy = custodyWallet.isBusy || isUnlocking;

  return (
    <View
      className="px-6"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: bottomInset + (Platform.OS === "ios" ? 49 : 64),
        zIndex: 100,
        elevation: 100,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.dark
          ? "rgba(10, 12, 18, 0.12)"
          : "rgba(245, 247, 250, 0.14)",
      }}
    >
      <BlurView
        intensity={100}
        experimentalBlurMethod={
          Platform.OS === "android" ? "dimezisBlurView" : "none"
        }
        tint={theme.dark ? "dark" : "light"}
        style={StyleSheet.absoluteFillObject}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          {
            backgroundColor: theme.dark
              ? "rgba(10, 12, 18, 0.12)"
              : "rgba(245, 247, 250, 0.14)",
          },
        ]}
      />
      <View
        className="w-full max-w-sm items-center px-6 py-7"
        style={{
          borderWidth: 1,
          borderRadius: radius.card + 4,
          ...continuousCorners,
          backgroundColor: theme.dark
            ? "rgba(28, 30, 38, 0.82)"
            : "rgba(255, 255, 255, 0.84)",
          borderColor: theme.dark
            ? "rgba(255, 255, 255, 0.25)"
            : "rgba(255, 255, 255, 0.82)",
        }}
      >
        <Text className="text-xl font-semibold">
          <Trans>Wallet locked</Trans>
        </Text>
        <Text
          className="mt-2 text-center text-sm leading-5"
          style={{ color: ui.muted }}
        >
          <Trans>Unlock your wallet to view your balances and positions.</Trans>
        </Text>
        <ActionButton
          className="mt-5 w-full"
          disabled={isBusy}
          loading={isBusy}
          accessibilityState={{ disabled: isBusy, busy: isBusy }}
          onPress={() => void setupWallet()}
          label={
            isBusy ? (
              <Trans>Unlocking wallet…</Trans>
            ) : (
              <Trans>Unlock wallet</Trans>
            )
          }
        />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: isBusy }}
          disabled={isBusy}
          onPress={() => setRecoveryVisible(true)}
          className="mt-3 min-h-10 justify-center px-2"
          style={{ opacity: isBusy ? 0.55 : 1 }}
        >
          <Text
            className="text-sm font-semibold"
            style={{ color: theme.colors.primary }}
          >
            <Trans>Lost access to your passkey?</Trans>
          </Text>
        </TouchableOpacity>
      </View>
      <WalletPasskeyRecoveryModal
        visible={recoveryVisible}
        oldAddress={account}
        isBusy={isBusy}
        onClose={() => setRecoveryVisible(false)}
        onRetryUnlock={async (existingAddress) => {
          try {
            await custodyWallet.ensureUnlocked({
              existingAddress,
              userName: agent.session?.handle ?? "Kites wallet",
            });
            return true;
          } catch (error) {
            console.error("Wallet unlock retry failed:", error);
            return false;
          }
        }}
        onReplace={async (existingAddress) => {
          const replacement = await custodyWallet.replaceWallet({
            existingAddress,
            userName: agent.session?.handle ?? "Kites wallet",
          });
          return replacement.address;
        }}
      />
    </View>
  );
};
