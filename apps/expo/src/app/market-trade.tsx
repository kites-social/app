import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { showToastable } from "react-native-toastable";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useIsFocused, useTheme } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react-native";
import {
  getAddress,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hash,
} from "viem";
import { monadTestnet, polygon } from "viem/chains";

import { DemoTradeScreen } from "~/components/demo-trade-screen";
import { DepositModal } from "~/components/deposit-modal";
import { MarketTransactionStatus } from "~/components/market-transaction-status";
import { OrderBookPanel } from "~/components/order-book-panel";
import { Text } from "~/components/themed/text";
import {
  ActionButton,
  SegmentedControl,
  TonePills,
  Notice as UiNotice,
} from "~/components/ui";
import { VenueFundingModal } from "~/components/venue-funding-modal";
import { YesNoProbability } from "~/components/yes-no-probability";
import { useAgent } from "~/lib/agent";
import { publishMarketActivity } from "~/lib/market-activity";
import { api } from "~/lib/utils/api";
import { sanitizeDecimalInput } from "~/lib/utils/decimal-input";
import { formatTokenAmount, formatUsdAmount } from "~/lib/utils/format-token";
import {
  DEMO_TRADING_ENABLED,
  type DemoTradeVenue,
} from "~/lib/venues/demo-trading";
import { getPolymarketTokenBalance } from "~/lib/venues/funding";
import {
  checkPolymarketTradingEligibility,
  getPolymarketOutcomeBalance,
  POLYMARKET_MINIMUM_SHARES_RAW,
  POLYMARKET_SHARE_DECIMALS,
  POLYMARKET_VENUE_ID,
  usePolymarketEvent,
  usePolymarketOrderBook,
  usePolymarketTrade,
  type OrderBook,
} from "~/lib/venues/prediction-markets/polymarket";
import {
  hasPolymarketTradingApprovals,
  syncPolymarketCollateralAllowance,
  syncPolymarketConditionalAllowance,
} from "~/lib/venues/prediction-markets/polymarket/onboarding";
import {
  addPendingPosition,
  capPosition,
  expectPositionChange,
  refreshWalletPositions,
} from "~/lib/wallet-positions";
import {
  COLLATERAL_TOKEN_DECIMALS,
  monadTestnetPublicClient,
  OUTCOME_TOKEN_DECIMALS,
  useErc20Balance,
  useMarketDetails,
  useMonBalance,
} from "~/lib/web3";
import {
  saveWalletActivity,
  walletActivityQueryKey,
  type WalletActivityStatus,
} from "~/lib/web3/activity";
import {
  approveTrade as approveTradeOnChain,
  executeTrade as executeTradeOnChain,
  useWallet,
} from "~/lib/web3/custody";
import {
  getCurrentYesProbabilityBps,
  getPoolSpotPrice,
  SPOT_PRICE_DECIMALS,
} from "~/lib/web3/market-pricing";

const slippageOptions = [
  { label: "1%", bps: 100 },
  { label: "3%", bps: 300 },
  { label: "5%", bps: 500 },
  { label: "10%", bps: 1_000 },
] as const;
const BPS_DENOMINATOR = BigInt(10_000);

type Outcome = "yes" | "no";
type Action = "buy" | "sell";
interface TradeIntent {
  marketAddress: Address;
  outcome: Outcome;
  action: Action;
  amount: string;
  slippageBps: number;
  quotedAmountOut: string;
  minAmountOut: string;
}

interface PendingTransaction {
  hash: Hash;
  kind: "approval-reset" | "approval" | "swap";
  intent: TradeIntent;
}

export default function MarketTradeScreen() {
  const { _ } = useLingui();
  const params = useLocalSearchParams<{
    provider?: string | string[];
    eventSlug?: string | string[];
    marketSlug?: string | string[];
    question?: string | string[];
    outcome?: string | string[];
  }>();
  const provider = firstParam(params.provider);
  const demoVenue = getDemoPredictionVenue(provider);

  if (provider === "hyperliquid-outcomes") {
    return (
      <>
        <Stack.Screen options={{ title: _(msg`Coming soon`) }} />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>Hyperliquid trading is coming soon.</Trans>
          </Text>
        </View>
      </>
    );
  }

  if (DEMO_TRADING_ENABLED && demoVenue) {
    const outcome =
      firstParam(params.outcome)?.toLowerCase() === "no" ? "no" : "yes";
    const eventSlug = firstParam(params.eventSlug) ?? "event";
    const marketSlug = firstParam(params.marketSlug) ?? "market";
    return (
      <>
        <Stack.Screen options={{ title: "Demo trade" }} />
        <DemoTradeScreen
          venue={demoVenue}
          marketType="prediction"
          marketId={`${eventSlug}/${marketSlug}`}
          title={firstParam(params.question)}
          initialOutcome={outcome}
        />
      </>
    );
  }

  return <MarketTradeContent />;
}

function MarketTradeContent() {
  const theme = useTheme();
  const isFocused = useIsFocused();
  const router = useRouter();
  const { _ } = useLingui();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    provider?: string | string[];
    eventSlug?: string | string[];
    marketSlug?: string | string[];
    question?: string | string[];
    yesProbability?: string | string[];
    noProbability?: string | string[];
    marketAddress?: string | string[];
    outcome?: string | string[];
    action?: string | string[];
    sourcePostUri?: string | string[];
    sourcePostCid?: string | string[];
  }>();
  const provider = firstParam(params.provider);
  const isPolymarket = provider === "polymarket";
  const eventSlug = firstParam(params.eventSlug);
  const marketSlug = firstParam(params.marketSlug);
  const polymarketEventState = usePolymarketEvent(
    eventSlug,
    isPolymarket && isFocused,
    marketSlug,
  );
  const polymarketTrade = usePolymarketTrade();
  const polymarketMarket = polymarketEventState.data?.markets.find(
    (item) => item.slug === marketSlug,
  );
  const polymarketQuestion =
    polymarketMarket?.question ?? firstParam(params.question);
  const polymarketYesProbability =
    polymarketMarket?.yesProbability ??
    parsePercentageParam(firstParam(params.yesProbability));
  const polymarketNoProbability =
    polymarketMarket?.noProbability ??
    parsePercentageParam(firstParam(params.noProbability));
  const addressParam = firstParam(params.marketAddress);
  const sourcePostUri = firstParam(params.sourcePostUri);
  const sourcePostCid = firstParam(params.sourcePostCid);
  const marketAddress =
    addressParam && isAddress(addressParam)
      ? getAddress(addressParam)
      : undefined;
  const [outcome, setOutcome] = useState<Outcome>(
    firstParam(params.outcome)?.toLowerCase() === "no" ? "no" : "yes",
  );
  const [action, setAction] = useState<Action>(
    firstParam(params.action)?.toLowerCase() === "sell" ? "sell" : "buy",
  );
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(500);
  const [customSlippageInput, setCustomSlippageInput] = useState("");
  const [slippageExpanded, setSlippageExpanded] = useState(false);
  const [pendingTransaction, setPendingTransaction] =
    useState<PendingTransaction | null>(null);
  const [pendingPolymarketOrderId, setPendingPolymarketOrderId] = useState<
    string | null
  >(null);
  const [fundingModalVisible, setFundingModalVisible] = useState(false);
  const [walletDepositModalVisible, setWalletDepositModalVisible] =
    useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const walletQuery = api.wallet.mine.useQuery();
  const account = walletQuery.data?.address;
  const detailsQuery = useMarketDetails(marketAddress, account ?? zeroAddress);
  const market = detailsQuery.data?.market;
  const inputDecimals =
    isPolymarket && action === "sell"
      ? 2
      : action === "buy"
        ? COLLATERAL_TOKEN_DECIMALS
        : OUTCOME_TOKEN_DECIMALS;
  const fractionalDigits = amount.split(".")[1]?.length ?? 0;
  const amountPrecisionIsValid = fractionalDigits <= inputDecimals;
  const collateralBalance = useErc20Balance(account, market?.collateral);
  const outcomeBalance = market
    ? outcome === "yes"
      ? market.accountYesBalance
      : market.accountNoBalance
    : undefined;
  const monBalance = useMonBalance(account);
  const selectedPool =
    outcome === "yes"
      ? detailsQuery.data?.pools.yesPool
      : detailsQuery.data?.pools.noPool;
  const yesSpotPrice =
    market && detailsQuery.data
      ? getPoolSpotPrice(detailsQuery.data.pools.yesPool)
      : undefined;
  const noSpotPrice =
    market && detailsQuery.data
      ? getPoolSpotPrice(detailsQuery.data.pools.noPool)
      : undefined;
  const yesProbabilityBps =
    detailsQuery.data !== undefined
      ? getCurrentYesProbabilityBps(
          detailsQuery.data.pools.yesPool,
          detailsQuery.data.pools.noPool,
        )
      : undefined;
  const noProbabilityBps =
    yesProbabilityBps === undefined
      ? undefined
      : BigInt(10_000) - yesProbabilityBps;
  const displayedYesProbability = isPolymarket
    ? polymarketYesProbability
    : yesProbabilityBps === undefined
      ? undefined
      : Number(yesProbabilityBps) / 100;
  const displayedNoProbability = isPolymarket
    ? polymarketNoProbability
    : noProbabilityBps === undefined
      ? undefined
      : Number(noProbabilityBps) / 100;
  const selectedPolymarketProbability =
    outcome === "yes" ? polymarketYesProbability : polymarketNoProbability;
  const selectedPolymarketPrice =
    selectedPolymarketProbability === undefined
      ? undefined
      : selectedPolymarketProbability / 100;
  const polymarketAmount = Number(amount);
  const polymarketExpectedOutput =
    !Number.isFinite(polymarketAmount) ||
    polymarketAmount <= 0 ||
    selectedPolymarketPrice === undefined ||
    selectedPolymarketPrice <= 0
      ? "—"
      : action === "buy"
        ? (polymarketAmount / selectedPolymarketPrice).toFixed(2)
        : (polymarketAmount * selectedPolymarketPrice).toFixed(2);
  const customSlippageBps = parseCustomSlippageBps(customSlippageInput);
  const wallet = useWallet();
  const agent = useAgent();
  const depositWalletAddress =
    walletQuery.data?.polymarketDepositWalletAddress ?? undefined;
  const polymarketTradingApprovals = useQuery({
    queryKey: ["polymarket-trading-approvals", depositWalletAddress],
    enabled: isPolymarket && Boolean(depositWalletAddress),
    staleTime: 0,
    queryFn: () => {
      if (!depositWalletAddress) {
        throw new Error("Set up the Polymarket deposit wallet first.");
      }
      return hasPolymarketTradingApprovals(depositWalletAddress);
    },
  });
  const polymarketEligibility = useQuery({
    queryKey: ["polymarket-trading-eligibility", action],
    enabled: isPolymarket,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: () => checkPolymarketTradingEligibility(action),
  });
  const polymarketBalance = useQuery({
    queryKey: ["wallet", "venue-balances", "polymarket", depositWalletAddress],
    enabled: isPolymarket && Boolean(depositWalletAddress),
    staleTime: 15_000,
    queryFn: () => {
      if (!depositWalletAddress) {
        throw new Error("Set up the Polymarket deposit wallet first.");
      }
      return getPolymarketTokenBalance(depositWalletAddress);
    },
  });
  const polymarketAssetId =
    outcome === "yes"
      ? polymarketMarket?.yesAssetId
      : polymarketMarket?.noAssetId;
  const polymarketOrderBook = usePolymarketOrderBook(
    polymarketAssetId,
    isPolymarket && isFocused,
  );
  const polymarketAllowanceSync = useQuery({
    queryKey: [
      "polymarket-trade-allowance-sync",
      depositWalletAddress,
      account,
      wallet.isUnlocked,
      action,
      action === "sell" ? polymarketAssetId : null,
      polymarketMarket?.positionSystem,
    ],
    enabled: Boolean(
      isPolymarket &&
      account &&
      wallet.isUnlocked &&
      depositWalletAddress &&
      polymarketTradingApprovals.data === true &&
      (action === "buy" || (polymarketAssetId && polymarketMarket)),
    ),
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!account) {
        throw new Error("Unlock your Kites wallet before trading.");
      }
      const session = wallet.requireSession();
      if (session.address.toLowerCase() !== account.toLowerCase()) {
        throw new Error("Unlock the wallet linked to your Polymarket account.");
      }
      const signTypedData = (
        request: Parameters<typeof session.account.signTypedData>[0],
      ) => session.account.signTypedData(request);
      if (action === "buy") {
        await syncPolymarketCollateralAllowance(account, signTypedData);
      } else {
        if (!polymarketAssetId || !polymarketMarket) {
          throw new Error("Load the Polymarket outcome before selling.");
        }
        await syncPolymarketConditionalAllowance(
          account,
          polymarketAssetId,
          polymarketMarket.positionSystem ?? "ctf",
          signTypedData,
        );
      }
      return true;
    },
  });
  const wasTradeScreenFocused = useRef(false);
  useEffect(() => {
    if (!isFocused) {
      wasTradeScreenFocused.current = false;
      return;
    }
    if (
      !isPolymarket ||
      !depositWalletAddress ||
      wasTradeScreenFocused.current
    ) {
      return;
    }
    wasTradeScreenFocused.current = true;
    void polymarketTradingApprovals.refetch().then(({ data }) => {
      if (
        data === true &&
        account &&
        (action === "buy" || (polymarketAssetId && polymarketMarket))
      ) {
        void polymarketAllowanceSync.refetch();
      }
    });
  }, [
    action,
    account,
    depositWalletAddress,
    isFocused,
    isPolymarket,
    polymarketAllowanceSync.refetch,
    polymarketAssetId,
    polymarketMarket,
    polymarketTradingApprovals.refetch,
  ]);
  const polymarketOutcomeBalance = useQuery({
    queryKey: [
      "wallet",
      "polymarket-outcome-balance",
      depositWalletAddress,
      polymarketAssetId,
      polymarketMarket?.positionSystem,
    ],
    enabled: Boolean(
      isPolymarket &&
      action === "sell" &&
      depositWalletAddress &&
      polymarketAssetId &&
      polymarketMarket,
    ),
    staleTime: 15_000,
    queryFn: () => {
      if (!depositWalletAddress || !polymarketAssetId || !polymarketMarket) {
        throw new Error("Load the Polymarket position before selling.");
      }
      return getPolymarketOutcomeBalance(
        depositWalletAddress,
        polymarketAssetId,
        polymarketMarket.positionSystem ?? "ctf",
      );
    },
  });

  const displayedInputBalance = isPolymarket
    ? action === "buy"
      ? polymarketBalance.data
      : polymarketOutcomeBalance.data
    : action === "buy"
      ? collateralBalance.data
      : outcomeBalance;
  const displayedBalanceDecimals =
    isPolymarket && action === "sell"
      ? POLYMARKET_SHARE_DECIMALS
      : inputDecimals;
  const maxAmountScale =
    BigInt(10) ** BigInt(displayedBalanceDecimals - inputDecimals);
  const maxAmountRaw =
    displayedInputBalance === undefined
      ? undefined
      : (displayedInputBalance / maxAmountScale) * maxAmountScale;
  const formattedInputBalance =
    maxAmountRaw !== undefined
      ? action === "buy"
        ? formatUsdAmount(maxAmountRaw, COLLATERAL_TOKEN_DECIMALS, {
            maxFractionDigits: Math.min(4, inputDecimals),
          })
        : formatTokenAmount(maxAmountRaw, displayedBalanceDecimals, {
            maxFractionDigits: Math.min(4, inputDecimals),
          })
      : "—";
  const amountRaw = parseTradeAmount(amount, inputDecimals);
  const reserveIn =
    action === "buy"
      ? selectedPool?.reserveCollateral
      : selectedPool?.reserveOutcome;
  const reserveOut =
    action === "buy"
      ? selectedPool?.reserveOutcome
      : selectedPool?.reserveCollateral;
  const estimatedAmountOut =
    amountRaw !== null &&
    reserveIn !== undefined &&
    reserveOut !== undefined &&
    selectedPool
      ? quoteExactInput(amountRaw, reserveIn, reserveOut, selectedPool.feeBps)
      : null;
  const minimumAmountOut =
    estimatedAmountOut !== null
      ? minimumAfterSlippage(estimatedAmountOut, slippageBps)
      : null;
  const outputDecimals =
    action === "buy" ? OUTCOME_TOKEN_DECIMALS : COLLATERAL_TOKEN_DECIMALS;
  const expectedOutput = isPolymarket
    ? polymarketExpectedOutput
    : estimatedAmountOut !== null && estimatedAmountOut > BigInt(0)
      ? action === "buy"
        ? formatTokenAmount(estimatedAmountOut, outputDecimals, {
            maxFractionDigits: 4,
          })
        : formatUsdAmount(estimatedAmountOut, outputDecimals, {
            maxFractionDigits: 4,
          })
      : "—";
  const enoughInputBalance =
    amountRaw !== null &&
    displayedInputBalance !== undefined &&
    displayedInputBalance >= amountRaw;
  const polymarketSellAmountRaw =
    action === "sell"
      ? parseTradeAmount(amount, POLYMARKET_SHARE_DECIMALS)
      : null;
  const polymarketEstimatedSharesRaw =
    action === "buy"
      ? estimatePolymarketBuyShares(amountRaw, selectedPolymarketProbability)
      : polymarketSellAmountRaw;
  const meetsPolymarketMinimum =
    polymarketEstimatedSharesRaw === null ||
    polymarketEstimatedSharesRaw >= POLYMARKET_MINIMUM_SHARES_RAW;
  const enoughPolymarketBalance =
    action === "buy"
      ? amountRaw !== null &&
        polymarketBalance.data !== undefined &&
        polymarketBalance.data >= amountRaw
      : polymarketSellAmountRaw !== null &&
        polymarketOutcomeBalance.data !== undefined &&
        polymarketOutcomeBalance.data >= polymarketSellAmountRaw;
  const hasGasBalance =
    monBalance.data !== undefined && monBalance.data > BigInt(0);
  const canSubmit = isPolymarket
    ? Boolean(
        account &&
        depositWalletAddress &&
        eventSlug &&
        marketSlug &&
        polymarketMarket &&
        !polymarketMarket.isClosed &&
        !polymarketMarket.isResolved &&
        (outcome === "yes"
          ? polymarketMarket.yesAssetId
          : polymarketMarket.noAssetId) &&
        amountRaw !== null &&
        amountRaw > BigInt(0) &&
        amountPrecisionIsValid &&
        meetsPolymarketMinimum &&
        enoughPolymarketBalance &&
        polymarketTradingApprovals.data === true &&
        !polymarketTradingApprovals.isFetching &&
        !polymarketTradingApprovals.isError &&
        polymarketEligibility.isSuccess &&
        polymarketOrderBook.data !== undefined &&
        !polymarketOrderBook.isError &&
        polymarketAllowanceSync.isSuccess &&
        !polymarketAllowanceSync.isFetching &&
        !pendingPolymarketOrderId &&
        !busy &&
        !wallet.isBusy,
      )
    : Boolean(
        account &&
        marketAddress &&
        market &&
        selectedPool &&
        !market.resolved &&
        estimatedAmountOut !== null &&
        estimatedAmountOut > BigInt(0) &&
        minimumAmountOut !== null &&
        amountPrecisionIsValid &&
        enoughInputBalance &&
        hasGasBalance &&
        !busy &&
        !wallet.isBusy &&
        !pendingTransaction,
      );
  const tradeControlsDisabled =
    busy || Boolean(pendingTransaction) || Boolean(pendingPolymarketOrderId);

  const inputTokenLabel = isPolymarket
    ? action === "buy"
      ? "pUSD"
      : `${outcome.toUpperCase()} shares`
    : action === "buy"
      ? "USDC"
      : `${outcome.toUpperCase()} tokens`;
  const outputTokenLabel = isPolymarket
    ? action === "buy"
      ? `${outcome.toUpperCase()} shares`
      : "pUSD"
    : action === "buy"
      ? `${outcome.toUpperCase()} tokens`
      : "USDC";
  const screenTitle =
    action === "buy" ? _(msg`Buy outcome`) : _(msg`Sell outcome`);

  const waitForTransaction = async (hash: Hash) =>
    monadTestnetPublicClient.waitForTransactionReceipt({
      hash,
      timeout: 120_000,
    });

  const refreshAfterTrade = () => {
    setPendingTransaction(null);
    setAmount("");
    showToastable({
      title: _(msg`Trade confirmed`),
      message: _(msg`Your trade is confirmed on-chain.`),
      status: "success",
    });
    router.back();
    void queryClient.invalidateQueries({ queryKey: ["web3"] });
    refreshWalletPositions(queryClient);
  };

  const notifyTradeError = (error: unknown) => {
    const message = userFacingTradeError(error);
    const needsSlippageAdjustment = /increase slippage/i.test(message);
    const stillProcessing = /still processing/i.test(message);
    showToastable({
      title: needsSlippageAdjustment
        ? _(msg`Price moved`)
        : _(msg`Trade not completed`),
      message,
      status: needsSlippageAdjustment || stillProcessing ? "warning" : "danger",
    });
  };

  const notifyPolymarketTradeError = (error: unknown) => {
    showToastable({
      title: _(msg`Polymarket order not submitted`),
      message:
        error instanceof Error
          ? error.message
          : _(msg`The Polymarket order could not be submitted.`),
      status: "danger",
    });
  };

  const beginBusyAction = async () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    return true;
  };

  const finishBusyAction = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const executeSwap = async (intent: TradeIntent) => {
    const custodial = await wallet.ensureUnlocked({
      existingAddress: account ?? null,
    });
    const result = await executeTradeOnChain(custodial.account, intent);
    saveTradeActivity(result.transactionHash, "trade", "pending", intent);
    setPendingTransaction({
      hash: result.transactionHash,
      kind: "swap",
      intent,
    });
    const receipt = await waitForTransaction(result.transactionHash);
    if (receipt.status !== "success") {
      saveTradeActivity(result.transactionHash, "trade", "failed", intent);
      setPendingTransaction(null);
      throw new Error(
        "The swap transaction failed. Refresh the quote and try again.",
      );
    }
    saveTradeActivity(result.transactionHash, "trade", "confirmed", intent);
    setPendingTransaction(null);
    await publishCompletedTradeActivity({
      side: intent.action,
      outcome: intent.outcome,
      marketType: "prediction",
      venue: "kites",
      marketId: intent.marketAddress,
      label: market?.question,
    });
    refreshAfterTrade();
  };

  const approveAndExecute = async (intent: TradeIntent) => {
    const custodial = await wallet.ensureUnlocked({
      existingAddress: account ?? null,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const approval = await approveTradeOnChain(custodial.account, intent);
      if (approval.stage === "ready") break;

      setPendingTransaction({
        hash: approval.transactionHash,
        kind: approval.stage === "reset" ? "approval-reset" : "approval",
        intent,
      });
      saveTradeActivity(
        approval.transactionHash,
        "approval",
        "pending",
        intent,
      );
      const receipt = await waitForTransaction(approval.transactionHash);
      if (receipt.status !== "success") {
        saveTradeActivity(
          approval.transactionHash,
          "approval",
          "failed",
          intent,
        );
        setPendingTransaction(null);
        throw new Error("Trade preparation failed. No swap was submitted.");
      }
      saveTradeActivity(
        approval.transactionHash,
        "approval",
        "confirmed",
        intent,
      );
      setPendingTransaction(null);
      if (approval.stage === "reset") continue;
      break;
    }

    await executeSwap(intent);
  };

  const checkPendingTransaction = async () => {
    const pending = pendingTransaction;
    if (!pending) return;
    if (!(await beginBusyAction())) return;
    try {
      const receipt = await waitForTransaction(pending.hash);
      if (receipt.status !== "success") {
        saveTradeActivity(
          pending.hash,
          pending.kind === "swap" ? "trade" : "approval",
          "failed",
          pending.intent,
        );
        setPendingTransaction(null);
        throw new Error("The trade transaction failed. No swap was confirmed.");
      }
      saveTradeActivity(
        pending.hash,
        pending.kind === "swap" ? "trade" : "approval",
        "confirmed",
        pending.intent,
      );
      setPendingTransaction(null);
      if (pending.kind === "swap") {
        await publishCompletedTradeActivity({
          side: pending.intent.action,
          outcome: pending.intent.outcome,
          marketType: "prediction",
          venue: "kites",
          marketId: pending.intent.marketAddress,
          label: market?.question,
        });
        refreshAfterTrade();
      } else if (pending.kind === "approval-reset") {
        await approveAndExecute(pending.intent);
      } else {
        await executeSwap(pending.intent);
      }
    } catch (error) {
      notifyTradeError(error);
    } finally {
      finishBusyAction();
    }
  };

  const submitTrade = async () => {
    if (pendingTransaction) {
      await checkPendingTransaction();
      return;
    }
    if (isPolymarket) {
      if (
        !eventSlug ||
        !marketSlug ||
        !account ||
        !depositWalletAddress ||
        !polymarketMarket ||
        !polymarketOrderBook.data ||
        !canSubmit
      ) {
        return;
      }
      if (!(await beginBusyAction())) return;
      try {
        const custodial = await wallet.ensureUnlocked({
          existingAddress: account,
        });
        const result = await polymarketTrade.executeTrade({
          account: custodial.account,
          signerAddress: custodial.address,
          depositWalletAddress,
          market: polymarketMarket,
          orderBook: polymarketOrderBook.data,
          outcome,
          action,
          amount,
          slippageBps,
        });
        const status = result.status.toLowerCase();
        const transactionHash = result.transactionHashes.find((hash) =>
          /^0x[\da-fA-F]{64}$/.test(hash),
        );
        const activityStatus: WalletActivityStatus = transactionHash
          ? "pending"
          : status === "unmatched"
            ? "failed"
            : "submitted";
        savePolymarketActivity(
          result.orderId,
          activityStatus,
          `${action === "buy" ? "Buy" : "Sell"} ${outcome.toUpperCase()} · ${amount} ${action === "buy" ? "pUSD" : "shares"}`,
          transactionHash,
        );
        if (result.tradeIds.length > 0) {
          await publishCompletedTradeActivity({
            side: action,
            outcome,
            marketType: "prediction",
            venue: POLYMARKET_VENUE_ID,
            marketId: marketSlug ?? eventSlug ?? "polymarket-market",
            label: polymarketQuestion,
          });
        }
        void queryClient.invalidateQueries({
          queryKey: [
            "wallet",
            "venue-balances",
            "polymarket",
            depositWalletAddress,
          ],
        });
        void queryClient.invalidateQueries({
          queryKey: [
            "wallet",
            "polymarket-outcome-balance",
            depositWalletAddress,
          ],
        });
        if (status === "matched" && polymarketAssetId) {
          const positionId = `polymarket-${polymarketAssetId}`;
          if (action === "sell") {
            if (
              polymarketOutcomeBalance.data !== undefined &&
              polymarketSellAmountRaw !== null
            ) {
              const remaining =
                polymarketOutcomeBalance.data > polymarketSellAmountRaw
                  ? polymarketOutcomeBalance.data - polymarketSellAmountRaw
                  : BigInt(0);
              capPosition(
                depositWalletAddress,
                positionId,
                Number(remaining) / 10 ** POLYMARKET_SHARE_DECIMALS,
              );
            }
          } else {
            addPendingPosition(depositWalletAddress, {
              id: positionId,
              market: `${polymarketQuestion ?? "Market position"} · ${outcome === "yes" ? "Yes" : "No"}`,
              side: "Open",
              size:
                polymarketEstimatedSharesRaw !== null
                  ? `~${formatTokenAmount(
                      polymarketEstimatedSharesRaw,
                      POLYMARKET_SHARE_DECIMALS,
                      { maxFractionDigits: 2 },
                    )}`
                  : "—",
              detail: "Syncing with Polymarket…",
              tradeTarget: {
                eventSlug,
                marketSlug,
                question: polymarketQuestion ?? "",
                outcome,
              },
            });
          }
        }
        if (status !== "unmatched") expectPositionChange();
        refreshWalletPositions(queryClient);
        if (status === "delayed") {
          setPendingPolymarketOrderId(result.orderId);
          return;
        }
        const unmatched = status === "unmatched";
        showToastable({
          title: unmatched
            ? _(msg`No liquidity matched your order`)
            : action === "sell"
              ? _(msg`Sell order filled`)
              : _(msg`Buy order filled`),
          message: unmatched
            ? `Order ID: ${result.orderId} · ${result.status}`
            : action === "sell"
              ? `Your ${outcome.toUpperCase()} shares were sold. Positions will update shortly.`
              : `Your ${outcome.toUpperCase()} position was opened. Positions will update shortly.`,
          status: unmatched ? "warning" : "success",
        });
        if (!unmatched) router.back();
      } catch (error) {
        notifyPolymarketTradeError(error);
      } finally {
        finishBusyAction();
      }
      return;
    }
    if (!marketAddress || !account || !canSubmit) return;

    if (!(await beginBusyAction())) return;
    try {
      if (
        estimatedAmountOut === null ||
        estimatedAmountOut <= BigInt(0) ||
        minimumAmountOut === null
      ) {
        throw new Error(
          "A valid estimate is unavailable. Adjust the amount and try again.",
        );
      }
      const intent: TradeIntent = {
        marketAddress,
        outcome,
        action,
        amount,
        slippageBps,
        quotedAmountOut: estimatedAmountOut.toString(),
        minAmountOut: minimumAmountOut.toString(),
      };
      await approveAndExecute(intent);
    } catch (error) {
      notifyTradeError(error);
    } finally {
      finishBusyAction();
    }
  };

  function saveTradeActivity(
    hash: Hash,
    kind: "trade" | "approval",
    status: WalletActivityStatus,
    intent: TradeIntent,
  ) {
    const did = agent.session?.did;
    if (!did) return;
    saveWalletActivity(did, {
      id: `evm:${monadTestnet.id}:${hash}`,
      kind,
      status,
      title:
        kind === "approval"
          ? "Token approval"
          : `${intent.action === "buy" ? "Buy" : "Sell"} ${intent.outcome.toUpperCase()} shares`,
      detail: `Market ${intent.marketAddress.slice(0, 8)}… · Monad Testnet`,
      chainId: monadTestnet.id,
      transactionHash: hash,
      venue: "Kites markets",
    });
    void queryClient.invalidateQueries({
      queryKey: walletActivityQueryKey(did),
    });
  }

  function savePolymarketActivity(
    orderId: string,
    status: WalletActivityStatus,
    title: string,
    transactionHash?: string,
  ) {
    const did = agent.session?.did;
    if (!did) return;
    saveWalletActivity(did, {
      id: `polymarket:${orderId}`,
      kind: "trade",
      status,
      title,
      detail: `${marketSlug ?? "Polymarket market"} · Order ${orderId}`,
      venue: "Polymarket",
      ...(transactionHash ? { chainId: polygon.id, transactionHash } : {}),
    });
    void queryClient.invalidateQueries({
      queryKey: walletActivityQueryKey(did),
    });
  }

  async function publishCompletedTradeActivity(input: {
    side: "buy" | "sell";
    outcome: "yes" | "no";
    marketType: "prediction";
    venue: string;
    marketId: string;
    label?: string;
  }) {
    if (!sourcePostUri || !sourcePostCid) return;
    try {
      await publishMarketActivity(agent, {
        subject: { uri: sourcePostUri, cid: sourcePostCid },
        market: {
          venue: input.venue,
          marketType: input.marketType,
          marketId: input.marketId,
          ...(input.label ? { label: input.label } : {}),
        },
        side: input.side,
        outcome: input.outcome,
      });
    } catch (error) {
      showToastable({
        title: _(msg`Trade completed; feed activity could not be published`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Try again later.`),
        status: "warning",
      });
    }
  }

  const setupWallet = async () => {
    if (!(await beginBusyAction())) return;
    try {
      const displayName = agent.session?.handle ?? "Kites wallet";
      await wallet.ensureUnlocked({
        existingAddress: walletQuery.data?.address ?? null,
        userName: displayName,
      });
      await walletQuery.refetch();
      showToastable({
        title: _(msg`Wallet ready`),
        message: _(msg`Your passkey wallet is linked to your Bluesky account.`),
        status: "success",
      });
    } catch (error) {
      notifyTradeError(error);
    } finally {
      finishBusyAction();
    }
  };

  const setMaxAmount = () => {
    if (maxAmountRaw === undefined || maxAmountRaw <= BigInt(0)) return;
    setAmount(
      formatTokenAmount(maxAmountRaw, displayedBalanceDecimals, {
        maxFractionDigits: inputDecimals,
        useGrouping: false,
      }),
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: screenTitle,
          headerTitleAlign: "left",
          headerTitle: () => (
            <Text className="ml-4 text-base font-semibold">{screenTitle}</Text>
          ),
          headerLeft: () => (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => router.back()}
            >
              <Text primary className="text-base font-medium">
                <Trans>Close</Trans>
              </Text>
            </TouchableOpacity>
          ),
          headerRight: () =>
            isPolymarket ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={_(msg`Refresh market data`)}
                disabled={polymarketEventState.isFetching || !eventSlug}
                onPress={() => {
                  void Promise.all([
                    polymarketEventState.refetch(),
                    polymarketOrderBook.refetch(),
                    polymarketTradingApprovals.refetch(),
                    polymarketEligibility.refetch(),
                  ]);
                }}
                hitSlop={8}
                className="rounded-full p-2"
              >
                {polymarketEventState.isFetching ? (
                  <ActivityIndicator size="small" color={theme.colors.text} />
                ) : (
                  <RefreshCw size={18} color={theme.colors.text} />
                )}
              </TouchableOpacity>
            ) : null,
        }}
      />
      <KeyboardAwareScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 32,
        }}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View
          className="mb-4 rounded-2xl border px-4 py-4"
          style={{
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
          }}
        >
          <Text className="text-base font-semibold" numberOfLines={3}>
            {isPolymarket
              ? (polymarketQuestion ?? _(msg`Market unavailable`))
              : (market?.question ??
                (detailsQuery.isPending
                  ? _(msg`Loading market…`)
                  : _(msg`Market unavailable`)))}
          </Text>
          <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {outcome === "yes" ? (
              <Trans>YES outcome</Trans>
            ) : (
              <Trans>NO outcome</Trans>
            )}
          </Text>
        </View>

        <YesNoProbability
          title={<Trans>Current probability</Trans>}
          yesProbability={displayedYesProbability}
          noProbability={displayedNoProbability}
        >
          <View className="flex-row items-center">
            <View className="flex-1">
              <Text className="text-xs font-semibold text-green-700 dark:text-green-400">
                {isPolymarket ? (
                  <Trans>YES price</Trans>
                ) : (
                  <Trans>YES token</Trans>
                )}
              </Text>
              <Text className="mt-0.5 text-sm font-semibold">
                {isPolymarket
                  ? formatProbabilityPrice(polymarketYesProbability)
                  : yesSpotPrice === undefined
                    ? _(msg`No liquidity`)
                    : formatUsdAmount(yesSpotPrice, SPOT_PRICE_DECIMALS, {
                        maxFractionDigits: 4,
                      })}
              </Text>
            </View>
            <View
              className="mx-4 h-8 w-px"
              style={{ backgroundColor: theme.colors.border }}
            />
            <View className="flex-1">
              <Text className="text-xs font-semibold text-red-700 dark:text-red-400">
                {isPolymarket ? (
                  <Trans>NO price</Trans>
                ) : (
                  <Trans>NO token</Trans>
                )}
              </Text>
              <Text className="mt-0.5 text-sm font-semibold">
                {isPolymarket
                  ? formatProbabilityPrice(polymarketNoProbability)
                  : noSpotPrice === undefined
                    ? _(msg`No liquidity`)
                    : formatUsdAmount(noSpotPrice, SPOT_PRICE_DECIMALS, {
                        maxFractionDigits: 4,
                      })}
              </Text>
            </View>
          </View>
        </YesNoProbability>

        <SegmentedControl
          value={action}
          disabled={tradeControlsDisabled}
          onChange={(item) => {
            setAction(item);
            setAmount("");
          }}
          options={[
            { value: "buy", label: <Trans>Buy</Trans> },
            { value: "sell", label: <Trans>Sell</Trans> },
          ]}
        />

        <TonePills
          value={outcome}
          disabled={tradeControlsDisabled}
          onChange={(item) => {
            setOutcome(item);
            setAmount("");
          }}
          options={[
            { value: "yes", label: <Trans>YES</Trans>, tone: "positive" },
            { value: "no", label: <Trans>NO</Trans>, tone: "negative" },
          ]}
        />

        {isPolymarket && polymarketMarket ? (
          <OrderBookPanel
            key={polymarketAssetId ?? outcome}
            title={
              outcome === "yes" ? (
                <Trans>YES order book</Trans>
              ) : (
                <Trans>NO order book</Trans>
              )
            }
            bids={formatPolymarketOrderBookLevels(
              polymarketOrderBook.displayBook?.bids ?? [],
            )}
            asks={formatPolymarketOrderBookLevels(
              polymarketOrderBook.displayBook?.asks ?? [],
            )}
            isLoading={
              Boolean(polymarketAssetId) &&
              polymarketOrderBook.isPending &&
              !polymarketOrderBook.displayBook
            }
            error={
              !polymarketAssetId
                ? _(msg`The selected outcome has no available order book.`)
                : (polymarketOrderBook.streamError?.message ??
                  (!polymarketOrderBook.displayBook
                    ? polymarketOrderBook.error?.message
                    : undefined))
            }
          />
        ) : null}

        <View
          className="mb-4 rounded-2xl border p-4"
          style={{
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
          }}
        >
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-sm font-medium">
              {isPolymarket ? (
                <Trans>Amount</Trans>
              ) : action === "buy" ? (
                <Trans>Pay with</Trans>
              ) : (
                <Trans>Sell</Trans>
              )}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={_(msg`Use maximum available balance`)}
              disabled={
                tradeControlsDisabled ||
                maxAmountRaw === undefined ||
                maxAmountRaw <= BigInt(0)
              }
              onPress={setMaxAmount}
            >
              <Text
                primary
                className={`text-xs font-semibold ${maxAmountRaw === undefined || maxAmountRaw <= BigInt(0) ? "opacity-50" : ""}`}
              >
                {inputTokenLabel} · {formattedInputBalance} <Trans>MAX</Trans>
              </Text>
            </TouchableOpacity>
          </View>
          <View className="flex-row items-center">
            <TextInput
              accessibilityLabel={_(msg`Trade amount`)}
              keyboardType="decimal-pad"
              value={amount}
              editable={!tradeControlsDisabled}
              onChangeText={(value) => setAmount(sanitizeDecimalInput(value))}
              placeholder="0.00"
              className="min-w-0 flex-1 py-1 text-2xl font-semibold text-black dark:text-white"
              placeholderTextColor={theme.dark ? "#737373" : "#a3a3a3"}
            />
            <Text className="ml-3 text-base font-semibold">
              {inputTokenLabel}
            </Text>
          </View>
          {amount.length > 0 && !amountPrecisionIsValid ? (
            <Text className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              <Trans>
                Use no more than {inputDecimals} decimal places for this token.
              </Trans>
            </Text>
          ) : null}
          {isPolymarket && polymarketEligibility.isError ? (
            <Notice tone="warning">
              {polymarketEligibility.error instanceof Error
                ? polymarketEligibility.error.message
                : _(msg`Polymarket trading is unavailable in your location.`)}
            </Notice>
          ) : null}
          {isPolymarket && action === "buy" ? (
            <View
              className="mt-3 flex-row items-center justify-between border-t pt-3"
              style={{ borderColor: theme.colors.border }}
            >
              <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                <Trans>Funds at Polymarket</Trans>
              </Text>
              <Text className="text-xs font-semibold">
                {polymarketBalance.data === undefined
                  ? polymarketBalance.isError
                    ? _(msg`Unavailable`)
                    : _(msg`Loading...`)
                  : formatUsdAmount(polymarketBalance.data, 6, {
                      maxFractionDigits: 4,
                    })}
              </Text>
            </View>
          ) : null}
          {isPolymarket && action === "sell" ? (
            <View
              className="mt-3 flex-row items-center justify-between border-t pt-3"
              style={{ borderColor: theme.colors.border }}
            >
              <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                <Trans>Your {outcome.toUpperCase()} shares</Trans>
              </Text>
              <Text className="text-xs font-semibold">
                {polymarketOutcomeBalance.data === undefined
                  ? polymarketOutcomeBalance.isError
                    ? _(msg`Unavailable`)
                    : _(msg`Loading...`)
                  : formatTokenAmount(
                      polymarketOutcomeBalance.data,
                      POLYMARKET_SHARE_DECIMALS,
                      { maxFractionDigits: 2 },
                    )}
              </Text>
            </View>
          ) : null}
          {isPolymarket ? (
            <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>
                Minimum order: 5 {outcome.toUpperCase()} shares. Buys are
                entered in pUSD. Market orders use available liquidity and
                cancel any unfilled amount.
              </Trans>
            </Text>
          ) : action === "buy" ? (
            <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>
                Buying requires USDC. Selling requires the selected outcome
                token.
              </Trans>
            </Text>
          ) : null}
        </View>

        {isPolymarket ? (
          <View className="mb-4 flex-row items-center justify-between">
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setFundingModalVisible(true)}
              className="rounded-full px-4 py-2"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <Text className="text-sm font-semibold text-white">
                <Trans>Fund this Polymarket wallet</Trans>
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/venue-onboarding/[venueId]",
                  params: { venueId: POLYMARKET_VENUE_ID },
                })
              }
              className="py-2"
            >
              <Text primary className="text-sm font-medium">
                <Trans>Manage setup</Trans>
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View
          className="mb-4 rounded-2xl border px-4 py-4"
          style={{
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
          }}
        >
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-sm font-medium">
              {isPolymarket ? (
                <Trans>Approx. at displayed price</Trans>
              ) : (
                <Trans>Estimated to receive</Trans>
              )}
            </Text>
            <Text className="text-base font-bold">
              {expectedOutput} {outputTokenLabel}
            </Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ expanded: slippageExpanded }}
            disabled={tradeControlsDisabled}
            onPress={() => setSlippageExpanded((expanded) => !expanded)}
            className="mt-3 flex-row items-center justify-between border-t pt-3"
            style={{ borderColor: theme.colors.border }}
          >
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              <Trans>Trade settings</Trans>
            </Text>
            {slippageExpanded ? (
              <ChevronUp size={16} color={theme.colors.text} />
            ) : (
              <ChevronDown size={16} color={theme.colors.text} />
            )}
          </TouchableOpacity>
          {slippageExpanded ? (
            <>
              <View className="mt-3 flex-row items-center justify-between">
                <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                  <Trans>Slippage tolerance</Trans>
                </Text>
                <Text className="text-xs font-semibold">
                  {formatBpsAsPercent(BigInt(slippageBps))}%
                </Text>
              </View>
              <View className="mt-3 flex-row">
                {slippageOptions.map((option) => (
                  <TouchableOpacity
                    key={option.bps}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: slippageBps === option.bps,
                    }}
                    disabled={tradeControlsDisabled}
                    onPress={() => {
                      setSlippageBps(option.bps);
                      setCustomSlippageInput("");
                    }}
                    className={`mr-2 rounded-full border px-3 py-1.5 ${busy || pendingTransaction ? "opacity-50" : ""}`}
                    style={{
                      borderColor: theme.colors.border,
                      backgroundColor:
                        slippageBps === option.bps
                          ? theme.colors.primary
                          : "transparent",
                    }}
                  >
                    <Text
                      className="text-xs font-semibold"
                      style={{
                        color:
                          slippageBps === option.bps
                            ? "white"
                            : theme.colors.text,
                      }}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View className="mt-3 flex-row items-center">
                <View
                  className="min-w-0 flex-1 flex-row items-center rounded-xl border px-3"
                  style={{ borderColor: theme.colors.border }}
                >
                  <TextInput
                    accessibilityLabel={_(msg`Custom slippage percentage`)}
                    keyboardType="decimal-pad"
                    maxLength={6}
                    value={customSlippageInput}
                    editable={!tradeControlsDisabled}
                    onChangeText={(value) =>
                      setCustomSlippageInput(sanitizeDecimalInput(value, 2))
                    }
                    placeholder="Custom"
                    className="min-w-0 flex-1 py-2 text-sm text-black dark:text-white"
                    placeholderTextColor={theme.dark ? "#737373" : "#a3a3a3"}
                  />
                  <Text className="ml-2 text-sm text-neutral-500 dark:text-neutral-400">
                    %
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={customSlippageBps === null || tradeControlsDisabled}
                  onPress={() => {
                    if (customSlippageBps !== null) {
                      setSlippageBps(customSlippageBps);
                      setSlippageExpanded(false);
                    }
                  }}
                  className="ml-2 rounded-full px-4 py-2"
                  style={{
                    backgroundColor:
                      customSlippageBps === null
                        ? theme.colors.border
                        : theme.colors.primary,
                  }}
                >
                  <Text
                    className="text-xs font-semibold"
                    style={{
                      color:
                        customSlippageBps === null
                          ? theme.colors.text
                          : "white",
                    }}
                  >
                    <Trans>Apply</Trans>
                  </Text>
                </TouchableOpacity>
              </View>
              <Text className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                <Trans>
                  Enter a value from 0.01% to 100%, with up to 2 decimal places.
                </Trans>
              </Text>
              {slippageBps === 10_000 ? (
                <Text className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  {isPolymarket ? (
                    <Trans>
                      At 100%, the most permissive price limit is used.
                    </Trans>
                  ) : (
                    <Trans>
                      At 100%, minimum-output protection is disabled.
                    </Trans>
                  )}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>

        {!isPolymarket && (
          <View
            className="mb-4 rounded-xl border px-4 py-3"
            style={{
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            }}
          >
            {action === "sell" ? (
              <View className="mb-2 flex-row items-center justify-between">
                <Text className="text-sm">
                  <Trans>Your USDC balance</Trans>
                </Text>
                <Text className="text-sm font-semibold">
                  {collateralBalance.data === undefined
                    ? "—"
                    : formatUsdAmount(collateralBalance.data, 6, {
                        maxFractionDigits: 4,
                      })}
                </Text>
              </View>
            ) : null}
            <View className="flex-row items-center justify-between">
              <Text className="text-sm">
                <Trans>MON Balance</Trans>
              </Text>
              <Text className="text-sm font-semibold">
                {monBalance.data === undefined
                  ? "—"
                  : `${formatTokenAmount(monBalance.data, 18, { maxFractionDigits: 4 })} MON`}
              </Text>
            </View>
          </View>
        )}

        {!isPolymarket && !account && !walletQuery.isPending ? (
          <View
            className="mb-4 rounded-2xl border px-4 py-4"
            style={{
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            }}
          >
            <Text className="text-sm">
              <Trans>
                Create a passkey wallet to trade. Your private key is derived
                from the passkey on this device and never leaves it; only the
                public address is linked to your account.
              </Trans>
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy || wallet.isBusy}
              onPress={() => void setupWallet()}
              className="mt-3 items-center rounded-xl py-3"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <Text className="font-semibold text-white">
                {wallet.isBusy || busy ? (
                  <Trans>Creating wallet...</Trans>
                ) : (
                  <Trans>Create passkey wallet</Trans>
                )}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {!isPolymarket && detailsQuery.isError ? (
          <Notice tone="warning">
            <Trans>
              Market data could not be loaded. Close and reopen the trade sheet.
            </Trans>
          </Notice>
        ) : null}
        {isPolymarket && polymarketTradingApprovals.isError ? (
          <Notice tone="warning">
            <Trans>
              Polymarket trading approvals could not be verified. Try again
              before trading.
            </Trans>
          </Notice>
        ) : null}
        {isPolymarket && polymarketTradingApprovals.data === false ? (
          <>
            <Notice tone="warning">
              <Trans>
                Polymarket trading approvals are missing. Finish account setup
                before trading.
              </Trans>
            </Notice>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/venue-onboarding/[venueId]",
                  params: { venueId: POLYMARKET_VENUE_ID },
                })
              }
              className="mb-3 items-center rounded-xl py-3"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <Text className="font-semibold text-white">
                <Trans>Finish Polymarket setup</Trans>
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
        {isPolymarket &&
        polymarketTradingApprovals.data === true &&
        polymarketAllowanceSync.isFetching ? (
          <Notice tone="warning">
            <Trans>Refreshing Polymarket trading balance...</Trans>
          </Notice>
        ) : null}
        {isPolymarket &&
        polymarketTradingApprovals.data === true &&
        polymarketAllowanceSync.isError ? (
          <>
            <Notice tone="warning">
              {polymarketAllowanceSync.error instanceof Error
                ? polymarketAllowanceSync.error.message
                : _(msg`Polymarket account data could not be refreshed.`)}
            </Notice>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void polymarketAllowanceSync.refetch()}
              className="mb-3 items-center rounded-xl py-3"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <Text className="font-semibold text-white">
                <Trans>Retry Polymarket refresh</Trans>
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
        {!isPolymarket &&
        amountRaw !== null &&
        displayedInputBalance !== undefined &&
        displayedInputBalance < amountRaw ? (
          <Notice tone="warning">
            {action === "buy" ? (
              <Trans>Your USDC balance is too low for this trade.</Trans>
            ) : (
              <Trans>
                Your {outcome.toUpperCase()} balance is too low for this trade.
              </Trans>
            )}
          </Notice>
        ) : null}
        {isPolymarket &&
        amountRaw !== null &&
        amountRaw > BigInt(0) &&
        polymarketEstimatedSharesRaw !== null &&
        polymarketEstimatedSharesRaw < POLYMARKET_MINIMUM_SHARES_RAW ? (
          <Notice tone="warning">
            {action === "buy" ? (
              <Trans>
                This amount is estimated to buy fewer than 5{" "}
                {outcome.toUpperCase()} shares. Increase the pUSD amount to
                continue.
              </Trans>
            ) : (
              <Trans>
                Enter at least 5 {outcome.toUpperCase()} shares to trade.
              </Trans>
            )}
          </Notice>
        ) : null}
        {isPolymarket &&
        action === "buy" &&
        amountRaw !== null &&
        polymarketBalance.data !== undefined &&
        polymarketBalance.data < amountRaw ? (
          <Notice tone="warning">
            <Trans>
              Your Polymarket balance is too low for this order. Fund this trade
              from your Kites wallet first.
            </Trans>
          </Notice>
        ) : null}
        {isPolymarket &&
        action === "sell" &&
        polymarketSellAmountRaw !== null &&
        polymarketOutcomeBalance.data !== undefined &&
        polymarketOutcomeBalance.data < polymarketSellAmountRaw ? (
          <Notice tone="warning">
            <Trans>
              Your Polymarket {outcome.toUpperCase()} position is too small for
              this order.
            </Trans>
          </Notice>
        ) : null}
        {!isPolymarket &&
        account &&
        monBalance.data !== undefined &&
        !hasGasBalance ? (
          <Notice tone="warning">
            <Trans>You need MON in your wallet to pay transaction gas.</Trans>
          </Notice>
        ) : null}

        {pendingTransaction ? (
          <MarketTransactionStatus
            checking={busy}
            transactionHash={pendingTransaction.hash}
          />
        ) : null}
        {pendingPolymarketOrderId ? (
          <Notice tone="warning">
            <Trans>
              This order is still processing. Check Polymarket before trading
              again. Order ID: {pendingPolymarketOrderId}
            </Trans>
          </Notice>
        ) : null}

        <ActionButton
          className="mt-3"
          tone={outcome === "yes" ? "positive" : "negative"}
          loading={busy}
          disabled={(!canSubmit && !pendingTransaction) || busy}
          onPress={() => void submitTrade()}
          label={
            busy ? (
              pendingTransaction ? (
                <Trans>Checking transaction...</Trans>
              ) : (
                <Trans>Submitting trade...</Trans>
              )
            ) : pendingTransaction ? (
              <Trans>Check trade status</Trans>
            ) : pendingPolymarketOrderId ? (
              <Trans>Order processing</Trans>
            ) : isPolymarket ? (
              action === "buy" ? (
                <Trans>Buy {outcome.toUpperCase()}</Trans>
              ) : (
                <Trans>Sell {outcome.toUpperCase()}</Trans>
              )
            ) : action === "buy" ? (
              <Trans>Buy {outcome.toUpperCase()}</Trans>
            ) : (
              <Trans>Sell {outcome.toUpperCase()}</Trans>
            )
          }
        />
        <Text className="mt-3 text-center text-xs text-neutral-500 dark:text-neutral-400">
          {isPolymarket ? (
            <Trans>
              Your order is signed by your passkey and sent to Polymarket.
              Execution is subject to your slippage setting and available
              liquidity.
            </Trans>
          ) : (
            <Trans>
              The estimate uses current pool reserves. The final amount may
              change with market activity, within your slippage tolerance.
            </Trans>
          )}
        </Text>
      </KeyboardAwareScrollView>
      <VenueFundingModal
        visible={fundingModalVisible}
        sourceAddress={account}
        destinationAddress={depositWalletAddress}
        onClose={() => {
          setFundingModalVisible(false);
          void queryClient.invalidateQueries({
            queryKey: ["polymarket-trade-allowance-sync", depositWalletAddress],
          });
        }}
        onSetup={() => {
          setFundingModalVisible(false);
          router.push({
            pathname: "/venue-onboarding/[venueId]",
            params: { venueId: POLYMARKET_VENUE_ID },
          });
        }}
        onDepositToWallet={() => {
          setFundingModalVisible(false);
          setWalletDepositModalVisible(true);
        }}
      />
      <DepositModal
        visible={walletDepositModalVisible}
        walletAddress={account}
        onClose={() => setWalletDepositModalVisible(false)}
        onSetup={() => {
          setWalletDepositModalVisible(false);
          void setupWallet();
        }}
      />
    </>
  );
}

const Notice = ({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warning" | "success";
}) => (
  <UiNotice tone={tone === "success" ? "positive" : "warning"}>
    {children}
  </UiNotice>
);

const formatBpsAsPercent = (basisPoints: bigint) => {
  const whole = (basisPoints / BigInt(100)).toString();
  const fraction = (basisPoints % BigInt(100))
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
};

const userFacingTradeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (/quote|slippage|price impact|minimum output/i.test(message)) {
    return "The market price moved beyond your slippage setting. Try increasing slippage or retrying.";
  }
  if (/timed out|timeout/i.test(message)) {
    return "The trade is still processing. Check its status before retrying.";
  }
  if (/approval|allowance|approve/i.test(message)) {
    return "Trade preparation failed. No swap was submitted; please try again.";
  }
  if (/balance/i.test(message)) {
    return "Your balance changed and is too low for this trade.";
  }
  if (/gas|MON/i.test(message)) {
    return "Your wallet needs MON to pay transaction fees.";
  }
  return "The trade could not be completed. Please try again.";
};

const quoteExactInput = (
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
) => {
  if (
    amountIn <= BigInt(0) ||
    reserveIn <= BigInt(0) ||
    reserveOut <= BigInt(0) ||
    feeBps < BigInt(0) ||
    feeBps >= BPS_DENOMINATOR
  ) {
    return BigInt(0);
  }

  const amountInWithFee = amountIn * (BPS_DENOMINATOR - feeBps);
  return (
    (amountInWithFee * reserveOut) /
    (reserveIn * BPS_DENOMINATOR + amountInWithFee)
  );
};

const minimumAfterSlippage = (amountOut: bigint, slippageBps: number) =>
  (amountOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;

const parseCustomSlippageBps = (value: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;

  try {
    const basisPoints = parseUnits(value, 2);
    return basisPoints >= BigInt(1) && basisPoints <= BigInt(10_000)
      ? Number(basisPoints)
      : null;
  } catch {
    return null;
  }
};

const parseTradeAmount = (value: string, decimals: number) => {
  if (!value || !/^(?:\d+)(?:\.\d+)?$/.test(value)) return null;
  try {
    return parseUnits(value, decimals);
  } catch {
    return null;
  }
};

const estimatePolymarketBuyShares = (
  amountRaw: bigint | null,
  probabilityPercent: number | undefined,
) => {
  if (
    amountRaw === null ||
    probabilityPercent === undefined ||
    !Number.isFinite(probabilityPercent) ||
    probabilityPercent <= 0 ||
    probabilityPercent > 100
  ) {
    return null;
  }

  const marketPriceRaw = Math.round(probabilityPercent * 10_000);
  if (marketPriceRaw <= 0) return null;
  return (amountRaw * BigInt(1_000_000)) / BigInt(marketPriceRaw);
};

const formatPolymarketOrderBookLevels = (levels: OrderBook["bids"]) =>
  levels.map(({ price, size }) => ({
    price: formatUsdAmount(price, POLYMARKET_SHARE_DECIMALS, {
      maxFractionDigits: 4,
    }),
    size: formatTokenAmount(size, POLYMARKET_SHARE_DECIMALS, {
      maxFractionDigits: 4,
    }),
    priceKey: price.toString(),
    priceValue: Number(price) / 10 ** POLYMARKET_SHARE_DECIMALS,
    sizeKey: size.toString(),
    sizeValue: Number(size) / 10 ** POLYMARKET_SHARE_DECIMALS,
  }));

const firstParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const getDemoPredictionVenue = (
  provider?: string,
): DemoTradeVenue | undefined => {
  if (provider === "hyperliquid-outcomes") return "hyperliquid-outcomes";
  return undefined;
};

const parsePercentageParam = (value?: string) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : undefined;
};

const formatProbabilityPrice = (probability?: number) =>
  probability === undefined ? "—" : `$${(probability / 100).toFixed(2)}`;
