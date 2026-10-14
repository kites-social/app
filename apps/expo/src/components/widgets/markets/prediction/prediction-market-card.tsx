import { View } from "react-native";
import { Trans } from "@lingui/macro";
import { useTheme } from "@react-navigation/native";

import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi } from "~/components/ui/tokens";
import { type PredictionMarketSnapshot } from "~/lib/venues/types";
import { MarketTradeButton, type MarketTradeVenue } from "../trade-button";

export const PredictionMarketCard = ({
  market,
  isLast = false,
  tradeVenues,
}: {
  market: PredictionMarketSnapshot;
  tradeVenues: MarketTradeVenue[];
  isLast?: boolean;
}) => {
  const theme = useTheme();

  return (
    <View
      className={`overflow-hidden border px-3.5 py-3 ${isLast ? "mb-0" : "mb-3"}`}
      style={{
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
        borderRadius: radius.card,
        ...continuousCorners,
      }}
    >
      <View className="flex-row items-start">
        <Text
          numberOfLines={3}
          className="min-w-0 flex-1 pr-3 text-[15px] font-semibold leading-5"
        >
          {market.question}
        </Text>
        {market.isResolved && <ResolvedBadge outcome={market.winningOutcome} />}
      </View>
      {market.isResolved ? null : market.isClosed ? (
        <View className="mt-3 flex-row items-center">
          <View
            className="mr-2 h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: theme.colors.text }}
          />
          <Text className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            <Trans>Trading closed</Trans>
          </Text>
        </View>
      ) : (
        <>
          <View className="mt-3 flex-row">
            <MarketOutcomePrice
              outcome="yes"
              probability={market.yesProbability}
            />
            <MarketOutcomePrice
              outcome="no"
              probability={market.noProbability}
            />
          </View>
          <MarketTradeButton
            marketName={market.question}
            venues={tradeVenues}
          />
        </>
      )}
    </View>
  );
};

const ResolvedBadge = ({
  outcome,
}: {
  outcome: PredictionMarketSnapshot["winningOutcome"];
}) => {
  const ui = useUi();
  const label =
    outcome === "yes"
      ? "YES"
      : outcome === "no"
        ? "NO"
        : outcome === "void"
          ? "VOID"
          : "RESOLVED";
  const color =
    outcome === "yes" ? ui.positive : outcome === "no" ? ui.negative : ui.text;
  const accessibilityLabel =
    outcome === "yes"
      ? "Resolved, YES won"
      : outcome === "no"
        ? "Resolved, NO won"
        : outcome === "void"
          ? "Resolved, market voided"
          : "Resolved, result unavailable";

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      className="ml-2 rounded-full px-2.5 py-1"
      style={{
        backgroundColor:
          outcome === "yes"
            ? ui.positiveSoft
            : outcome === "no"
              ? ui.negativeSoft
              : ui.primarySoft,
      }}
    >
      <Text className="text-[10px] font-bold tracking-wide" style={{ color }}>
        {label}
      </Text>
    </View>
  );
};

const MarketOutcomePrice = ({
  outcome,
  probability,
}: {
  outcome: "yes" | "no";
  probability: number | null;
}) => {
  const ui = useUi();
  const isYes = outcome === "yes";
  const label = isYes ? "YES" : "NO";
  const color = isYes ? ui.positive : ui.negative;
  const backgroundColor = isYes ? ui.positiveSoft : ui.negativeSoft;

  return (
    <View
      className={`min-h-14 flex-1 flex-row items-center justify-between px-4 ${isYes ? "mr-2" : ""}`}
      style={{
        backgroundColor,
        borderRadius: radius.control,
        ...continuousCorners,
      }}
    >
      <Text className="text-sm font-bold tracking-wide" style={{ color }}>
        {label}
      </Text>
      <Text className="text-lg font-bold" style={{ color }}>
        {probability === null ? "—" : `${formatProbability(probability)}%`}
      </Text>
    </View>
  );
};

const formatProbability = (probability: number) =>
  String(Math.round(probability));
