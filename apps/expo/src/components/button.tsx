import React from "react";
import {
  ActivityIndicator,
  Text,
  TouchableHighlight,
  View,
  type TouchableHighlightProps,
} from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "@react-navigation/native";

import { cx } from "~/lib/utils/cx";

interface ButtonProps extends TouchableHighlightProps {
  variant?: "white" | "black" | "outline";
  className?: string;
  loading?: boolean;
}

export const Button = ({
  onPress,
  className,
  variant = "black",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) => {
  const theme = useTheme();
  return (
    <TouchableHighlight
      onPress={onPress}
      disabled={disabled || loading}
      className="rounded-xl"
      {...props}
    >
      <View
        className={cx(
          "w-full items-center justify-center rounded-xl px-4 py-3",
          {
            black: "bg-[#00A96B]",
            white: "bg-white",
            outline: "border border-[#00A96B]",
          }[variant],
          className,
        )}
        style={[
          { borderCurve: "continuous", minHeight: 44 },
          variant === "black"
            ? { backgroundColor: theme.colors.primary }
            : variant === "white"
              ? { backgroundColor: "#FFFFFF" }
              : { borderColor: theme.colors.primary },
        ]}
      >
        <View className="flex-row items-center justify-center">
          {loading ? (
            <ActivityIndicator
              size="small"
              color={variant === "black" ? "#FFFFFF" : theme.colors.primary}
              style={{ marginRight: 8 }}
            />
          ) : null}
          <Text
            className={cx(
              "text-base font-medium",
              {
                black: "text-white",
                white: "text-black",
                outline: "text-[#087B53] dark:text-[#8BE0B5]",
              }[variant],
              disabled && !loading && "opacity-50",
            )}
            style={
              variant === "black"
                ? undefined
                : {
                    color:
                      variant === "white" ? "#121916" : theme.colors.primary,
                  }
            }
          >
            {children}
          </Text>
        </View>
      </View>
    </TouchableHighlight>
  );
};

interface LinkProps extends Omit<ButtonProps, "onPress"> {
  href: string;
}

export const LinkButton = ({ href, ...props }: LinkProps) => {
  const router = useRouter();
  return (
    <Button
      onPress={() => router.push(href)}
      {...props}
      accessibilityRole="link"
    />
  );
};
