import {
  AppBskyActorDefs,
  AppBskyFeedDefs,
  AppBskyFeedPost,
} from "@atproto/api";
import { type Address } from "viem";

export const mockUser = {
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  handle: "mock-user.example.com",
  displayName: "Mira Chen",
  description: "A local-only profile for developing the feed UI.",
  followersCount: 128,
  followsCount: 94,
  postsCount: 4,
  createdAt: "2024-01-15T12:00:00.000Z",
  indexedAt: "2024-01-15T12:00:00.000Z",
} satisfies AppBskyActorDefs.ProfileViewDetailed;

export interface MockTimelineItem {
  item: AppBskyFeedDefs.FeedViewPost;
  hasReply: boolean;
  filter: null;
  predictionMarketCreator?: Address;
}

const predictionMarketDemoCreator =
  "0x53FC3C42f3F61d900DB572609537F9825a96E3f9" satisfies Address;

const now = Date.now();

const mockPostRecords = [
  {
    rkey: "mock-001",
    cid: "bafyreiawt366xpjwlue5r6imnx44imie7vn5jtt4crqcfisqq2jmsyuadm",
    text: "Hello hello hello, Will this test market resolve to yes?",
    minutesAgo: 8,
    likeCount: 12,
    repostCount: 3,
    replyCount: 2,
  },
  {
    rkey: "mock-002",
    cid: "bafyreidu7j7ieat5hwxpdvc4ao4lux5sdn3etyrm5mdxwuahstaf44lnv4",
    text: "Mock timelines make it easier to work on layouts without logging in or writing anything to Kites.",
    minutesAgo: 36,
    likeCount: 7,
    repostCount: 1,
    replyCount: 0,
  },
  {
    rkey: "mock-003",
    cid: "bafyreic4jab2226suzcu5pyc5x4qxwy7ih5i6rwdc5wbbuq6eowvnsmdty",
    text: "A longer sample post gives you room to check text wrapping, spacing, and custom feed components on a phone-sized screen.\n\nEverything here is fixture data; it never comes from or gets sent to an account.",
    minutesAgo: 125,
    likeCount: 24,
    repostCount: 5,
    replyCount: 4,
  },
  {
    rkey: "mock-004",
    cid: "bafyreiav2qwznyumtzxy5gtnmjbkkgogt3ut2gexmfdiab2otrpyypnywe",
    text: "Add your own UI around these posts and see how it looks in the normal Following feed.",
    minutesAgo: 1_440,
    likeCount: 3,
    repostCount: 0,
    replyCount: 1,
  },
] as const;

export const mockTimelineItems: MockTimelineItem[] = mockPostRecords.map(
  ({ rkey, cid, text, minutesAgo, likeCount, repostCount, replyCount }) => {
    const createdAt = new Date(now - minutesAgo * 60_000).toISOString();
    const item: AppBskyFeedDefs.FeedViewPost = {
      post: {
        uri: `at://${mockUser.did}/app.bsky.feed.post/${rkey}`,
        cid,
        author: mockUser,
        record: {
          $type: "app.bsky.feed.post",
          text,
          createdAt,
          langs: ["en"],
        } satisfies AppBskyFeedPost.Record,
        indexedAt: createdAt,
        likeCount,
        repostCount,
        replyCount,
      },
    };

    if (
      __DEV__ &&
      (!AppBskyFeedDefs.validateFeedViewPost(item).success ||
        !AppBskyFeedPost.validateRecord(item.post.record).success)
    ) {
      throw new Error(`Invalid development mock post: ${rkey}`);
    }

    return {
      item,
      hasReply: false,
      filter: null,
      ...(__DEV__ && rkey === "mock-001"
        ? { predictionMarketCreator: predictionMarketDemoCreator }
        : {}),
    };
  },
);

if (
  __DEV__ &&
  !AppBskyActorDefs.validateProfileViewDetailed(mockUser).success
) {
  throw new Error("Invalid development mock user");
}
