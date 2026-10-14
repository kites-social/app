import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";

import { fetchPerplAccountSummary } from "./account";

export function usePerplAccount(
  walletAddress: Address | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["venues", "perpetual", "perpl", "account", walletAddress],
    queryFn: () => {
      if (!walletAddress) throw new Error("A Kites wallet is required.");
      return fetchPerplAccountSummary(walletAddress);
    },
    staleTime: 30_000,
    enabled: Boolean(walletAddress) && enabled,
  });
}
