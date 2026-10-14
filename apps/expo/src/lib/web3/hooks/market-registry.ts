import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";

import { MarketFactoryAbi } from "../abis/market-factory";
import { monadTestnet, monadTestnetPublicClient } from "../client";
import { MARKET_FACTORY_ADDRESS } from "../constants";

const queryKey = ["web3", monadTestnet.id, "market-factory"] as const;
const staleTime = 15_000;

export const useCreatorMarkets = (creator?: Address) =>
  useQuery({
    queryKey: [...queryKey, "creator-markets", creator],
    enabled: Boolean(creator),
    staleTime,
    queryFn: () => {
      if (!creator) throw new Error("A creator address is required");

      return monadTestnetPublicClient.readContract({
        address: MARKET_FACTORY_ADDRESS,
        abi: MarketFactoryAbi,
        functionName: "creatorMarkets",
        args: [creator],
      });
    },
  });

export const useCreatorMarketCount = (creator?: Address) =>
  useQuery({
    queryKey: [...queryKey, "creator-market-count", creator],
    enabled: Boolean(creator),
    staleTime,
    queryFn: () => {
      if (!creator) throw new Error("A creator address is required");

      return monadTestnetPublicClient.readContract({
        address: MARKET_FACTORY_ADDRESS,
        abi: MarketFactoryAbi,
        functionName: "creatorMarketCount",
        args: [creator],
      });
    },
  });

export const useCreatorMarketAt = (creator?: Address, index?: bigint) =>
  useQuery({
    queryKey: [...queryKey, "creator-market-at", creator, index?.toString()],
    enabled: Boolean(creator && index !== undefined && index >= BigInt(0)),
    staleTime,
    queryFn: () => {
      if (!creator || index === undefined || index < BigInt(0)) {
        throw new Error(
          "A creator address and non-negative index are required",
        );
      }

      return monadTestnetPublicClient.readContract({
        address: MARKET_FACTORY_ADDRESS,
        abi: MarketFactoryAbi,
        functionName: "creatorMarketAt",
        args: [creator, index],
      });
    },
  });

export const useAllMarketsData = (account?: Address) =>
  useQuery({
    queryKey: [...queryKey, "all-markets-data", account],
    enabled: Boolean(account),
    staleTime,
    queryFn: () => {
      if (!account) throw new Error("An account address is required");

      return monadTestnetPublicClient.readContract({
        address: MARKET_FACTORY_ADDRESS,
        abi: MarketFactoryAbi,
        functionName: "getAllMarketsData",
        args: [account],
      });
    },
  });

export const useMarketCount = () =>
  useQuery({
    queryKey: [...queryKey, "market-count"],
    staleTime,
    queryFn: () =>
      monadTestnetPublicClient.readContract({
        address: MARKET_FACTORY_ADDRESS,
        abi: MarketFactoryAbi,
        functionName: "marketCount",
      }),
  });
