import { type ReactNode } from "react";
import { View } from "react-native";

import { Text } from "./themed/text";
import { continuousCorners, radius, useUi } from "./ui/tokens";

interface Props {
  title: ReactNode;
  yesProbability?: number;
  noProbability?: number;
  compact?: boolean;
  children?: ReactNode;
}

export const YesNoProbability = ({
  title,
  yesProbability,
  noProbability,
  compact = false,
  children,
}: Props) => {
  const ui = useUi();
  const hasProbability =
    yesProbability !== undefined &&
    noProbability !== undefined &&
    Number.isFinite(yesProbability) &&
    Number.isFinite(noProbability);
  const yes = hasProbability ? clamp(Math.round(yesProbability)) : 0;
  const no = hasProbability ? clamp(Math.round(noProbability)) : 0;

  return (
    <View
      className={`${compact ? "mt-2 px-3 py-2.5" : "mb-4 p-4"} overflow-hidden`}
      style={{
        backgroundColor: ui.card,
        borderColor: ui.border,
        borderWidth: 1,
        borderRadius: compact ? radius.control : radius.card,
        ...continuousCorners,
      }}
    >
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="min-w-0 flex-1 text-sm font-medium" numberOfLines={2}>
          {title}
        </Text>
        {hasProbability ? (
          <View className="ml-3 flex-row items-center">
            <Text
              className="text-xs font-semibold"
              style={{ color: ui.positive }}
            >
              YES {formatPercent(yes)}%
            </Text>
            <Text className="mx-1 text-xs" style={{ color: ui.muted }}>
              /
            </Text>
            <Text
              className="text-xs font-semibold"
              style={{ color: ui.negative }}
            >
              NO {formatPercent(no)}%
            </Text>
          </View>
        ) : (
          <Text className="ml-3 text-xs" style={{ color: ui.muted }}>
            Unavailable
          </Text>
        )}
      </View>
      <View
        className="h-2 flex-row overflow-hidden rounded-full"
        style={{ backgroundColor: ui.inset }}
        accessibilityLabel={
          hasProbability
            ? `Current probability: ${formatPercent(yes)}% YES, ${formatPercent(no)}% NO`
            : "Probability unavailable"
        }
      >
        {hasProbability && (
          <>
            <View
              className="h-full"
              style={{ width: `${yes}%`, backgroundColor: ui.positive }}
            />
            <View
              className="h-full"
              style={{ width: `${no}%`, backgroundColor: ui.negative }}
            />
          </>
        )}
      </View>
      {children && (
        <View className="mt-3 border-t pt-3" style={{ borderColor: ui.border }}>
          {children}
        </View>
      )}
    </View>
  );
};

function clamp(value: number) {
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}
