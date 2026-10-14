import { useState } from "react";
import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react-native";
import { formatUnits, type Address } from "viem";

import { PerplCollateralModal } from "~/components/perpl-collateral-modal";
import { PolymarketWithdrawModal } from "~/components/polymarket-withdraw-modal";
import { Text } from "~/components/themed/text";
import { Card, SectionLabel, useUi } from "~/components/ui";
import { VenueFundingModal } from "~/components/venue-funding-modal";
import { polymarketFundingAdapter } from "~/lib/venues/funding";
import {
  fetchPerplAccountSummary,
  PerplExchangeAccountMissingError,
} from "~/lib/venues/perpetual-markets/perpl/account";
import { getPerplApiCredentials } from "~/lib/venues/perpetual-markets/perpl/api-credentials";
import { fetchPerplProtocolConfig } from "~/lib/venues/perpetual-markets/perpl/protocol";
import { erc20Abi, getAppChain } from "~/lib/web3";

interface VenueBalance {
  id: string;
  name: string;
  network: string;
  amount: string | null;
  asset: string;
  detail?: string;
  availableBalance?: bigint;
  state: "ready" | "setup" | "unavailable" | "coming-soon";
}

export function WalletVenueBalances({
  address,
  polymarketAddress,
}: {
  address: Address;
  polymarketAddress?: Address | null;
}) {
  const { _ } = useLingui();
  const ui = useUi();
  const router = useRouter();
  const [perplCollateralMode, setPerplCollateralMode] = useState<
    "deposit" | "withdraw" | null
  >(null);
  const [polymarketDepositVisible, setPolymarketDepositVisible] =
    useState(false);
  const [polymarketWithdrawVisible, setPolymarketWithdrawVisible] =
    useState(false);
  const balances = useQuery({
    queryKey: ["wallet", "venue-balances", address, polymarketAddress],
    staleTime: 15_000,
    queryFn: async () => {
      const [polymarket, perpl] = await Promise.allSettled([
        fetchPolymarketBalance(polymarketAddress),
        fetchPerplBalance(address),
      ]);
      return [
        polymarket.status === "fulfilled"
          ? polymarket.value
          : unavailableBalance("polymarket", "Polymarket", "Polygon", "pUSD"),
        perpl.status === "fulfilled"
          ? perpl.value
          : unavailableBalance("perpl", "Perpl", "Testnet · Monad", "AUSD"),
        {
          id: "hyperliquid",
          name: "Hyperliquid",
          network: "Testnet",
          amount: null,
          asset: "USDC",
          state: "coming-soon",
        },
      ] satisfies VenueBalance[];
    },
  });

  return (
    <View className="mt-7">
      <SectionLabel className="mb-1">
        <Trans>Venue balances</Trans>
      </SectionLabel>
      <Text className="mb-3 text-[13px] leading-5" style={{ color: ui.muted }}>
        <Trans>
          These funds are held by each trading venue and are separate from your
          Kites wallet.
        </Trans>
      </Text>
      {balances.isPending ? (
        <Card className="items-center py-8">
          <ActivityIndicator />
        </Card>
      ) : balances.isError ? (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void balances.refetch()}
        >
          <Card className="mb-0">
            <Text className="text-[13px]" style={{ color: ui.muted }}>
              <Trans>Could not refresh venue balances. Tap to retry.</Trans>
            </Text>
          </Card>
        </TouchableOpacity>
      ) : (
        <View className="gap-3">
          {balances.data.map((balance) => {
            const comingSoon = balance.state === "coming-soon";
            const content = (
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-base font-semibold">
                    {balance.name}
                  </Text>
                  {comingSoon ? (
                    <Text className="mt-1 text-xs" style={{ color: ui.muted }}>
                      <Trans>Coming soon...</Trans>
                    </Text>
                  ) : (
                    <Text className="mt-1 text-xs" style={{ color: ui.muted }}>
                      {balance.network}
                    </Text>
                  )}
                </View>
                {!comingSoon && (
                  <View className="flex-row items-center gap-2">
                    <Text className="text-right text-base font-semibold">
                      {balance.amount === null
                        ? _(msg`Unavailable`)
                        : `${balance.amount} ${balance.asset}`}
                    </Text>
                    <ChevronRightIcon size={16} color={ui.muted} />
                  </View>
                )}
              </View>
            );

            return (
              <View
                key={balance.id}
                pointerEvents={comingSoon ? "none" : "auto"}
              >
                <Card
                  className="mb-0"
                  style={
                    comingSoon
                      ? {
                          backgroundColor: ui.dark ? "#262626" : "#e5e7eb",
                          borderColor: ui.dark ? "#404040" : "#d1d5db",
                          opacity: 0.75,
                        }
                      : undefined
                  }
                >
                  {comingSoon ? (
                    content
                  ) : (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={_(msg`Open ${balance.name} venue`)}
                      onPress={() =>
                        router.push({
                          pathname: "/venue-onboarding/[venueId]",
                          params: { venueId: balance.id },
                        })
                      }
                      className="rounded-xl"
                    >
                      {content}
                      {balance.detail ? (
                        <Text
                          className="mt-2 text-xs"
                          style={{ color: ui.muted }}
                        >
                          {balance.detail}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  )}
                  {!comingSoon && balance.state !== "ready" ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => {
                        if (balance.state === "unavailable") {
                          void balances.refetch();
                          return;
                        }
                        router.push({
                          pathname: "/venue-onboarding/[venueId]",
                          params: { venueId: balance.id },
                        });
                      }}
                      className="min-h-10 mt-3 items-center justify-center self-start rounded-full px-4"
                      style={{ backgroundColor: ui.primarySoft }}
                    >
                      <Text
                        className="text-[13px] font-semibold"
                        style={{ color: ui.primary }}
                      >
                        {balance.state === "setup" ? (
                          <Trans>Set up venue</Trans>
                        ) : (
                          <Trans>Retry</Trans>
                        )}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  {(balance.id === "perpl" || balance.id === "polymarket") &&
                  balance.state === "ready" ? (
                    <View
                      style={{
                        marginTop: 16,
                        flexDirection: "row",
                        gap: 8,
                      }}
                    >
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={_(msg`Deposit to ${balance.name}`)}
                        onPress={() => {
                          if (balance.id === "perpl") {
                            setPerplCollateralMode("deposit");
                          } else {
                            setPolymarketDepositVisible(true);
                          }
                        }}
                        style={{
                          minHeight: 40,
                          flex: 1,
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 20,
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          backgroundColor: ui.primarySoft,
                        }}
                      >
                        <Text
                          style={{
                            color: ui.primary,
                            fontSize: 14,
                            fontWeight: "600",
                          }}
                        >
                          <Trans>Deposit</Trans>
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={_(
                          msg`Withdraw from ${balance.name}`,
                        )}
                        disabled={!balance.availableBalance}
                        onPress={() => {
                          if (balance.id === "perpl") {
                            setPerplCollateralMode("withdraw");
                          } else {
                            setPolymarketWithdrawVisible(true);
                          }
                        }}
                        style={{
                          minHeight: 40,
                          flex: 1,
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 20,
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          backgroundColor: ui.primarySoft,
                          opacity: balance.availableBalance ? 1 : 0.5,
                        }}
                      >
                        <Text
                          style={{
                            color: ui.primary,
                            fontSize: 14,
                            fontWeight: "600",
                          }}
                        >
                          <Trans>Withdraw</Trans>
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </Card>
              </View>
            );
          })}
        </View>
      )}
      {perplCollateralMode && balances.data && (
        <PerplCollateralModal
          visible
          mode={perplCollateralMode}
          walletAddress={address}
          availableBalance={
            balances.data.find((balance) => balance.id === "perpl")
              ?.availableBalance ?? BigInt(0)
          }
          onClose={() => setPerplCollateralMode(null)}
          onComplete={() => void balances.refetch()}
        />
      )}
      <VenueFundingModal
        visible={polymarketDepositVisible}
        sourceAddress={address}
        destinationAddress={polymarketAddress ?? undefined}
        onClose={() => setPolymarketDepositVisible(false)}
      />
      <PolymarketWithdrawModal
        visible={polymarketWithdrawVisible}
        walletAddress={address}
        depositWalletAddress={polymarketAddress ?? undefined}
        onClose={() => setPolymarketWithdrawVisible(false)}
        onComplete={() => void balances.refetch()}
      />
    </View>
  );
}

async function fetchPolymarketBalance(
  depositAddress?: Address | null,
): Promise<VenueBalance> {
  if (!depositAddress) {
    return {
      id: "polymarket",
      name: "Polymarket",
      network: "Polygon",
      amount: null,
      asset: "pUSD",
      detail: "Set up the Polymarket deposit wallet to see venue funds.",
      state: "setup",
    };
  }
  const chain = getAppChain(polymarketFundingAdapter.sourceChainId);
  const balance = await chain.publicClient.readContract({
    address: polymarketFundingAdapter.token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [depositAddress],
  });
  return {
    id: "polymarket",
    name: "Polymarket",
    network: "Polygon",
    amount: formatFixedUnits(
      balance,
      polymarketFundingAdapter.token.decimals,
      4,
    ),
    asset: "pUSD",
    availableBalance: balance,
    detail: "Available pUSD at your Polymarket deposit wallet.",
    state: "ready",
  };
}

async function fetchPerplBalance(address: Address): Promise<VenueBalance> {
  try {
    await getPerplApiCredentials(address);
  } catch {
    return {
      id: "perpl",
      name: "Perpl",
      network: "Testnet · Monad",
      amount: null,
      asset: "AUSD",
      detail: "Enable Perpl account access to see funds held there.",
      state: "setup",
    };
  }
  const config = await fetchPerplProtocolConfig();
  let summary;
  try {
    summary = await fetchPerplAccountSummary(address);
  } catch (error) {
    if (!(error instanceof PerplExchangeAccountMissingError)) throw error;
    return {
      id: "perpl",
      name: "Perpl",
      network: "Testnet · Monad",
      amount: "0",
      asset: config.collateralSymbol,
      detail: "Create a Perpl exchange account to use venue funds.",
      state: "setup",
    };
  }
  const balance = summary.accounts.reduce(
    (total, account) => total + BigInt(account.balance),
    BigInt(0),
  );
  const locked = summary.accounts.reduce(
    (total, account) => total + BigInt(account.lockedBalance),
    BigInt(0),
  );
  const availableBalance = balance > locked ? balance - locked : BigInt(0);
  return {
    id: "perpl",
    name: "Perpl",
    network: "Testnet · Monad",
    amount: formatFixedUnits(balance, config.collateralDecimals, 4),
    asset: config.collateralSymbol,
    availableBalance,
    detail: "Available AUSD in your Perpl account.",
    state: "ready",
  };
}

function unavailableBalance(
  id: string,
  name: string,
  network: string,
  asset: string,
): VenueBalance {
  return {
    id,
    name,
    network,
    amount: null,
    asset,
    detail: "Could not load this venue balance. Refresh and retry.",
    state: "unavailable",
  };
}

function formatFixedUnits(value: bigint, decimals: number, places: number) {
  return formatDecimal(formatUnits(value, decimals), places);
}

function formatDecimal(value: string, places: number) {
  const [whole = "0", fraction = ""] = value.split(".");
  return `${whole}.${fraction.slice(0, places).padEnd(places, "0")}`;
}
