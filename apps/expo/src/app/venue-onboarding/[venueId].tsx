import { useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  View,
} from "react-native";
import { showToastable } from "react-native-toastable";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";

import {
  type VenueOnboardingContext,
  type VenueOnboardingTransaction,
} from "@kites-social/venues";

import { DepositModal } from "~/components/deposit-modal";
import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi } from "~/components/ui/tokens";
import { VenueFundingModal } from "~/components/venue-funding-modal";
import { useAgent } from "~/lib/agent";
import { api } from "~/lib/utils/api";
import {
  capturePerplSetupError,
  logPerplSetup,
} from "~/lib/venues/perpetual-markets/perpl/logging";
import { requestPerplTestnetAUsd } from "~/lib/venues/perpetual-markets/perpl/protocol";
import { onboardingVenues } from "~/lib/venues/registry";
import {
  appChainBalancesQueryKey,
  getAppChain,
  web3BalancesQueryKey,
} from "~/lib/web3";
import {
  saveWalletActivity,
  walletActivityQueryKey,
} from "~/lib/web3/activity";
import { useWallet } from "~/lib/web3/custody";
import { type CustodySession } from "~/lib/web3/custody/session";

export default function VenueOnboardingScreen() {
  const { _ } = useLingui();
  const ui = useUi();
  const wallet = useWallet();
  const agent = useAgent();
  const queryClient = useQueryClient();
  const walletQuery = api.wallet.mine.useQuery();
  const { venueId } = useLocalSearchParams<{ venueId: string }>();
  const selected = onboardingVenues.find((item) => item.venue.id === venueId);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fundingModalVisible, setFundingModalVisible] = useState(false);
  const [walletDepositModalVisible, setWalletDepositModalVisible] =
    useState(false);
  const provider = selected?.onboarding;
  const address = walletQuery.data?.address;
  const depositWalletAddress =
    walletQuery.data?.polymarketDepositWalletAddress ?? undefined;
  const automaticState = selected
    ? wallet.venueSetup[
        selected.venue.id as "polymarket" | "perpl" | "hyperliquid"
      ]
    : undefined;
  const isPolymarketSetupBusy =
    selected?.venue.id === "polymarket" &&
    (busyStep === "create-account" ||
      busyStep === "finish-setup" ||
      automaticState?.status === "running");
  const steps = useQuery({
    queryKey: ["venue-onboarding", venueId, address, depositWalletAddress],
    enabled:
      selected?.venue.id !== "hyperliquid" &&
      Boolean(provider) &&
      !walletQuery.isPending &&
      !walletQuery.isError,
    queryFn: () => {
      if (!provider) throw new Error("This venue has no onboarding flow.");
      return provider.getSteps({
        walletAddress: address,
        depositWalletAddress,
      });
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnMount: "always",
  });
  const perplAccountReady =
    selected?.venue.id === "perpl" &&
    steps.data?.some(
      (step) => step.id === "create-account" && step.status === "complete",
    );

  const ensureSession = async () => {
    const session = await wallet.ensureUnlocked({
      existingAddress: address,
      userName: "Kites wallet",
    });
    if (!address) await walletQuery.refetch();
    return session;
  };

  const reportVenueTransaction = (transaction: VenueOnboardingTransaction) => {
    const did = agent.session?.did;
    if (!did) return;
    saveWalletActivity(did, {
      id: `tx:${transaction.chainId}:${transaction.hash}`,
      kind: transaction.kind,
      status: transaction.status,
      title: transaction.title,
      detail: transaction.detail,
      chainId: transaction.chainId,
      transactionHash: transaction.hash,
      venue: selected?.venue.name ?? "Perpl",
    });
    void queryClient.invalidateQueries({
      queryKey: walletActivityQueryKey(did),
    });
  };

  const createOnboardingContext = (
    session?: CustodySession,
  ): VenueOnboardingContext => {
    const activeAddress = session?.address ?? address ?? wallet.address;
    return {
      ...(activeAddress ? { walletAddress: activeAddress } : {}),
      ...(depositWalletAddress ? { depositWalletAddress } : {}),
      ...(session
        ? {
            signTypedData: (
              request: Parameters<
                NonNullable<VenueOnboardingContext["signTypedData"]>
              >[0],
            ) => session.account.signTypedData(request),
            sendTransaction: async (
              chainId: number,
              transaction: { to: Address; data: Hex; value?: bigint },
            ) => {
              const chain = getAppChain(chainId);
              return createWalletClient({
                account: session.account,
                chain: chain.chain,
                transport: http(),
              }).sendTransaction(transaction);
            },
          }
        : {}),
      onTransaction: reportVenueTransaction,
    };
  };

  const runStep = async (stepId: string) => {
    if (!selected) return;
    setBusyStep(stepId);
    setError(null);
    try {
      if (
        selected.venue.id === "polymarket" &&
        (stepId === "create-account" || stepId === "finish-setup")
      ) {
        await ensureSession();
        await wallet.retryVenueSetup("polymarket");
        await Promise.all([steps.refetch(), walletQuery.refetch()]);
        return;
      }
      if (stepId === "wallet") {
        await ensureSession();
        await walletQuery.refetch();
        return;
      }
      if (stepId === "deposit") {
        setFundingModalVisible(true);
        return;
      }
      const needsWalletSession =
        stepId === "clob-authentication" ||
        stepId.startsWith("api-key-enrollment") ||
        stepId === "create-account" ||
        stepId === "add-collateral" ||
        stepId === "enable-order-forwarding" ||
        stepId === "revoke-order-forwarding";
      const session = needsWalletSession ? await ensureSession() : undefined;
      const activeAddress = session?.address ?? address ?? wallet.address;
      if (needsWalletSession && (!activeAddress || !session)) {
        throw new Error("Create or unlock a wallet before continuing.");
      }
      await selected.onboarding.runStep(
        stepId,
        createOnboardingContext(session),
      );
      await Promise.all([
        steps.refetch(),
        walletQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["wallet", "venue-balances"],
        }),
        queryClient.invalidateQueries({ queryKey: ["wallet", "positions"] }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`The venue setup step could not be completed.`),
      );
    } finally {
      setBusyStep(null);
    }
  };

  const requestPerplAUsd = async () => {
    if (selected?.venue.id !== "perpl") return;
    setBusyStep("request-perpl-ausd");
    setError(null);
    let session: CustodySession | undefined;
    try {
      session = await ensureSession();
      logPerplSetup("manual_faucet_request_started", {
        walletAddress: getAddress(session.address),
      });
      await requestPerplTestnetAUsd(createOnboardingContext(session));
      await Promise.all([
        steps.refetch(),
        walletQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["wallet", "venue-balances"],
        }),
        queryClient.invalidateQueries({ queryKey: ["wallet", "positions"] }),
        queryClient.invalidateQueries({ queryKey: appChainBalancesQueryKey }),
        queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey }),
      ]);
      showToastable({
        title: _(msg`AUSD request confirmed`),
        message: _(msg`Retry setup to continue Perpl setup.`),
        status: "success",
      });
    } catch (cause) {
      if (session) {
        capturePerplSetupError(cause, getAddress(session.address));
      }
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`The Perpl AUSD request could not be completed.`),
      );
    } finally {
      setBusyStep(null);
    }
  };

  const retryAutomaticSetup = async () => {
    setBusyStep("automatic-setup");
    setError(null);
    try {
      await ensureSession();
      const venue =
        selected?.venue.id === "polymarket" || selected?.venue.id === "perpl"
          ? selected.venue.id
          : undefined;
      await wallet.retryVenueSetup(venue);
      await Promise.all([steps.refetch(), walletQuery.refetch()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`Venue setup could not be resumed.`),
      );
    } finally {
      setBusyStep(null);
    }
  };

  const copyDetail = async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      showToastable({ message: _(msg`Copied to clipboard`) });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : _(msg`Could not copy this value.`),
      );
    }
  };

  if (!selected) {
    return (
      <>
        <Stack.Screen options={{ title: _(msg`Trading venue`) }} />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>This venue is not available for setup.</Trans>
          </Text>
        </View>
      </>
    );
  }

  if (selected.venue.id === "hyperliquid") {
    return (
      <>
        <Stack.Screen options={{ title: selected.venue.name }} />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base font-semibold">
            <Trans>Unavailable</Trans>
          </Text>
          <Text className="mt-2 text-center text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Coming soon...</Trans>
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: selected.venue.name }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        {automaticState && automaticState.status !== "complete" && (
          <View
            className="mb-3 border p-4"
            style={{
              borderRadius: radius.card,
              ...continuousCorners,
              backgroundColor: ui.card,
              borderColor: ui.border,
            }}
          >
            <Text className="text-base font-semibold">
              {automaticState.status === "running"
                ? _(msg`Setting up in the background`)
                : automaticState.status === "waiting"
                  ? _(msg`Waiting to continue setup`)
                  : _(msg`Setup needs attention`)}
            </Text>
            <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              {automaticState.error ?? automaticState.step}
            </Text>
            {(automaticState.status === "failed" ||
              automaticState.status === "waiting") && (
              <TouchableOpacity
                accessibilityRole="button"
                disabled={busyStep !== null}
                className="mt-4 items-center px-4 py-3.5"
                style={{
                  borderRadius: radius.control,
                  ...continuousCorners,
                  backgroundColor: ui.primary,
                  opacity: busyStep !== null ? 0.65 : 1,
                }}
                onPress={() => void retryAutomaticSetup()}
              >
                {busyStep === "automatic-setup" ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="font-semibold text-white">
                    <Trans>Retry setup</Trans>
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}
        {walletQuery.isPending ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" />
          </View>
        ) : walletQuery.isError ? (
          <FeedbackCard
            message={_(msg`Unable to load your wallet. Retry to continue.`)}
            actionLabel={_(msg`Retry`)}
            onPress={() => void walletQuery.refetch()}
          />
        ) : isPolymarketSetupBusy ? (
          <View
            className="border p-4"
            style={{
              borderRadius: radius.card,
              ...continuousCorners,
              backgroundColor: ui.card,
              borderColor: ui.border,
            }}
          >
            <Text className="text-base font-semibold">
              <Trans>Create your Polymarket account</Trans>
            </Text>
            <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>Set up your Polymarket wallet, then deposit.</Trans>
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              disabled
              className="mt-4 items-center px-4 py-3.5"
              style={{
                borderRadius: radius.control,
                ...continuousCorners,
                backgroundColor: ui.primary,
                opacity: 0.65,
              }}
            >
              <View className="flex-row items-center gap-2">
                <ActivityIndicator color="white" />
                <Text className="font-semibold text-white">
                  {automaticState?.step ?? _(msg`Creating account...`)}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        ) : steps.isPending ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" />
          </View>
        ) : steps.isError ? (
          <FeedbackCard
            message={_(
              msg`Unable to load ${selected.venue.name} requirements.`,
            )}
            actionLabel={_(msg`Retry`)}
            onPress={() => void steps.refetch()}
          />
        ) : (
          <View className="gap-3">
            {steps.data.map((step, index) => {
              const isNumberedStep =
                step.kind !== "deposit" &&
                step.id !== "account-ready" &&
                step.id !== "revoke-order-forwarding" &&
                step.id !== "manage-api-keys";
              const stepNumber = steps.data
                .slice(0, index + 1)
                .filter(
                  (candidate) =>
                    candidate.kind !== "deposit" &&
                    candidate.id !== "account-ready" &&
                    candidate.id !== "revoke-order-forwarding" &&
                    candidate.id !== "manage-api-keys",
                ).length;
              const automaticallyManagedPerplStep =
                selected.venue.id === "perpl" &&
                [
                  "create-account",
                  "api-key-enrollment",
                  "enable-order-forwarding",
                ].includes(step.id);
              const description = automaticallyManagedPerplStep
                ? step.id === "create-account"
                  ? _(
                      msg`Kites creates your Perpl exchange account automatically after test funds arrive.`,
                    )
                  : step.id === "api-key-enrollment"
                    ? _(
                        msg`Kites enables Perpl API access automatically after the exchange account is created.`,
                      )
                    : _(
                        msg`Kites enables Perpl order forwarding automatically when setup is ready.`,
                      )
                : step.description;
              const status =
                automaticallyManagedPerplStep &&
                step.status === "action-required"
                  ? "waiting"
                  : step.status;

              return (
                <View
                  key={step.id}
                  className="border p-4"
                  style={{
                    borderRadius: radius.card,
                    ...continuousCorners,
                    backgroundColor: ui.card,
                    borderColor: ui.border,
                  }}
                >
                  <View className="flex-row items-start justify-between">
                    <View className="mr-3 flex-1">
                      <Text className="text-base font-semibold">
                        {isNumberedStep
                          ? `${stepNumber}. ${step.title}`
                          : step.title}
                      </Text>
                      <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
                        {description}
                      </Text>
                      {selected.venue.id === "perpl" &&
                        step.id === "api-key-enrollment" && (
                          <Text className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                            <Trans>
                              Perpl API access may be restricted in some
                              locations.
                            </Trans>
                          </Text>
                        )}
                    </View>
                    {step.kind !== "deposit" && <StepStatus status={status} />}
                  </View>
                  {step.details?.map((detail) => (
                    <OnboardingDetail
                      key={`${step.id}-${detail.label}`}
                      detail={detail}
                      onCopy={copyDetail}
                    />
                  ))}
                  {selected.venue.id === "perpl" &&
                    step.id === "api-key-enrollment" &&
                    step.status !== "complete" &&
                    step.status !== "blocked" &&
                    perplAccountReady && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        disabled={
                          busyStep !== null ||
                          automaticState?.status === "running"
                        }
                        className="mt-4 items-center border px-4 py-3.5"
                        style={{
                          borderRadius: radius.control,
                          ...continuousCorners,
                          borderColor: ui.primary,
                          opacity:
                            busyStep !== null ||
                            automaticState?.status === "running"
                              ? 0.65
                              : 1,
                        }}
                        onPress={() => void runStep(step.id)}
                      >
                        {busyStep === step.id ? (
                          <View className="flex-row items-center gap-2">
                            <ActivityIndicator color={ui.primary} />
                            <Text
                              className="font-semibold"
                              style={{ color: ui.primary }}
                            >
                              <Trans>Working...</Trans>
                            </Text>
                          </View>
                        ) : (
                          <Text
                            className="font-semibold"
                            style={{ color: ui.primary }}
                          >
                            <Trans>Retry API access</Trans>
                          </Text>
                        )}
                      </TouchableOpacity>
                    )}
                  {!automaticallyManagedPerplStep &&
                    step.actionLabel &&
                    step.status !== "blocked" && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        disabled={busyStep !== null}
                        className="mt-4 items-center px-4 py-3.5"
                        style={{
                          borderRadius: radius.control,
                          ...continuousCorners,
                          backgroundColor: ui.primary,
                          opacity: busyStep !== null ? 0.65 : 1,
                        }}
                        onPress={() => void runStep(step.id)}
                      >
                        {busyStep === step.id ? (
                          <View className="flex-row items-center gap-2">
                            <ActivityIndicator color="white" />
                            <Text className="font-semibold text-white">
                              {step.id === "create-account"
                                ? _(msg`Creating account...`)
                                : step.id === "finish-setup"
                                  ? _(msg`Finishing setup...`)
                                  : _(msg`Working...`)}
                            </Text>
                          </View>
                        ) : (
                          <Text className="font-semibold text-white">
                            {step.actionLabel}
                          </Text>
                        )}
                      </TouchableOpacity>
                    )}
                  {selected.venue.id === "perpl" &&
                    step.id === "create-account" &&
                    step.status !== "complete" && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        disabled={
                          busyStep !== null ||
                          automaticState?.status === "running"
                        }
                        className="mt-4 items-center border px-4 py-3.5"
                        style={{
                          borderRadius: radius.control,
                          ...continuousCorners,
                          borderColor: ui.primary,
                          opacity:
                            busyStep !== null ||
                            automaticState?.status === "running"
                              ? 0.65
                              : 1,
                        }}
                        onPress={() => void requestPerplAUsd()}
                      >
                        {busyStep === "request-perpl-ausd" ? (
                          <View className="flex-row items-center gap-2">
                            <ActivityIndicator color={ui.primary} />
                            <Text
                              className="font-semibold"
                              style={{ color: ui.primary }}
                            >
                              <Trans>Requesting AUSD...</Trans>
                            </Text>
                          </View>
                        ) : (
                          <Text
                            className="font-semibold"
                            style={{ color: ui.primary }}
                          >
                            <Trans>Request testnet AUSD</Trans>
                          </Text>
                        )}
                      </TouchableOpacity>
                    )}
                </View>
              );
            })}
          </View>
        )}
        {error && (
          <Text className="mt-4 text-sm" style={{ color: ui.negative }}>
            {error}
          </Text>
        )}
      </ScrollView>
      <VenueFundingModal
        visible={fundingModalVisible}
        sourceAddress={address}
        destinationAddress={depositWalletAddress}
        onClose={() => setFundingModalVisible(false)}
        onDepositToWallet={() => {
          setFundingModalVisible(false);
          setWalletDepositModalVisible(true);
        }}
      />
      <DepositModal
        visible={walletDepositModalVisible}
        walletAddress={address}
        onClose={() => setWalletDepositModalVisible(false)}
        onSetup={() => {
          setWalletDepositModalVisible(false);
          void runStep("wallet");
        }}
      />
    </>
  );
}

const OnboardingDetail = ({
  detail,
  onCopy,
}: {
  detail: {
    label: string;
    value: string;
    copyable?: boolean;
  };
  onCopy: (value: string) => Promise<void>;
}) => {
  const ui = useUi();
  const { _ } = useLingui();
  return (
    <View
      className="mt-3 p-3"
      style={{
        backgroundColor: ui.inset,
        borderRadius: radius.control,
        ...continuousCorners,
      }}
    >
      <Text className="text-xs text-neutral-500 dark:text-neutral-400">
        {detail.label}
      </Text>
      <View className="mt-1 flex-row items-center justify-between">
        <Text selectable className="flex-1 text-sm font-medium">
          {detail.value}
        </Text>
        {detail.copyable && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={_(msg`Copy ${detail.label}`)}
            className="ml-3 px-3 py-1.5"
            style={{ backgroundColor: ui.primary, borderRadius: radius.pill }}
            onPress={() => void onCopy(detail.value)}
          >
            <Text className="text-xs font-semibold text-white">
              <Trans>Copy</Trans>
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const StepStatus = ({
  status,
}: {
  status: "action-required" | "blocked" | "complete" | "waiting";
}) => {
  const { _ } = useLingui();
  const label = {
    "action-required": _(msg`Required`),
    blocked: _(msg`Blocked`),
    complete: _(msg`Complete`),
    waiting: _(msg`Waiting`),
  }[status];
  const ui = useUi();
  const color =
    status === "complete"
      ? ui.positive
      : status === "blocked"
        ? ui.warning
        : ui.muted;
  return (
    <Text className="text-xs font-semibold" style={{ color }}>
      {label}
    </Text>
  );
};

const FeedbackCard = ({
  message,
  actionLabel,
  onPress,
}: {
  message: string;
  actionLabel: string;
  onPress: () => void;
}) => {
  const ui = useUi();
  return (
    <View
      className="items-center border p-5"
      style={{
        borderColor: ui.border,
        borderRadius: radius.card,
        ...continuousCorners,
      }}
    >
      <Text className="text-center text-sm text-neutral-600 dark:text-neutral-400">
        {message}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onPress}
        className="mt-4 px-5 py-2.5"
        style={{ backgroundColor: ui.primary, borderRadius: radius.pill }}
      >
        <Text className="font-medium text-white">{actionLabel}</Text>
      </TouchableOpacity>
    </View>
  );
};
