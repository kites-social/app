import { useState } from "react";
import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { useActionSheet } from "@expo/react-native-action-sheet";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQueries } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import { showWalletStatusToast } from "~/components/toastable/toastable";
import { continuousCorners, radius, useUi } from "~/components/ui/tokens";
import { actionSheetStyles } from "~/lib/utils/action-sheet";
import { api } from "~/lib/utils/api";
import { onboardingVenues } from "~/lib/venues/registry";
import { useWallet } from "~/lib/web3/custody";

export interface MarketTradeAction {
  label: string;
  onPress: () => void;
}

export interface MarketTradeVenue {
  id?: string;
  name: string;
  actions: MarketTradeAction[];
}

export const MarketTradeButton = ({
  marketName,
  venues,
  preview = false,
}: {
  marketName?: string;
  venues: MarketTradeVenue[];
  preview?: boolean;
}) => {
  const theme = useTheme();
  const ui = useUi();
  const router = useRouter();
  const { _ } = useLingui();
  const { showActionSheetWithOptions } = useActionSheet();
  const custodyWallet = useWallet();
  const [isUnlocking, setIsUnlocking] = useState(false);
  const setupVenues = venues.flatMap((venue) => {
    if (!venue.id) return [];
    const provider = onboardingVenues.find(
      (candidate) => candidate.venue.id === venue.id,
    );
    return provider ? [{ venue, provider }] : [];
  });
  const walletQuery = api.wallet.mine.useQuery(undefined, {
    enabled: setupVenues.length > 0,
  });
  const walletAddress = walletQuery.data?.address;
  const depositWalletAddress =
    walletQuery.data?.polymarketDepositWalletAddress ?? undefined;
  const setupQueries = useQueries({
    queries: setupVenues.map(({ venue, provider }) => ({
      queryKey: [
        "venue-onboarding",
        venue.id,
        walletAddress,
        depositWalletAddress,
      ],
      queryFn: () =>
        provider.onboarding.getSteps({
          walletAddress,
          depositWalletAddress,
        }),
      enabled: !walletQuery.isPending && !walletQuery.isError,
      staleTime: 30_000,
    })),
  });
  const setupChecksComplete =
    setupVenues.length === 0 ||
    (!walletQuery.isPending &&
      !walletQuery.isError &&
      setupQueries.every((query) => !query.isPending && !query.isError));
  const venueNeedsSetup = setupQueries.some((query) =>
    query.data?.some(
      (step) => step.kind !== "deposit" && step.status !== "complete",
    ),
  );
  const selectedVenue = venues.length === 1 ? venues[0] : undefined;
  const directAction = selectedVenue?.actions[0];
  const walletMatchesAccount =
    !walletAddress ||
    custodyWallet.address?.toLowerCase() === walletAddress.toLowerCase();
  const canSkipMenu =
    Boolean(directAction && selectedVenue?.actions.length === 1) &&
    setupChecksComplete &&
    !venueNeedsSetup &&
    custodyWallet.isUnlocked &&
    walletMatchesAccount;

  const unlockWallet = async () => {
    if (isUnlocking || custodyWallet.isBusy) return;
    setIsUnlocking(true);
    showWalletStatusToast({
      title: _(msg`Unlocking wallet…`),
      message: _(msg`Please wait while your wallet unlocks.`),
      status: "progress",
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    try {
      await custodyWallet.ensureUnlocked({ existingAddress: walletAddress });
    } catch (error) {
      console.error("Wallet unlock from trade widget failed:", error);
      showWalletStatusToast({
        title: _(msg`Could not unlock wallet`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Please try unlocking your wallet again.`),
        status: "danger",
      });
      setIsUnlocking(false);
      return;
    }
    showWalletStatusToast({
      title: _(msg`Wallet unlocked`),
      message: _(msg`Your wallet is ready to trade.`),
      status: "success",
    });
    try {
      if (selectedVenue?.actions.length === 1) {
        directAction?.onPress();
      } else {
        openTradeMenu(true);
      }
    } finally {
      setIsUnlocking(false);
    }
  };

  const openTradeMenu = (walletIsUnlocked = custodyWallet.isUnlocked) => {
    const options: string[] = [];
    const onSelect: (() => void)[] = [];
    let onboardingError: Error | undefined;

    if (!walletIsUnlocked) {
      options.push(_(msg`Unlock wallet`));
      onSelect.push(() => void unlockWallet());
    } else {
      onboardingError =
        walletQuery.error instanceof Error ? walletQuery.error : undefined;

      for (const venue of venues) {
        const setupIndex = setupVenues.findIndex(
          (target) => target.venue === venue,
        );
        const setupQuery =
          setupIndex >= 0 ? setupQueries[setupIndex] : undefined;
        const needsSetup = Boolean(
          setupIndex >= 0 &&
          (walletQuery.isPending ||
            walletQuery.isError ||
            setupQuery?.isPending ||
            setupQuery?.isError ||
            setupQuery?.data?.some(
              (step) => step.kind !== "deposit" && step.status !== "complete",
            )),
        );

        if (setupQuery?.error instanceof Error) {
          onboardingError = setupQuery.error;
        }
        if (needsSetup && venue.id) {
          options.push(_(msg`Set up ${venue.name}`));
          onSelect.push(() =>
            router.push({
              pathname: "/venue-onboarding/[venueId]",
              params: { venueId: venue.id },
            }),
          );
        }

        for (const action of venue.actions) {
          options.push(action.label);
          onSelect.push(action.onPress);
        }
      }
    }

    if (options.length === 0) return;
    const cancelButtonIndex = options.length;
    options.push(_(msg`Cancel`));
    showActionSheetWithOptions(
      {
        ...(walletIsUnlocked
          ? {
              title: marketName
                ? _(msg`Trade ${marketName}`)
                : _(msg`Trade market`),
            }
          : {}),
        message: onboardingError
          ? _(msg`Could not check venue setup: ${onboardingError.message}`)
          : undefined,
        options,
        cancelButtonIndex,
        ...actionSheetStyles(theme),
      },
      (index) => {
        if (index !== undefined && index >= 0 && index < onSelect.length) {
          onSelect[index]?.();
        }
      },
    );
  };

  const hasMenuAction =
    venues.some((venue) => venue.actions.length > 0) ||
    setupVenues.some((_, index) => {
      const query = setupQueries[index];
      return Boolean(
        walletQuery.isPending ||
        walletQuery.isError ||
        query?.isPending ||
        query?.isError ||
        query?.data?.some(
          (step) => step.kind !== "deposit" && step.status !== "complete",
        ),
      );
    });

  if (preview || !hasMenuAction) {
    return null;
  }

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={
        marketName ? _(msg`Trade ${marketName}`) : _(msg`Trade market`)
      }
      disabled={isUnlocking}
      accessibilityState={{ busy: isUnlocking, disabled: isUnlocking }}
      onPress={() => {
        if (canSkipMenu) {
          directAction?.onPress();
          return;
        }
        openTradeMenu();
      }}
      className="min-h-12 mt-3 items-center justify-center px-4"
      style={{
        backgroundColor: ui.primary,
        borderRadius: radius.control,
        ...continuousCorners,
        opacity: isUnlocking ? 0.75 : 1,
      }}
    >
      <View className="flex-row items-center">
        {isUnlocking && (
          <ActivityIndicator color="white" size="small" className="mr-2" />
        )}
        <Text className="text-sm font-semibold text-white">
          {isUnlocking ? _(msg`Unlocking wallet…`) : _(msg`Trade`)}
        </Text>
      </View>
    </TouchableOpacity>
  );
};
