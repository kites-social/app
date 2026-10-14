import { useQuery } from "@tanstack/react-query";
import { zeroAddress, type Address } from "viem";

import { MarketAbi } from "../abis/market";
import { resolutionHubAbi } from "../abis/resolution-hub";
import { monadTestnet, monadTestnetPublicClient } from "../client";

const staleTime = 15_000;

export const useMarketDetails = (
  marketAddress?: Address,
  account: Address = zeroAddress,
  refetchInterval: number | false = false,
) =>
  useQuery({
    queryKey: ["web3", monadTestnet.id, "market", marketAddress, account],
    enabled: Boolean(marketAddress),
    staleTime,
    refetchInterval: (query) =>
      query.state.data?.market.resolved ? false : refetchInterval,
    queryFn: async () => {
      if (!marketAddress) throw new Error("A market address is required");

      const [market, pools] = await monadTestnetPublicClient.multicall({
        contracts: [
          {
            address: marketAddress,
            abi: MarketAbi,
            functionName: "getMarketData",
            args: [account],
          },
          {
            address: marketAddress,
            abi: MarketAbi,
            functionName: "getPoolState",
          },
        ] as const,
        allowFailure: false,
      });

      return { market, pools };
    },
  });

export const useChainTimestamp = () =>
  useQuery({
    queryKey: ["web3", monadTestnet.id, "chain-timestamp"],
    staleTime: 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const block = await monadTestnetPublicClient.getBlock({
        blockTag: "latest",
      });
      return block.timestamp;
    },
  });

export const useMarketResolution = (
  marketAddress?: Address,
  resolutionHub?: Address,
  enabled = false,
  refetchInterval: number | false = false,
) =>
  useQuery({
    queryKey: [
      "web3",
      monadTestnet.id,
      "market-resolution",
      marketAddress,
      resolutionHub,
    ],
    enabled: Boolean(enabled && marketAddress && resolutionHub),
    staleTime,
    refetchInterval,
    queryFn: async () => {
      if (!marketAddress || !resolutionHub) {
        throw new Error("A market and resolution hub address are required");
      }

      const [resolution, settings] = await monadTestnetPublicClient.multicall({
        contracts: [
          {
            address: resolutionHub,
            abi: resolutionHubAbi,
            functionName: "resolutions",
            args: [marketAddress],
          },
          {
            address: resolutionHub,
            abi: resolutionHubAbi,
            functionName: "settings",
          },
        ] as const,
        allowFailure: false,
      });

      return {
        phase: resolution[0],
        proposedOutcome: resolution[1],
        firstDisputer: resolution[8],
        deadline: resolution[11],
        resolverBondAmount: settings[0],
      };
    },
  });
