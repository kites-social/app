import { Stack } from "expo-router";

import { FeedScreen } from "~/components/screens/feed-screen";
import { isIOS26 } from "~/lib/utils/version";

export default function FeedPage() {
  return (
    <>
      {isIOS26 && <Stack.Screen options={{ headerTransparent: true }} />}
      <FeedScreen feed="following" />
    </>
  );
}
