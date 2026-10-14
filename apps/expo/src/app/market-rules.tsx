import { ScrollView, View } from "react-native";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";

import { Text } from "~/components/themed/text";

const RESOLUTION_STEPS = [
  {
    title: msg`A result is proposed`,
    description: msg`After trading ends, anyone can propose YES, NO, or Cancelled based on the market's published rules.`,
  },
  {
    title: msg`The result can be challenged`,
    description: msg`Before the deadline, someone else can challenge by proposing a different result. If nobody challenges, the proposal becomes final. If challenged, a group called the Oracle Council votes.`,
  },
  {
    title: msg`SPM holders may vote`,
    description: msg`The Council's result can be challenged before the next deadline. If it is, holders of the SPM token vote. If nobody challenges, the Council's result becomes final.`,
  },
  {
    title: msg`A final review may be requested`,
    description: msg`Before the final deadline, an eligible SPM holder can ask a designated review panel to vote. If no review is requested, the result at this stage becomes final.`,
  },
];

export default function MarketRules() {
  const { _ } = useLingui();

  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
    >
      <View className="mb-6 rounded-2xl bg-neutral-100 p-4 dark:bg-neutral-900">
        <Text className="text-base leading-6">
          <Trans>
            Markets are settled using the question and resolution rules shown on
            each market. These steps begin after trading ends.
          </Trans>
        </Text>
      </View>

      {RESOLUTION_STEPS.map((step, index) => (
        <View key={step.title.id} className="mb-6">
          <Text className="text-lg font-semibold">
            {index + 1}. {_(step.title)}
          </Text>
          <Text className="mt-2 text-base leading-6 text-neutral-600 dark:text-neutral-400">
            {_(step.description)}
          </Text>
        </View>
      ))}

      <View className="mb-6">
        <Text className="text-lg font-semibold">
          <Trans>Challenges and voting</Trans>
        </Text>
        <Text className="mt-2 text-base leading-6 text-neutral-600 dark:text-neutral-400">
          <Trans>
            Challenges and votes must happen before their deadlines. A vote
            needs enough participation and support; otherwise, an earlier
            proposed or decided result may stand. Bond amounts, deadlines, and
            voting requirements can vary.
          </Trans>
        </Text>
        <Text className="mt-3 text-base leading-6 text-neutral-600 dark:text-neutral-400">
          <Trans>
            Proposals and challenges require a deposit (bond) to back the
            choice. It is returned only if the final result matches that choice;
            otherwise, it is lost. Requesting a final review requires no
            deposit.
          </Trans>
        </Text>
      </View>

      <View className="mb-6">
        <Text className="text-lg font-semibold">
          <Trans>What the final result means</Trans>
        </Text>
        <Text className="mt-2 text-base leading-6 text-neutral-600 dark:text-neutral-400">
          <Trans>
            If the result is YES, each whole YES share pays one unit of the
            market’s payout currency and NO shares pay nothing; NO works the
            other way around. If a market is Cancelled, each YES and NO share
            pays half a unit. Cancelled is an outcome, not a refund of what you
            paid to trade.
          </Trans>
        </Text>
      </View>

      <View>
        <Text className="text-lg font-semibold">
          <Trans>If a market does not reach its funding goal</Trans>
        </Text>
        <Text className="mt-2 text-base leading-6 text-neutral-600 dark:text-neutral-400">
          <Trans>
            Contributors can reclaim their contributions after the funding
            deadline. This is separate from a market being Cancelled.
          </Trans>
        </Text>
      </View>
    </ScrollView>
  );
}
