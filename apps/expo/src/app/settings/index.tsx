import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import {
  AtSignIcon,
  BellRingIcon,
  FlaskConical,
  LanguagesIcon,
  NewspaperIcon,
  ShieldIcon,
  SmartphoneIcon,
  StarIcon,
  UserIcon,
} from "lucide-react-native";

import { GroupedList, type Groups } from "~/components/grouped-list";
import { SwitchAccounts } from "~/components/switch-accounts";
import { useOptionalAgent } from "~/lib/agent";
import { kitesDevEnabled } from "~/lib/dev/config";
import { useIsPro } from "~/lib/purchases";
import { useEnableNotifications } from "~/lib/storage/app-preferences";

export default function SettingsPage() {
  const theme = useTheme();
  const agent = useOptionalAgent();
  const isPro = useIsPro();
  const enableNotifications = useEnableNotifications();
  const { _ } = useLingui();

  const groups = useMemo(
    () =>
      [
        {
          title: _(msg`Your account`),
          options: [
            {
              title: _(msg`Account`),
              href: "/settings/account",
              icon: UserIcon,
            },
            {
              title: _(msg`Moderation`),
              href: "/settings/moderation",
              icon: ShieldIcon,
            },
            {
              title: _(msg`Home feed preferences`),
              href: "/settings/feed",
              icon: NewspaperIcon,
            },
            {
              title: _(msg`Languages`),
              href: "/settings/language",
              icon: LanguagesIcon,
            },
            {
              title: _(msg`App settings`),
              href: "/settings/app",
              icon: SmartphoneIcon,
            },
          ],
        },
        ...(enableNotifications
          ? []
          : [
              {
                title: _(msg`Notifications`),
                options: [
                  {
                    title: _(msg`Push notifications`),
                    href: "/push-notifications",
                    icon: BellRingIcon,
                  },
                ],
              },
            ]),
        {
          title: _(msg`Kites`),
          options: [
            {
              title: _(msg`Kites Pro`),
              href: isPro ? "/settings/pro" : "/pro",
              icon: StarIcon,
            },
            {
              title: _(msg`About Kites`),
              href: "/settings/about",
              icon: AtSignIcon,
            },
          ],
        },
        ...(kitesDevEnabled
          ? [
              {
                title: _(msg`Developer`),
                options: [
                  {
                    title: "Wallet custody test",
                    href: "/wallet-test",
                    icon: FlaskConical,
                  },
                ],
              },
            ]
          : []),
      ] satisfies Groups,
    [isPro, enableNotifications, _, kitesDevEnabled],
  );

  return (
    <GroupedList groups={groups}>
      <View
        className="mb-4 flex-1"
        style={{
          borderColor: theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <SwitchAccounts active={agent?.session?.did} showAddAccount />
      </View>
    </GroupedList>
  );
}
