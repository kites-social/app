import { getAddress } from "viem";
import { monadTestnet } from "viem/chains";

import { type PerplNetwork } from "@kites-social/venues/src/perpetual-markets/perpl";

export type { PerplNetwork } from "@kites-social/venues/src/perpetual-markets/perpl";

// Use Perpl's own testnet origin while developing before Kites is allowlisted.
export const PERPL_ORIGIN = "https://testnet.perpl.xyz";
export const PERPL_TESTNET_AUSD_TOKEN_ADDRESS = getAddress(
  "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
);
export const PERPL_TESTNET_AUSD_FAUCET_ADDRESS = getAddress(
  "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
);

export const PERPL_NETWORKS: Record<
  PerplNetwork,
  {
    chainId: number;
    chainName: string;
    apiUrl: string;
    wsUrl: string;
    appUrl: string;
    apiKeysUrl: string;
  }
> = {
  testnet: {
    chainId: monadTestnet.id,
    chainName: "Monad",
    apiUrl: "https://testnet.perpl.xyz/api",
    wsUrl: "wss://testnet.perpl.xyz",
    appUrl: "https://testnet.perpl.xyz/trade/BTC",
    apiKeysUrl: "https://testnet.perpl.xyz/apikeys",
  },
};
