import { useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useTheme } from "@react-navigation/native";

import { Text } from "~/components/themed/text";
import {
  DEMO_TRADE_VENUE_NAMES,
  executeDemoTrade,
  type DemoTradeReceipt,
  type DemoTradeStage,
  type DemoTradeVenue,
} from "~/lib/venues/demo-trading";

type Outcome = "yes" | "no";
type Side = "buy" | "sell";

export function DemoTradeScreen({
  venue,
  marketType,
  marketId,
  title,
  initialOutcome = "yes",
}: {
  venue: DemoTradeVenue;
  marketType: "prediction" | "perpetual";
  marketId: string;
  title?: string;
  initialOutcome?: Outcome;
}) {
  const theme = useTheme();
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("10");
  const [leverage, setLeverage] = useState("1");
  const [stage, setStage] = useState<DemoTradeStage | "idle">("idle");
  const [receipt, setReceipt] = useState<DemoTradeReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage === "signing" || stage === "submitting";
  const amountIsValid =
    /^\d+(?:\.\d+)?$/.test(amount) &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0;
  const leverageIsValid =
    /^\d+$/.test(leverage) &&
    Number.isInteger(Number(leverage)) &&
    Number(leverage) >= 1 &&
    Number(leverage) <= 100;
  const canSubmit =
    amountIsValid && (marketType !== "perpetual" || leverageIsValid);

  const submit = async () => {
    if (!canSubmit || busy) return;
    setReceipt(null);
    setError(null);
    try {
      const result = await executeDemoTrade(
        {
          venue,
          marketType,
          marketId,
          side,
          amount,
          ...(marketType === "prediction" ? { outcome } : {}),
          ...(marketType === "perpetual"
            ? { orderType: "market" as const, leverage: Number(leverage) }
            : {}),
        },
        setStage,
      );
      setReceipt(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("idle");
    }
  };

  const primaryColor = theme.colors.primary;
  const neutralBackground = theme.dark
    ? "rgba(255, 255, 255, 0.07)"
    : "rgba(15, 23, 42, 0.06)";
  const titleText = title?.trim() || marketId;

  return (
    <KeyboardAwareScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View
        className="rounded-2xl border p-4"
        style={{
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
        }}
      >
        <Text className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
          {DEMO_TRADE_VENUE_NAMES[venue]} · {marketType}
        </Text>
        <Text className="mt-2 text-lg font-bold">{titleText}</Text>
        <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Market: {marketId}
        </Text>

        <View className="bg-amber-500/15 mt-4 rounded-xl p-3">
          <Text className="text-sm font-semibold">Demo only</Text>
          <Text className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
            Uses a Mera-shaped signing stub. No venue API or blockchain request
            is sent.
          </Text>
        </View>

        {marketType === "prediction" ? (
          <>
            <Text className="mb-2 mt-5 text-sm font-semibold">Outcome</Text>
            <View className="flex-row gap-2">
              <ChoiceButton
                label="Yes"
                selected={outcome === "yes"}
                onPress={() => setOutcome("yes")}
                background={neutralBackground}
                primary={primaryColor}
              />
              <ChoiceButton
                label="No"
                selected={outcome === "no"}
                onPress={() => setOutcome("no")}
                background={neutralBackground}
                primary={primaryColor}
              />
            </View>
          </>
        ) : null}

        <Text className="mb-2 mt-5 text-sm font-semibold">
          {marketType === "prediction" ? "Order side" : "Position"}
        </Text>
        <View className="flex-row gap-2">
          <ChoiceButton
            label={marketType === "perpetual" ? "Long" : "Buy"}
            selected={side === "buy"}
            onPress={() => setSide("buy")}
            background={neutralBackground}
            primary={primaryColor}
          />
          <ChoiceButton
            label={marketType === "perpetual" ? "Short" : "Sell"}
            selected={side === "sell"}
            onPress={() => setSide("sell")}
            background={neutralBackground}
            primary={primaryColor}
          />
        </View>

        <Text className="mb-2 mt-5 text-sm font-semibold">
          {marketType === "prediction" ? "Amount (USD)" : "Order size (USD)"}
        </Text>
        <TextInput
          accessibilityLabel="Trade amount"
          testID="demo-trade-amount"
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
          placeholder="10"
          placeholderTextColor={theme.dark ? "#9ca3af" : "#6b7280"}
          className="min-h-12 rounded-xl border px-3 text-base"
          style={{
            color: theme.colors.text,
            borderColor: theme.colors.border,
            backgroundColor: neutralBackground,
          }}
        />

        {marketType === "perpetual" ? (
          <>
            <Text className="mb-2 mt-4 text-sm font-semibold">Leverage</Text>
            <TextInput
              accessibilityLabel="Leverage"
              testID="demo-trade-leverage"
              keyboardType="number-pad"
              value={leverage}
              onChangeText={setLeverage}
              placeholder="1"
              placeholderTextColor={theme.dark ? "#9ca3af" : "#6b7280"}
              className="min-h-12 rounded-xl border px-3 text-base"
              style={{
                color: theme.colors.text,
                borderColor: theme.colors.border,
                backgroundColor: neutralBackground,
              }}
            />
          </>
        ) : null}

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Submit demo trade"
          testID="demo-trade-submit"
          disabled={!canSubmit || busy}
          onPress={() => void submit()}
          className="min-h-12 mt-5 items-center justify-center rounded-xl px-4"
          style={{
            backgroundColor: primaryColor,
            opacity: !canSubmit || busy ? 0.55 : 1,
          }}
        >
          <Text className="text-sm font-semibold text-white">
            {busy ? stageLabel(stage) : "Sign and simulate order"}
          </Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View
          accessibilityRole="alert"
          className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3"
        >
          <Text className="text-sm text-red-700 dark:text-red-300">
            {error}
          </Text>
        </View>
      ) : null}

      {receipt ? (
        <View
          accessibilityLabel="Demo trade confirmed"
          testID="demo-trade-receipt"
          className="mt-3 rounded-xl border border-green-500/40 bg-green-500/10 p-3"
        >
          <Text className="text-sm font-semibold text-green-800 dark:text-green-300">
            Demo order confirmed
          </Text>
          <Text selectable className="mt-2 text-xs">
            Order: {receipt.id}
          </Text>
          <Text selectable className="mt-1 text-xs">
            Fingerprint: {receipt.hash}
          </Text>
          <Text className="mt-1 text-xs">
            Mera-shaped signature: {receipt.signaturePreview}
          </Text>
        </View>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

function ChoiceButton({
  label,
  selected,
  onPress,
  background,
  primary,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  background: string;
  primary: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="min-h-11 flex-1 items-center justify-center rounded-xl border px-3"
      style={{
        backgroundColor: selected ? `${primary}1a` : background,
        borderColor: selected ? primary : "transparent",
      }}
    >
      <Text className="text-sm font-semibold">{label}</Text>
    </TouchableOpacity>
  );
}

function stageLabel(stage: DemoTradeStage | "idle") {
  switch (stage) {
    case "signing":
      return "Signing demo order…";
    case "submitting":
      return "Simulating venue submission…";
    case "confirmed":
      return "Demo order confirmed";
    default:
      return "Sign and simulate order";
  }
}
