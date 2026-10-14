import { useTheme } from "@react-navigation/native";

export function usePlainBackgroundColor() {
  const theme = useTheme();

  return theme.dark ? theme.colors.background : "#fff";
}
