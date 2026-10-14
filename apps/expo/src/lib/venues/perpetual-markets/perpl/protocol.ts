import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import {
  type VenueOnboardingContext,
  type VenueOnboardingTransaction,
} from "@kites-social/venues";

import { store } from "~/lib/storage/storage";
import { getAppChain, getAppPublicClient } from "~/lib/web3";
import { erc20Abi } from "~/lib/web3/abis/erc20";
import { logPerplSetup } from "./logging";
import {
  PERPL_NETWORKS,
  PERPL_TESTNET_AUSD_FAUCET_ADDRESS,
  PERPL_TESTNET_AUSD_TOKEN_ADDRESS,
} from "./network";

const ausdFaucetAbi = [
  {
    type: "error",
    name: "InsufficientFunds",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxAllowedExceeded",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxFrequencyExceeded",
    inputs: [],
  },
  {
    type: "function",
    name: "lastDripTimestamp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxDripFrequency",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "requestFunds",
    stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [],
  },
] as const;

const pendingAUsdFaucetKey = (address: Address) =>
  `perpl.testnet-ausd-faucet-tx.v1:${address.toLowerCase()}`;
const inFlightAUsdFaucetRequests = new Map<string, Promise<Hash>>();
const maxFrequencyExceededSelector = "0x20e5bc67";

export class PerplFaucetCooldownError extends Error {
  constructor(readonly remainingSeconds: number) {
    super(
      `The shared Agora AUSD faucet is on its global cooldown. Try again in about ${remainingSeconds} seconds. No transaction was sent.`,
    );
    this.name = "PerplFaucetCooldownError";
  }
}

async function getAUsdFaucetCooldown(chainId: number, faucetAddress: Address) {
  const chain = getAppChain(chainId);
  const block = await chain.publicClient.getBlock({ blockTag: "latest" });
  const [lastDripTimestamp, maxDripFrequency] = await Promise.all([
    chain.publicClient.readContract({
      address: faucetAddress,
      abi: ausdFaucetAbi,
      functionName: "lastDripTimestamp",
      blockNumber: block.number,
    }),
    chain.publicClient.readContract({
      address: faucetAddress,
      abi: ausdFaucetAbi,
      functionName: "maxDripFrequency",
      blockNumber: block.number,
    }),
  ]);
  const elapsed =
    block.timestamp > lastDripTimestamp
      ? block.timestamp - lastDripTimestamp
      : 0n;
  const remaining =
    maxDripFrequency > elapsed ? maxDripFrequency - elapsed : 0n;

  return {
    blockTimestamp: block.timestamp,
    lastDripTimestamp,
    maxDripFrequency,
    remainingSeconds: Number(remaining),
  };
}

const perplExchangeAbi = [
  {
    type: "function",
    name: "getAccountByAddr",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "accountId", type: "uint256" }],
  },
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [{ name: "accountId", type: "uint256" }],
  },
  {
    type: "function",
    name: "depositCollateral",
    stateMutability: "nonpayable",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawCollateral",
    stateMutability: "nonpayable",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "allowOrderForwarding",
    stateMutability: "nonpayable",
    inputs: [{ name: "allow", type: "bool" }],
    outputs: [],
  },
] as const;

export interface PerplProtocolConfig {
  chainId: number;
  exchangeAddress: Address;
  collateralAddress: Address;
  collateralSymbol: string;
  collateralDecimals: number;
  minAccountOpenAmount: bigint;
  minDepositAmount: bigint;
  minWithdrawAmount: bigint;
}

interface PerplPublicContext {
  chain: { chain_id: number };
  instances: {
    id: number;
    address: string;
    collateral_token_id: number;
    min_account_open_amount: string;
    min_deposit_amount: string;
    min_withdraw_amount: string;
  }[];
  tokens: {
    id?: number;
    address?: string;
    symbol: string;
    decimals: number;
  }[];
}

export async function fetchPerplProtocolConfig(): Promise<PerplProtocolConfig> {
  const response = await fetch(
    `${PERPL_NETWORKS.testnet.apiUrl}/v1/pub/context`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(
      `Perpl setup information is unavailable (${response.status}).`,
    );
  }
  const raw: unknown = await response.json();
  if (!isPerplPublicContext(raw)) {
    throw new Error("Perpl returned invalid setup information.");
  }

  const chainId = raw.chain.chain_id;
  if (chainId !== PERPL_NETWORKS.testnet.chainId) {
    throw new Error("Perpl returned configuration for the wrong network.");
  }
  const instance = raw.instances.find((candidate) =>
    isAddress(candidate.address),
  );
  const token = instance
    ? raw.tokens.find(
        (candidate) => candidate.id === instance.collateral_token_id,
      )
    : undefined;
  if (!instance || !token?.address || !isAddress(token.address)) {
    throw new Error("Perpl's collateral contract configuration is incomplete.");
  }

  return {
    chainId,
    exchangeAddress: getAddress(instance.address),
    collateralAddress: getAddress(token.address),
    collateralSymbol: token.symbol,
    collateralDecimals: token.decimals,
    minAccountOpenAmount: BigInt(instance.min_account_open_amount),
    minDepositAmount: BigInt(instance.min_deposit_amount),
    minWithdrawAmount: BigInt(instance.min_withdraw_amount),
  };
}

/** Requests Agora testnet AUSD, resuming a submitted transaction if needed. */
export function requestPerplTestnetAUsd(
  context: VenueOnboardingContext,
): Promise<Hash> {
  const walletAddress = requireWalletAddress(context);
  const requestKey = walletAddress.toLowerCase();
  const existingRequest = inFlightAUsdFaucetRequests.get(requestKey);
  if (existingRequest) {
    logPerplSetup("faucet_request_joining_in_flight_request", {
      walletAddress,
    });
    return existingRequest;
  }

  const request = performPerplTestnetAUsdRequest(context, walletAddress);
  inFlightAUsdFaucetRequests.set(requestKey, request);
  const clearInFlightRequest = () => {
    if (inFlightAUsdFaucetRequests.get(requestKey) === request) {
      inFlightAUsdFaucetRequests.delete(requestKey);
    }
  };
  void request.then(clearInFlightRequest, clearInFlightRequest);
  return request;
}

async function performPerplTestnetAUsdRequest(
  context: VenueOnboardingContext,
  walletAddress: Address,
) {
  const config = await fetchPerplProtocolConfig();
  if (config.collateralAddress !== PERPL_TESTNET_AUSD_TOKEN_ADDRESS) {
    logPerplSetup("faucet_request_blocked_collateral_changed", {
      walletAddress,
      chainId: config.chainId,
      collateralAddress: config.collateralAddress,
      expectedCollateralAddress: PERPL_TESTNET_AUSD_TOKEN_ADDRESS,
    });
    throw new Error(
      "Perpl's testnet collateral changed; automatic AUSD funding is unavailable.",
    );
  }
  const faucetAddress = PERPL_TESTNET_AUSD_FAUCET_ADDRESS;
  const storageKey = pendingAUsdFaucetKey(walletAddress);
  const chain = getAppChain(config.chainId);
  const storedHash = store.getString(storageKey);
  let hash: Hash | undefined;

  if (
    storedHash &&
    isHex(storedHash, { strict: true }) &&
    storedHash.length === 66
  ) {
    hash = storedHash;
    logPerplSetup("faucet_request_resuming_transaction", {
      walletAddress,
      chainId: config.chainId,
      collateralAddress: config.collateralAddress,
      faucetAddress,
      transactionHash: hash,
    });
  } else if (storedHash) {
    logPerplSetup("faucet_request_discarding_invalid_transaction_hash", {
      walletAddress,
      storedHash,
    });
    store.remove(storageKey);
  }

  if (!hash) {
    const cooldown = await getAUsdFaucetCooldown(config.chainId, faucetAddress);
    logPerplSetup("faucet_global_cooldown_checked", {
      walletAddress,
      chainId: config.chainId,
      faucetAddress,
      lastDripTimestamp: cooldown.lastDripTimestamp.toString(),
      maxDripFrequency: cooldown.maxDripFrequency.toString(),
      blockTimestamp: cooldown.blockTimestamp.toString(),
      remainingSeconds: cooldown.remainingSeconds,
    });
    if (cooldown.remainingSeconds > 0) {
      logPerplSetup("faucet_request_blocked_global_cooldown", {
        walletAddress,
        chainId: config.chainId,
        faucetAddress,
        remainingSeconds: cooldown.remainingSeconds,
      });
      throw new PerplFaucetCooldownError(cooldown.remainingSeconds);
    }

    logPerplSetup("faucet_request_simulation_started", {
      walletAddress,
      chainId: config.chainId,
      collateralAddress: config.collateralAddress,
      faucetAddress,
      recipient: walletAddress,
    });
    try {
      await chain.publicClient.simulateContract({
        account: walletAddress,
        address: faucetAddress,
        abi: ausdFaucetAbi,
        functionName: "requestFunds",
        args: [walletAddress],
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const isFrequencyLimited =
        errorMessage.toLowerCase().includes(maxFrequencyExceededSelector) ||
        errorMessage.toLowerCase().includes("maxfrequencyexceeded");
      logPerplSetup("faucet_request_simulation_failed", {
        walletAddress,
        chainId: config.chainId,
        faucetAddress,
        recipient: walletAddress,
        error: errorMessage,
        ...(isFrequencyLimited ? { errorName: "MaxFrequencyExceeded" } : {}),
      });
      if (isFrequencyLimited) {
        let remainingSeconds: number | undefined;
        try {
          const currentCooldown = await getAUsdFaucetCooldown(
            config.chainId,
            faucetAddress,
          );
          remainingSeconds = currentCooldown.remainingSeconds;
          logPerplSetup("faucet_global_cooldown_reread_after_revert", {
            walletAddress,
            chainId: config.chainId,
            faucetAddress,
            lastDripTimestamp: currentCooldown.lastDripTimestamp.toString(),
            maxDripFrequency: currentCooldown.maxDripFrequency.toString(),
            blockTimestamp: currentCooldown.blockTimestamp.toString(),
            remainingSeconds,
          });
        } catch (cooldownError) {
          logPerplSetup("faucet_global_cooldown_read_failed", {
            walletAddress,
            chainId: config.chainId,
            faucetAddress,
            error:
              cooldownError instanceof Error
                ? cooldownError.message
                : String(cooldownError),
          });
        }
        throw new PerplFaucetCooldownError(
          remainingSeconds && remainingSeconds > 0 ? remainingSeconds : 5,
        );
      }
      throw error;
    }
    logPerplSetup("faucet_request_simulation_succeeded", {
      walletAddress,
      chainId: config.chainId,
      faucetAddress,
      recipient: walletAddress,
    });
    const data = encodeFunctionData({
      abi: ausdFaucetAbi,
      functionName: "requestFunds",
      args: [walletAddress],
    });
    logPerplSetup("faucet_request_transaction_sending", {
      walletAddress,
      chainId: config.chainId,
      collateralAddress: config.collateralAddress,
      faucetAddress,
      recipient: walletAddress,
    });
    try {
      hash = await context.sendTransaction!(config.chainId, {
        to: faucetAddress,
        data,
      });
    } catch (error) {
      logPerplSetup("faucet_request_transaction_send_failed", {
        walletAddress,
        chainId: config.chainId,
        faucetAddress,
        recipient: walletAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logPerplSetup("faucet_request_transaction_submitted", {
      walletAddress,
      chainId: config.chainId,
      collateralAddress: config.collateralAddress,
      faucetAddress,
      recipient: walletAddress,
      transactionHash: hash,
    });
    store.set(storageKey, hash);
  }

  reportTransaction(context.onTransaction, config, hash, {
    kind: "funding",
    title: "Requested Perpl testnet AUSD",
    detail: "AUSD testnet faucet · Monad",
    status: "pending",
  });
  logPerplSetup("faucet_request_waiting_for_receipt", {
    walletAddress,
    chainId: config.chainId,
    faucetAddress,
    recipient: walletAddress,
    transactionHash: hash,
  });
  let receipt;
  try {
    receipt = await getAppPublicClient(
      config.chainId,
    ).waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (error) {
    logPerplSetup("faucet_request_receipt_wait_failed", {
      walletAddress,
      chainId: config.chainId,
      faucetAddress,
      recipient: walletAddress,
      transactionHash: hash,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  store.remove(storageKey);
  const status = receipt.status === "success" ? "confirmed" : "failed";
  logPerplSetup("faucet_request_receipt_received", {
    walletAddress,
    chainId: config.chainId,
    faucetAddress,
    recipient: walletAddress,
    transactionHash: hash,
    status,
    blockNumber: receipt.blockNumber.toString(),
  });
  reportTransaction(context.onTransaction, config, hash, {
    kind: "funding",
    title: "Requested Perpl testnet AUSD",
    detail: "AUSD testnet faucet · Monad",
    status,
  });
  if (receipt.status !== "success") {
    throw new Error("Perpl testnet AUSD faucet request failed on Monad.");
  }
  return hash;
}

export async function createPerplAccountOnChain(
  context: VenueOnboardingContext,
) {
  const walletAddress = requireWalletAddress(context);
  const config = await fetchPerplProtocolConfig();
  const chain = getAppChain(config.chainId);
  if (await hasPerplOnchainAccount(walletAddress, config)) {
    throw new Error("This wallet already has a Perpl exchange account.");
  }
  const balance = await chain.publicClient.readContract({
    address: config.collateralAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress],
  });
  if (balance < config.minAccountOpenAmount) {
    throw new Error(
      `Your Kites wallet needs at least ${formatUnits(config.minAccountOpenAmount, config.collateralDecimals)} ${config.collateralSymbol} on Monad testnet to create a Perpl account.`,
    );
  }

  await approveCollateralIfNeeded(context, config, config.minAccountOpenAmount);
  const amount = config.minAccountOpenAmount;
  await chain.publicClient.simulateContract({
    account: walletAddress,
    address: config.exchangeAddress,
    abi: perplExchangeAbi,
    functionName: "createAccount",
    args: [amount],
  });
  const data = encodeFunctionData({
    abi: perplExchangeAbi,
    functionName: "createAccount",
    args: [amount],
  });
  await sendAndConfirm(context, config, {
    to: config.exchangeAddress,
    data,
    kind: "funding",
    title: "Created Perpl account",
    detail: `Initial collateral · ${formatUnits(amount, config.collateralDecimals)} ${config.collateralSymbol} · Monad testnet`,
  });
}

export async function depositPerplCollateralOnChain(
  context: VenueOnboardingContext,
  amountInput?: string,
) {
  const walletAddress = requireWalletAddress(context);
  const config = await fetchPerplProtocolConfig();
  const chain = getAppChain(config.chainId);
  let amount = config.minDepositAmount;
  if (amountInput !== undefined) {
    try {
      amount = parseUnits(amountInput, config.collateralDecimals);
    } catch {
      throw new Error(
        `Enter an amount with no more than ${config.collateralDecimals} decimal places.`,
      );
    }
  }
  if (amount < config.minDepositAmount) {
    throw new Error(
      `Perpl's minimum collateral deposit is ${formatUnits(config.minDepositAmount, config.collateralDecimals)} ${config.collateralSymbol}.`,
    );
  }
  const balance = await chain.publicClient.readContract({
    address: config.collateralAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress],
  });
  if (balance < amount) {
    throw new Error(
      `Your Kites wallet needs ${formatUnits(amount, config.collateralDecimals)} ${config.collateralSymbol} on Monad testnet for this Perpl deposit.`,
    );
  }
  await approveCollateralIfNeeded(context, config, amount);
  await chain.publicClient.simulateContract({
    account: walletAddress,
    address: config.exchangeAddress,
    abi: perplExchangeAbi,
    functionName: "depositCollateral",
    args: [amount],
  });
  const data = encodeFunctionData({
    abi: perplExchangeAbi,
    functionName: "depositCollateral",
    args: [amount],
  });
  await sendAndConfirm(context, config, {
    to: config.exchangeAddress,
    data,
    kind: "funding",
    title: "Added Perpl collateral",
    detail: `${formatUnits(amount, config.collateralDecimals)} ${config.collateralSymbol} · Kites wallet → Perpl · Monad testnet`,
  });
}

export async function hasPerplOnchainAccount(
  walletAddress: Address,
  config?: PerplProtocolConfig,
) {
  const currentConfig = config ?? (await fetchPerplProtocolConfig());
  try {
    const accountId = await getAppPublicClient(
      currentConfig.chainId,
    ).readContract({
      address: currentConfig.exchangeAddress,
      abi: perplExchangeAbi,
      functionName: "getAccountByAddr",
      args: [getAddress(walletAddress)],
    });
    return accountId > 0n;
  } catch (error) {
    if (isContractRevert(error)) return false;
    throw error;
  }
}

export async function enablePerplOrderForwardingOnChain(
  context: VenueOnboardingContext,
  allowed = true,
) {
  const walletAddress = requireWalletAddress(context);
  const config = await fetchPerplProtocolConfig();
  await getAppPublicClient(config.chainId).simulateContract({
    account: walletAddress,
    address: config.exchangeAddress,
    abi: perplExchangeAbi,
    functionName: "allowOrderForwarding",
    args: [allowed],
  });
  const data = encodeFunctionData({
    abi: perplExchangeAbi,
    functionName: "allowOrderForwarding",
    args: [allowed],
  });
  await sendAndConfirm(context, config, {
    to: config.exchangeAddress,
    data,
    kind: "approval",
    title: allowed
      ? "Enabled Perpl order forwarding"
      : "Revoked Perpl order forwarding",
    detail: `${allowed ? "Enabled" : "Revoked"} persistent order permission · Perpl · Monad testnet`,
  });
}

export async function withdrawPerplCollateralOnChain(input: {
  walletAddress: Address;
  amount: string;
  availableBalance: bigint;
  sendTransaction: (
    chainId: number,
    transaction: { to: Address; data: Hex; value?: bigint },
  ) => Promise<Hex>;
  onTransaction?: (transaction: VenueOnboardingTransaction) => void;
}): Promise<Hex> {
  const config = await fetchPerplProtocolConfig();
  const amount = parseUnits(input.amount, config.collateralDecimals);
  if (amount < config.minWithdrawAmount) {
    throw new Error(
      `Perpl's minimum withdrawal is ${formatUnits(config.minWithdrawAmount, config.collateralDecimals)} ${config.collateralSymbol}.`,
    );
  }
  if (amount > input.availableBalance) {
    throw new Error("The amount exceeds your available Perpl balance.");
  }
  const chain = getAppChain(config.chainId);
  await chain.publicClient.simulateContract({
    account: input.walletAddress,
    address: config.exchangeAddress,
    abi: perplExchangeAbi,
    functionName: "withdrawCollateral",
    args: [amount],
  });
  const data = encodeFunctionData({
    abi: perplExchangeAbi,
    functionName: "withdrawCollateral",
    args: [amount],
  });
  const hash = await input.sendTransaction(config.chainId, {
    to: config.exchangeAddress,
    data,
  });
  reportTransaction(input.onTransaction, config, hash, {
    kind: "funding",
    title: "Withdrew Perpl collateral",
    detail: `${input.amount} ${config.collateralSymbol} · Perpl → Kites wallet · Monad testnet`,
    status: "pending",
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  });
  const status = receipt.status === "success" ? "confirmed" : "failed";
  reportTransaction(input.onTransaction, config, hash, {
    kind: "funding",
    title: "Withdrew Perpl collateral",
    detail: `${input.amount} ${config.collateralSymbol} · Perpl → Kites wallet · Monad testnet`,
    status,
  });
  if (receipt.status !== "success") {
    throw new Error("Perpl rejected the withdrawal transaction.");
  }
  return hash;
}

export function perplAmountLabel(amount: bigint, decimals: number) {
  return formatUnits(amount, decimals);
}

async function approveCollateralIfNeeded(
  context: VenueOnboardingContext,
  config: PerplProtocolConfig,
  amount: bigint,
) {
  const walletAddress = requireWalletAddress(context);
  const chain = getAppChain(config.chainId);
  const allowance = await chain.publicClient.readContract({
    address: config.collateralAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [walletAddress, config.exchangeAddress],
  });
  if (allowance === amount) return;
  const approve = async (value: bigint) => {
    await chain.publicClient.simulateContract({
      account: walletAddress,
      address: config.collateralAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [config.exchangeAddress, value],
    });
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [config.exchangeAddress, value],
    });
    return sendAndConfirm(context, config, {
      to: config.collateralAddress,
      data,
      kind: "approval",
      title:
        value === 0n
          ? "Reset Perpl collateral approval"
          : "Approved Perpl collateral",
      detail:
        value === 0n
          ? "Cleared previous Perpl token allowance · Monad testnet"
          : `${formatUnits(value, config.collateralDecimals)} ${config.collateralSymbol} · exact amount · Monad testnet`,
    });
  };
  if (allowance > 0n) await approve(0n);
  await approve(amount);
}

async function sendAndConfirm(
  context: VenueOnboardingContext,
  config: PerplProtocolConfig,
  input: {
    to: Address;
    data: Hex;
    kind: VenueOnboardingTransaction["kind"];
    title: string;
    detail: string;
  },
) {
  if (!context.sendTransaction) {
    throw new Error("Unlock your Kites wallet before setting up Perpl.");
  }
  const hash = await context.sendTransaction(config.chainId, {
    to: input.to,
    data: input.data,
  });
  reportTransaction(context.onTransaction, config, hash, {
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    status: "pending",
  });
  const receipt = await getAppPublicClient(
    config.chainId,
  ).waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  });
  const status = receipt.status === "success" ? "confirmed" : "failed";
  reportTransaction(context.onTransaction, config, hash, {
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    status,
  });
  if (receipt.status !== "success") {
    throw new Error("The Perpl setup transaction failed on Monad.");
  }
  return hash;
}

function reportTransaction(
  callback: VenueOnboardingContext["onTransaction"],
  config: PerplProtocolConfig,
  hash: Hex,
  input: Omit<VenueOnboardingTransaction, "chainId" | "hash">,
) {
  callback?.({ chainId: config.chainId, hash, ...input });
}

function requireWalletAddress(context: VenueOnboardingContext): Address {
  if (!context.walletAddress || !context.sendTransaction) {
    throw new Error("Unlock your Kites wallet before setting up Perpl.");
  }
  return getAddress(context.walletAddress);
}

function isPerplPublicContext(value: unknown): value is PerplPublicContext {
  if (!isRecord(value) || !isRecord(value.chain)) return false;
  if (
    typeof value.chain.chain_id !== "number" ||
    !Array.isArray(value.instances) ||
    !Array.isArray(value.tokens)
  ) {
    return false;
  }
  return (
    value.instances.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "number" &&
        typeof item.address === "string" &&
        typeof item.collateral_token_id === "number" &&
        isPositiveIntegerString(item.min_account_open_amount) &&
        isPositiveIntegerString(item.min_deposit_amount) &&
        isPositiveIntegerString(item.min_withdraw_amount),
    ) &&
    value.tokens.every(
      (item) =>
        isRecord(item) &&
        (item.id === undefined || typeof item.id === "number") &&
        (item.address === undefined || typeof item.address === "string") &&
        typeof item.symbol === "string" &&
        typeof item.decimals === "number",
    )
  );
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContractRevert(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const description = `${current.name} ${current.message}`.toLowerCase();
    if (
      description.includes("execution reverted") ||
      description.includes("contract function reverted") ||
      description.includes("revert reason")
    ) {
      return true;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
