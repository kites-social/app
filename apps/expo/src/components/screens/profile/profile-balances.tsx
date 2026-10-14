import { useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  View,
} from "react-native";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Address } from "viem";

import { DepositModal } from "~/components/deposit-modal";
import {
  SendTokenModal,
  type SendableToken,
} from "~/components/send-token-modal";
import { Text } from "~/components/themed/text";
import { showWalletStatusToast } from "~/components/toastable/toastable";
import {
  ActionButton,
  Card,
  continuousCorners,
  Divider,
  radius,
  SectionLabel,
  useUi,
} from "~/components/ui";
import { WalletActivityPreview } from "~/components/wallet-activity-preview";
import { WalletPositions } from "~/components/wallet-positions";
import { WalletVenueBalances } from "~/components/wallet-venue-balances";
import { useAgent } from "~/lib/agent";
import { logFlow } from "~/lib/flow-log";
import { api } from "~/lib/utils/api";
import { formatTokenAmount } from "~/lib/utils/format-token";
import {
  appChainBalancesQueryKey,
  appChains,
  useAppChainBalances,
  web3BalancesQueryKey,
} from "~/lib/web3";
import { useWallet } from "~/lib/web3/custody";
import { resolvePublicWalletLink } from "~/lib/web3/custody/wallet-link";

export const ProfileBalances = () => {
  const { _ } = useLingui();
  const theme = useTheme();
  const ui = useUi();
  const agent = useAgent();
  const custodyWallet = useWallet();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"balances" | "positions">(
    "balances",
  );
  const [refreshingBalances, setRefreshingBalances] = useState(false);
  const [refreshingPositions, setRefreshingPositions] = useState(false);
  const [depositModalVisible, setDepositModalVisible] = useState(false);
  const [sendToken, setSendToken] = useState<SendableToken | null>(null);
  const [pendingSendToken, setPendingSendToken] =
    useState<SendableToken | null>(null);
  const did = agent.session?.did;
  const walletLink = useQuery({
    queryKey: ["wallet", "public-link", did],
    enabled: Boolean(did),
    queryFn: () => {
      if (!did) throw new Error("Sign in before checking your wallet link.");
      return resolvePublicWalletLink(agent, did);
    },
  });
  // The Bluesky record is authoritative for whether this account has a wallet.
  const account = walletLink.data?.address;
  const previousWalletAddress = custodyWallet.previousWalletAddress;
  // This API data is only supplemental venue metadata; it does not decide
  // whether the wallet is linked or whether Setup/Unlock is shown.
  const venueWallet = api.wallet.mine.useQuery(undefined, {
    enabled: Boolean(account),
  });
  const refreshPositions = async () => {
    setRefreshingPositions(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: ["wallet", "positions"],
      });
    } finally {
      setRefreshingPositions(false);
    }
  };
  const refreshBalances = async () => {
    setRefreshingBalances(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey }),
        queryClient.invalidateQueries({ queryKey: appChainBalancesQueryKey }),
        queryClient.invalidateQueries({
          queryKey: ["wallet", "venue-balances"],
        }),
      ]);
    } finally {
      setRefreshingBalances(false);
    }
  };
  const setupWallet = async () => {
    const isUnlocking = Boolean(account);
    logFlow("wallet", "setupWallet begin", { isUnlocking, account });
    showWalletStatusToast({
      title: isUnlocking ? _(msg`Unlocking wallet…`) : _(msg`Creating wallet…`),
      message: isUnlocking
        ? _(msg`Please wait while your wallet unlocks.`)
        : _(msg`Create a passkey to set up your wallet.`),
      status: "progress",
    });
    try {
      await custodyWallet.ensureUnlocked({
        existingAddress: account,
        userName: agent.session?.handle ?? "Kites wallet",
      });
      if (!isUnlocking) await walletLink.refetch();
      logFlow("wallet", "setupWallet done", { isUnlocking });
      showWalletStatusToast({
        title: isUnlocking ? _(msg`Wallet unlocked`) : _(msg`Wallet created`),
        message: isUnlocking
          ? _(msg`Your wallet is ready to use.`)
          : _(msg`Your wallet is ready.`),
        status: "success",
      });
    } catch (error) {
      logFlow("wallet", "setupWallet failed", {
        isUnlocking,
        error: error instanceof Error ? error.stack : String(error),
      });
      console.error(
        isUnlocking ? "Wallet unlock failed:" : "Wallet setup failed:",
        error,
      );
      // Setup may have published the authoritative ATProto link before a
      // supplemental API sync failed. Refresh so the UI switches to Unlock.
      if (!isUnlocking) await walletLink.refetch();
      showWalletStatusToast({
        title: isUnlocking
          ? _(msg`Wallet unlock failed`)
          : _(msg`Wallet creation did not finish`),
        message:
          error instanceof Error
            ? error.message
            : _(msg`Please try setting up your wallet again.`),
        status: "danger",
      });
    }
  };

  if (did && walletLink.isPending) {
    return (
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      </ScrollView>
    );
  }

  if (!did || walletLink.isError) {
    return (
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>Unable to read your wallet link from Bluesky.</Trans>
          </Text>
          {did && <RetryButton onPress={() => void walletLink.refetch()} />}
        </View>
      </ScrollView>
    );
  }

  if (!account) {
    return (
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>No wallet is linked to this account yet.</Trans>
          </Text>
          <Text className="mt-3 text-center text-sm leading-5 text-neutral-500 dark:text-neutral-400">
            <Trans>
              Create a Kites wallet with a passkey. After it is created, Perpl
              and Polymarket setup starts automatically in the background.
            </Trans>
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{
              disabled: custodyWallet.isBusy,
              busy: custodyWallet.isBusy,
            }}
            disabled={custodyWallet.isBusy}
            onPress={() => void setupWallet()}
            style={{
              marginTop: 16,
              minHeight: 40,
              alignSelf: "stretch",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              borderRadius: 20,
              paddingHorizontal: 16,
              paddingVertical: 8,
              backgroundColor: ui.primarySoft,
              opacity: custodyWallet.isBusy ? 0.5 : 1,
            }}
          >
            {custodyWallet.isBusy ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : null}
            <Text
              style={{
                color: ui.primary,
                fontSize: 14,
                fontWeight: "600",
              }}
            >
              {custodyWallet.isBusy ? (
                <Trans>Creating wallet…</Trans>
              ) : (
                <Trans>Create wallet</Trans>
              )}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        accessibilityElementsHidden={!custodyWallet.isUnlocked}
        importantForAccessibility={
          custodyWallet.isUnlocked ? "auto" : "no-hide-descendants"
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          activeTab === "positions" ? (
            <RefreshControl
              refreshing={refreshingPositions}
              onRefresh={() => void refreshPositions()}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          ) : (
            <RefreshControl
              refreshing={refreshingBalances}
              onRefresh={() => void refreshBalances()}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          )
        }
      >
        {previousWalletAddress && (
          <View className="mb-4 rounded-2xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/40">
            <Text className="font-semibold text-orange-950 dark:text-orange-100">
              <Trans>Your previous wallet is still separate</Trans>
            </Text>
            <Text className="mt-1 text-sm leading-5 text-orange-950 dark:text-orange-100">
              <Trans>
                Funds and positions associated with its address remain there.
                The new wallet cannot access or move them.
              </Trans>
            </Text>
            <Text selectable className="mt-2 font-mono text-xs leading-5">
              {previousWalletAddress}
            </Text>
          </View>
        )}
        <View
          className="mb-4 flex-row p-1"
          style={{
            backgroundColor: ui.inset,
            borderRadius: radius.control,
            ...continuousCorners,
          }}
        >
          <WalletTab
            label={_(msg`Balances`)}
            selected={activeTab === "balances"}
            onPress={() => setActiveTab("balances")}
          />
          <WalletTab
            label={_(msg`Positions`)}
            selected={activeTab === "positions"}
            onPress={() => setActiveTab("positions")}
          />
        </View>
        {activeTab === "positions" ? (
          <WalletPositions
            address={account}
            polymarketAddress={venueWallet.data?.polymarketDepositWalletAddress}
          />
        ) : (
          <>
            <Text className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
              <Trans>
                Kites wallet balances are shown separately by network.
              </Trans>
            </Text>
            <ActionButton
              className="mb-5"
              label={<Trans>Deposit</Trans>}
              onPress={() => {
                setDepositModalVisible(true);
              }}
            />
            {pendingSendToken && (
              <Card>
                <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-300">
                  <Trans>
                    A {pendingSendToken.symbol} transfer is awaiting
                    confirmation.
                  </Trans>
                </Text>
                <View className="mt-3 self-start">
                  <ActionButton
                    size="md"
                    variant="soft"
                    label={<Trans>Check transfer status</Trans>}
                    onPress={() => setSendToken(pendingSendToken)}
                  />
                </View>
              </Card>
            )}
            {appChains.map((chain) => (
              <ChainBalanceCard
                key={chain.id}
                chain={chain}
                account={account}
                onSend={setSendToken}
                sendDisabled={pendingSendToken !== null}
              />
            ))}
            <WalletVenueBalances
              address={account}
              polymarketAddress={
                venueWallet.data?.polymarketDepositWalletAddress
              }
            />
            <WalletActivityPreview />
          </>
        )}
        <DepositModal
          visible={depositModalVisible}
          walletAddress={account}
          onClose={() => setDepositModalVisible(false)}
          onSetup={() => void setupWallet()}
        />
        <SendTokenModal
          visible={sendToken !== null}
          token={sendToken}
          senderAddress={account}
          onClose={() => setSendToken(null)}
          onPendingChange={setPendingSendToken}
        />
      </ScrollView>
    </View>
  );
};

const WalletTab = ({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) => {
  const ui = useUi();
  return (
    <TouchableOpacity
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="flex-1 items-center py-2.5"
      style={{
        backgroundColor: selected ? ui.card : "transparent",
        borderRadius: radius.control - 4,
        ...continuousCorners,
      }}
    >
      <Text className="text-sm font-semibold">{label}</Text>
    </TouchableOpacity>
  );
};

const ChainBalanceCard = ({
  chain,
  account,
  onSend,
  sendDisabled,
}: {
  chain: (typeof appChains)[number];
  account: Address;
  onSend: (token: SendableToken) => void;
  sendDisabled: boolean;
}) => {
  const ui = useUi();
  const { _ } = useLingui();
  const balances = useAppChainBalances(account, chain.id);

  return (
    <View className="mb-5">
      <View className="mb-2">
        <SectionLabel>{chain.name}</SectionLabel>
      </View>
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
        <BalanceRow
          symbol={chain.nativeSymbol}
          description={_(msg`Native network token`)}
          balance={
            balances.data
              ? formatTokenAmount(
                  balances.data.native,
                  chain.chain.nativeCurrency.decimals,
                  { maxFractionDigits: 6 },
                )
              : undefined
          }
          onSend={() =>
            onSend({
              chainId: chain.id,
              chainName: chain.name,
              symbol: chain.nativeSymbol,
              decimals: chain.chain.nativeCurrency.decimals,
            })
          }
          sendDisabled={sendDisabled}
          isPending={balances.isPending}
          isError={balances.isError}
        />
        {chain.tokens.map((token, index) => (
          <View key={token.address}>
            <Divider className="mx-4 my-0" />
            <BalanceRow
              symbol={token.symbol}
              description={token.name}
              balance={
                balances.data?.tokens[index]
                  ? formatTokenAmount(
                      balances.data.tokens[index].balance,
                      token.decimals,
                      { maxFractionDigits: 6 },
                    )
                  : undefined
              }
              onSend={() =>
                onSend({
                  chainId: chain.id,
                  chainName: chain.name,
                  symbol: token.symbol,
                  decimals: token.decimals,
                  tokenAddress: token.address,
                })
              }
              sendDisabled={sendDisabled}
              isPending={balances.isPending}
              isError={balances.isError}
            />
          </View>
        ))}
      </View>
      {balances.isError && (
        <RetryButton
          onPress={() => void balances.refetch()}
          label={_(msg`Retry loading ${chain.name} balances`)}
        />
      )}
    </View>
  );
};

const RetryButton = ({
  onPress,
  label,
}: {
  onPress: () => void;
  label?: string;
}) => {
  const ui = useUi();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="min-h-10 mt-3 items-center justify-center self-start rounded-full px-4"
      style={{ backgroundColor: ui.primarySoft }}
    >
      <Text className="text-[13px] font-semibold" style={{ color: ui.primary }}>
        {label ?? <Trans>Retry</Trans>}
      </Text>
    </TouchableOpacity>
  );
};

const BalanceRow = ({
  symbol,
  description,
  balance,
  onSend,
  sendDisabled,
  isPending,
  isError,
}: {
  symbol: string;
  description: string;
  balance?: string;
  onSend: () => void;
  sendDisabled: boolean;
  isPending: boolean;
  isError: boolean;
}) => {
  const ui = useUi();
  return (
    <View className="flex-row items-center justify-between px-4 py-4">
      <View className="flex-1 pr-4">
        <Text className="text-base font-semibold">{symbol}</Text>
        <Text className="mt-0.5 text-[13px]" style={{ color: ui.muted }}>
          {description}
        </Text>
      </View>
      <View className="flex-row items-center">
        <View className="min-w-20 items-end">
          {isPending ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text
              className="text-base font-semibold"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {isError ? <Trans>Unavailable</Trans> : (balance ?? "0")}
            </Text>
          )}
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Send ${symbol}`}
          disabled={sendDisabled}
          onPress={onSend}
          className="ml-3 rounded-full px-3.5 py-2"
          style={{
            backgroundColor: ui.inset,
            opacity: sendDisabled ? 0.5 : 1,
          }}
        >
          <Text className="text-sm font-semibold">
            <Trans>Send</Trans>
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
