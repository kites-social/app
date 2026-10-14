import {
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hash,
  type LocalAccount,
} from "viem";

import { erc20Abi } from "../abis/erc20";
import { getAppChain } from "../chains";

export interface TokenTransferIntent {
  chainId: number;
  recipient: Address;
  amount: string;
  decimals: number;
  tokenAddress?: Address;
}

type TransferFeeParameters =
  | { gasPrice: bigint }
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

const requireSigningAccount = (
  account: LocalAccount<"mera">,
): LocalAccount<"mera"> => {
  if (!account.signTransaction) {
    throw new Error("The wallet session cannot sign transactions.");
  }
  return account;
};

const parseTransferAmount = (amount: string, decimals: number) => {
  let value: bigint;
  try {
    value = parseUnits(amount, decimals);
  } catch {
    throw new Error(
      `Enter an amount with no more than ${decimals} decimal places.`,
    );
  }
  if (value <= BigInt(0)) {
    throw new Error("Transfer amount must be greater than zero.");
  }
  return value;
};

const bumpTransferFee = (fee: bigint) =>
  (fee * BigInt(110) + BigInt(99)) / BigInt(100);

const estimateTransferFees = async (
  chain: ReturnType<typeof getAppChain>,
): Promise<TransferFeeParameters> => {
  const feeQuote = await chain.publicClient.estimateFeesPerGas();
  if (
    feeQuote.maxFeePerGas !== undefined &&
    feeQuote.maxPriorityFeePerGas !== undefined
  ) {
    return {
      maxFeePerGas: bumpTransferFee(feeQuote.maxFeePerGas),
      maxPriorityFeePerGas: bumpTransferFee(feeQuote.maxPriorityFeePerGas),
    };
  }
  if (feeQuote.gasPrice !== undefined) {
    return { gasPrice: bumpTransferFee(feeQuote.gasPrice) };
  }
  throw new Error("Could not estimate network transaction fees.");
};

const assertGasFunds = (
  chain: ReturnType<typeof getAppChain>,
  balance: bigint,
  gas: bigint,
  value: bigint,
  fees: TransferFeeParameters,
) => {
  const feePerGas = "gasPrice" in fees ? fees.gasPrice : fees.maxFeePerGas;
  if (balance < value + gas * feePerGas) {
    throw new Error(
      `Your ${chain.nativeSymbol} balance is too low to cover the transfer and network fees.`,
    );
  }
};

export async function sendAppToken(
  account: LocalAccount<"mera">,
  intent: TokenTransferIntent,
): Promise<Hash> {
  const chain = getAppChain(intent.chainId);
  const recipient = getAddress(intent.recipient);
  const sender = getAddress(account.address);
  if (sender === recipient) {
    throw new Error("Choose a different recipient than your own wallet.");
  }
  const signingAccount = requireSigningAccount(account);

  const walletClient = createWalletClient({
    account: signingAccount,
    chain: chain.chain,
    transport: http(),
  });

  if (!intent.tokenAddress) {
    if (intent.decimals !== chain.chain.nativeCurrency.decimals) {
      throw new Error("The selected native token configuration is invalid.");
    }
    const value = parseTransferAmount(intent.amount, intent.decimals);
    const [gas, fees, nativeBalance] = await Promise.all([
      chain.publicClient.estimateGas({
        account: sender,
        to: recipient,
        value,
      }),
      estimateTransferFees(chain),
      chain.publicClient.getBalance({ address: sender }),
    ]);
    assertGasFunds(chain, nativeBalance, gas, value, fees);
    return walletClient.sendTransaction({
      to: recipient,
      value,
      gas,
      ...fees,
    });
  }

  const tokenAddress = intent.tokenAddress;
  const token = chain.tokens.find(
    (candidate) => getAddress(candidate.address) === getAddress(tokenAddress),
  );
  if (!token || token.decimals !== intent.decimals) {
    throw new Error("The selected token is not supported on this network.");
  }

  const amount = parseTransferAmount(intent.amount, token.decimals);
  const [balance, simulation, gas, fees, nativeBalance] = await Promise.all([
    chain.publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sender],
    }),
    chain.publicClient.simulateContract({
      account: sender,
      address: token.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, amount],
    }),
    chain.publicClient.estimateContractGas({
      account: sender,
      address: token.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, amount],
    }),
    estimateTransferFees(chain),
    chain.publicClient.getBalance({ address: sender }),
  ]);
  if (balance < amount) {
    throw new Error(
      `Your ${token.symbol} balance is too low for this transfer.`,
    );
  }
  if (!simulation.result) {
    throw new Error(
      `The ${token.symbol} token contract rejected this transfer.`,
    );
  }

  assertGasFunds(chain, nativeBalance, gas, BigInt(0), fees);
  const transactionRequest = {
    account: signingAccount,
    address: token.address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amount],
    gas,
  } as const;
  if ("gasPrice" in fees) {
    return walletClient.writeContract({
      ...transactionRequest,
      gasPrice: fees.gasPrice,
    });
  }
  return walletClient.writeContract({
    ...transactionRequest,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}
