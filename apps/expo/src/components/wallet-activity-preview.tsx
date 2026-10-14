import {
  ActivityIndicator,
  Linking,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQuery } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import {
  continuousCorners,
  radius,
  SectionLabel,
  useUi,
} from "~/components/ui";
import { useAgent } from "~/lib/agent";
import { getAppChain } from "~/lib/web3";
import {
  listWalletActivity,
  walletActivityQueryKey,
  type WalletActivityEntry,
} from "~/lib/web3/activity";

export function WalletActivityPreview() {
  const agent = useAgent();
  const router = useRouter();
  const ui = useUi();
  const did = agent.session?.did;
  const activity = useQuery({
    queryKey: walletActivityQueryKey(did ?? ""),
    enabled: Boolean(did),
    queryFn: () => (did ? listWalletActivity(did) : []),
  });

  return (
    <View className="mt-2">
      <View className="mb-2 flex-row items-center justify-between">
        <SectionLabel>
          <Trans>Recent activity</Trans>
        </SectionLabel>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => router.push("/wallet-activity")}
        >
          <Text
            className="text-[13px] font-semibold"
            style={{ color: ui.primary }}
          >
            <Trans>View all</Trans>
          </Text>
        </TouchableOpacity>
      </View>
      {activity.isPending ? (
        <ActivityIndicator className="py-4" />
      ) : activity.data?.length ? (
        <View
          className="overflow-hidden"
          style={{
            backgroundColor: ui.card,
            borderColor: ui.border,
            borderWidth: 1,
            borderRadius: radius.card,
            ...continuousCorners,
          }}
        >
          {activity.data.slice(0, 5).map((item, index) => (
            <ActivityRow
              key={item.id}
              item={item}
              divider={index > 0}
              border={ui.border}
            />
          ))}
        </View>
      ) : (
        <Text className="py-3 text-[13px]" style={{ color: ui.muted }}>
          <Trans>Your sends and trades will appear here.</Trans>
        </Text>
      )}
    </View>
  );
}

export function ActivityRow({
  item,
  divider,
  border,
}: {
  item: WalletActivityEntry;
  divider: boolean;
  border: string;
}) {
  const { _ } = useLingui();
  const ui = useUi();
  return (
    <View
      className="px-4 py-3"
      style={
        divider ? { borderTopWidth: 1, borderTopColor: border } : undefined
      }
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-semibold" numberOfLines={1}>
          {item.title}
        </Text>
        <Text className="text-xs" style={{ color: ui.muted }}>
          {_(msg`${statusLabel(item.status, item.kind)}`)}
        </Text>
      </View>
      <Text
        className="mt-1 text-xs"
        style={{ color: ui.muted }}
        numberOfLines={2}
      >
        {item.detail}
      </Text>
      <Text className="mt-1 text-xs" style={{ color: ui.muted }}>
        {new Date(item.createdAt).toLocaleString()}
      </Text>
      {getTransactionUrl(item) ? (
        <TouchableOpacity
          accessibilityRole="link"
          onPress={() => {
            const url = getTransactionUrl(item);
            if (url) void Linking.openURL(url);
          }}
          className="mt-2 self-start"
        >
          <Text className="text-xs font-semibold" style={{ color: ui.primary }}>
            <Trans>View transaction</Trans>
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function statusLabel(
  status: WalletActivityEntry["status"],
  kind: WalletActivityEntry["kind"],
): string {
  switch (status) {
    case "pending":
      return kind === "trade" ? "Submitted" : "Pending";
    case "submitted":
      return "Submitted";
    case "confirmed":
      return "Confirmed";
    case "failed":
      return "Failed";
  }
}

function getTransactionUrl(item: WalletActivityEntry) {
  if (!item.transactionHash || item.chainId === undefined) return null;
  try {
    const explorer = getAppChain(item.chainId).chain.blockExplorers?.default
      .url;
    return explorer
      ? `${explorer.replace(/\/$/, "")}/tx/${item.transactionHash}`
      : null;
  } catch {
    return null;
  }
}
