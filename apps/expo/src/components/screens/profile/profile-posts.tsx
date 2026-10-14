import { useEffect, useMemo, useRef } from "react";
import { LogBox } from "react-native";
import { Tabs } from "react-native-collapsible-tab-view";
import { RefreshControl } from "react-native-gesture-handler";
import { AppBskyFeedDefs, AppBskyFeedPost } from "@atproto/api";

import { ListFooterComponent } from "~/components/list-footer";
import { useTabPressScrollRef } from "~/lib/hooks";
import { useMarketPostLinks } from "~/lib/hooks/market-posts";
import { useUserRefresh } from "~/lib/utils/query";
import { subscribeToPolymarketEvent } from "~/lib/venues/prediction-markets/polymarket";
import { isPolymarketEmbedView } from "~/lib/venues/prediction-markets/polymarket/embed";
import { FeedPost } from "../../feed-post";
import { useProfile, useProfilePosts } from "./hooks";

LogBox.ignoreLogs(["FlashList only supports padding related props"]);

// vendored react-merge-refs due to import issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeRefs<T = any>(
  refs: (React.MutableRefObject<T> | React.Ref<T>)[],
): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(value);
      } else if (ref != null) {
        (ref as React.MutableRefObject<T | null>).current = value;
      }
    });
  };
}

interface Props {
  did: string;
  mode: "posts" | "replies" | "likes" | "media";
}

export const ProfilePosts = ({ did, mode }: Props) => {
  const { preferences, timeline, timelineData } = useProfilePosts(mode, did);
  const polymarketEvents = useMemo(() => {
    const events = new Map<string, { slug: string; marketSlug?: string }>();
    for (const { item } of timelineData) {
      const event = getPolymarketEventReference(item.post);
      if (!event) continue;
      events.set(JSON.stringify([event.slug, event.marketSlug]), event);
    }
    return [...events];
  }, [timelineData]);
  const polymarketSubscriptions = useRef(new Map<string, () => void>());
  useEffect(() => {
    const subscriptions = polymarketSubscriptions.current;
    const requiredEvents = new Map(polymarketEvents);

    for (const [key, unsubscribe] of subscriptions) {
      if (!requiredEvents.has(key)) {
        unsubscribe();
        subscriptions.delete(key);
      }
    }

    for (const [key, event] of requiredEvents) {
      if (subscriptions.has(key)) continue;
      const unsubscribe = subscribeToPolymarketEvent(
        event.slug,
        () => {},
        undefined,
        event.marketSlug,
      );
      if (unsubscribe) subscriptions.set(key, unsubscribe);
    }
  }, [polymarketEvents]);
  useEffect(
    () => () => {
      for (const unsubscribe of polymarketSubscriptions.current.values()) {
        unsubscribe();
      }
      polymarketSubscriptions.current.clear();
    },
    [],
  );
  const marketPostUris = useMemo(
    () => timelineData.map(({ item }) => item.post.uri),
    [timelineData],
  );
  const { query: marketPostLinksQuery, marketByPostUri } =
    useMarketPostLinks(marketPostUris);

  const profile = useProfile(did);

  const [ref, onScroll] = useTabPressScrollRef<(typeof timelineData)[number]>(
    timeline.refetch,
  );

  const { refreshing, handleRefresh, tintColor } = useUserRefresh(
    timeline.refetch,
  );

  if (profile.data?.viewer?.blocking) {
    return null;
  } else if (profile.data?.viewer?.blockedBy) {
    return null;
  } else {
    return (
      <Tabs.FlashList<(typeof timelineData)[number]>
        removeClippedSubviews
        ref={ref}
        onScroll={onScroll}
        data={preferences.data ? timelineData : []}
        renderItem={({ item, index }) => (
          <FeedPost
            {...item}
            // TODO: investigate & fix error with isReply logic below
            isReply={mode === "replies" && timelineData[index - 1]?.hasReply}
            inlineParent={mode !== "replies"}
            dataUpdatedAt={timeline.dataUpdatedAt}
            marketAddress={marketByPostUri.get(item.item.post.uri)}
            marketLookupComplete={marketPostLinksQuery.isSuccess}
          />
        )}
        onEndReachedThreshold={2}
        onEndReached={() => timeline.fetchNextPage()}
        ListFooterComponent={<ListFooterComponent query={timeline} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={tintColor}
          />
        }
      />
    );
  }
};

const getPolymarketEventReference = (post: AppBskyFeedDefs.PostView) => {
  if (!AppBskyFeedPost.isRecord(post.record)) return undefined;
  const recordEmbed = post.record.embed;
  const embed = isPolymarketEmbedView(recordEmbed)
    ? recordEmbed
    : isPolymarketEmbedView(post.embed)
      ? post.embed
      : undefined;
  return embed
    ? {
        slug: embed.slug,
        ...(embed.marketSlug ? { marketSlug: embed.marketSlug } : {}),
      }
    : undefined;
};
