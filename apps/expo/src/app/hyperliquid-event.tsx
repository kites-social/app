import { ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useIsFocused } from "@react-navigation/native";

import { HyperliquidEventEmbed } from "~/components/widgets/markets/prediction/hyperliquid-event";

export default function HyperliquidEventScreen() {
  const { _ } = useLingui();
  const isFocused = useIsFocused();
  const params = useLocalSearchParams<{
    questionId?: string | string[];
    outcomeId?: string | string[];
  }>();
  const questionId = firstParam(params.questionId);
  const outcomeId = firstParam(params.outcomeId);

  return (
    <>
      <Stack.Screen
        options={{ title: _(msg`Hyperliquid Prediction Market`) }}
      />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      >
        {questionId ? (
          <HyperliquidEventEmbed
            questionId={questionId}
            outcomeId={outcomeId || undefined}
            showAll
            enabled={isFocused}
          />
        ) : null}
      </ScrollView>
    </>
  );
}

function firstParam(value?: string | string[]) {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}
