import Constants from "expo-constants";

/**
 * WebAuthn relying party for the wallet passkey. This must be a host the
 * project controls and must match the `rpId` used by the web app if accounts
 * are shared across platforms. Configure with `EXPO_PUBLIC_WALLET_RP_ID`.
 */
const extra: unknown = Constants.expoConfig?.extra;

const readExtraString = (key: string): string | undefined => {
  if (typeof extra !== "object" || extra === null || !(key in extra)) {
    return undefined;
  }
  const value = (extra as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

export const WALLET_RP_NAME = "Kites Wallet";
export const WALLET_RP_ID = readExtraString("walletRpId");

export function requireWalletRpId(): string {
  if (!WALLET_RP_ID) {
    throw new Error(
      "Passkey wallet is not configured. Set to the WebAuthn relying party domain.",
    );
  }
  return WALLET_RP_ID;
}
