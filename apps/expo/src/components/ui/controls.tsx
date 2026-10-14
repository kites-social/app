import { type ReactNode } from "react";
import {
  ActivityIndicator,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi, type Tone } from "./tokens";

/** Full-width call-to-action. `tone` colors it (e.g. long/short, yes/no). */
export const ActionButton = ({
  label,
  onPress,
  disabled = false,
  loading = false,
  tone = "primary",
  variant = "solid",
  size = "lg",
  accessibilityState,
  className,
  style,
}: {
  label: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: Tone;
  variant?: "solid" | "outline" | "soft";
  size?: "md" | "lg";
  accessibilityState?: { disabled?: boolean; busy?: boolean };
  className?: string;
  style?: StyleProp<ViewStyle>;
}) => {
  const ui = useUi();
  const toneColor = ui.toneColor(tone);
  const inactive = disabled || loading;
  const solid = variant === "solid";
  const solidColor =
    tone === "positive"
      ? "#16a34a"
      : tone === "negative"
        ? "#dc2626"
        : toneColor;
  const background = solid
    ? disabled && !loading
      ? ui.border
      : solidColor
    : variant === "soft"
      ? ui.toneSoft(tone)
      : "transparent";
  const foreground = solid ? "white" : toneColor;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={accessibilityState ?? { disabled, busy: loading }}
      activeOpacity={0.8}
      disabled={inactive}
      onPress={onPress}
      className={`items-center justify-center px-5 ${size === "lg" ? "min-h-[52px]" : "min-h-11"} ${className ?? ""}`}
      style={[
        {
          backgroundColor: background,
          borderRadius: radius.control,
          borderWidth: variant === "outline" ? 1 : 0,
          borderColor: variant === "outline" ? ui.border : "transparent",
          opacity: disabled && !solid ? 0.5 : 1,
          ...continuousCorners,
        },
        style,
      ]}
    >
      <View className="flex-row items-center">
        {loading ? (
          <ActivityIndicator
            size="small"
            color={solid ? "white" : toneColor}
            style={{ marginRight: 10 }}
          />
        ) : null}
        <Text
          className="text-[15px] font-semibold"
          style={{
            color: foreground,
            opacity: solid && disabled && !loading ? 0.6 : 1,
          }}
        >
          {label}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

/** Pill-shaped secondary button for inline actions. */
export const PillButton = ({
  label,
  onPress,
  disabled = false,
  tone = "primary",
  variant = "solid",
}: {
  label: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  tone?: Tone;
  variant?: "solid" | "soft";
}) => {
  const ui = useUi();
  const solid = variant === "solid";

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      activeOpacity={0.8}
      disabled={disabled}
      onPress={onPress}
      className="min-h-10 items-center justify-center rounded-full px-4"
      style={{
        backgroundColor: solid ? ui.toneColor(tone) : ui.toneSoft(tone),
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        className="text-[13px] font-semibold"
        style={{ color: solid ? "white" : ui.toneColor(tone) }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
};

/** Neutral two-or-more option track (e.g. Buy / Sell). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const ui = useUi();

  return (
    <View
      className="mb-4 flex-row p-1"
      style={{
        backgroundColor: ui.inset,
        borderRadius: radius.control + 2,
        ...continuousCorners,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            activeOpacity={0.8}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            className="min-h-10 flex-1 items-center justify-center"
            style={{
              borderRadius: radius.control - 2,
              backgroundColor: selected ? ui.card : "transparent",
              borderWidth: selected ? 1 : 0,
              borderColor: ui.border,
              opacity: disabled ? 0.5 : 1,
              ...continuousCorners,
            }}
          >
            <Text
              className="text-sm font-semibold"
              style={{ color: selected ? ui.text : ui.muted }}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Side-by-side colored choices (Yes/No, Long/Short). */
export function TonePills<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  prominentSelected = false,
}: {
  options: { value: T; label: ReactNode; tone: Tone; detail?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  prominentSelected?: boolean;
}) {
  const ui = useUi();

  return (
    <View className="mb-4 flex-row">
      {options.map((option, index) => {
        const selected = option.value === value;
        const color = ui.toneColor(option.tone);
        return (
          <TouchableOpacity
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            activeOpacity={0.8}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            className={`min-h-[52px] flex-1 items-center justify-center ${index > 0 ? "ml-2" : ""}`}
            style={{
              borderRadius: radius.control,
              borderWidth: selected && prominentSelected ? 2 : 1.5,
              borderColor: selected ? color : ui.border,
              backgroundColor: selected
                ? prominentSelected
                  ? color
                  : ui.toneSoft(option.tone)
                : ui.card,
              opacity: disabled ? 0.5 : 1,
              ...continuousCorners,
            }}
          >
            <Text
              className="text-[15px] font-bold tracking-wide"
              style={{
                color: selected
                  ? prominentSelected
                    ? ui.card
                    : color
                  : ui.muted,
              }}
            >
              {option.label}
            </Text>
            {option.detail ? (
              <Text
                className="mt-0.5 text-[11px] font-medium"
                style={{
                  color: selected
                    ? prominentSelected
                      ? ui.card
                      : color
                    : ui.muted,
                }}
              >
                {option.detail}
              </Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Recessed input well used for amounts and numeric fields. */
export const InputWell = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => {
  const ui = useUi();

  return (
    <View
      className={`flex-row items-center px-4 ${className ?? ""}`}
      style={{
        backgroundColor: ui.inset,
        borderColor: ui.border,
        borderWidth: 1,
        borderRadius: radius.input,
        ...continuousCorners,
      }}
    >
      {children}
    </View>
  );
};
