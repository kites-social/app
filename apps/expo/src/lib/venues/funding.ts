import {
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type LocalAccount,
} from "viem";
import { polygon } from "viem/chains";

import { erc20Abi, getAppChain } from "~/lib/web3";
import { sendAppToken } from "~/lib/web3/custody";

export const polymarketFundingAdapter = {
  venue: "Polymarket",
  sourceChainId: polygon.id,
  sourceNetwork: "Polygon",
  destinationNetwork: "Polygon",
  token: {
    symbol: "pUSD",
    name: "Polymarket USD",
    address: getAddress("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"),
    decimals: 6,
  },
  routeDescription: "Direct transfer on Polygon. No bridge is used.",
} as const;

export interface PolymarketFundingQuote {
  amount: string;
  sourceBalance: string;
  sourceNativeBalance: string;
  estimatedNetworkFee: string | null;
  hasEnoughToken: boolean;
  hasEnoughGas: boolean | null;
}

export async function getPolymarketTokenBalance(address: Address) {
  const chain = getAppChain(polymarketFundingAdapter.sourceChainId);
  return chain.publicClient.readContract({
    address: polymarketFundingAdapter.token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  });
}

/** Quotes a direct pUSD transfer into the user's Polymarket deposit wallet. */
export async function quotePolymarketFunding(
  source: Address,
  destination: Address,
  amount: string,
): Promise<PolymarketFundingQuote> {
  const chain = getAppChain(polymarketFundingAdapter.sourceChainId);
  const tokenAddress = polymarketFundingAdapter.token.address;
  let parsedAmount: bigint;
  try {
    parsedAmount = parseUnits(amount, polymarketFundingAdapter.token.decimals);
  } catch {
    throw new Error("Enter a valid pUSD amount with up to 6 decimal places.");
  }
  if (parsedAmount <= BigInt(0)) {
    throw new Error("Enter an amount greater than zero.");
  }

  const [sourceBalance, sourceNativeBalance] = await Promise.all([
    chain.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [source],
    }),
    chain.publicClient.getBalance({ address: source }),
  ]);
  const hasEnoughToken = sourceBalance >= parsedAmount;
  if (!hasEnoughToken) {
    return {
      amount,
      sourceBalance: formatUnits(
        sourceBalance,
        polymarketFundingAdapter.token.decimals,
      ),
      sourceNativeBalance: formatUnits(sourceNativeBalance, 18),
      estimatedNetworkFee: null,
      hasEnoughToken: false,
      hasEnoughGas: null,
    };
  }

  const gas = await chain.publicClient.estimateContractGas({
    account: source,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(destination), parsedAmount],
  });
  const feeQuote = await chain.publicClient.estimateFeesPerGas();
  const feePerGas = feeQuote.maxFeePerGas ?? feeQuote.gasPrice;
  if (feePerGas === undefined) {
    throw new Error("Could not estimate the Polygon network fee.");
  }
  const estimatedFee = gas * feePerGas;

  return {
    amount,
    sourceBalance: formatUnits(
      sourceBalance,
      polymarketFundingAdapter.token.decimals,
    ),
    sourceNativeBalance: formatUnits(sourceNativeBalance, 18),
    estimatedNetworkFee: formatUnits(estimatedFee, 18),
    hasEnoughToken: true,
    hasEnoughGas: sourceNativeBalance >= estimatedFee,
  };
}

export function sendToPolymarket(
  account: LocalAccount<"mera">,
  destination: Address,
  amount: string,
) {
  return sendAppToken(account, {
    chainId: polymarketFundingAdapter.sourceChainId,
    recipient: destination,
    amount,
    decimals: polymarketFundingAdapter.token.decimals,
    tokenAddress: polymarketFundingAdapter.token.address,
  });
}
