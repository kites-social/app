import { Linking } from "react-native";
import * as SecureStore from "expo-secure-store";
import { formatUnits, getAddress } from "viem";

import {
  type VenueOnboardingProvider,
  type VenueOnboardingStep,
} from "@kites-social/venues";

import { fetchPerplAccountSummary } from "./account";
import { enrollPerplApiKey, hasPerplApiCredentials } from "./api-credentials";
import {
  createPerplAccountOnChain,
  depositPerplCollateralOnChain,
  enablePerplOrderForwardingOnChain,
  fetchPerplProtocolConfig,
  hasPerplOnchainAccount,
} from "./protocol";
import { PERPL_NETWORKS } from "./network";

export const perplOnboarding: VenueOnboardingProvider = {
  getSteps: async ({ walletAddress }) => {
    if (!walletAddress) return [walletRequiredStep()];

    const address = getAddress(walletAddress);
    const config = await fetchPerplProtocolConfig();
    const secureStorageAvailable = await SecureStore.isAvailableAsync();
    const hasCredentials =
      secureStorageAvailable && (await hasPerplApiCredentials(address));
    const accountExists = await hasPerplOnchainAccount(address, config);
    let allowsForwarding = false;
    let forwardingStateAvailable = true;
    if (hasCredentials && accountExists) {
      try {
        const summary = await fetchPerplAccountSummary(address);
        const tradingAccount = summary.accounts.find(
          (account) => !account.frozen,
        );
        if (tradingAccount) {
          allowsForwarding = tradingAccount.allowsForwarding;
        } else {
          forwardingStateAvailable = false;
        }
      } catch {
        forwardingStateAvailable = false;
      }
    }

    return [
      accountSetupStep(
        accountExists,
        config.minAccountOpenAmount,
        config.collateralDecimals,
        config.collateralSymbol,
      ),
      apiKeyStep(secureStorageAvailable, hasCredentials, accountExists),
      collateralStep(
        accountExists,
        config.minDepositAmount,
        config.collateralDecimals,
        config.collateralSymbol,
      ),
      orderForwardingStep(
        accountExists,
        hasCredentials,
        allowsForwarding,
        forwardingStateAvailable,
      ),
      ...(hasCredentials ? [manageAccountStep()] : []),
    ];
  },
  runStep: async (stepId, context) => {
    if (stepId === "create-account") {
      await createPerplAccountOnChain(context);
      return;
    }
    if (stepId === "add-collateral") {
      await depositPerplCollateralOnChain(context);
      return;
    }
    if (stepId === "enable-order-forwarding") {
      await enablePerplOrderForwardingOnChain(context);
      return;
    }
    if (stepId === "revoke-order-forwarding") {
      await enablePerplOrderForwardingOnChain(context, false);
      return;
    }
    if (stepId === "manage-api-keys") {
      await Linking.openURL(PERPL_NETWORKS.testnet.apiKeysUrl);
      return;
    }
    if (stepId !== "api-key-enrollment") {
      throw new Error(`Unknown Perpl onboarding step: ${stepId}`);
    }
    if (!context.walletAddress) {
      throw new Error("Create or unlock your Kites wallet before continuing.");
    }
    const config = await fetchPerplProtocolConfig();
    if (!(await hasPerplOnchainAccount(context.walletAddress, config))) {
      throw new Error(
        "Create your Perpl exchange account before enabling API access.",
      );
    }
    if (!context.signTypedData) {
      throw new Error("Unlock your passkey to enable Perpl API access.");
    }
    await enrollPerplApiKey(
      context.walletAddress,
      context.signTypedData,
      "testnet",
    );
  },
};

function walletRequiredStep(): VenueOnboardingStep {
  return {
    id: "wallet",
    title: "Set up your Kites wallet",
    description: "Create or unlock your wallet to enable Perpl features.",
    kind: "action",
    status: "action-required",
    actionLabel: "Continue",
  };
}

function apiKeyStep(
  secureStorageAvailable: boolean,
  hasCredentials: boolean,
  accountExists: boolean,
): VenueOnboardingStep {
  const config = PERPL_NETWORKS.testnet;
  return {
    id: "api-key-enrollment",
    title: "Enable Perpl API access",
    description: hasCredentials
      ? "Perpl API credentials are stored securely on this device."
      : !secureStorageAvailable
        ? "Secure credential storage is unavailable on this device."
        : accountExists
          ? "Kites is enabling API access for account data and in-app orders."
          : "Kites enables Perpl API access automatically after creating the exchange account.",
    kind: "action",
    status: hasCredentials
      ? "complete"
      : secureStorageAvailable
        ? "waiting"
        : "blocked",
    chainId: config.chainId,
    chainName: config.chainName,
    details: [
      {
        label: "Permissions",
        value:
          "This key can read data and place, cancel, or modify orders. It cannot withdraw or transfer funds.",
      },
      {
        label: "Account requirement",
        value:
          "The exchange account is created on-chain first. Perpl API access is enrolled afterward for account data and in-app orders.",
      },
      {
        label: "Storage and revocation",
        value:
          "The API token and signing key are stored in this device's secure storage. Revoke the key from Perpl API-key settings if needed.",
      },
      ...(!secureStorageAvailable
        ? [
            {
              label: "Secure storage",
              value:
                "Secure credential storage is unavailable on this device, so an API key cannot be created here.",
            },
          ]
        : []),
    ],
  };
}

function accountSetupStep(
  accountExists: boolean,
  minimum: bigint,
  decimals: number,
  symbol: string,
): VenueOnboardingStep {
  const config = PERPL_NETWORKS.testnet;
  return {
    id: "create-account",
    title: "Create your Perpl account",
    description: accountExists
      ? "Your Perpl exchange account is ready."
      : "Kites creates your Perpl exchange account automatically after test funds arrive.",
    kind: "information",
    status: accountExists ? "complete" : "waiting",
    chainId: config.chainId,
    chainName: config.chainName,
    details: accountExists
      ? undefined
      : [
          {
            label: "Initial collateral",
            value: `${formatUnits(minimum, decimals)} ${symbol} minimum on Monad testnet, plus MON for network fees.`,
          },
          {
            label: "Wallet",
            value:
              "The exchange account belongs to your Kites wallet. Kites approves only the exact collateral amount needed for this transaction.",
          },
        ],
  };
}

function collateralStep(
  accountExists: boolean,
  minimum: bigint,
  decimals: number,
  symbol: string,
): VenueOnboardingStep {
  const config = PERPL_NETWORKS.testnet;
  return {
    id: "add-collateral",
    title: "Add Perpl collateral",
    description: accountExists
      ? `Move ${symbol} from your Kites wallet into your Perpl trading balance.`
      : "Create the exchange account first to add collateral.",
    kind: "deposit",
    status: accountExists ? "action-required" : "waiting",
    chainId: config.chainId,
    chainName: config.chainName,
    actionLabel: accountExists ? "Add minimum collateral" : undefined,
    details: [
      {
        label: "Minimum top-up",
        value: `${formatUnits(minimum, decimals)} ${symbol} on Monad testnet, plus MON for network fees.`,
      },
    ],
  };
}

function orderForwardingStep(
  accountExists: boolean,
  hasCredentials: boolean,
  allowsForwarding: boolean,
  forwardingStateAvailable: boolean,
): VenueOnboardingStep {
  const config = PERPL_NETWORKS.testnet;
  const blocked =
    accountExists && (!hasCredentials || !forwardingStateAvailable);
  const actionId = allowsForwarding
    ? "revoke-order-forwarding"
    : "enable-order-forwarding";
  return {
    id: actionId,
    title: allowsForwarding
      ? "Revoke order placement permission"
      : "Allow in-app order placement",
    description: allowsForwarding
      ? "Perpl order forwarding is enabled. You can turn it off here."
      : "Kites enables Perpl order forwarding automatically when setup is ready.",
    kind: "action",
    status: blocked
      ? "blocked"
      : allowsForwarding
        ? "complete"
        : "waiting",
    chainId: config.chainId,
    chainName: config.chainName,
    actionLabel: allowsForwarding ? "Revoke permission" : undefined,
    details: [
      {
        label: "Permission",
        value:
          "This is a persistent, revocable on-chain permission that lets Perpl submit orders you sign through its API. It does not allow withdrawals or transfers.",
      },
      ...(blocked
        ? [
            {
              label: "What's needed",
              value: !hasCredentials
                ? "Enable Perpl API access first. Kites can still create and fund your exchange account without it."
                : "Perpl account status could not be verified. Retry once its API is available before changing this permission.",
            },
          ]
        : []),
    ],
  };
}

function manageAccountStep(): VenueOnboardingStep {
  const config = PERPL_NETWORKS.testnet;
  return {
    id: "manage-api-keys",
    title: "Manage or revoke API keys",
    description: "View or revoke this device's API key from Perpl settings.",
    kind: "action",
    status: "complete",
    chainId: config.chainId,
    chainName: config.chainName,
    actionLabel: "Manage API keys",
  };
}
