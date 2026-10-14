import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import { Trans } from "@lingui/macro";
import { useTheme } from "@react-navigation/native";
import { RefreshCcwIcon } from "lucide-react-native";

import { Text } from "./themed/text";

interface Props<TError = unknown> {
  query: {
    error: TError | null;
    refetch: () => Promise<unknown>;
  };
}

export const QueryWithoutData = ({ query }: Props) => {
  const theme = useTheme();
  if (query.error) {
    return (
      <View className="flex-1 items-center justify-center">
        <View className="w-3/4 flex-col items-start">
          <Text className="mb-2 text-2xl font-medium">
            <Trans>An error occurred</Trans>
          </Text>
          {query.error instanceof Error && (
            <Text className="text-lg">{query.error.message}</Text>
          )}
          <TouchableOpacity
            className="mt-8 flex-row items-center rounded-full py-2 pl-4 pr-8"
            style={{ backgroundColor: theme.colors.primary }}
            onPress={() => void query.refetch()}
          >
            <RefreshCcwIcon size={20} className="text-white" />
            <Text className="ml-4 text-xl text-white">
              <Trans>Retry</Trans>
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator size="large" />
    </View>
  );
};
