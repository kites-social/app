import { Text as RNText, StyleSheet, type TextProps } from "react-native";
import { UITextView } from "react-native-uitextview";
import { useTheme } from "@react-navigation/native";

import { KitesColors } from "~/lib/theme";

export const Text = ({
  style,
  primary,
  secondary,
  ...props
}: TextProps & { primary?: boolean; secondary?: boolean }) => {
  const theme = useTheme();

  return (
    <RNText
      {...props}
      style={StyleSheet.compose(
        {
          color: primary
            ? theme.colors.primary
            : secondary
              ? theme.dark
                ? "#9BB0FF"
                : KitesColors.secondary
              : theme.colors.text,
          letterSpacing: -0.15,
        },
        style,
      )}
    />
  );
};
export const SelectableText = ({
  style,
  primary,
  secondary,
  selectable = true,
  uiTextView = true,
  ...props
}: TextProps & {
  primary?: boolean;
  secondary?: boolean;
  uiTextView?: boolean;
}) => {
  const theme = useTheme();

  return (
    <UITextView
      selectable={selectable}
      uiTextView={uiTextView}
      {...props}
      style={StyleSheet.compose(
        {
          color: primary
            ? theme.colors.primary
            : secondary
              ? theme.dark
                ? "#9BB0FF"
                : KitesColors.secondary
              : theme.colors.text,
          letterSpacing: -0.15,
        },
        style,
      )}
    />
  );
};
