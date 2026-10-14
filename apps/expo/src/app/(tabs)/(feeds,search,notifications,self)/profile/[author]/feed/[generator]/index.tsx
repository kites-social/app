import { TouchableHighlight, TouchableOpacity } from "react-native";
import { Image } from "expo-image";
import { Link, Stack, useLocalSearchParams } from "expo-router";

import { FeedScreen } from "~/components/screens/feed-screen";
import { usePlainBackgroundColor } from "~/components/themed/background";
import { useAbsolutePath } from "~/lib/absolute-path-context";
import { useFeedInfo } from "~/lib/hooks/feeds";
import { isIOS26 } from "~/lib/utils/version";

export default function FeedsPage() {
  const path = useAbsolutePath();
  const { author, generator } = useLocalSearchParams<{
    author: string;
    generator: string;
  }>();

  const feed = `at://${author}/app.bsky.feed.generator/${generator}`;

  const info = useFeedInfo(feed);
  const backgroundColor = usePlainBackgroundColor();

  return (
    <>
      <Stack.Screen
        options={
          isIOS26
            ? {
                headerTransparent: true,
                contentStyle: { backgroundColor },
                unstable_headerRightItems: () => [
                  {
                    type: "custom",
                    hidesSharedBackground: true,
                    element: (
                      <Link
                        asChild
                        href={path(
                          `/profile/${author}/feed/${generator}/details`,
                        )}
                      >
                        <TouchableHighlight>
                          <Image
                            source={{ uri: info.data?.view.avatar }}
                            className="h-8 w-8 rounded-xl bg-[#00A96B]"
                            alt={info.data?.view.displayName}
                          />
                        </TouchableHighlight>
                      </Link>
                    ),
                  },
                ],
              }
            : {
                headerRight: () => (
                  <Link
                    asChild
                    href={path(`/profile/${author}/feed/${generator}/details`)}
                  >
                    <TouchableOpacity>
                      <Image
                        source={{ uri: info.data?.view.avatar }}
                        className="h-6 w-6 rounded-xl bg-[#00A96B]"
                        alt={info.data?.view.displayName}
                      />
                    </TouchableOpacity>
                  </Link>
                ),
              }
        }
      />
      <FeedScreen feed={feed} />
    </>
  );
}
