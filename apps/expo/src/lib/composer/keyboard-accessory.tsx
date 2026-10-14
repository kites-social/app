import {
  Platform,
  ScrollView,
  StyleSheet,
  TouchableHighlight,
  View,
} from "react-native";
import { AnimatedCircularProgress } from "react-native-circular-progress";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import {
  LanguagesIcon,
  PaperclipIcon,
  TrendingUpIcon,
} from "lucide-react-native";
import colors from "tailwindcss/colors";
import * as DropdownMenu from "zeego/dropdown-menu";

import { Text } from "~/components/themed/text";
import { useHaptics } from "../hooks/preferences";
import { cx } from "../utils/cx";
import { MAX_IMAGES, MAX_LENGTH } from "./utils";

interface Props {
  charCount?: number;
  onPressImage: (action: "camera" | "gallery") => void;
  onPressLanguage: () => void;
  language: string;
  imageCount: number;
  marketProposalSelected: boolean;
  onOpenMarketProposal: () => void;
}

export const KeyboardAccessory = ({
  charCount = 0,
  imageCount,
  onPressImage,
  onPressLanguage,
  language,
  marketProposalSelected,
  onOpenMarketProposal,
}: Props) => {
  const theme = useTheme();
  const haptics = useHaptics();
  const router = useRouter();
  const { _ } = useLingui();

  const tooLong = charCount > MAX_LENGTH;
  const progress = (charCount / MAX_LENGTH) * 100;

  const { bottom } = useSafeAreaInsets();

  const content = (
    <View
      className="flex-1 flex-row items-center px-2"
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.card,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled
        className="flex-1"
        style={{ minWidth: 0 }}
        contentContainerStyle={{
          alignItems: "center",
          flexGrow: 0,
          gap: 8,
          paddingRight: 8,
        }}
      >
        <View className="shrink-0">
          <DropdownMenu.Root
            onOpenChange={(willOpen) => {
              if (willOpen) haptics.selection();
            }}
          >
            <DropdownMenu.Trigger>
              <View
                className="h-9 flex-row items-center justify-center rounded-full px-2.5"
                style={{
                  backgroundColor: theme.dark
                    ? colors.neutral[800]
                    : theme.colors.background,
                }}
              >
                <PaperclipIcon size={20} color={theme.colors.primary} />
                <Text primary className="ml-2.5 mr-1 font-medium">
                  <Trans>Add image</Trans>
                </Text>
              </View>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item
                key="camera"
                textValue={_(msg`Take photo`)}
                onSelect={() => onPressImage("camera")}
                disabled={imageCount >= MAX_IMAGES}
              >
                <DropdownMenu.ItemIcon
                  ios={{ name: "camera" }}
                  androidIconName="ic_menu_camera"
                />
              </DropdownMenu.Item>
              <DropdownMenu.Item
                key="gallery"
                textValue={_(msg`Choose from Library`)}
                onSelect={() => onPressImage("gallery")}
                disabled={imageCount >= MAX_IMAGES}
              >
                <DropdownMenu.ItemIcon
                  ios={{ name: "photo" }}
                  androidIconName="ic_menu_gallery"
                />
              </DropdownMenu.Item>
              <DropdownMenu.Item
                key="gifs"
                textValue={_(msg`Search GIFs`)}
                onSelect={() => router.push("/composer/gifs")}
                disabled={imageCount > 0}
              >
                <DropdownMenu.ItemIcon
                  ios={{ name: "magnifyingglass" }}
                  androidIconName="ic_menu_search"
                />
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </View>
        <TouchableHighlight
          className="shrink-0 rounded-full"
          accessibilityLabel={_(msg`Propose Market`)}
          accessibilityRole="button"
          accessibilityState={{ selected: marketProposalSelected }}
          onPress={() => {
            haptics.selection();
            onOpenMarketProposal();
          }}
        >
          <View
            className="h-9 flex-row items-center justify-center rounded-full px-2.5"
            style={{
              backgroundColor: marketProposalSelected
                ? theme.colors.primary
                : theme.dark
                  ? colors.neutral[800]
                  : theme.colors.background,
            }}
          >
            <TrendingUpIcon
              size={18}
              color={marketProposalSelected ? "white" : theme.colors.primary}
            />
            <Text
              primary={!marketProposalSelected}
              className={`ml-2 font-medium ${marketProposalSelected ? "text-white" : ""}`}
            >
              <Trans>Propose Market</Trans>
            </Text>
          </View>
        </TouchableHighlight>
        <TouchableHighlight
          className="shrink-0 rounded-full"
          accessibilityLabel={_(msg`Change post language`)}
          accessibilityRole="button"
          onPress={() => {
            haptics.selection();
            onPressLanguage();
          }}
        >
          <View
            className="h-9 flex-row items-center justify-center rounded-full px-2.5"
            style={{
              backgroundColor: theme.dark
                ? colors.neutral[800]
                : theme.colors.background,
            }}
          >
            <LanguagesIcon size={20} color={theme.colors.primary} />
            <Text primary className="ml-2.5 mr-1 font-medium uppercase">
              {language}
            </Text>
          </View>
        </TouchableHighlight>
      </ScrollView>
      <Text className="mx-3 text-right">
        <Text
          style={{
            color: tooLong ? theme.colors.notification : undefined,
          }}
          className={cx(tooLong && "font-medium")}
        >
          {charCount}
        </Text>{" "}
        / {MAX_LENGTH}
      </Text>
      <AnimatedCircularProgress
        fill={tooLong ? progress % 100 : progress}
        size={28}
        width={5}
        rotation={0}
        backgroundColor={
          theme.dark ? colors.neutral[800] : theme.colors.background
        }
        tintColor={!tooLong ? theme.colors.primary : theme.colors.notification}
      />
    </View>
  );

  if (Platform.OS === "ios" && Platform.isPad) {
    return <View className="h-12 w-full">{content}</View>;
  }

  return (
    <KeyboardStickyView
      className="h-12 w-full"
      offset={{
        closed: -bottom,
        opened: 0,
      }}
    >
      {content}
    </KeyboardStickyView>
  );
};
