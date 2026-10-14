import { useCallback } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import { ActivityRow } from "~/components/wallet-activity-preview";
import { useAgent } from "~/lib/agent";
import {
  listWalletActivity,
  refreshPendingWalletActivity,
  walletActivityQueryKey,
} from "~/lib/web3/activity";

export default function WalletActivityScreen() {
  const { _ } = useLingui();
  const agent = useAgent();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const did = agent.session?.did;
  const queryKey = walletActivityQueryKey(did ?? "");
  const activity = useQuery({
    queryKey,
    enabled: Boolean(did),
    queryFn: async () => {
      if (!did) return [];
      await refreshPendingWalletActivity(did);
      return listWalletActivity(did);
    },
  });

  useFocusEffect(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey });
    }, [queryClient, did]),
  );

  return (
    <View className="flex-1">
      <Stack.Screen options={{ title: _(msg`Activity`) }} />
      {activity.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      ) : activity.data?.length ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        >
          <View
            className="overflow-hidden rounded-2xl border"
            style={{
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            }}
          >
            {activity.data.map((item, index) => (
              <ActivityRow
                key={item.id}
                item={item}
                divider={index > 0}
                border={theme.colors.border}
              />
            ))}
          </View>
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>Your wallet activity will appear here.</Trans>
          </Text>
        </View>
      )}
    </View>
  );
}
