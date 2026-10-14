import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";

import { api } from "~/lib/utils/api";

export const marketPostLinksQueryKey = ["marketPostLinks"] as const;

export const useMarketPostLinks = (postUris: string[]) => {
  const uniquePostUris = useMemo(() => [...new Set(postUris)], [postUris]);
  const apiUtils = api.useUtils();
  const query = useQuery({
    queryKey: [...marketPostLinksQueryKey, uniquePostUris],
    queryFn: async () => {
      const batches = [];
      for (let index = 0; index < uniquePostUris.length; index += 1000) {
        batches.push(
          apiUtils.markets.byPostUris.fetch({
            postUris: uniquePostUris.slice(index, index + 1000),
          }),
        );
      }
      return (await Promise.all(batches)).flat();
    },
    enabled: uniquePostUris.length > 0,
    staleTime: 60_000,
  });
  const marketByPostUri = useMemo(
    () =>
      new Map(
        query.data?.map(
          (link) => [link.postUri, link.marketAddress] as [string, Address],
        ),
      ),
    [query.data],
  );

  return { query, marketByPostUri };
};
