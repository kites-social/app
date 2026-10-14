import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  TouchableHighlight,
  TouchableOpacity,
  View,
  type TextInput,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, {
  FadeInDown,
  FadeOut,
  FadeOutDown,
  FadeOutLeft,
  LinearTransition,
  SlideInUp,
  SlideOutUp,
} from "react-native-reanimated";
import { showToastable } from "react-native-toastable";
import { Image } from "expo-image";
import { Stack, useNavigation, useRouter } from "expo-router";
import {
  RichText as RichTextHelper,
  type AppBskyEmbedRecord,
} from "@atproto/api";
import { useActionSheet } from "@expo/react-native-action-sheet";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useHeaderHeight } from "@react-navigation/elements";
import { useTheme } from "@react-navigation/native";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CheckIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldPlusIcon,
  XIcon,
} from "lucide-react-native";

import { getPerplMarketIdForTicker } from "@kites-social/venues";

import { Avatar } from "~/components/avatar";
import { Embed } from "~/components/embed";
import { FeedPost } from "~/components/feed-post";
import { RichText } from "~/components/rich-text";
import { Text } from "~/components/themed/text";
import { PasteableTextInput } from "~/components/themed/text-input";
import { useAgent } from "~/lib/agent";
import { AltTextEditor } from "~/lib/composer/alt-text-editor";
import { CancelButton, PostButton } from "~/lib/composer/buttons";
import { KeyboardAccessory } from "~/lib/composer/keyboard-accessory";
import {
  isMarketProposalValid,
  toCreateMarketInput,
} from "~/lib/composer/market-proposal";
import { MarketProposalPanel } from "~/lib/composer/market-proposal-panel";
import { useComposerState } from "~/lib/composer/state";
import { SuggestionList } from "~/lib/composer/suggestion-list";
import {
  MAX_LENGTH,
  useExternal,
  useImages,
  useQuote,
  useReply,
  useSendPost,
} from "~/lib/composer/utils";
import { useControlledKeyboard } from "~/lib/hooks/keyboard-modifiers";
import { marketPostLinksQueryKey } from "~/lib/hooks/market-posts";
import { useContentFilter, useHaptics } from "~/lib/hooks/preferences";
import { profileMarketsQueryKey } from "~/lib/hooks/profile-markets";
import {
  useAltText,
  useMostRecentLanguage,
  usePrimaryLanguage,
} from "~/lib/storage/app-preferences";
import { actionSheetStyles } from "~/lib/utils/action-sheet";
import { api, type RouterOutputs } from "~/lib/utils/api";
import { cx } from "~/lib/utils/cx";
import { getMentionAt, insertMentionAt } from "~/lib/utils/mention-suggest";
import { produce } from "~/lib/utils/produce";
import { isIOS26 } from "~/lib/utils/version";
import {
  HYPERLIQUID_TESTNET_APP_URL,
  useHyperliquidMarketSymbols,
} from "~/lib/venues/hyperliquid";
import { web3BalancesQueryKey } from "~/lib/web3";

const AnimatedImage = Animated.createAnimatedComponent(Image);

interface Selection {
  start: number;
  end: number;
}

function useKeyboardMaxHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", (e) =>
      setKeyboardHeight((h) => Math.max(e.endCoordinates.height, h)),
    );
    return () => {
      sub.remove();
    };
  }, [setKeyboardHeight]);

  return keyboardHeight;
}

export default function ComposerScreen() {
  const theme = useTheme();
  const agent = useAgent();
  const router = useRouter();
  const { showActionSheetWithOptions } = useActionSheet();

  const primaryLanguage = usePrimaryLanguage();
  const mostRecentLanguage = useMostRecentLanguage();
  const altTextSetting = useAltText();

  const navigation = useNavigation();
  const { contentFilter } = useContentFilter();
  const [trucateParent, setTruncateParent] = useState(true);
  const haptics = useHaptics();
  const { _ } = useLingui();

  const [
    {
      initialText,
      gif,
      languages,
      marketProposal,
      reply: replyStr,
      quote: quoteStr,
    },
    setComposerState,
  ] = useComposerState();

  const reply = useReply(replyStr);
  const quote = useQuote(quoteStr);

  const selectionRef = useRef<Selection>({
    start: 0,
    end: 0,
  });

  const inputRef = useRef<TextInput>(null!);
  const keyboardMaxHeight = useKeyboardMaxHeight();

  useControlledKeyboard();

  const [text, setText] = useState(initialText ?? "");

  const { images, imagePicker, addAltText, removeImage } = useImages();

  const [editingAltText, setEditingAltText] = useState<number | null>(null);

  const rt = useMemo(() => {
    const rt = new RichTextHelper({ text });
    rt.detectFacetsWithoutResolution();
    return rt;
  }, [text]);

  const {
    external,
    selectExternal,
    potentialExternalEmbeds,
    potentialPerpetualTickers,
    selectedPerpetualTicker,
    hasExternal,
  } = useExternal(rt.facets, text);

  const prefix = useMemo(
    () => getMentionAt(text, selectionRef.current?.start || 0),
    [text],
  );

  const isSuggestionsOpen = !!prefix;

  const suggestionsQuery = useQuery({
    enabled: isSuggestionsOpen,
    queryKey: ["suggestions", prefix?.value],
    queryFn: async () => {
      if (!prefix?.value) return [];
      const actors = await agent.searchActorsTypeahead({
        term: prefix.value,
        limit: 10,
      });
      if (!actors.success) throw new Error("Cannot fetch suggestions");
      return actors.data.actors;
    },
    placeholderData: keepPreviousData,
  });

  const suggestions = suggestionsQuery.data ?? [];

  const isEmpty = text.trim().length === 0 && images.length === 0 && !gif;
  const [createdMarket, setCreatedMarket] = useState<
    RouterOutputs["markets"]["create"] | null
  >(null);
  const [publishedPost, setPublishedPost] = useState<{
    uri: string;
    cid: string;
  } | null>(null);

  const send = useSendPost({
    text,
    images,
    external: external.query.data,
    reply: reply?.ref,
    quote: quote?.ref,
    onPostCreated:
      marketProposal.enabled || createdMarket ? setPublishedPost : undefined,
  });
  const queryClient = useQueryClient();
  const createMarket = api.markets.create.useMutation({
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey }),
  });
  const confirmMarket = api.markets.confirm.useMutation();
  const associateMarketPost = api.markets.associatePost.useMutation({
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: marketPostLinksQueryKey }),
        queryClient.invalidateQueries({ queryKey: profileMarketsQueryKey }),
      ]);
    },
  });
  useEffect(() => {
    navigation.getParent()?.setOptions({ gestureEnabled: isEmpty });
  }, [navigation, isEmpty]);

  const handleFocus = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleSave = useCallback(() => {
    Alert.alert("Not yet implemented");
  }, []);

  const closeComposer = useCallback(() => {
    const close = () => {
      requestAnimationFrame(() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace("/feeds");
        }
      });
    };

    if (Platform.OS === "android" && Keyboard.isVisible()) {
      const subscription = Keyboard.addListener("keyboardDidHide", () => {
        subscription.remove();
        close();
      });
      Keyboard.dismiss();
      return;
    }

    close();
  }, [router]);

  if (editingAltText !== null) {
    const image = images[editingAltText]!;
    return (
      <AltTextEditor
        image={image}
        editingAltText={editingAltText}
        setEditingAltText={setEditingAltText}
        addAltText={addAltText}
        keyboardHeight={keyboardMaxHeight}
      />
    );
  }

  const isSubmitting =
    send.isPending ||
    createMarket.isPending ||
    confirmMarket.isPending ||
    associateMarketPost.isPending;

  const discardComposer = (discard: () => void) => {
    if (!createdMarket || publishedPost) {
      discard();
      return;
    }

    Alert.alert(
      _(msg`Market not attached`),
      _(
        msg`A market transaction has already been submitted. Discarding this post will leave that market unattached.`,
      ),
      [
        { text: _(msg`Keep working`), style: "cancel" },
        {
          text: _(msg`Discard anyway`),
          style: "destructive",
          onPress: discard,
        },
      ],
    );
  };

  const discardFromCancelButton = () => discardComposer(closeComposer);

  const headerLeft = () => (
    <CancelButton
      hasContent={!isEmpty}
      onSave={handleSave}
      onCancel={handleFocus}
      onDiscard={discardFromCancelButton}
      disabled={isSubmitting || Boolean(publishedPost)}
    />
  );

  const onPressSend = async (anchor?: number) => {
    haptics.impact();

    if (images.some((i) => !i.alt)) {
      switch (altTextSetting) {
        case "force":
          Alert.alert(
            _(msg`Missing alt text`),
            _(
              msg`Please add descriptive alt text to all images before posting.`,
            ),
          );
          return;
        case "warn": {
          if (Platform.OS === "android") Keyboard.dismiss();
          const cancel = await new Promise((resolve) => {
            showActionSheetWithOptions(
              {
                title: _(msg`Missing alt text`),
                message: _(
                  msg`Adding a description to your image makes Kites more accessible to people with disabilities, and helps give context to everyone. We strongly recommend adding alt text to all images.`,
                ),
                options: [_(msg`Post anyway`), _(msg`Go back`)],
                destructiveButtonIndex: 0,
                cancelButtonIndex: 1,
                anchor,
                ...actionSheetStyles(theme),
              },
              (index) => resolve(index === 1),
            );
          });
          if (cancel) return;
          else break;
        }
        case "hide":
          // do nothing
          break;
      }
    }

    try {
      if (publishedPost) {
        if (!createdMarket?.marketAddress) {
          throw new Error("The market address is not available yet.");
        }
        await associateMarketPost.mutateAsync({
          postUri: publishedPost.uri,
          postCid: publishedPost.cid,
          marketAddress: createdMarket.marketAddress,
          marketTxHash: createdMarket.marketTxHash,
        });
        closeComposer();
        showToastable({ message: _(msg`Post published!`) });
        return;
      }

      let market = createdMarket;
      if (marketProposal.enabled && !market) {
        market = await createMarket.mutateAsync(
          toCreateMarketInput(marketProposal),
        );
        setCreatedMarket(market);
        showToastable({
          title:
            market.transactionStatus === "confirmed"
              ? _(msg`Market created`)
              : _(msg`Market transaction submitted`),
          message: market.marketAddress
            ? _(msg`Market deployed at ${market.marketAddress}`)
            : _(msg`Market transaction submitted; confirmation is pending.`),
          status:
            market.transactionStatus === "confirmed" ? "success" : "warning",
        });
      }

      if (
        market &&
        (market.transactionStatus === "pending" || !market.marketAddress)
      ) {
        const confirmation = await confirmMarket.mutateAsync({
          marketTxHash: market.marketTxHash,
        });
        if (!confirmation.marketAddress) {
          showToastable({
            title: _(msg`Market transaction submitted`),
            message: _(
              msg`Confirmation is still pending. Tap Post again to check before publishing.`,
            ),
            status: "warning",
          });
          return;
        }
        market = {
          ...market,
          marketAddress: confirmation.marketAddress,
          transactionStatus: "confirmed",
        };
        setCreatedMarket(market);
      }

      if (market && !market.marketAddress) {
        throw new Error("The market address could not be confirmed.");
      }

      const post = await send.mutateAsync();
      if (market?.marketAddress) {
        await associateMarketPost.mutateAsync({
          postUri: post.uri,
          postCid: post.cid,
          marketAddress: market.marketAddress,
          marketTxHash: market.marketTxHash,
        });
      }

      closeComposer();
      showToastable({ message: _(msg`Post published!`) });
    } catch {
      // Mutation errors are shown in the composer banner below.
    }
  };

  const marketDraftIsInvalid =
    marketProposal.enabled && !isMarketProposalValid(marketProposal);
  const disableSend =
    isEmpty ||
    isSubmitting ||
    marketDraftIsInvalid ||
    (rt.graphemeLength ?? 0) > MAX_LENGTH;
  const submitError =
    associateMarketPost.error ??
    send.error ??
    confirmMarket.error ??
    createMarket.error;

  const headerRight = () => (
    <PostButton
      onPress={onPressSend}
      disabled={isSubmitting || (publishedPost ? false : disableSend)}
      loading={isSubmitting}
      label={publishedPost ? _(msg`Retry save`) : undefined}
      hideThreadgate={Boolean(publishedPost)}
    />
  );

  const headerHeight = useHeaderHeight();

  return (
    <>
      <Stack.Screen
        options={{
          headerBackVisible: false,
          headerTitleStyle: { color: "transparent" },
          ...(isIOS26
            ? {
                headerTransparent: true,
                unstable_headerLeftItems: () => [
                  isEmpty
                    ? {
                        type: "button",
                        label: _(msg`Close`),
                        icon: { type: "sfSymbol", name: "xmark" },
                        disabled: isSubmitting || Boolean(publishedPost),
                        onPress: () => router.dismiss(),
                      }
                    : {
                        type: "menu",
                        disabled: isSubmitting || Boolean(publishedPost),
                        icon: { type: "sfSymbol", name: "xmark" },
                        label: _(msg`Close`),
                        menu: {
                          items: [
                            {
                              type: "action",
                              label: _(msg`Discard post`),
                              icon: { type: "sfSymbol", name: "trash" },
                              onPress: () =>
                                discardComposer(() => router.dismiss()),
                              destructive: true,
                            },
                          ],
                        },
                      },
                ],
                unstable_headerRightItems: () => [
                  {
                    type: "button",
                    icon: { type: "sfSymbol", name: "globe" },
                    label: _(msg`Edit who can reply`),
                    disabled: Boolean(publishedPost),
                    onPress: () => {
                      Keyboard.dismiss();
                      router.push("/composer/threadgate");
                    },
                  },
                  {
                    type: "button",
                    icon: { type: "sfSymbol", name: "paperplane" },
                    label: publishedPost ? _(msg`Retry save`) : _(msg`Send`),
                    variant: "done",
                    disabled:
                      isSubmitting || (publishedPost ? false : disableSend),
                    onPress: () => {
                      Keyboard.dismiss();
                      void onPressSend();
                    },
                  },
                ],
              }
            : { headerLeft, headerRight }),
        }}
      />
      {(send.isError ||
        createMarket.isError ||
        confirmMarket.isError ||
        associateMarketPost.isError) && (
        <Animated.View
          className="z-10 bg-red-500 px-4 py-3"
          style={isIOS26 ? { paddingTop: headerHeight + 4 } : {}}
          entering={SlideInUp}
          exiting={SlideOutUp}
          layout={LinearTransition}
        >
          <Text className="text-base font-medium leading-5 text-white">
            {submitError instanceof Error ? (
              submitError.message
            ) : (
              <Trans>An unknown error occurred</Trans>
            )}
          </Text>
          <Text className="my-0.5 text-white/90">
            {publishedPost ? (
              <Trans>
                The post is already published. Tap Retry save to record its
                association without posting again.
              </Trans>
            ) : (
              <Trans>Please try again</Trans>
            )}
          </Text>
        </Animated.View>
      )}
      <KeyboardAwareScrollView
        className="flex-1 pt-4"
        style={{ backgroundColor: theme.colors.card }}
        alwaysBounceVertical={!isEmpty}
        keyboardShouldPersistTaps="always"
        bottomOffset={48 + 32}
        contentInsetAdjustmentBehavior="automatic"
      >
        {reply.thread.data && (
          <TouchableOpacity
            onPress={() => setTruncateParent((t) => !t)}
            className="flex-1"
          >
            <Animated.View
              layout={LinearTransition}
              pointerEvents="none"
              className="flex-1"
            >
              <FeedPost
                item={reply.thread.data}
                dataUpdatedAt={0}
                filter={contentFilter(reply.thread.data.post.labels)}
                hasReply
                isReply
                hideActions
                hideEmbed={trucateParent}
                numberOfLines={trucateParent ? 3 : undefined}
                avatarSize="reduced"
                background="transparent"
                extraPadding
              />
            </Animated.View>
          </TouchableOpacity>
        )}
        <Animated.View
          className="w-full flex-1 flex-row px-2 pb-6"
          layout={LinearTransition}
        >
          <View className="shrink-0 px-2">
            <Avatar self size="medium" />
          </View>
          <View className="flex flex-1 items-start pl-1 pr-2">
            <View className="min-h-[40px] flex-1 flex-row items-center">
              <PasteableTextInput
                ref={inputRef}
                editable={!publishedPost}
                onChange={(evt) => {
                  setText(evt.nativeEvent.text);
                  if (send.isError) {
                    send.reset();
                  }
                }}
                multiline
                className="relative -top-[3px] w-full max-w-full text-lg leading-6"
                placeholder={
                  reply.thread.data
                    ? _(
                        msg`Replying to @${reply.thread.data.post.author.handle}`,
                      )
                    : _(msg`What's on your mind?`)
                }
                keyboardType="default"
                verticalAlign="middle"
                textAlignVertical="center"
                autoFocus
                onSelectionChange={(evt) => {
                  selectionRef.current = evt.nativeEvent.selection;
                }}
                scrollEnabled={false}
                // onPaste={handlePaste}
              >
                <RichText
                  size="lg"
                  text={rt.text}
                  facets={rt.facets}
                  truncate={false}
                  disableLinks
                  selectable={false}
                  uiTextView={false}
                />
              </PasteableTextInput>
            </View>
            {/* AUTOSUGGESTIONS */}
            {isSuggestionsOpen &&
              suggestions.length > 0 &&
              !suggestions.some((s) => s.handle === prefix.value) && (
                <SuggestionList
                  suggestions={suggestions}
                  onInsertHandle={(handle) =>
                    setText((text) =>
                      insertMentionAt(
                        text,
                        selectionRef.current?.start || 0,
                        handle,
                      ),
                    )
                  }
                />
              )}
          </View>
        </Animated.View>
        {marketProposal.enabled && (
          <MarketProposalPanel createdMarket={createdMarket} />
        )}
        {/* IMAGES */}
        {!gif && images.length > 0 && (
          <>
            <Animated.ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="mt-4 w-full flex-1 pb-2 pl-16"
              entering={FadeInDown}
              exiting={FadeOut}
              layout={LinearTransition}
              keyboardShouldPersistTaps="always"
            >
              {images.map((image, i) => (
                <Animated.View
                  key={image.asset.uri}
                  className={cx(
                    "relative overflow-hidden rounded-md",
                    i !== 3 && "mr-2",
                  )}
                  layout={LinearTransition}
                  exiting={FadeOutLeft}
                >
                  <AnimatedImage
                    // sharedTransitionTag={`image-${i}`}
                    cachePolicy="memory"
                    source={{ uri: image.asset.uri }}
                    alt={image.alt ?? `image ${i + 1}`}
                    className="h-44 rounded-md"
                    style={{
                      aspectRatio: Math.max(
                        0.6,
                        Math.min(image.asset.width / image.asset.height, 1.2),
                      ),
                    }}
                  />
                  <TouchableOpacity
                    className="absolute left-2 top-2 z-10"
                    onPress={() => {
                      haptics.impact();
                      setEditingAltText(i);
                    }}
                  >
                    <View className="flex-row items-center rounded-full bg-black/90 px-2 py-[3px]">
                      {image.alt ? (
                        <CheckIcon size={14} color="white" />
                      ) : (
                        <PlusIcon size={14} color="white" />
                      )}
                      <Text className="ml-1 text-xs font-bold uppercase text-white">
                        <Trans>Alt</Trans>
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    className="absolute right-2 top-2 z-10"
                    onPress={() => {
                      haptics.impact();
                      removeImage(i);
                    }}
                  >
                    <View className="rounded-full bg-black/90 p-1">
                      <XIcon size={14} color="white" />
                    </View>
                  </TouchableOpacity>
                  {image.alt && (
                    <View className="absolute bottom-0 left-0 right-0 z-10 bg-black/60 px-3 pb-2 pt-1">
                      <Text
                        numberOfLines={2}
                        className="text-sm leading-[18px] text-white"
                      >
                        {image.alt}
                      </Text>
                    </View>
                  )}
                </Animated.View>
              ))}
              {/* spacer */}
              <View className="w-20" />
            </Animated.ScrollView>
            <AddContentWarning
              onPress={() => router.push("/composer/content-warning")}
            />
          </>
        )}
        <Animated.View
          layout={LinearTransition}
          className="w-full flex-1 pl-16 pr-2"
        >
          {/* GIF */}
          {gif && (
            <Animated.View
              className="relative mb-2 flex-1"
              layout={LinearTransition}
              entering={FadeInDown}
              exiting={FadeOutDown}
            >
              <TouchableOpacity
                onPress={() =>
                  setComposerState(
                    produce((draft) => {
                      delete draft.gif;
                    }),
                  )
                }
                className="absolute right-2 top-4 z-10 rounded-full"
              >
                <View className="rounded-full bg-black/90 p-1">
                  <XIcon size={14} color="white" />
                </View>
              </TouchableOpacity>
              <Embed
                uri={gif.view.external.uri}
                transparent
                content={gif.view}
              />
            </Animated.View>
          )}
          {/* EMBED/QUOTE */}
          {(!!quote.thread.data || hasExternal) && (
            <Animated.View
              layout={LinearTransition}
              entering={FadeInDown}
              className="w-full flex-1"
            >
              {quote.thread.data ? (
                <View pointerEvents="none" className="w-full flex-1">
                  <Embed
                    uri=""
                    transparent
                    content={
                      {
                        $type: "app.bsky.embed.record#view",
                        record: {
                          $type: "app.bsky.embed.record#viewRecord",
                          ...quote.thread.data.post,
                          value: quote.thread.data.post.record,
                        },
                      } satisfies AppBskyEmbedRecord.View
                    }
                  />
                </View>
              ) : (
                images.length === 0 &&
                !gif &&
                (external.url ? (
                  <View className="relative flex-1">
                    <TouchableOpacity
                      onPress={() => selectExternal(null)}
                      className="absolute right-2 top-4 z-10 rounded-full"
                    >
                      <View className="rounded-full bg-black/90 p-1">
                        <XIcon size={14} color="white" />
                      </View>
                    </TouchableOpacity>
                    {selectedPerpetualTicker ? (
                      <MarketWidgetChooser
                        ticker={selectedPerpetualTicker}
                        selectedUrl={external.url}
                        query={external.query}
                        onSelect={selectExternal}
                      />
                    ) : (
                      <LoadableEmbed
                        url={external.url}
                        query={external.query}
                      />
                    )}
                  </View>
                ) : (
                  <>
                    {potentialPerpetualTickers.map((ticker) => {
                      const perplMarketId = getPerplMarketIdForTicker(ticker);
                      const marketUrl = perplMarketId
                        ? `https://testnet.perpl.xyz/trade/${perplMarketId}`
                        : `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(ticker)}`;
                      return (
                        <TouchableHighlight
                          key={`perpetual-${ticker}`}
                          className="mb-2 rounded-lg"
                          onPress={() => selectExternal(marketUrl)}
                        >
                          <View
                            style={{
                              backgroundColor: theme.colors.card,
                              borderColor: theme.colors.border,
                            }}
                            className="rounded-lg border px-3 py-2"
                          >
                            <Text numberOfLines={1} className="text-base">
                              <Trans>
                                Add market widget for{" "}
                                <Text primary>${ticker}</Text>
                              </Trans>
                            </Text>
                          </View>
                        </TouchableHighlight>
                      );
                    })}
                    {potentialExternalEmbeds
                      .filter((x) => x !== external.url)
                      .map((potential) => (
                        <TouchableHighlight
                          key={potential}
                          className="mb-2 rounded-lg"
                          onPress={() => selectExternal(potential)}
                        >
                          <View
                            style={{
                              backgroundColor: theme.colors.card,
                              borderColor: theme.colors.border,
                            }}
                            className="rounded-lg border px-3 py-2"
                          >
                            <Text numberOfLines={1} className="text-base">
                              <Trans>
                                Add embed for <Text primary>{potential}</Text>
                              </Trans>
                            </Text>
                          </View>
                        </TouchableHighlight>
                      ))}
                  </>
                ))
              )}
            </Animated.View>
          )}
        </Animated.View>
      </KeyboardAwareScrollView>
      <KeyboardAccessory
        charCount={rt.graphemeLength}
        imageCount={images.length}
        onPressImage={(action) => imagePicker.mutate(action)}
        language={
          languages?.join(", ") ?? mostRecentLanguage ?? primaryLanguage
        }
        onPressLanguage={() => router.push("/composer/language")}
        marketProposalSelected={marketProposal.enabled}
        onOpenMarketProposal={() =>
          setComposerState((state) => ({
            ...state,
            marketProposal: {
              ...state.marketProposal,
              enabled: true,
            },
          }))
        }
      />
    </>
  );
}

const LoadableEmbed = ({
  url,
  query,
}: Pick<ReturnType<typeof useExternal>["external"], "url" | "query">) => {
  const theme = useTheme();

  if (!url) return null;

  switch (query.status) {
    case "pending":
      return (
        <View className="min-h-[180px] w-full items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.text} />
        </View>
      );
    case "error":
      return (
        <View className="w-full">
          <Text className="text-base font-medium text-red-500">
            {query.error instanceof Error
              ? query.error.message
              : "An unknown error occurred"}
          </Text>
        </View>
      );
    case "success":
      if (!query.data) return null;
      return (
        <View className="w-full flex-1" pointerEvents="none">
          <Embed uri={url} transparent preview content={query.data.view} />
        </View>
      );
  }
};

const MarketWidgetChooser = ({
  ticker,
  selectedUrl,
  query,
  onSelect,
}: {
  ticker: string;
  selectedUrl: string;
  query: ReturnType<typeof useExternal>["external"]["query"];
  onSelect: (url: string) => void;
}) => {
  const theme = useTheme();
  const market = query.data?.type === "market" ? query.data : null;
  const hyperliquidSymbols = useHyperliquidMarketSymbols(true);
  const perplMarketId = getPerplMarketIdForTicker(ticker);
  const marketVenues = [
    ...(perplMarketId
      ? [
          {
            venue: "perpl",
            marketId: perplMarketId,
            url: `https://testnet.perpl.xyz/trade/${encodeURIComponent(perplMarketId)}`,
          },
        ]
      : []),
    ...(hyperliquidSymbols.data?.includes(ticker)
      ? [
          {
            venue: "hyperliquid",
            marketId: ticker,
            url: `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(ticker)}`,
          },
        ]
      : []),
  ];

  if (query.status !== "success" || !market) {
    return <LoadableEmbed url={selectedUrl} query={query} />;
  }

  return (
    <View className="w-full">
      <Text className="mb-3 text-base font-semibold">
        <Trans>Select the venue widget to post with</Trans>
      </Text>
      {marketVenues.map((venueMarket) => {
        const selected = venueMarket.url === selectedUrl;
        return (
          <TouchableOpacity
            key={venueMarket.venue}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onSelect(venueMarket.url)}
            className="mb-2 w-full shrink-0 rounded-lg border-2 p-2"
            style={{
              borderColor: selected ? "#16a34a" : theme.colors.border,
            }}
          >
            <View pointerEvents="none">
              <Embed
                uri={venueMarket.url}
                transparent
                preview
                content={{
                  ...market.view,
                  ...venueMarket,
                }}
              />
            </View>
          </TouchableOpacity>
        );
      })}
      {hyperliquidSymbols.isPending && (
        <View className="mb-2 flex-row items-center">
          <ActivityIndicator size="small" color={theme.colors.text} />
          <Text className="ml-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Loading live market data…</Trans>
          </Text>
        </View>
      )}
      {hyperliquidSymbols.isError && (
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>Hyperliquid ticker availability could not be loaded.</Trans>
        </Text>
      )}
    </View>
  );
};

const AddContentWarning = ({ onPress }: { onPress: () => void }) => {
  const theme = useTheme();
  const [{ labels }] = useComposerState();

  const captialise = (str: string) =>
    str.charAt(0).toUpperCase() + str.slice(1);

  return (
    <Animated.View
      className="w-full flex-1 pl-16"
      entering={FadeInDown.delay(500)}
      exiting={FadeOut}
      layout={LinearTransition}
    >
      <TouchableOpacity
        className="flex-row items-center py-2"
        onPress={onPress}
      >
        {labels.length > 0 ? (
          <>
            <ShieldAlertIcon size={18} color={theme.colors.primary} />
            <Text className="ml-2 font-medium" primary>
              {labels.map(captialise).join(", ")}
            </Text>
          </>
        ) : (
          <>
            <ShieldPlusIcon size={18} color={theme.colors.text} />
            <Text className="ml-2">
              <Trans>Add a content warning</Trans>
            </Text>
          </>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};
