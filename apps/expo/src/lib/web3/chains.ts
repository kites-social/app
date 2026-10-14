import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { monadTestnet, polygon } from "viem/chains";

const polygonRpcTransport = fallback([
  http("https://polygon-bor-rpc.publicnode.com"),
  http("https://polygon.drpc.org"),
]);

export interface ChainBalanceToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
}

export interface AppChain {
  id: number;
  name: string;
  chain: Chain;
  publicClient: PublicClient;
  nativeSymbol: string;
  tokens: ChainBalanceToken[];
}

const createChainClient = (chain: Chain): PublicClient =>
  createPublicClient({
    chain,
    transport: chain.id === polygon.id ? polygonRpcTransport : http(),
  }) as PublicClient;

export const appChains: AppChain[] = [
  {
    id: monadTestnet.id,
    name: "Monad Testnet",
    chain: monadTestnet,
    publicClient: createChainClient(monadTestnet),
    nativeSymbol: monadTestnet.nativeCurrency.symbol,
    tokens: [
      {
        symbol: "AUSD",
        name: "Agora USD",
        address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
        decimals: 6,
      },
    ],
  },
  {
    id: polygon.id,
    name: "Polygon",
    chain: polygon,
    publicClient: createChainClient(polygon),
    nativeSymbol: polygon.nativeCurrency.symbol,
    tokens: [
      {
        symbol: "pUSD",
        name: "Polymarket USD",
        address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
        decimals: 6,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        decimals: 6,
      },
    ],
  },
];

export const getAppChain = (chainId: number) => {
  const config = appChains.find((candidate) => candidate.id === chainId);
  if (!config) throw new Error(`Unsupported EVM chain: ${chainId}`);
  return config;
};

export const getAppPublicClient = (chainId: number) =>
  getAppChain(chainId).publicClient;
