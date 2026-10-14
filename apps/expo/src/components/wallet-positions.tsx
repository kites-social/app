import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  TouchableOpacity,
  View,
} from "react-native";
import { showToastable } from "react-native-toastable";
import { Trans } from "@lingui/macro";
import { useIsFocused } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";

import { Text } from "~/components/themed/text";
import {
  ActionButton,
  Card,
  continuousCorners,
  radius,
  useUi,
  type Tone,
} from "~/components/ui";
import { useAgent } from "~/lib/agent";
import {
  fetchPerplOpenPositions,
  type PerplOpenPosition,
} from "~/lib/venues/perpetual-markets/perpl/account";
import {
  fetchMarket,
  getPerplPositionMarketInfo,
  subscribeToMarket,
} from "~/lib/venues/perpetual-markets/perpl/market-data";
import {
  closePerplPosition,
  getPerplOrderFailureMessage,
  waitForPerplOrderResult,
  type PerplOrderOutcome,
} from "~/lib/venues/perpetual-markets/perpl/trading";
import {
  checkPolymarketTradingEligibility,
  fetchPolymarketEvent,
  fetchPolymarketOrderBook,
  getPolymarketOutcomeBalance,
  POLYMARKET_MINIMUM_SHARES_RAW,
  POLYMARKET_SHARE_DECIMALS,
  usePolymarketTrade,
} from "~/lib/venues/prediction-markets/polymarket";
import {
  hasPolymarketTradingApprovals,
  syncPolymarketConditionalAllowance,
} from "~/lib/venues/prediction-markets/polymarket/onboarding";
import {
  applyClosedPosition,
  applyPositionCap,
  expectPerplPositionClose,
  expectPositionChange,
  hasPendingPositionChanges,
  mergePendingPositions,
  reconcilePerplPositionToasts,
  refreshWalletPositions,
  walletPositionsQueryKey,
  type PositionRow,
} from "~/lib/wallet-positions";
import {
  saveWalletActivity,
  walletActivityQueryKey,
  type WalletActivityStatus,
} from "~/lib/web3/activity";
import { useWallet } from "~/lib/web3/custody";

interface PositionsData {
  items: (PositionRow & { venue: string })[];
  unavailable: string[];
}

export function WalletPositions({
  address,
  polymarketAddress,
}: {
  address: Address;
  polymarketAddress?: Address | null;
}) {
  const ui = useUi();
  const agent = useAgent();
  const wallet = useWallet();
  const polymarketTrade = usePolymarketTrade();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const wasFocused = useRef(false);
  const [markPrices, setMarkPrices] = useState<Record<number, number>>({});
  const [closingPositionId, setClosingPositionId] = useState<string | null>(
    null,
  );
  const [pendingClosePosition, setPendingClosePosition] = useState<
    (PositionRow & { venue: string }) | null
  >(null);
  const positionsQueryKey = useMemo(
    () => [...walletPositionsQueryKey, address, polymarketAddress] as const,
    [address, polymarketAddress],
  );
  const positions = useQuery({
    queryKey: positionsQueryKey,
    staleTime: 5_000,
    refetchOnMount: "always",
    refetchInterval: () => (hasPendingPositionChanges() ? 3_000 : false),
    queryFn: async () => {
      const [polymarket, hyperliquid, perpl] = await Promise.allSettled([
        fetchPolymarketPositions(polymarketAddress ?? address),
        fetchHyperliquidPositions(address),
        fetchPerplPositionRows(address),
      ]);
      const results = [
        { venue: "Polymarket", result: polymarket },
        { venue: "Hyperliquid", result: hyperliquid },
        { venue: "Perpl", result: perpl },
      ] as const;
      const successful = results.filter(
        (entry) => entry.result.status === "fulfilled",
      );
      if (successful.length === 0) {
        throw new Error("No venue position data was available.");
      }
      return {
        items: results.flatMap((entry) =>
          entry.venue !== "Hyperliquid" && entry.result.status === "fulfilled"
            ? entry.result.value.map((position) => ({
                ...position,
                venue:
                  entry.venue === "Perpl"
                    ? `${entry.venue} · Testnet`
                    : entry.venue,
              }))
            : [],
        ),
        unavailable: results
          .filter(
            (entry) =>
              entry.venue !== "Hyperliquid" &&
              entry.result.status === "rejected",
          )
          .map((entry) => entry.venue),
      } satisfies PositionsData;
    },
  });
  const perplMarkets = useMemo(() => {
    const markets = new Map<number, string>();
    for (const position of positions.data?.items ?? []) {
      if (position.perplPosition) {
        markets.set(
          position.perplPosition.position.marketId,
          position.perplPosition.marketSymbol,
        );
      }
    }
    return [...markets.entries()];
  }, [positions.data]);

  const showPositionConfirmations = useCallback(
    (data: PositionsData) => {
      if (data.unavailable.includes("Perpl")) return;
      for (const notification of reconcilePerplPositionToasts(
        address,
        data.items,
      )) {
        showToastable({
          title:
            notification.type === "partial"
              ? "Position partially closed"
              : "Position closed",
          message: `Your ${notification.marketSymbol} ${notification.side.toLowerCase()} position is ${notification.type === "partial" ? "partially closed" : "closed"}.`,
          status: notification.type === "partial" ? "warning" : "success",
        });
      }
    },
    [address],
  );

  useEffect(() => {
    const reconcileSnapshot = (snapshot: unknown) => {
      if (isPositionsData(snapshot)) showPositionConfirmations(snapshot);
    };
    const cache = queryClient.getQueryCache();
    const query = cache.find({ queryKey: positionsQueryKey, exact: true });
    const queryHash = query?.queryHash;
    if (query) reconcileSnapshot(query.state.data);
    return cache.subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "success" ||
        !queryHash ||
        event.query.queryHash !== queryHash
      ) {
        return;
      }
      reconcileSnapshot(event.query.state.data);
    });
  }, [positionsQueryKey, queryClient, showPositionConfirmations]);

  useEffect(() => {
    let active = true;
    const streamedMarkets = new Set<number>();
    const unsubscribe = perplMarkets.map(([marketId, symbol]) => {
      const stop = subscribeToMarket(symbol, (market) => {
        const markPrice = market.markPrice;
        if (!active || typeof markPrice !== "number") return;
        streamedMarkets.add(marketId);
        setMarkPrices((current) => ({ ...current, [marketId]: markPrice }));
      });
      void fetchMarket(symbol)
        .then((market) => {
          const markPrice = market?.markPrice;
          if (
            !active ||
            streamedMarkets.has(marketId) ||
            typeof markPrice !== "number"
          ) {
            return;
          }
          setMarkPrices((current) => ({ ...current, [marketId]: markPrice }));
        })
        .catch(() => undefined);
      return stop;
    });
    return () => {
      active = false;
      unsubscribe.forEach((stop) => stop());
    };
  }, [perplMarkets]);

  const startClosePosition = (row: PositionRow & { venue: string }) => {
    if (!(row.perplPosition || row.polymarketPosition) || closingPositionId) {
      return;
    }
    setPendingClosePosition(row);
  };

  const submitClosePosition = (row: PositionRow & { venue: string }) =>
    row.polymarketPosition
      ? submitClosePolymarketPosition(row)
      : submitClosePerplPosition(row);

  const submitClosePolymarketPosition = async (
    row: PositionRow & { venue: string },
  ) => {
    const target = row.tradeTarget;
    const held = row.polymarketPosition;
    if (!target || !held || closingPositionId) return;
    setClosingPositionId(row.id);
    try {
      if (!polymarketAddress) {
        throw new Error("Set up your Polymarket wallet before closing.");
      }
      await checkPolymarketTradingEligibility("sell");
      const custodial = await wallet.ensureUnlocked({
        existingAddress: address,
        userName: agent.session?.handle ?? "Kites wallet",
      });
      if (custodial.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Unlock the wallet linked to your Bluesky account.");
      }
      if (!(await hasPolymarketTradingApprovals(polymarketAddress))) {
        throw new Error("Finish Polymarket setup before closing positions.");
      }
      const event = await fetchPolymarketEvent(target.eventSlug);
      const market = event.markets.find(
        (item) => item.slug === target.marketSlug,
      );
      const marketAssetId =
        target.outcome === "yes" ? market?.yesAssetId : market?.noAssetId;
      if (!market || marketAssetId !== held.assetId) {
        throw new Error("This Polymarket market could not be loaded.");
      }
      const positionSystem = market.positionSystem ?? "ctf";
      await syncPolymarketConditionalAllowance(
        custodial.address,
        held.assetId,
        positionSystem,
      );
      const [orderBook, balance] = await Promise.all([
        fetchPolymarketOrderBook(held.assetId),
        getPolymarketOutcomeBalance(
          polymarketAddress,
          held.assetId,
          positionSystem,
        ),
      ]);
      // Sell orders support at most two decimal places of shares.
      const unit = BigInt(10) ** BigInt(POLYMARKET_SHARE_DECIMALS - 2);
      const sellRaw = (balance / unit) * unit;
      if (sellRaw < POLYMARKET_MINIMUM_SHARES_RAW) {
        throw new Error("This position is too small to sell.");
      }
      const result = await polymarketTrade.executeTrade({
        account: custodial.account,
        signerAddress: custodial.address,
        depositWalletAddress: polymarketAddress,
        market,
        orderBook,
        outcome: target.outcome,
        action: "sell",
        amount: formatUnits(sellRaw, POLYMARKET_SHARE_DECIMALS),
        slippageBps: 500,
      });
      const status = result.status.toLowerCase();
      const did = agent.session?.did;
      if (did) {
        saveWalletActivity(did, {
          id: `polymarket:${result.orderId}`,
          kind: "trade",
          status:
            status === "unmatched"
              ? "failed"
              : status === "matched"
                ? "confirmed"
                : "submitted",
          title: `Sell ${target.outcome.toUpperCase()} · ${formatUnits(sellRaw, POLYMARKET_SHARE_DECIMALS)} shares`,
          detail: `${target.marketSlug} · Order ${result.orderId}`,
          venue: "Polymarket",
        });
        void queryClient.invalidateQueries({
          queryKey: walletActivityQueryKey(did),
        });
      }
      if (status === "matched") {
        await applyClosedPosition(
          queryClient,
          positionsQueryKey,
          polymarketAddress,
          row.id,
          0,
        );

        showToastable({
          title: "Position closed",
          message: `Sold your ${target.outcome.toUpperCase()} shares in ${target.question}.`,
          status: "success",
        });
      } else if (status === "unmatched") {
        showToastable({
          title: "Position not closed",
          message: "No liquidity matched the close order. Try again shortly.",
          status: "warning",
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ["wallet", "venue-balances"],
      });
      refreshWalletPositions(queryClient);
    } catch (cause) {
      showToastable({
        title: "Unable to close position",
        message:
          cause instanceof Error
            ? cause.message
            : "Polymarket could not submit the close order.",
        status: "danger",
      });
    } finally {
      setClosingPositionId(null);
    }
  };

  const submitClosePerplPosition = async (
    row: PositionRow & { venue: string },
  ) => {
    const perplPosition = row.perplPosition;
    if (!perplPosition || closingPositionId) return;
    setClosingPositionId(row.id);
    try {
      const result = await closePerplPosition({
        walletAddress: address,
        position: perplPosition.position,
        marketSymbol: perplPosition.marketSymbol,
      });
      expectPerplPositionClose({
        owner: address,
        id: row.id,
        marketSymbol: perplPosition.marketSymbol,
        side: perplPosition.position.side,
        size: perplPosition.position.size,
      });
      expectPositionChange();
      const currentPositions =
        queryClient.getQueryData<PositionsData>(positionsQueryKey);
      if (currentPositions) showPositionConfirmations(currentPositions);
      const did = agent.session?.did;
      const activityTitle = `Perpl close · ${perplPosition.marketSymbol}`;
      const activityDetail = `${perplPosition.position.side} position close · ${formatPerplScaled(
        perplPosition.position.size,
        perplPosition.sizeDecimals,
      )} requested · testnet`;
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
      saveOrderActivity(currentRequestId, "submitted", activityDetail);
      const refresh = () =>
        refreshWalletPositions(queryClient, [
          ["venues", "perpetual", "perpl", "positions"],
        ]);
      refresh();
      void waitForPerplOrderResult({
        walletAddress: address,
        requestId: result.requestId,
        positionsReflectOrder: (open) =>
          !open.some(({ id }) => id === perplPosition.position.id),
        retryOnRequestIdTooLow: async () => {
          const retry = await closePerplPosition({
            walletAddress: address,
            position: perplPosition.position,
            marketSymbol: perplPosition.marketSymbol,
          });
          saveOrderActivity(
            currentRequestId,
            "failed",
            "Perpl rejected a stale request ID; retrying with a fresh ID.",
          );
          currentRequestId = retry.requestId;
          saveOrderActivity(currentRequestId, "submitted", activityDetail);
          return retry;
        },
      })
        .then(async (confirmation) => {
          if (!confirmation) {
            const message =
              "Perpl has not confirmed whether the close order filled. Check your positions before retrying.";
            saveOrderActivity(currentRequestId, "submitted", message);
            showToastable({
              title: "Close order status pending",
              message,
              status: "warning",
            });
            return;
          }
          const outcome: PerplOrderOutcome =
            confirmation.source === "order"
              ? confirmation.outcome
              : {
                  terminal: true,
                  orderStatusName: "Filled",
                  requestedSizeScaled: perplPosition.position.size,
                  filledSizeScaled: perplPosition.position.size,
                };

          const requestedSize =
            outcome.requestedSizeScaled ?? perplPosition.position.size;
          const reportedFilledSize = Math.max(0, outcome.filledSizeScaled ?? 0);
          const indicatesFill =
            reportedFilledSize > 0 ||
            outcome.orderStatusName === "Filled" ||
            outcome.orderStatusName === "Executed" ||
            outcome.statusReasonName === "ImmediateOrCancelExecuted" ||
            outcome.statusReasonName === "TakerOrderFilled";
          const filledSize =
            reportedFilledSize > 0
              ? reportedFilledSize
              : indicatesFill
                ? requestedSize
                : 0;
          const fullyFilled = filledSize >= requestedSize && filledSize > 0;
          const activityStatus: WalletActivityStatus = indicatesFill
            ? "confirmed"
            : "failed";
          const fillDetail = indicatesFill
            ? `Closed ${formatPerplScaled(
                filledSize,
                perplPosition.sizeDecimals,
              )} of ${formatPerplScaled(
                requestedSize,
                perplPosition.sizeDecimals,
              )} ${perplPosition.marketSymbol}${
                fullyFilled ? "." : ". The remaining position is still open."
              }`
            : `No size was closed. ${getPerplOrderFailureMessage(
                outcome,
                "Perpl did not fill the close order.",
              )}`;
          if (indicatesFill) {
            const remaining = Math.max(
              0,
              perplPosition.position.size - filledSize,
            );
            await applyClosedPosition(
              queryClient,
              positionsQueryKey,
              address,
              row.id,
              remaining,
            );
          }
          if (did) {
            saveWalletActivity(did, {
              id: `venue:perpl:${confirmation.requestId}`,
              kind: "trade",
              status: activityStatus,
              title: `Perpl close · ${perplPosition.marketSymbol}`,
              detail: fillDetail,
              venue: "Perpl",
            });
            void queryClient.invalidateQueries({
              queryKey: walletActivityQueryKey(did),
            });
          }

          if (!indicatesFill) {
            showToastable({
              title: "Position not closed",
              message: fillDetail,
              status: "danger",
            });
          }
        })
        .catch((cause: unknown) => {
          const message =
            cause instanceof Error
              ? cause.message
              : "Perpl could not confirm the close order outcome.";
          saveOrderActivity(currentRequestId, "failed", message);
          showToastable({
            title: "Close order status unavailable",
            message,
            status: "warning",
          });
        })
        .finally(() => {
          refresh();
          setClosingPositionId(null);
        });
    } catch (cause) {
      showToastable({
        title: "Unable to close position",
        message:
          cause instanceof Error
            ? cause.message
            : "Perpl could not submit the close order.",
        status: "danger",
      });
      setClosingPositionId(null);
    }
  };

  useEffect(() => {
    if (!isFocused) {
      wasFocused.current = false;
      return;
    }
    if (wasFocused.current) return;
    wasFocused.current = true;
    if (positions.data) void positions.refetch();
  }, [isFocused, positions.data, positions.refetch]);

  if (positions.isPending) {
    return (
      <View className="flex-1 items-center justify-center py-20">
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (positions.isError) {
    return (
      <View className="items-center px-6 py-16">
        <Text className="text-center text-base" style={{ color: ui.muted }}>
          <Trans>Unable to load positions from your trading venues.</Trans>
        </Text>
        <WalletAction label="Retry" onPress={() => void positions.refetch()} />
      </View>
    );
  }

  if (positions.data.items.length === 0) {
    return (
      <View className="items-center px-6 py-16">
        <Text className="text-center text-lg font-semibold">
          <Trans>No open positions</Trans>
        </Text>
        <Text
          className="mt-2 text-center text-[13px]"
          style={{ color: ui.muted }}
        >
          {positions.data.unavailable.length > 0 ? (
            <Trans>
              Position data is unavailable from{" "}
              {positions.data.unavailable.join(", ")}.
            </Trans>
          ) : (
            <Trans>Your open positions will appear here.</Trans>
          )}
        </Text>
        {positions.data.unavailable.length > 0 && (
          <WalletAction
            label="Retry"
            onPress={() => void positions.refetch()}
          />
        )}
      </View>
    );
  }

  return (
    <>
      <View className="gap-3">
        {positions.data.unavailable.length > 0 && (
          <View className="mb-1">
            <Text className="text-[13px]" style={{ color: ui.muted }}>
              <Trans>
                Unable to refresh positions from{" "}
                {positions.data.unavailable.join(", ")}.
              </Trans>
            </Text>
            <WalletAction
              label="Retry"
              onPress={() => void positions.refetch()}
            />
          </View>
        )}
        {positions.data.items.map((position) => {
          const perplPosition = position.perplPosition;
          const markPrice = perplPosition
            ? markPrices[perplPosition.position.marketId]
            : undefined;
          const pnl =
            perplPosition && markPrice !== undefined
              ? calculatePerplMarkPnl(
                  perplPosition.position,
                  markPrice,
                  perplPosition.priceDecimals,
                  perplPosition.sizeDecimals,
                )
              : undefined;

          return (
            <Card key={position.id} className="mb-0">
              <View>
                <View className="flex-row items-start justify-between">
                  <Text
                    numberOfLines={2}
                    ellipsizeMode="tail"
                    className="min-w-0 flex-1 pr-3 text-base font-semibold"
                  >
                    {position.market}
                  </Text>
                  <Text className="shrink-0 text-sm font-semibold">
                    {position.side}
                  </Text>
                </View>
                <Text className="mt-1 text-[13px]" style={{ color: ui.muted }}>
                  {position.venue}
                </Text>
                <Text className="mt-3 text-sm">
                  <Trans>Size: {position.size}</Trans>
                </Text>
                {position.detail ? (
                  <Text
                    className="mt-1 text-[13px]"
                    style={{ color: ui.muted }}
                  >
                    {position.detail}
                  </Text>
                ) : null}
              </View>
              {position.polymarketPosition ? (
                <WalletPositionButton
                  label={
                    closingPositionId === position.id
                      ? "Closing…"
                      : "Close position"
                  }
                  onPress={() => startClosePosition(position)}
                  tone="negative"
                  disabled={closingPositionId !== null}
                  style={{ alignSelf: "flex-start", marginTop: 16 }}
                />
              ) : null}
              {perplPosition ? (
                <>
                  {markPrice === undefined ? (
                    <Text
                      className="mt-1 text-[13px]"
                      style={{ color: ui.muted }}
                    >
                      <Trans>Waiting for live mark price</Trans>
                    </Text>
                  ) : (
                    <>
                      <Text
                        className="mt-1 text-[13px]"
                        style={{ color: ui.muted }}
                      >
                        Mark price: $
                        {formatPerplPrice(
                          markPrice,
                          perplPosition.priceDecimals,
                        )}
                      </Text>
                      {pnl === undefined ? null : (
                        <Text
                          className="mt-1 text-[13px] font-semibold"
                          style={{
                            color: pnl >= 0 ? ui.positive : ui.negative,
                          }}
                        >
                          Mark P&amp;L: {pnl >= 0 ? "+" : "−"}$
                          {Math.abs(pnl).toFixed(2)}{" "}
                          <Text
                            className="text-xs font-normal"
                            style={{ color: ui.muted }}
                          >
                            (before fees and funding)
                          </Text>
                        </Text>
                      )}
                    </>
                  )}
                  <WalletPositionButton
                    label={
                      closingPositionId === position.id
                        ? "Closing…"
                        : "Close position"
                    }
                    onPress={() => startClosePosition(position)}
                    tone="negative"
                    disabled={closingPositionId !== null}
                    style={{
                      alignSelf: "flex-start",
                      marginTop: 16,
                    }}
                  />
                </>
              ) : null}
            </Card>
          );
        })}
      </View>
      <Modal
        animationType="fade"
        transparent
        visible={pendingClosePosition !== null}
        onRequestClose={() => setPendingClosePosition(null)}
      >
        <View
          className="flex-1 justify-center px-6"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.68)" }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss close confirmation"
            className="absolute inset-0"
            onPress={() => setPendingClosePosition(null)}
          />
          <View
            className="p-5"
            style={{
              backgroundColor: ui.card,
              borderColor: ui.border,
              borderWidth: 1,
              borderRadius: radius.card,
              ...continuousCorners,
            }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="flex-1 pr-3 text-xl font-semibold">
                {pendingClosePosition?.polymarketPosition ? (
                  <Trans>Close Polymarket position?</Trans>
                ) : (
                  <Trans>Close Perpl position?</Trans>
                )}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Close dialog"
                onPress={() => setPendingClosePosition(null)}
                className="h-10 w-10 items-center justify-center rounded-full"
                style={{ backgroundColor: ui.inset }}
              >
                <Text className="text-2xl">×</Text>
              </TouchableOpacity>
            </View>
            <Text className="mt-3 text-base text-neutral-600 dark:text-neutral-300">
              {pendingClosePosition?.polymarketPosition ? (
                <Trans>
                  Sell all of your shares in {pendingClosePosition.market} at
                  the current market price. The order fills available liquidity
                  and may close only part of it.
                </Trans>
              ) : pendingClosePosition?.perplPosition ? (
                <Trans>
                  Submit a market close order for your{" "}
                  {pendingClosePosition.perplPosition.position.side.toLowerCase()}{" "}
                  {pendingClosePosition.market} position (
                  {formatPerplScaled(
                    pendingClosePosition.perplPosition.position.size,
                    pendingClosePosition.perplPosition.sizeDecimals,
                  )}
                  ). The order fills available liquidity and may close only part
                  of it.
                </Trans>
              ) : null}
            </Text>
            <WalletPositionButton
              label="Close position"
              onPress={() => {
                const row = pendingClosePosition;
                setPendingClosePosition(null);
                if (row) void submitClosePosition(row);
              }}
              tone="negative"
              style={{ marginTop: 16 }}
            />
            <WalletPositionButton
              label="Cancel"
              onPress={() => setPendingClosePosition(null)}
              style={{ marginTop: 12 }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

function WalletAction({
  label,
  onPress,
  tone = "primary",
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  tone?: Tone;
  disabled?: boolean;
}) {
  return (
    <ActionButton
      className="mt-4"
      size="md"
      tone={tone}
      label={label}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
    />
  );
}

function WalletPositionButton({
  label,
  onPress,
  tone = "primary",
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "negative";
  disabled?: boolean;
  style?: {
    alignSelf?: "flex-start";
    marginTop?: number;
  };
}) {
  const ui = useUi();
  const negative = tone === "negative";

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          minHeight: 40,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 20,
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: negative ? ui.negative : ui.primarySoft,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      <Text
        style={{
          color: negative ? "#fff" : ui.primary,
          fontSize: 14,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

async function fetchPolymarketPositions(user: Address): Promise<PositionRow[]> {
  const url = new URL("https://data-api.polymarket.com/positions");
  url.searchParams.set("user", user);
  url.searchParams.set("sizeThreshold", "0");
  url.searchParams.set("limit", "100");
  // Bypass HTTP/CDN caches so fresh fills are not hidden behind a cached reply.
  url.searchParams.set("_", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Unable to load Polymarket positions (${response.status}).`,
    );
  }
  const value: unknown = await response.json();
  if (!Array.isArray(value))
    throw new Error("Polymarket returned invalid positions.");
  const rows = value.flatMap((item, index): PositionRow[] => {
    if (!isRecord(item)) return [];
    const title =
      typeof item.title === "string" ? item.title : "Market position";
    const outcome =
      typeof item.outcome === "string" ? item.outcome : "Position";
    const normalizedOutcome = outcome.toLowerCase();
    const tradeOutcome =
      normalizedOutcome === "yes" || normalizedOutcome === "no"
        ? normalizedOutcome
        : undefined;
    const rawSize =
      typeof item.size === "number" || typeof item.size === "string"
        ? Number(item.size)
        : undefined;
    if (rawSize !== undefined && Number.isFinite(rawSize) && rawSize < 0.01) {
      return [];
    }
    const id = `polymarket-${String(item.asset ?? index)}`;
    const cappedSize =
      rawSize !== undefined && Number.isFinite(rawSize)
        ? applyPositionCap(user, id, rawSize)
        : undefined;
    if (cappedSize !== undefined && cappedSize <= 0) return [];
    const sizeAdjusted = cappedSize !== undefined && cappedSize !== rawSize;
    const size =
      cappedSize !== undefined
        ? String(cappedSize)
        : rawSize === undefined
          ? "—"
          : String(item.size);
    const eventSlug =
      typeof item.eventSlug === "string" ? item.eventSlug : undefined;
    const marketSlug = typeof item.slug === "string" ? item.slug : undefined;
    const currentValue =
      typeof item.currentValue === "number"
        ? `$${item.currentValue.toFixed(2)}`
        : undefined;
    return [
      {
        id,
        ...(typeof item.asset === "string" &&
        eventSlug &&
        marketSlug &&
        tradeOutcome &&
        cappedSize !== undefined
          ? { polymarketPosition: { assetId: item.asset, size: cappedSize } }
          : {}),
        market: `${title} · ${outcome}`,
        side: "Open",
        size,
        ...(eventSlug && marketSlug && tradeOutcome
          ? {
              tradeTarget: {
                eventSlug,
                marketSlug,
                question: title,
                outcome: tradeOutcome,
              },
            }
          : {}),
        ...(currentValue && !sizeAdjusted
          ? { detail: `Current value ${currentValue}` }
          : {}),
      },
    ];
  });
  return mergePendingPositions(user, rows);
}

async function fetchHyperliquidPositions(
  user: Address,
): Promise<PositionRow[]> {
  const response = await fetch("https://api.hyperliquid-testnet.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user }),
  });
  if (!response.ok) {
    throw new Error(
      `Unable to load Hyperliquid positions (${response.status}).`,
    );
  }
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.assetPositions)) {
    throw new Error("Hyperliquid returned invalid position data.");
  }
  return value.assetPositions.flatMap((entry, index): PositionRow[] => {
    if (!isRecord(entry) || !isRecord(entry.position)) return [];
    const position = entry.position;
    const size = typeof position.szi === "string" ? Number(position.szi) : 0;
    if (!Number.isFinite(size) || size === 0) return [];
    const market =
      typeof position.coin === "string" ? position.coin : "Perpetual";
    const pnl =
      typeof position.unrealizedPnl === "string"
        ? Number(position.unrealizedPnl)
        : null;
    return [
      {
        id: `hyperliquid-${String(position.coin ?? index)}`,
        market,
        side: size > 0 ? "Long" : "Short",
        size: String(Math.abs(size)),
        ...(pnl !== null && Number.isFinite(pnl)
          ? { detail: `Unrealized P&L $${pnl.toFixed(2)}` }
          : {}),
      },
    ];
  });
}

async function fetchPerplPositionRows(user: Address): Promise<PositionRow[]> {
  const positions = await fetchPerplOpenPositions(user);
  const marketEntries = await Promise.all(
    [...new Set(positions.map(({ marketId }) => marketId))].map(
      async (marketId) =>
        [
          marketId,
          await getPerplPositionMarketInfo(marketId).catch(() => undefined),
        ] as const,
    ),
  );
  const marketInfo = new Map(marketEntries);

  const openPositions = positions.flatMap((position) => {
    const size = applyPositionCap(user, `perpl-${position.id}`, position.size);
    return size > 0 ? [{ ...position, size }] : [];
  });

  return openPositions.map((position) => {
    const market = marketInfo.get(position.marketId);
    const detail = `Entry $${formatPerplScaled(position.entryPrice, market?.priceDecimals)} · ${position.leverage}×`;
    return {
      id: `perpl-${position.id}`,
      market: market?.name ?? `Market ${position.marketId}`,
      side: position.side,
      size: formatPerplScaled(position.size, market?.sizeDecimals),
      detail,
      perplIdentity: { size: position.size },
      ...(market?.symbol && market.sizeDecimals !== undefined
        ? {
            perplPosition: {
              position,
              marketSymbol: market.symbol,
              priceDecimals: market.priceDecimals,
              sizeDecimals: market.sizeDecimals,
            },
          }
        : {}),
    };
  });
}

function calculatePerplMarkPnl(
  position: PerplOpenPosition,
  markPrice: number,
  priceDecimals: number,
  sizeDecimals: number,
) {
  const entryPrice =
    (position.entryPrice + (position.entryPriceRemainder ?? 0) / 65_536) /
    10 ** priceDecimals;
  const size = position.size / 10 ** sizeDecimals;
  const priceDelta =
    position.side === "Long" ? markPrice - entryPrice : entryPrice - markPrice;
  const pnl = priceDelta * size;
  return Number.isFinite(pnl) ? pnl : undefined;
}

function formatPerplPrice(value: number, decimals: number) {
  return trimFractionalZeros(value.toFixed(Math.min(decimals, 8)));
}

function formatPerplScaled(value: number, decimals: number | undefined) {
  if (decimals === undefined) return String(value);
  const formatted = (value / 10 ** decimals).toFixed(Math.min(decimals, 8));
  return trimFractionalZeros(formatted);
}

function trimFractionalZeros(value: string) {
  return value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositionsData(value: unknown): value is PositionsData {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    Array.isArray(value.unavailable)
  );
}
