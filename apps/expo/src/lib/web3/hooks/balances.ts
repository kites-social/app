import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";

import { erc20Abi } from "../abis/erc20";
import { getAppChain } from "../chains";
import { monadTestnet, monadTestnetPublicClient } from "../client";
import { COLLATERAL_TOKEN_ADDRESS } from "../constants";

export const web3BalancesQueryKey = [
  "web3",
  monadTestnet.id,
  "balances",
] as const;
export const appChainBalancesQueryKey = ["web3", "chain-balances"] as const;
const staleTime = 15_000;

export const useAppChainBalances = (
  account: Address | undefined,
  chainId: number,
) => {
  const chain = getAppChain(chainId);
  return useQuery({
    queryKey: [...appChainBalancesQueryKey, chainId, account],
    enabled: Boolean(account),
    staleTime,
    queryFn: async () => {
      if (!account) throw new Error("An account address is required");
      const [native, ...tokens] = await Promise.all([
        chain.publicClient.getBalance({ address: account }),
        ...chain.tokens.map((token) =>
          chain.publicClient.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          }),
        ),
      ]);
      return {
        native,
        tokens: chain.tokens.map((token, index) => ({
          ...token,
          balance: tokens[index] ?? BigInt(0),
        })),
      };
    },
  });
};

export const useMonBalance = (account?: Address) =>
  useQuery({
    queryKey: [...web3BalancesQueryKey, "mon", account],
    enabled: Boolean(account),
    staleTime,
    queryFn: () => {
      if (!account) throw new Error("An account address is required");
      return monadTestnetPublicClient.getBalance({ address: account });
    },
  });

export const useErc20Balance = (
  account?: Address,
  tokenAddress: Address = COLLATERAL_TOKEN_ADDRESS,
) =>
  useQuery({
    queryKey: [...web3BalancesQueryKey, "erc20", tokenAddress, account],
    enabled: Boolean(account),
    staleTime,
    queryFn: () => {
      if (!account) throw new Error("An account address is required");

      return monadTestnetPublicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
    },
  });
