import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import { Trans } from "@lingui/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { OrderBookPanel } from "~/components/order-book-panel";
import { Text } from "~/components/themed/text";
import { showWalletStatusToast } from "~/components/toastable/toastable";
import {
  ActionButton,
  Card,
  InputWell,
  Notice,
  SectionLabel,
  StatRow,
  TonePills,
  useUi,
} from "~/components/ui";
import { useAgent } from "~/lib/agent";
import { publishMarketActivity } from "~/lib/market-activity";
import { api } from "~/lib/utils/api";
import { fetchPerplOpenPositions } from "~/lib/venues/perpetual-markets/perpl/account";
import { logPerplTrade } from "~/lib/venues/perpetual-markets/perpl/logging";
import {
  subscribeToOrderBook,
  type PerplOrderBookSnapshot,
} from "~/lib/venues/perpetual-markets/perpl/market-data";
import {
  fetchPerplOrderBook,
  fetchPerplTradeAccount,
  fetchPerplTradeMarket,
  getPerplOrderFailureMessage,
  placePerplMarketOrder,
  waitForPerplOrderResult,
} from "~/lib/venues/perpetual-markets/perpl/trading";
import {
  expectPositionChange,
  refreshWalletPositions,
} from "~/lib/wallet-positions";
import {
  saveWalletActivity,
  walletActivityQueryKey,
  type WalletActivityStatus,
} from "~/lib/web3/activity";
import { useWallet } from "~/lib/web3/custody";

type Side = "long" | "short";

interface StreamedOrderBook {
  marketId: number;
  book: PerplOrderBookSnapshot;
}

export function PerplTradeScreen({
  symbol,
  sourcePostUri,
  sourcePostCid,
}: {
  symbol: string;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) {
  const ui = useUi();
  const router = useRouter();
  const agent = useAgent();
  const wallet = useWallet();
  const walletQuery = api.wallet.mine.useQuery();
  const queryClient = useQueryClient();
  const normalizedSymbol = symbol
    .trim()
    .toUpperCase()
    .replace(/-PERP$/, "");
  const [side, setSide] = useState<Side>("long");
  const [amount, setAmount] = useState("10");
  const [leverage, setLeverage] = useState("1");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderBookStreamError, setOrderBookStreamError] =
    useState<Error | null>(null);
  const marketQuery = useQuery({
    queryKey: [
      "venues",
      "perpetual",
      "perpl",
      "trade-market",
      normalizedSymbol,
    ],
    queryFn: () => fetchPerplTradeMarket(normalizedSymbol),
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: Boolean(normalizedSymbol),
  });
  const address = walletQuery.data?.address;
  const accountQuery = useQuery({
    queryKey: ["venues", "perpetual", "perpl", "trade-account", address],
    queryFn: () => fetchPerplTradeAccount(address!),
    enabled: Boolean(address),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const market = marketQuery.data;
  const marketId = market?.id;
  const priceDecimals = market?.priceDecimals;
  const sizeDecimals = market?.sizeDecimals;
  const orderBookQueryKey = [
    "venues",
    "perpetual",
    "perpl",
    "trade-order-book",
    marketId,
  ] as const;
  const latestStreamBook = useRef<StreamedOrderBook | undefined>(undefined);
  const [streamBook, setStreamBook] = useState<StreamedOrderBook>();
  const orderBookQuery = useQuery({
    queryKey: orderBookQueryKey,
    queryFn: async () => {
      if (!market) {
        throw new Error("Load a Perpl market before its order book.");
      }
      const orderBook = await fetchPerplOrderBook(market);
      const latestBook = latestStreamBook.current;
      return latestBook?.marketId === market.id ? latestBook.book : orderBook;
    },
    enabled: Boolean(market),
    staleTime: 0,
    refetchInterval: market ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    latestStreamBook.current = undefined;
    setStreamBook(undefined);
    setOrderBookStreamError(null);
    if (
      marketId === undefined ||
      priceDecimals === undefined ||
      sizeDecimals === undefined
    ) {
      return;
    }
    return subscribeToOrderBook(
      {
        id: marketId,
        symbol: normalizedSymbol,
        priceDecimals,
        sizeDecimals,
      },
      (book) => {
        const streamedBook = { marketId, book };
        latestStreamBook.current = streamedBook;
        setStreamBook(streamedBook);
        setOrderBookStreamError(null);
        queryClient.setQueryData<PerplOrderBookSnapshot>(
          ["venues", "perpetual", "perpl", "trade-order-book", marketId],
          book,
        );
      },
      (cause) => {
        latestStreamBook.current = undefined;
        setStreamBook(undefined);
        setOrderBookStreamError(cause);
      },
    );
  }, [marketId, normalizedSymbol, priceDecimals, queryClient, sizeDecimals]);
  const displayOrderBook =
    marketId !== undefined && streamBook?.marketId === marketId
      ? streamBook.book
      : orderBookQuery.data;
  const accounts = accountQuery.data ?? [];
  const account =
    accounts.find(
      (candidate) => !candidate.frozen && candidate.allowsForwarding,
    ) ?? accounts.find((candidate) => !candidate.frozen);
  const parsedAmount = Number(amount);
  const parsedLeverage = Number(leverage);
  const validAmount =
    /^\d+(?:\.\d{1,2})?$/.test(amount) &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0;
  const validLeverage =
    /^\d+$/.test(leverage) &&
    Number.isInteger(parsedLeverage) &&
    parsedLeverage >= 1 &&
    parsedLeverage <= (market?.maxLeverage ?? 1);
  const collateralRequired = useMemo(
    () => (validAmount && validLeverage ? parsedAmount / parsedLeverage : 0),
    [parsedAmount, parsedLeverage, validAmount, validLeverage],
  );
  const fundingReady = Boolean(
    account &&
    !account.frozen &&
    account.allowsForwarding &&
    account.availableBalance >= collateralRequired,
  );
  const submitOrder = async () => {
    if (
      !market ||
      !account ||
      !address ||
      !validAmount ||
      !validLeverage ||
      busy
    )
      return;
    setBusy(true);
    setError(null);
    const flowContext = {
      marketSymbol: normalizedSymbol,
      marketId: market.id,
      side,
      notionalUsd: parsedAmount,
      leverage: parsedLeverage,
    };
    let stage = "wallet_unlock";
    logPerplTrade("order_flow_started", flowContext);
    try {
      const session = await wallet.ensureUnlocked({
        existingAddress: address,
        userName: agent.session?.handle ?? "Kites wallet",
      });
      if (session.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Unlock the wallet linked to your Bluesky account.");
      }
      stage = "order_submission";
      const result = await placePerplMarketOrder({
        walletAddress: session.address,
        market,
        account,
        side,
        notionalUsd: parsedAmount,
        leverage: parsedLeverage,
      });
      const did = agent.session?.did;
      const activityTitle = `Perpl ${side} · ${normalizedSymbol}`;
      const activityDetail = `$${parsedAmount} target notional · ${parsedLeverage}× · testnet`;
      const saveOrderActivity = (
        requestId: number,
        status: WalletActivityStatus,
        detail: string,
      ) => {
        if (!did) return;
        saveWalletActivity(did, {
          id: `venue:perpl:${requestId}`,
          kind: "trade",
          status,
          title: activityTitle,
          detail,
          venue: "Perpl",
        });
        void queryClient.invalidateQueries({
          queryKey: walletActivityQueryKey(did),
        });
      };
      let currentRequestId = result.requestId;
      saveOrderActivity(result.requestId, "submitted", activityDetail);
      const refreshPerplPositions = () =>
        refreshWalletPositions(queryClient, [
          ["venues", "perpetual", "perpl", "trade-account"],
          ["venues", "perpetual", "perpl", "account"],
          ["venues", "perpetual", "perpl", "positions"],
        ]);
      showWalletStatusToast({
        title: "Order placed",
        message: `Your ${side} ${normalizedSymbol} order was sent to Perpl.`,
        status: "success",
      });
      void waitForPerplOrderResult({
        walletAddress: session.address,
        requestId: result.requestId,
        positionsReflectOrder: (open) =>
          open.some((position) => position.requestId === currentRequestId),
        retryOnRequestIdTooLow: async () => {
          const refreshedAccounts = await fetchPerplTradeAccount(
            session.address,
          );
          const refreshedAccount = refreshedAccounts.find(
            (candidate) => candidate.id === account.id,
          );
          if (!refreshedAccount) {
            throw new Error(
              "The Perpl account could not be refreshed to retry the order.",
            );
          }
          saveOrderActivity(
            currentRequestId,
            "failed",
            "Perpl rejected the stale request ID; retrying with a fresh one.",
          );
          const retry = await placePerplMarketOrder({
            walletAddress: session.address,
            market,
            account: refreshedAccount,
            side,
            notionalUsd: parsedAmount,
            leverage: parsedLeverage,
          });
          currentRequestId = retry.requestId;
          saveOrderActivity(retry.requestId, "submitted", activityDetail);
          return retry;
        },
      })
        .then((confirmation) => {
          refreshPerplPositions();
          const confirmedRequestId =
            confirmation?.requestId ?? currentRequestId;
          if (!confirmation) {
            const message =
              "Perpl has not confirmed whether the order filled. Check your positions before retrying.";
            saveOrderActivity(confirmedRequestId, "submitted", message);
            showWalletStatusToast({
              title: "Order status pending",
              message,
              status: "warning",
            });
            return;
          }
          const outcome =
            confirmation.source === "order" ? confirmation.outcome : undefined;
          const filledSize = outcome?.filledSizeScaled ?? 0;
          const filled =
            confirmation.source === "positions" ||
            filledSize > 0 ||
            outcome?.orderStatusName === "Filled" ||
            outcome?.orderStatusName === "PartiallyFilled" ||
            outcome?.orderStatusName === "Executed" ||
            outcome?.statusReasonName === "ImmediateOrCancelExecuted" ||
            outcome?.statusReasonName === "TakerOrderFilled";
          if (!filled) {
            const message = getPerplOrderFailureMessage(
              outcome,
              "Perpl did not fill the order.",
            );
            saveOrderActivity(confirmedRequestId, "failed", message);
            showWalletStatusToast({
              title: "Order not filled",
              message,
              status: "danger",
            });
            return;
          }
          const positionOpened = confirmation.source === "positions";
          const partiallyFilled =
            !positionOpened &&
            (outcome?.orderStatusName === "PartiallyFilled" ||
              (outcome?.requestedSizeScaled !== undefined &&
                outcome.filledSizeScaled !== undefined &&
                outcome.filledSizeScaled < outcome.requestedSizeScaled));
          const message = positionOpened
            ? `Perpl confirmed an open ${side} ${normalizedSymbol} position. Check your positions for the filled amount.`
            : partiallyFilled
              ? `Perpl partially filled your ${side} ${normalizedSymbol} order. Check your positions for the filled amount.`
              : `Your ${side} ${normalizedSymbol} order was filled.`;
          saveOrderActivity(confirmedRequestId, "confirmed", message);
          if (
            sourcePostUri &&
            sourcePostCid &&
            did &&
            agent.session?.did === did
          ) {
            void publishMarketActivity(agent, {
              subject: { uri: sourcePostUri, cid: sourcePostCid },
              market: {
                venue: "perpl",
                marketType: "perpetual",
                marketId: normalizedSymbol,
                label: `${normalizedSymbol}-PERP`,
              },
              side,
            }).catch((cause: unknown) => {
              showWalletStatusToast({
                title: "Trade completed; feed activity could not be published",
                message:
                  cause instanceof Error ? cause.message : "Try again later.",
                status: "warning",
              });
            });
          }
          if (!partiallyFilled) return;
          showWalletStatusToast({
            title: "Order partially filled",
            message,
            status: "warning",
          });
        })
        .catch((cause: unknown) => {
          const message =
            cause instanceof Error
              ? cause.message
              : "Perpl could not confirm the order result.";
          logPerplTrade("order_confirmation_failed", {
            ...flowContext,
            requestId: currentRequestId,
            error: message,
          });
          saveOrderActivity(currentRequestId, "failed", message);
          refreshPerplPositions();
          showWalletStatusToast({
            title: "Order confirmation failed",
            message,
            status: "danger",
          });
        });
      void queryClient.invalidateQueries({
        queryKey: ["wallet", "venue-balances"],
      });
      expectPositionChange();
      refreshPerplPositions();
      logPerplTrade("post_order_positions_refresh_started", {
        ...flowContext,
        requestId: result.requestId,
      });
      void fetchPerplOpenPositions(session.address)
        .then((positions) => {
          logPerplTrade("post_order_positions_refresh_completed", {
            ...flowContext,
            requestId: result.requestId,
            positionCount: positions.length,
            matchingMarketPositionCount: positions.filter(
              (position) => position.marketId === market.id,
            ).length,
            matchingRequestIdPositionCount: positions.filter(
              (position) => position.requestId === result.requestId,
            ).length,
          });
        })
        .catch((cause: unknown) => {
          logPerplTrade("post_order_positions_refresh_failed", {
            ...flowContext,
            requestId: result.requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
      setReviewing(false);
      router.back();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "The Perpl order could not be submitted.";
      logPerplTrade("order_flow_failed", {
        ...flowContext,
        stage,
        error: message,
      });
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const openSetup = () =>
    router.push({
      pathname: "/venue-onboarding/[venueId]",
      params: { venueId: "perpl" },
    });

  const controlsDisabled =
    busy ||
    !validAmount ||
    !validLeverage ||
    !market?.isOpen ||
    !account ||
    !fundingReady;
  return (
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
      <Card>
        <SectionLabel>Perpl · Monad testnet perpetual</SectionLabel>
        <Text className="mt-2 text-xl font-bold">{normalizedSymbol}-PERP</Text>
        <Text className="mt-1 text-xs leading-5" style={{ color: ui.muted }}>
          Perpl collateral and positions stay at Perpl, separate from your Kites
          wallet.
        </Text>
      </Card>

      {marketQuery.isPending ? (
        <Card className="items-center py-5">
          <ActivityIndicator color={ui.primary} />
          <Text className="mt-2 text-sm" style={{ color: ui.muted }}>
            Loading market data…
          </Text>
        </Card>
      ) : marketQuery.isError ? (
        <Notice tone="negative">{marketQuery.error.message}</Notice>
      ) : market ? (
        <Card>
          <SectionLabel>Mark price</SectionLabel>
          <Text
            className="mt-1 text-3xl font-bold"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {formatUsd(market.price)}
          </Text>
          <Text className="mt-2 text-xs" style={{ color: ui.muted }}>
            IOC market order · up to {formatPercent(market.maxSlippageBps)}{" "}
            slippage
          </Text>
        </Card>
      ) : null}

      {market ? (
        <OrderBookPanel
          key={market.id}
          title={<Trans>Order book</Trans>}
          bids={(displayOrderBook?.bids ?? []).map((level) => ({
            price: formatPerplBookPrice(level.price, market.priceDecimals),
            size: formatPerplBookSize(level.size, market.sizeDecimals),
            ...(level.orders === undefined
              ? {}
              : {
                  orders: formatPerplBookSize(level.orders, 0),
                  ordersKey: String(level.orders),
                  ordersValue: level.orders,
                }),
            priceKey: level.price.toString(),
            priceValue: level.price,
            sizeKey: level.size.toString(),
            sizeValue: level.size,
          }))}
          asks={(displayOrderBook?.asks ?? []).map((level) => ({
            price: formatPerplBookPrice(level.price, market.priceDecimals),
            size: formatPerplBookSize(level.size, market.sizeDecimals),
            ...(level.orders === undefined
              ? {}
              : {
                  orders: formatPerplBookSize(level.orders, 0),
                  ordersKey: String(level.orders),
                  ordersValue: level.orders,
                }),
            priceKey: level.price.toString(),
            priceValue: level.price,
            sizeKey: level.size.toString(),
            sizeValue: level.size,
          }))}
          isLoading={!displayOrderBook && orderBookQuery.isPending}
          error={
            orderBookStreamError?.message ??
            (!displayOrderBook ? orderBookQuery.error?.message : undefined)
          }
        />
      ) : null}

      <TonePills<Side>
        value={side}
        prominentSelected
        onChange={(next) => {
          setSide(next);
          setReviewing(false);
        }}
        options={[
          { value: "long", label: "Long", tone: "positive" },
          { value: "short", label: "Short", tone: "negative" },
        ]}
      />

      <Card>
        <Text className="mb-2 text-sm font-medium">
          Target order size · USD notional
        </Text>
        <InputWell>
          <TextInput
            accessibilityLabel="Order size in US dollars"
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={(value) => {
              setAmount(value);
              setReviewing(false);
            }}
            placeholder="10"
            placeholderTextColor={ui.placeholder}
            className="min-h-14 min-w-0 flex-1 text-2xl font-semibold"
            style={{ color: ui.text }}
          />
          <Text
            className="ml-3 text-sm font-semibold"
            style={{ color: ui.muted }}
          >
            USD
          </Text>
        </InputWell>
        <View
          className="mt-4 flex-row items-center justify-between border-t pt-3"
          style={{ borderColor: ui.border }}
        >
          <Text className="text-sm font-medium">Leverage</Text>
          <InputWell className="px-3">
            <TextInput
              accessibilityLabel="Leverage"
              keyboardType="number-pad"
              value={leverage}
              onChangeText={(value) => {
                setLeverage(value);
                setReviewing(false);
              }}
              placeholder="1"
              placeholderTextColor={ui.placeholder}
              className="min-h-11 min-w-8 py-1 text-right text-base font-semibold"
              style={{ color: ui.text }}
            />
            <Text className="ml-1 text-sm font-semibold">×</Text>
          </InputWell>
        </View>
        <Text className="mt-3 text-xs" style={{ color: ui.muted }}>
          Estimated collateral · {formatUsd(collateralRequired)} AUSD
        </Text>
      </Card>

      {address && accountQuery.isPending ? (
        <Card compact className="flex-row items-center">
          <ActivityIndicator color={ui.primary} />
          <Text className="ml-3 text-sm" style={{ color: ui.muted }}>
            Loading Perpl account…
          </Text>
        </Card>
      ) : accountQuery.isError || !address || accounts.length === 0 ? (
        <Card>
          <Text className="text-sm font-semibold">Set up Perpl testnet</Text>
          <Text className="mt-1 text-xs leading-5" style={{ color: ui.muted }}>
            Create the Perpl exchange account and add its test collateral. Use
            the linked Kites address on Perpl, then enable one-click order
            forwarding only if you accept its persistent permission.
          </Text>
          <ActionButton
            className="mt-3"
            size="md"
            label="Set up Perpl"
            onPress={openSetup}
          />
        </Card>
      ) : account && !account.allowsForwarding ? (
        <Card>
          <Text className="text-sm font-semibold">Order forwarding is off</Text>
          <Text className="mt-1 text-xs leading-5" style={{ color: ui.muted }}>
            Perpl requires a persistent one-click trading permission before this
            app can place orders. Review and enable it on Perpl.
          </Text>
          <ActionButton
            className="mt-3"
            size="md"
            label="Review Perpl permissions"
            onPress={openSetup}
          />
        </Card>
      ) : account ? (
        <Card compact>
          <StatRow
            label="Available Perpl collateral"
            value={`${formatUsd(account.availableBalance)} AUSD`}
          />
          {account.availableBalance < collateralRequired ? (
            <ActionButton
              className="mt-3"
              size="md"
              variant="outline"
              label="Add collateral on Perpl"
              onPress={openSetup}
            />
          ) : null}
        </Card>
      ) : null}

      {reviewing && market && account ? (
        <Card>
          <Text className="mb-2 text-base font-semibold">Review order</Text>
          <StatRow
            label="Position"
            tone={side === "long" ? "positive" : "negative"}
            value={`${side === "long" ? "Long" : "Short"} ${normalizedSymbol}`}
          />
          <StatRow label="Target notional" value={formatUsd(parsedAmount)} />
          <StatRow label="Leverage" value={`${parsedLeverage}×`} />
          <StatRow
            label="Est. collateral"
            value={`${formatUsd(collateralRequired)} AUSD`}
          />
          <Text
            className="mt-3 border-t pt-3 text-xs leading-5"
            style={{ borderColor: ui.border, color: ui.muted }}
          >
            IOC order · maximum slippage {formatPercent(market.maxSlippageBps)}.
            It may fill partially or not at all. Perpl can use up to{" "}
            {formatPercent(market.maxNegativePnlCollateralBps)} of notional to
            cover negative PnL. The API key cannot withdraw or transfer funds.
          </Text>
        </Card>
      ) : null}

      {error ? (
        <View accessibilityRole="alert">
          <Notice tone="negative">{error}</Notice>
        </View>
      ) : null}

      {market && !market.isOpen ? (
        <Notice tone="warning">This Perpl market is currently closed.</Notice>
      ) : null}

      <ActionButton
        tone={side === "long" ? "positive" : "negative"}
        disabled={controlsDisabled}
        loading={busy}
        accessibilityState={{ disabled: controlsDisabled, busy }}
        onPress={() => (reviewing ? void submitOrder() : setReviewing(true))}
        label={
          busy
            ? "Submitting order…"
            : reviewing
              ? "Confirm and submit"
              : side === "long"
                ? "Review long"
                : "Review short"
        }
      />
      <Text
        className="mt-3 text-center text-xs leading-5"
        style={{ color: ui.muted }}
      >
        Perpl orders use your enabled order-forwarding permission. Review the
        estimated collateral and slippage before submitting.
      </Text>
    </KeyboardAwareScrollView>
  );
}

function formatUsd(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(basisPoints: number) {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

function formatPerplBookPrice(value: number, decimals: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(decimals, 2),
    maximumFractionDigits: Math.min(Math.max(decimals, 2), 8),
  }).format(value);
}

function formatPerplBookSize(value: number, decimals: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Math.min(decimals, 8),
  }).format(value);
}
