import Constants from "expo-constants";
import { getAddress, isAddress, type Address } from "viem";

export const MARKET_FACTORY_ADDRESS =
  "0x5834ec50d2785ceD160eaC622Fa4aeB8D09691Ea" satisfies Address;

export const COLLATERAL_TOKEN_ADDRESS =
  "0x8C9C3aa5f9eA298b09C0F6C06c19b9f9dBEdf460" satisfies Address;
export const COLLATERAL_TOKEN_DECIMALS = 6;
export const OUTCOME_TOKEN_DECIMALS = 18;

export const MARKET_FUNDING_TARGET_USDC = "10000" as const;
export const MARKET_FUNDING_TARGET_LABEL = "$10,000 USDC" as const;
export const MARKET_FUNDING_WINDOW_DAYS = 5;
export const MIN_TRADING_DURATION_DAYS = MARKET_FUNDING_WINDOW_DAYS + 1;

const expoExtra: unknown = Constants.expoConfig?.extra;
const configuredDevelopmentAccount =
  typeof expoExtra === "object" &&
  expoExtra !== null &&
  "devEvmAccount" in expoExtra
    ? expoExtra.devEvmAccount
    : undefined;
const developmentAccount =
  typeof configuredDevelopmentAccount === "string"
    ? configuredDevelopmentAccount.trim()
    : undefined;

export const DEV_EVM_ACCOUNT_ADDRESS: Address | undefined =
  __DEV__ &&
  developmentAccount &&
  isAddress(developmentAccount, { strict: false })
    ? getAddress(developmentAccount)
    : undefined;
