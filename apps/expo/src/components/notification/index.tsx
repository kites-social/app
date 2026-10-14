import { TouchableHighlight, TouchableOpacity, View } from "react-native";
import { Link, useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { type Address } from "viem";

import { type NotificationGroup } from "~/app/(tabs)/(feeds,search,notifications,self)/notifications";
import { useAbsolutePath } from "~/lib/absolute-path-context";
import { useAgent } from "~/lib/agent";
import { useHaptics } from "~/lib/hooks/preferences";
import { timeSince } from "~/lib/utils/time";
import { Avatar } from "../avatar";
import { useLists } from "../lists/context";
import { Text } from "../themed/text";
import { NotificationItem } from "./item";
import { PostNotification } from "./post";

export const Notification = ({
  reason,
  subject,
  actors,
  isRead,
  indexedAt,
  dataUpdatedAt,
  item,
  marketAddress,
  marketLookupComplete,
}: NotificationGroup & {
  dataUpdatedAt: number;
  marketAddress?: Address;
  marketLookupComplete?: boolean;
}) => {
  const { openLikes, openFollowers, openReposts } = useLists();
  const agent = useAgent();
  const router = useRouter();
  const path = useAbsolutePath();
  const theme = useTheme();
  const { _ } = useLingui();

  let href: string | undefined;
  if (subject?.startsWith("at://")) {
    const [did, _, id] = subject.slice("at://".length).split("/");
    href = path(`/profile/${did}/post/${id}`);
  }

  const Container = ({ children }: React.PropsWithChildren) =>
    href ? (
      <Link href={href} asChild>
        <TouchableHighlight className="flex-1">{children}</TouchableHighlight>
      </Link>
    ) : (
      <View className="flex-1">{children}</View>
    );

  switch (reason) {
    case "like":
      return (
        <Container>
          <NotificationItem>
            <ProfileList
              actors={actors}
              action={_(msg`liked your post`)}
              indexedAt={indexedAt}
              showAll={() => subject && openLikes(subject, actors.length)}
            />
            {item && (
              <PostNotification
                item={item}
                unread={!isRead}
                inline
                dataUpdatedAt={dataUpdatedAt}
              />
            )}
          </NotificationItem>
        </Container>
      );
    case "repost":
      return (
        <Container>
          <NotificationItem>
            <ProfileList
              actors={actors}
              action={_(msg`reposted your post`)}
              indexedAt={indexedAt}
              showAll={() => subject && openReposts(subject, actors.length)}
            />
            {item && (
              <PostNotification
                item={item}
                unread={!isRead}
                inline
                dataUpdatedAt={dataUpdatedAt}
              />
            )}
          </NotificationItem>
        </Container>
      );
    case "follow":
      return (
        <TouchableHighlight
          onPress={() =>
            actors.length === 1
              ? router.push(path(`/profile/${actors[0]!.did}`))
              : openFollowers(agent.assertDid, actors.length)
          }
        >
          <NotificationItem>
            <ProfileList
              actors={actors}
              action={_(msg`started following you`)}
              indexedAt={indexedAt}
              showAll={() => openFollowers(agent.assertDid, actors.length)}
            />
          </NotificationItem>
        </TouchableHighlight>
      );
    case "reply":
    case "quote":
    case "mention":
      if (!subject || !item) return null;
      return (
        <PostNotification
          item={item}
          unread={!isRead}
          dataUpdatedAt={dataUpdatedAt}
          marketAddress={marketAddress}
          marketLookupComplete={marketLookupComplete}
        />
      );
    default:
      console.warn("Unknown notification reason", reason);
      return null;
  }
};

const ProfileList = ({
  actors,
  action,
  indexedAt,
  showAll,
}: Pick<NotificationGroup, "actors" | "indexedAt"> & {
  action: string;
  showAll: () => void;
}) => {
  const theme = useTheme();
  const haptics = useHaptics();
  const router = useRouter();
  const path = useAbsolutePath();
  const { _, i18n } = useLingui();

  if (!actors[0]) return null;
  const timeSinceNotif = timeSince(new Date(indexedAt), i18n);

  return (
    <View className="flex-1 flex-row items-start">
      <View className="h-8 flex-row">
        <View className="h-8 max-w-[80px] flex-row overflow-hidden">
          {actors.slice(0, 2).map((actor, index) => (
            <Link
              href={path(`/profile/${actor.did}`)}
              asChild
              key={actor.did}
              accessibilityHint={_(msg`Opens profile`)}
            >
              <TouchableOpacity className="mr-2 rounded-full">
                <Avatar
                  uri={actor.avatar}
                  alt={
                    // TODO: find a better way to handle this
                    action === _(msg`started following you`)
                      ? _(
                          index === 0
                            ? msg`New follower: ${actor.displayName} @${actor.handle}`
                            : msg`${actor.displayName} @${actor.handle}`,
                        )
                      : ""
                  }
                  size="smallMedium"
                />
              </TouchableOpacity>
            </Link>
          ))}
        </View>
        {actors.length > 2 && (
          <TouchableOpacity
            onPress={() => {
              haptics.selection();
              showAll();
            }}
            className="mr-2 h-8 items-center justify-center rounded-full px-2"
            style={{
              backgroundColor: theme.dark ? "#233128" : "#EAF7EF",
            }}
          >
            <Text className="font-medium" primary>
              +{actors.length - 2}
            </Text>
          </TouchableOpacity>
        )}
      </View>
      <View className="flex-1">
        <Text className="text-base">
          <Trans comment="This is the text from the notification tab. examples: 'Paul liked your post', 'Alice and Bob reposted your post', 'Eric and 4 others followed you'">
            <Text
              className="text-base font-medium"
              onPress={() => {
                if (actors.length === 1) {
                  router.push(path(`/profile/${actors[0]!.did}`));
                } else {
                  haptics.selection();
                  showAll();
                }
              }}
            >
              {actors.length === 1 ? (
                actors[0].displayName?.trim() || `@${actors[0].handle}`
              ) : actors.length === 2 ? (
                <Trans>
                  {actors[0].displayName?.trim() || `@${actors[0].handle}`} and{" "}
                  {actors[1]?.displayName?.trim() || `@${actors[1]?.handle}`}
                </Trans>
              ) : (
                <Trans>
                  {actors[0].displayName?.trim() || `@${actors[0].handle}`} and{" "}
                  {actors.length - 1} others
                </Trans>
              )}
            </Text>
            <Text className="text-base text-neutral-500 dark:text-neutral-400">
              {" " + action}
            </Text>
          </Trans>
        </Text>
        <Text
          className="mt-1 text-sm text-neutral-500 dark:text-neutral-400"
          accessibilityLabel={timeSinceNotif.accessible}
        >
          {timeSinceNotif.visible}
        </Text>
      </View>
    </View>
  );
};
