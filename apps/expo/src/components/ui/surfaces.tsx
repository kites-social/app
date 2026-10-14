import { type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi, type Tone } from "./tokens";

/** Standard elevated surface used for every panel in the app. */
export const Card = ({
  children,
  compact = false,
  className,
  style,
}: {
  children: ReactNode;
  compact?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
}) => {
  const ui = useUi();

  return (
    <View
      className={`mb-4 ${compact ? "px-4 py-3" : "p-4"} ${className ?? ""}`}
      style={[
        {
          backgroundColor: ui.card,
          borderColor: ui.border,
          borderWidth: 1,
          borderRadius: radius.card,
          ...continuousCorners,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
};

/** Small uppercase caption used above groups of content. */
export const SectionLabel = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => {
  const ui = useUi();

  return (
    <Text
      className={`text-[11px] font-semibold uppercase tracking-wider ${className ?? ""}`}
      style={{ color: ui.muted }}
    >
      {children}
    </Text>
  );
};

export const Divider = ({ className }: { className?: string }) => {
  const ui = useUi();

  return (
    <View
      className={className ?? "my-3"}
      style={{ height: 1, backgroundColor: ui.border }}
    />
  );
};

/** Label/value row for summaries and reviews. */
export const StatRow = ({
  label,
  value,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  className?: string;
}) => {
  const ui = useUi();

  return (
    <View
      className={`flex-row items-center justify-between ${className ?? "py-1"}`}
    >
      <Text className="mr-3 text-[13px]" style={{ color: ui.muted }}>
        {label}
      </Text>
      <Text
        className="min-w-0 shrink text-right text-[13px] font-semibold"
        style={tone ? { color: ui.toneColor(tone) } : undefined}
      >
        {value}
      </Text>
    </View>
  );
};

/** Inline message with a soft tinted background. */
export const Notice = ({
  children,
  tone = "warning",
  className,
}: {
  children: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  className?: string;
}) => {
  const ui = useUi();

  return (
    <View
      className={`mb-3 flex-row rounded-xl px-3.5 py-3 ${className ?? ""}`}
      style={{
        backgroundColor: ui.toneSoft(tone),
        borderColor: ui.toneSoft(tone),
        ...continuousCorners,
      }}
    >
      <Text
        className="min-w-0 flex-1 text-[13px] leading-5"
        style={{ color: ui.toneColor(tone) }}
      >
        {children}
      </Text>
    </View>
  );
};
