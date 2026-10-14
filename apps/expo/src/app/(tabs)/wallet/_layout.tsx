import { Stack } from "expo-router";
import { useTheme } from "@react-navigation/native";

export default function WalletLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: false,
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.primary,
        headerTitleStyle: {
          color: theme.colors.text,
          fontWeight: "700",
        },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
