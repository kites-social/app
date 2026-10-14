import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQuery } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi } from "~/components/ui/tokens";
import { api } from "~/lib/utils/api";
import { onboardingVenues } from "~/lib/venues/registry";
import { useWallet } from "~/lib/web3/custody";

export default function VenueOnboardingListScreen() {
  const { _ } = useLingui();
  const ui = useUi();
  const router = useRouter();
  const custodyWallet = useWallet();
  const wallet = api.wallet.mine.useQuery();
  const fundingStatus = wallet.data?.initialFundingStatus ?? null;

  return (
    <>
      <Stack.Screen options={{ title: _(msg`Trading venues`) }} />
      <View className="flex-1 px-4 pt-5">
        <Text className="mb-5 text-base leading-6 text-neutral-600 dark:text-neutral-400">
          <Trans>Set up your trading venues.</Trans>
        </Text>
        {fundingStatus && fundingStatus !== "complete" && (
          <View
            className="mb-4 border p-4"
            style={{
              backgroundColor: ui.card,
              borderColor: ui.border,
              borderRadius: radius.card,
              ...continuousCorners,
            }}
          >
            <Text className="text-base font-semibold">
              {fundingStatus === "pending"
                ? _(msg`Preparing your testnet wallet`)
                : _(msg`Testnet funding is not ready`)}
            </Text>
            <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                Perpl setup will continue after your wallet receives test funds.
                Other venue setup can finish independently.
              </Trans>
            </Text>
          </View>
        )}
        {wallet.isPending ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" />
          </View>
        ) : wallet.isError ? (
          <View className="items-center px-6 pt-12">
            <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
              <Trans>Unable to load your wallet and venue setup.</Trans>
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void wallet.refetch()}
              className="mt-3 px-5 py-2.5"
              style={{
                backgroundColor: ui.primary,
                borderRadius: radius.pill,
              }}
            >
              <Text className="font-medium text-white">
                <Trans>Retry</Trans>
              </Text>
            </TouchableOpacity>
          </View>
        ) : onboardingVenues.length === 0 ? (
          <View className="items-center px-6 pt-12">
            <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
              <Trans>No trading venues are available yet.</Trans>
            </Text>
          </View>
        ) : (
          <View className="gap-3">
            {onboardingVenues.map(({ venue, onboarding }) => (
              <VenueCard
                key={venue.id}
                venue={venue}
                walletAddress={wallet.data?.address}
                depositWalletAddress={
                  wallet.data?.polymarketDepositWalletAddress ?? undefined
                }
                autoSetup={
                  custodyWallet.venueSetup[
                    venue.id as "polymarket" | "perpl" | "hyperliquid"
                  ]
                }
                getSteps={onboarding.getSteps}
                onPress={() =>
                  venue.id === "hyperliquid"
                    ? undefined
                    : router.push({
                        pathname: "/venue-onboarding/[venueId]",
                        params: { venueId: venue.id },
                      })
                }
              />
            ))}
          </View>
        )}
      </View>
    </>
  );
}

const VenueCard = ({
  venue,
  walletAddress,
  depositWalletAddress,
  autoSetup,
  getSteps,
  onPress,
}: {
  venue: (typeof onboardingVenues)[number]["venue"];
  walletAddress?: `0x${string}`;
  depositWalletAddress?: `0x${string}`;
  autoSetup?: {
    status: "waiting" | "running" | "complete" | "failed";
    step: string;
    error?: string;
  };
  getSteps: (context: {
    walletAddress?: `0x${string}`;
    depositWalletAddress?: `0x${string}`;
  }) => Promise<
    {
      status: "action-required" | "blocked" | "complete" | "waiting";
      kind: "action" | "deposit" | "information";
    }[]
  >;
  onPress: () => void;
}) => {
  const ui = useUi();
  const { _ } = useLingui();
  const unavailable = venue.id === "hyperliquid";
  const steps = useQuery({
    queryKey: [
      "venue-onboarding",
      venue.id,
      walletAddress,
      depositWalletAddress,
    ],
    queryFn: () => getSteps({ walletAddress, depositWalletAddress }),
    enabled: !unavailable,
    staleTime: 30_000,
  });
  const tradingSteps = steps.data?.filter((step) => step.kind !== "deposit");
  const actualStatus =
    tradingSteps?.length &&
    tradingSteps.every((step) => step.status === "complete")
      ? _(msg`Setup complete`)
      : tradingSteps?.some((step) => step.status === "complete")
        ? _(msg`In progress`)
        : _(msg`Not set up`);
  const status =
    autoSetup?.status === "running"
      ? _(msg`Setting up`)
      : autoSetup?.status === "waiting"
        ? _(msg`Waiting`)
        : autoSetup?.status === "failed"
          ? _(msg`Needs attention`)
          : actualStatus;
  const marketTypes = venue.supportedMarketTypes ?? [venue.marketType];
  const type = marketTypes
    .map((marketType) => {
      switch (marketType) {
        case "prediction":
          return _(msg`Prediction markets`);
        case "spot":
          return _(msg`Spot markets`);
        case "perpetual":
          return _(msg`Perpetual markets`);
      }
    })
    .join(" · ");

  const card = (
    <View
      pointerEvents={unavailable ? "none" : "auto"}
      className="border p-4"
      style={{
        backgroundColor: unavailable
          ? ui.dark
            ? "#262626"
            : "#e5e7eb"
          : ui.card,
        borderColor: unavailable
          ? ui.dark
            ? "#404040"
            : "#d1d5db"
          : ui.border,
        borderRadius: radius.card,
        opacity: unavailable ? 0.8 : 1,
        ...continuousCorners,
      }}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-lg font-semibold">{venue.name}</Text>
          <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {type}
          </Text>
          {unavailable && (
            <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              <Trans>Coming soon...</Trans>
            </Text>
          )}
        </View>
        {unavailable ? (
          <Text className="ml-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
            <Trans>Unavailable</Trans>
          </Text>
        ) : steps.isPending ? (
          <ActivityIndicator size="small" />
        ) : (
          <Text className="ml-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
            {steps.isError ? _(msg`Unavailable`) : status}
          </Text>
        )}
      </View>
      {!unavailable && steps.isError && (
        <Text className="mt-3 text-sm" style={{ color: ui.negative }}>
          <Trans>Could not check venue setup. Open it to retry.</Trans>
        </Text>
      )}
      {!unavailable && autoSetup?.status === "running" && (
        <Text className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {autoSetup.step}
        </Text>
      )}
      {!unavailable && autoSetup?.status === "waiting" && (
        <Text className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {autoSetup.step}
        </Text>
      )}
      {!unavailable && autoSetup?.status === "failed" && autoSetup.error && (
        <Text className="mt-2 text-sm" style={{ color: ui.negative }}>
          {autoSetup.error}
        </Text>
      )}
    </View>
  );

  return unavailable ? (
    card
  ) : (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      activeOpacity={0.75}
    >
      {card}
    </TouchableOpacity>
  );
};
