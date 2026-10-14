import { View } from "react-native";
import { useTheme } from "@react-navigation/native";

export const NotificationItem = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const theme = useTheme();
  return (
    <View
      className="flex-row border-b px-4 py-4"
      style={{
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.background,
      }}
    >
      <View className="flex-1">{children}</View>
    </View>
  );
};
