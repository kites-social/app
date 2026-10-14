import { useMemo } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  View,
} from "react-native";
import { Tabs } from "react-native-collapsible-tab-view";
import { Link } from "expo-router";
import {
  AppBskyFeedPost,
  type AppBskyActorDefs,
  type AppBskyFeedDefs,
} from "@atproto/api";
import { Trans } from "@lingui/macro";
import { useTheme } from "@react-navigation/native";

import { Avatar } from "~/components/avatar";
import { FeedPost } from "~/components/feed-post";
import { ListFooterComponent } from "~/components/list-footer";
import { QueryWithoutData } from "~/components/query-without-data";
import { Text } from "~/components/themed/text";
import { PredictionMarketCard } from "~/components/widgets/markets/prediction/custom-contract-card";
import { useAbsolutePath } from "~/lib/absolute-path-context";
import { useTabPressScrollRef } from "~/lib/hooks";
import { useContentFilter, type FilterResult } from "~/lib/hooks/preferences";
import { useProfileMarkets } from "~/lib/hooks/profile-markets";
import { type RouterOutputs } from "~/lib/utils/api";
import { useUserRefresh } from "~/lib/utils/query";
import { useProfile } from "./hooks";

interface Props {
  did: string;
}

type MarketItem = RouterOutputs["markets"]["byCreatorDid"]["items"][number];

export const ProfileMarkets = ({ did }: Props) => {
  const query = useProfileMarkets(did);
  const profile = useProfile(did);
  const { contentFilter } = useContentFilter();
  const pages = query.data?.pages ?? [];
  const postsByUri = useMemo(
    () =>
      new Map(
        pages.flatMap((page) =>
          page.posts.map((post) => [post.uri, post] as const),
        ),
      ),
    [pages],
  );
  const items = useMemo(
    () =>
      pages
        .flatMap((page) => page.items)
        .sort((left, right) => {
          const leftTime = getMarketPostTime(left, postsByUri);
          const rightTime = getMarketPostTime(right, postsByUri);
          if (leftTime !== rightTime) {
            if (leftTime === null) return 1;
            if (rightTime === null) return -1;
            return rightTime - leftTime;
          }
          return right.creatorIndex - left.creatorIndex;
        }),
    [pages, postsByUri],
  );
  const [ref, onScroll] = useTabPressScrollRef<MarketItem>(query.refetch);
  const { refreshing, handleRefresh, tintColor } = useUserRefresh(
    query.refetch,
  );

  if (profile.data?.viewer?.blocking || profile.data?.viewer?.blockedBy) {
    return null;
  }

  return (
    <Tabs.FlashList<MarketItem>
      removeClippedSubviews
      ref={ref}
      onScroll={onScroll}
      data={items}
      keyExtractor={(item) => item.marketAddress.toLowerCase()}
      renderItem={({ item }) => {
        const post = item.postUri ? postsByUri.get(item.postUri) : undefined;
        return (
          <MarketListItem
            item={item}
            post={post}
            filter={contentFilter(post?.labels)}
            dataUpdatedAt={query.dataUpdatedAt}
            profile={profile.data}
          />
        );
      }}
      onEndReachedThreshold={2}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) {
          void query.fetchNextPage();
        }
      }}
      ListEmptyComponent={
        query.isError && !query.data ? (
          <QueryWithoutData query={query} />
        ) : (
          <View className="px-4 py-16">
            {query.isFetching ? (
              <ActivityIndicator />
            ) : (
              <Text className="text-center text-neutral-500 dark:text-neutral-400">
                <Trans>No markets created yet.</Trans>
              </Text>
            )}
          </View>
        )
      }
      ListFooterComponent={
        items.length > 0 ? <ListFooterComponent query={query} /> : null
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={tintColor}
        />
      }
    />
  );
};

const MarketListItem = ({
  item,
  post,
  filter,
  dataUpdatedAt,
  profile,
}: {
  item: MarketItem;
  post?: AppBskyFeedDefs.PostView;
  filter: FilterResult;
  dataUpdatedAt: number;
  profile?: AppBskyActorDefs.ProfileViewDetailed;
}) => {
  const theme = useTheme();
  const path = useAbsolutePath();
  const postPath = item.postUri ? getPostPath(item.postUri) : undefined;

  if (post && AppBskyFeedPost.isRecord(post.record)) {
    return (
      <FeedPost
        item={{ post }}
        filter={filter}
        dataUpdatedAt={dataUpdatedAt}
        marketAddress={item.marketAddress}
        marketLookupComplete
      />
    );
  }

  return (
    <View
      className="flex-1 flex-row border-b px-2 pt-2"
      style={{
        backgroundColor: theme.colors.card,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View className="items-center px-2">
        <Avatar
          uri={profile?.avatar}
          alt={profile?.displayName ?? profile?.handle}
          size="medium"
        />
      </View>
      <View className="flex-1 pb-3 pl-1 pr-2">
        <View className="flex-row items-center">
          <Text numberOfLines={1} className="shrink font-semibold">
            {profile?.displayName ??
              (profile?.handle ? (
                `@${profile.handle}`
              ) : (
                <Trans>Market creator</Trans>
              ))}
          </Text>
          {profile?.handle && profile.displayName && (
            <Text
              numberOfLines={1}
              className="ml-1 shrink text-neutral-500 dark:text-neutral-400"
            >
              @{profile.handle}
            </Text>
          )}
        </View>
        <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {item.postUri ? (
            <Trans>The associated post could not be loaded.</Trans>
          ) : (
            <Trans>
              This market is not associated with a post as the author may have
              deleted it.
            </Trans>
          )}
        </Text>
        {postPath && (
          <Link href={path(postPath)} asChild>
            <TouchableOpacity
              accessibilityRole="link"
              className="mt-1 self-start"
            >
              <Text primary className="font-medium">
                <Trans>Open associated post</Trans>
              </Text>
            </TouchableOpacity>
          </Link>
        )}
        <PredictionMarketCard marketAddress={item.marketAddress} compact />
      </View>
    </View>
  );
};

const getPostPath = (postUri: string) => {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(
    postUri,
  );
  return match ? `/profile/${match[1]}/post/${match[2]}` : undefined;
};

const getMarketPostTime = (
  item: MarketItem,
  postsByUri: ReadonlyMap<string, AppBskyFeedDefs.PostView>,
) => {
  const post = item.postUri ? postsByUri.get(item.postUri) : undefined;
  const postCreatedAt = parseTimestamp(
    post?.record &&
      typeof post.record === "object" &&
      "createdAt" in post.record
      ? post.record.createdAt
      : null,
  );
  if (postCreatedAt !== null) return postCreatedAt;

  return parseTimestamp(item.associationCreatedAt);
};

const parseTimestamp = (value: unknown) => {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};
