import { forwardRef } from "react";
import {
  TextInput as RNTextInput,
  StyleSheet,
  type TextInputProps,
} from "react-native";
import { useTheme } from "@react-navigation/native";

import { maskPasswordImmediately } from "~/lib/secure-password";

export type TextInput = RNTextInput;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(
  ({ onFocus, style, ...props }, ref) => {
    const theme = useTheme();

    return (
      <RNTextInput
        ref={ref}
        keyboardAppearance={theme.dark ? "dark" : "light"}
        placeholderTextColor={theme.dark ? "#9AA89F" : "#8A958E"}
        {...props}
        onFocus={(event) => {
          onFocus?.(event);
          if (props.secureTextEntry) {
            maskPasswordImmediately(event.nativeEvent.target);
          }
        }}
        style={StyleSheet.compose(
          {
            color: theme.colors.text,
            borderColor: theme.colors.border,
            borderRadius: 12,
            borderWidth: 1,
            backgroundColor: theme.colors.card,
            paddingHorizontal: 12,
            paddingVertical: 11,
          },
          style,
        )}
      />
    );
  },
);

TextInput.displayName = "TextInput";

// temporarily not pasteable
export const PasteableTextInput = forwardRef<TextInput, TextInputProps>(
  ({ style, ...props }, ref) => {
    const theme = useTheme();

    return (
      <RNTextInput
        ref={ref}
        keyboardAppearance={theme.dark ? "dark" : "light"}
        placeholderTextColor={theme.dark ? "#9AA89F" : "#8A958E"}
        {...props}
        style={StyleSheet.compose({ color: theme.colors.text }, style)}
      />
    );
  },
);

PasteableTextInput.displayName = "PasteableTextInput";
