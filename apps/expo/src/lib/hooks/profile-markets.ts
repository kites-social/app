import { useInfiniteQuery } from "@tanstack/react-query";

import { useAgent } from "~/lib/agent";
import { api } from "~/lib/utils/api";

export const profileMarketsQueryKey = ["profileMarkets"] as const;
export const PROFILE_MARKETS_PAGE_SIZE = 20;

export const useProfileMarkets = (creatorDid: string) => {
  const agent = useAgent();
  const apiUtils = api.useUtils();

  return useInfiniteQuery({
    queryKey: [...profileMarketsQueryKey, creatorDid, agent.session?.did],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await apiUtils.markets.byCreatorDid.fetch({
        creatorDid,
        cursor: pageParam,
        limit: PROFILE_MARKETS_PAGE_SIZE,
      });
      const postUris = page.items.flatMap((item) =>
        item.postUri ? [item.postUri] : [],
      );
      let posts: Awaited<ReturnType<typeof agent.getPosts>>["data"]["posts"] =
        [];

      if (postUris.length > 0) {
        try {
          const response = await agent.getPosts({ uris: postUris });
          posts = response.data.posts;
        } catch {
          // Keep market rows visible when an associated post cannot be fetched.
        }
      }

      return { ...page, posts };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
  });
};
