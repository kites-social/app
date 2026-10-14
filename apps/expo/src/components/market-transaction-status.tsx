import { ActivityIndicator, View } from "react-native";
import { Trans } from "@lingui/macro";

import { Text } from "~/components/themed/text";
import { Card, useUi } from "~/components/ui";

export const MarketTransactionStatus = ({
  checking,
  transactionHash,
}: {
  checking: boolean;
  transactionHash?: string;
}) => {
  const ui = useUi();

  return (
    <Card compact className="mb-0 mt-3">
      <View className="flex-row items-center">
        <ActivityIndicator size="small" color={ui.primary} />
        <View className="ml-3 min-w-0 flex-1">
          <Text className="text-sm font-semibold">
            <Trans>Transaction submitted</Trans>
          </Text>
          <Text className="mt-0.5 text-xs" style={{ color: ui.muted }}>
            {checking ? (
              <Trans>Checking for on-chain confirmation...</Trans>
            ) : (
              <Trans>
                Confirmation is pending. Check the transaction status.
              </Trans>
            )}
          </Text>
        </View>
      </View>
      {transactionHash ? (
        <Text
          selectable
          className="mt-2 text-[11px]"
          style={{ color: ui.muted }}
        >
          <Trans>Transaction</Trans>: {transactionHash}
        </Text>
      ) : null}
    </Card>
  );
};
