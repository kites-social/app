import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Pressable, View } from "react-native";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { ChevronDown, ChevronUp } from "lucide-react-native";

import { Text } from "~/components/themed/text";
import { Card, Notice, SectionLabel, useUi } from "~/components/ui";

const DEFAULT_ORDER_BOOK_LEVELS = 5;
const MAX_ORDER_BOOK_LEVELS = 20;

export interface OrderBookDisplayLevel {
  price: string;
  priceKey: string;
  priceValue: number;
  orders?: string;
  ordersKey?: string;
  ordersValue?: number;
  size: string;
  sizeKey: string;
  sizeValue: number;
}

type BookSide = "bid" | "ask";

interface DisplayLevel extends OrderBookDisplayLevel {
  id: string;
  depthPercent: number;
}

interface LevelSnapshot {
  sizeKey: string;
  sizeValue: number;
  ordersKey?: string;
  ordersValue?: number;
}

interface LevelFlash {
  revision: number;
  direction: "up" | "down";
}

export function OrderBookPanel({
  title,
  bids,
  asks,
  isLoading = false,
  error,
}: {
  title: ReactNode;
  bids: OrderBookDisplayLevel[];
  asks: OrderBookDisplayLevel[];
  isLoading?: boolean;
  error?: string;
}) {
  const ui = useUi();
  const { _ } = useLingui();
  const [expanded, setExpanded] = useState(true);
  const [showFullDepth, setShowFullDepth] = useState(false);
  const totalFormatter = useMemo(
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }),
    [],
  );
  const spreadFormatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8,
      }),
    [],
  );
  const percentFormatter = useMemo(
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }),
    [],
  );
  const { bidRows, askRows, bestBid, bestAsk, bidTotal, askTotal } =
    useMemo(() => {
      const sortedBids = bids
        .slice()
        .sort((left, right) => right.priceValue - left.priceValue);
      const sortedAsks = asks
        .slice()
        .sort((left, right) => left.priceValue - right.priceValue);

      return {
        bidRows: createDisplayLevels(sortedBids, "bid"),
        askRows: createDisplayLevels(sortedAsks, "ask"),
        bestBid: sortedBids[0],
        bestAsk: sortedAsks[0],
        bidTotal: sortedBids.reduce(
          (total, level) => total + Math.max(0, level.sizeValue),
          0,
        ),
        askTotal: sortedAsks.reduce(
          (total, level) => total + Math.max(0, level.sizeValue),
          0,
        ),
      };
    }, [asks, bids]);
  const visibleLevelCount = showFullDepth
    ? MAX_ORDER_BOOK_LEVELS
    : DEFAULT_ORDER_BOOK_LEVELS;
  const visibleBidRows = useMemo(
    () => withDepthPercent(bidRows.slice(0, visibleLevelCount)),
    [bidRows, visibleLevelCount],
  );
  const visibleAskRows = useMemo(
    () => withDepthPercent(askRows.slice(0, visibleLevelCount)),
    [askRows, visibleLevelCount],
  );
  const levelSnapshot = useMemo(() => {
    const snapshot = new Map<string, LevelSnapshot>();
    for (const level of [...askRows, ...bidRows]) {
      snapshot.set(level.id, {
        sizeKey: level.sizeKey,
        sizeValue: level.sizeValue,
        ...(level.ordersKey === undefined
          ? {}
          : { ordersKey: level.ordersKey }),
        ...(level.ordersValue === undefined
          ? {}
          : { ordersValue: level.ordersValue }),
      });
    }
    return snapshot;
  }, [askRows, bidRows]);
  const previousSnapshot = useRef<Map<string, LevelSnapshot> | undefined>(
    undefined,
  );
  const nextFlashRevision = useRef(0);
  const [flashes, setFlashes] = useState<Map<string, LevelFlash>>(
    () => new Map(),
  );
  useEffect(() => {
    const previous = previousSnapshot.current;
    if (previous === undefined) {
      if (levelSnapshot.size > 0) previousSnapshot.current = levelSnapshot;
      return;
    }

    previousSnapshot.current = levelSnapshot;
    const updates = new Map<string, LevelFlash>();
    for (const [id, current] of levelSnapshot) {
      const prior = previous.get(id);
      const sizeChanged = prior?.sizeKey !== current.sizeKey;
      const ordersChanged = prior?.ordersKey !== current.ordersKey;
      if (prior && !sizeChanged && !ordersChanged) continue;
      const direction =
        prior === undefined
          ? "up"
          : sizeChanged
            ? current.sizeValue >= prior.sizeValue
              ? "up"
              : "down"
            : (current.ordersValue ?? 0) >= (prior.ordersValue ?? 0)
              ? "up"
              : "down";
      updates.set(id, {
        revision: ++nextFlashRevision.current,
        direction,
      });
    }

    setFlashes((current) => {
      const next = new Map<string, LevelFlash>();
      for (const [id, flash] of current) {
        if (levelSnapshot.has(id)) next.set(id, flash);
      }
      for (const [id, flash] of updates) {
        next.set(id, flash);
      }
      if (
        next.size === current.size &&
        [...next].every(([id, flash]) => current.get(id) === flash)
      ) {
        return current;
      }
      return next;
    });
  }, [levelSnapshot]);

  const hasLevels = askRows.length > 0 || bidRows.length > 0;
  const visibleRowCount = Math.max(
    visibleBidRows.length,
    visibleAskRows.length,
  );
  const canShowMoreDepth =
    bidRows.length > DEFAULT_ORDER_BOOK_LEVELS ||
    askRows.length > DEFAULT_ORDER_BOOK_LEVELS;
  const spread =
    bestBid && bestAsk ? bestAsk.priceValue - bestBid.priceValue : undefined;
  const midpoint =
    bestBid && bestAsk
      ? (bestBid.priceValue + bestAsk.priceValue) / 2
      : undefined;
  const spreadPercent =
    spread !== undefined && midpoint !== undefined && midpoint !== 0
      ? (spread / midpoint) * 100
      : undefined;

  return (
    <Card compact>
      <View
        className={`flex-row items-center justify-between ${expanded ? "mb-3" : ""}`}
      >
        <SectionLabel>{title}</SectionLabel>
        <View className="flex-row items-center">
          {isLoading && hasLevels ? (
            <ActivityIndicator size="small" color={ui.primary} />
          ) : null}
          <Pressable
            accessibilityLabel={
              expanded ? _(msg`Collapse order book`) : _(msg`Expand order book`)
            }
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            hitSlop={8}
            onPress={() => setExpanded((current) => !current)}
            className="ml-1 h-7 w-7 items-center justify-center"
          >
            {expanded ? (
              <ChevronUp size={16} color={ui.muted} />
            ) : (
              <ChevronDown size={16} color={ui.muted} />
            )}
          </Pressable>
        </View>
      </View>
      <View
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
        style={{ display: expanded ? "flex" : "none" }}
      >
        <View className="mb-1 flex-row items-center">
          <OrderBookSideHeader
            label={<Trans>Bid</Trans>}
            color={ui.positive}
            mutedColor={ui.muted}
            borderColor={ui.border}
          />
          <OrderBookSideHeader
            label={<Trans>Ask</Trans>}
            color={ui.negative}
            mutedColor={ui.muted}
            borderColor={ui.border}
            bordered
          />
        </View>
        <View
          className="my-2 flex-row items-center justify-center border-y py-1.5"
          style={{ borderColor: ui.border }}
        >
          <Text
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: ui.muted }}
          >
            <Trans>Spread</Trans>
          </Text>
          <Text
            className="ml-2 text-xs font-semibold"
            style={{ color: ui.text, fontVariant: ["tabular-nums"] }}
          >
            {spread === undefined ? "--" : spreadFormatter.format(spread)}
          </Text>
          {spreadPercent === undefined ? null : (
            <Text
              className="ml-1 text-xs"
              style={{ color: ui.muted, fontVariant: ["tabular-nums"] }}
            >
              ({percentFormatter.format(spreadPercent)}%)
            </Text>
          )}
        </View>
        {isLoading && !hasLevels ? (
          <View className="flex-row items-center justify-center py-4">
            <ActivityIndicator size="small" color={ui.primary} />
            <Text className="ml-2 text-xs" style={{ color: ui.muted }}>
              <Trans>Loading order book...</Trans>
            </Text>
          </View>
        ) : !hasLevels ? (
          <NoLevels mutedColor={ui.muted} />
        ) : (
          <View className="flex-row">
            <View className="flex-1">
              {visibleBidRows.map((level) => (
                <OrderBookSide
                  key={level.id}
                  level={level}
                  flash={flashes.get(level.id)}
                  sideColor={ui.positive}
                  depthColor={ui.positive}
                  positiveFlashColor={ui.positive}
                  negativeFlashColor={ui.negative}
                />
              ))}
              {Array.from(
                { length: visibleRowCount - visibleBidRows.length },
                (_, index) => (
                  <EmptyOrderBookSide
                    key={`bid-placeholder-${index}`}
                    mutedColor={ui.muted}
                  />
                ),
              )}
              <OrderBookTotal
                value={totalFormatter.format(bidTotal)}
                color={ui.positive}
                borderColor={ui.border}
              />
            </View>
            <View
              className="flex-1 border-l"
              style={{ borderColor: ui.border }}
            >
              {visibleAskRows.map((level) => (
                <OrderBookSide
                  key={level.id}
                  level={level}
                  flash={flashes.get(level.id)}
                  sideColor={ui.negative}
                  depthColor={ui.negative}
                  positiveFlashColor={ui.positive}
                  negativeFlashColor={ui.negative}
                />
              ))}
              {Array.from(
                { length: visibleRowCount - visibleAskRows.length },
                (_, index) => (
                  <EmptyOrderBookSide
                    key={`offer-placeholder-${index}`}
                    mutedColor={ui.muted}
                  />
                ),
              )}
              <OrderBookTotal
                value={totalFormatter.format(askTotal)}
                color={ui.negative}
                borderColor={ui.border}
              />
            </View>
          </View>
        )}
        {hasLevels && canShowMoreDepth ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showFullDepth }}
            onPress={() => setShowFullDepth((current) => !current)}
            className="mt-2 items-center py-1"
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: ui.primary }}
            >
              {showFullDepth ? (
                <Trans>Show less</Trans>
              ) : (
                <Trans>Show 20 depth</Trans>
              )}
            </Text>
          </Pressable>
        ) : null}
        {error ? (
          <Notice tone="warning" className="mb-0 mt-3">
            {error}
          </Notice>
        ) : null}
      </View>
    </Card>
  );
}

function OrderBookSideHeader({
  label,
  color,
  mutedColor,
  borderColor,
  bordered = false,
}: {
  label: ReactNode;
  color: string;
  mutedColor: string;
  borderColor: string;
  bordered?: boolean;
}) {
  return (
    <View
      className={`flex-1 flex-row items-center px-1 ${bordered ? "border-l" : ""}`}
      style={{ borderColor }}
    >
      <Text
        className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wider"
        numberOfLines={1}
        style={{ color }}
      >
        {label}
      </Text>
      <Text
        className="w-1/4 text-right text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: mutedColor }}
      >
        <Trans>Orders</Trans>
      </Text>
      <Text
        className="w-1/3 text-right text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: mutedColor }}
      >
        <Trans>Qty</Trans>
      </Text>
    </View>
  );
}

function OrderBookTotal({
  value,
  color,
  borderColor,
}: {
  value: string;
  color: string;
  borderColor: string;
}) {
  return (
    <View
      className="h-8 flex-row items-center border-t px-1"
      style={{ borderColor }}
    >
      <Text
        className="min-w-0 flex-1 text-[11px] font-semibold"
        numberOfLines={1}
        style={{ color }}
      >
        <Trans>Total</Trans>
      </Text>
      <View className="w-1/4" />
      <Text
        className="w-1/3 text-right text-[11px] font-semibold"
        numberOfLines={1}
        style={{ color, fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

function OrderBookSide({
  level,
  flash,
  sideColor,
  depthColor,
  positiveFlashColor,
  negativeFlashColor,
}: {
  level: DisplayLevel;
  flash?: LevelFlash;
  sideColor: string;
  depthColor: string;
  positiveFlashColor: string;
  negativeFlashColor: string;
}) {
  const flashOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!flash) return;
    flashOpacity.stopAnimation();
    flashOpacity.setValue(0.38);
    const animation = Animated.timing(flashOpacity, {
      toValue: 0,
      duration: 650,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [flash, flashOpacity]);

  return (
    <View className="relative h-8 flex-row items-center overflow-hidden px-1">
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          opacity: flashOpacity,
          backgroundColor:
            flash?.direction === "down"
              ? negativeFlashColor
              : positiveFlashColor,
        }}
      />
      <Text
        className="min-w-0 flex-1 text-[11px] font-semibold"
        numberOfLines={1}
        style={{ color: sideColor, fontVariant: ["tabular-nums"] }}
      >
        {level.price}
      </Text>
      <Text
        className="w-1/4 text-right text-[10px]"
        numberOfLines={1}
        style={{ color: sideColor, fontVariant: ["tabular-nums"] }}
      >
        {level.orders ?? "—"}
      </Text>
      <View className="relative h-full w-1/3 justify-center overflow-hidden">
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 4,
            bottom: 4,
            right: 0,
            width: `${level.depthPercent}%`,
            backgroundColor: depthColor,
            opacity: 0.18,
          }}
        />
        <Text
          className="w-full text-right text-[10px]"
          numberOfLines={1}
          style={{ color: sideColor, fontVariant: ["tabular-nums"] }}
        >
          {level.size}
        </Text>
      </View>
    </View>
  );
}

function EmptyOrderBookSide({ mutedColor }: { mutedColor: string }) {
  return (
    <View className="h-8 flex-row items-center px-1">
      <Text className="min-w-0 flex-1" style={{ color: mutedColor }}>
        —
      </Text>
      <Text className="w-1/4 text-right" style={{ color: mutedColor }}>
        —
      </Text>
      <Text className="w-1/3 text-right" style={{ color: mutedColor }}>
        —
      </Text>
    </View>
  );
}

function createDisplayLevels(
  levels: OrderBookDisplayLevel[],
  side: BookSide,
): DisplayLevel[] {
  return levels.slice(0, MAX_ORDER_BOOK_LEVELS).map((level) => ({
    ...level,
    id: `${side}:${level.priceKey}`,
    depthPercent: 0,
  }));
}

function withDepthPercent(levels: DisplayLevel[]): DisplayLevel[] {
  const maxSize = Math.max(0, ...levels.map((level) => level.sizeValue));
  return levels.map((level) => ({
    ...level,
    depthPercent:
      maxSize > 0 ? (Math.max(0, level.sizeValue) / maxSize) * 100 : 0,
  }));
}

function NoLevels({ mutedColor }: { mutedColor: string }) {
  return (
    <Text className="h-8 py-1 text-xs" style={{ color: mutedColor }}>
      <Trans>No levels</Trans>
    </Text>
  );
}
