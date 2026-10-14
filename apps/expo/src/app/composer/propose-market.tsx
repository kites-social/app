import { useState } from "react";
import { ActivityIndicator, Alert, TouchableOpacity, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { showToastable } from "react-native-toastable";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { AppBskyFeedPost } from "@atproto/api";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import {
  isMarketProposalValid,
  toCreateMarketInput,
} from "~/lib/composer/market-proposal";
import { MarketProposalPanel } from "~/lib/composer/market-proposal-panel";
import { useComposerState } from "~/lib/composer/state";
import { useContextualPost } from "~/lib/composer/utils";
import { marketPostLinksQueryKey } from "~/lib/hooks/market-posts";
import { profileMarketsQueryKey } from "~/lib/hooks/profile-markets";
import { api, type RouterOutputs } from "~/lib/utils/api";
import { web3BalancesQueryKey } from "~/lib/web3";

const postUriPattern = /^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[^/]+$/;

type CreatedMarket = RouterOutputs["markets"]["create"];

export default function ProposeMarketScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { _ } = useLingui();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    postUri?: string | string[];
    postCid?: string | string[];
  }>();
  const postUri = firstParam(params.postUri);
  const postCid = firstParam(params.postCid);
  const validPostUri = Boolean(postUri && postUriPattern.test(postUri));
  const [{ marketProposal }] = useComposerState();
  const selectedPost = useContextualPost(
    validPostUri && postUri ? postUri : undefined,
  );
  const marketAssociation = api.markets.byPostUris.useQuery(
    { postUris: validPostUri && postUri ? [postUri] : [] },
    { enabled: validPostUri },
  );
  const [createdMarket, setCreatedMarket] = useState<CreatedMarket | null>(
    null,
  );

  const closeComposer = () => {
    if (router.canDismiss()) {
      router.dismissAll();
    } else {
      router.replace("/(feeds)/feeds");
    }
  };

  const createMarket = api.markets.create.useMutation({
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey }),
  });
  const confirmMarket = api.markets.confirm.useMutation();
  const associatePost = api.markets.associatePost.useMutation({
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: marketPostLinksQueryKey }),
        queryClient.invalidateQueries({ queryKey: profileMarketsQueryKey }),
      ]);
    },
  });

  const existingMarket = marketAssociation.data?.[0];
  const submitting =
    createMarket.isPending ||
    confirmMarket.isPending ||
    associatePost.isPending;
  const proposalValid = isMarketProposalValid(marketProposal);
  const submitError =
    associatePost.error ?? confirmMarket.error ?? createMarket.error;

  const close = () => {
    if (!createdMarket) {
      closeComposer();
      return;
    }

    Alert.alert(
      _(msg`Market not attached`),
      _(
        msg`A market transaction has already been submitted. Leaving now will leave that market unattached to this post.`,
      ),
      [
        { text: _(msg`Keep working`), style: "cancel" },
        {
          text: _(msg`Leave anyway`),
          style: "destructive",
          onPress: closeComposer,
        },
      ],
    );
  };

  const submit = async () => {
    if (
      !validPostUri ||
      !postUri ||
      !postCid ||
      !proposalValid ||
      !marketAssociation.isSuccess ||
      existingMarket
    ) {
      return;
    }

    let market = createdMarket;
    try {
      if (!market) {
        market = await createMarket.mutateAsync(
          toCreateMarketInput(marketProposal),
        );
        setCreatedMarket(market);
      }

      if (market.transactionStatus === "pending" || !market.marketAddress) {
        const confirmation = await confirmMarket.mutateAsync({
          marketTxHash: market.marketTxHash,
        });
        if (!confirmation.marketAddress) {
          showToastable({
            title: _(msg`Market transaction submitted`),
            message: _(
              msg`Confirmation is still pending. Check again before attaching the market.`,
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

      if (!market.marketAddress) {
        throw new Error("The market address could not be confirmed.");
      }

      await associatePost.mutateAsync({
        postUri,
        postCid,
        marketAddress: market.marketAddress,
        marketTxHash: market.marketTxHash,
      });
      showToastable({
        message: _(msg`Market attached to post`),
        status: "success",
      });
      closeComposer();
    } catch {
      const refreshedAssociation = await marketAssociation.refetch();
      const associationWasSaved = refreshedAssociation.data?.some(
        (link) =>
          market?.marketAddress &&
          link.marketAddress.toLowerCase() ===
            market.marketAddress.toLowerCase(),
      );
      if (associationWasSaved) {
        showToastable({
          message: _(msg`Market attached to post`),
          status: "success",
        });
        closeComposer();
      }
    }
  };

  const targetPost = selectedPost.data?.post;
  const postText = AppBskyFeedPost.isRecord(targetPost?.record)
    ? targetPost.record.text
    : undefined;
  const canSubmit =
    validPostUri &&
    Boolean(postCid) &&
    proposalValid &&
    marketAssociation.isSuccess &&
    !existingMarket &&
    !submitting;
  const buttonLabel = createdMarket
    ? createdMarket.transactionStatus === "pending" ||
      !createdMarket.marketAddress
      ? _(msg`Check transaction`)
      : _(msg`Attach market`)
    : _(msg`Create market`);

  return (
    <>
      <Stack.Screen
        options={{
          title: _(msg`Propose Market`),
          headerLeft: () => (
            <TouchableOpacity accessibilityRole="button" onPress={close}>
              <Text primary className="text-lg">
                <Trans>Cancel</Trans>
              </Text>
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
              disabled={!canSubmit}
              onPress={() => void submit()}
              className="rounded-full px-3 py-1"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <View className="flex-row items-center">
                {submitting ? (
                  <ActivityIndicator
                    size="small"
                    color="white"
                    className="mr-2"
                  />
                ) : null}
                <Text className="font-semibold text-white">{buttonLabel}</Text>
              </View>
            </TouchableOpacity>
          ),
        }}
      />
      <KeyboardAwareScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32, paddingTop: 16 }}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View
          className="mx-4 mb-4 rounded-2xl border px-4 py-4"
          style={{
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
          }}
        >
          <Text className="text-sm font-semibold">
            {targetPost ? (
              <Trans>For @{targetPost.author.handle}&apos;s post</Trans>
            ) : (
              <Trans>For the selected post</Trans>
            )}
          </Text>
          {postText ? (
            <Text
              numberOfLines={4}
              className="mt-1 text-sm text-neutral-500 dark:text-neutral-400"
            >
              {postText}
            </Text>
          ) : null}
          {existingMarket && (
            <Text className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              <Trans>This post already has a market attached.</Trans>
            </Text>
          )}
          {!validPostUri || !postCid ? (
            <Text className="mt-2 text-sm text-red-500">
              <Trans>
                This post could not be identified. Close and try again.
              </Trans>
            </Text>
          ) : null}
          {marketAssociation.isError && (
            <TouchableOpacity onPress={() => void marketAssociation.refetch()}>
              <Text primary className="mt-2 text-sm font-medium">
                <Trans>
                  Could not check this post for an existing market. Tap to
                  retry.
                </Trans>
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <MarketProposalPanel createdMarket={createdMarket} />

        {submitError && (
          <View
            className="mx-4 mb-4 rounded-xl px-4 py-3"
            style={{
              backgroundColor: theme.dark
                ? "rgba(239,68,68,0.16)"
                : "rgba(239,68,68,0.1)",
            }}
          >
            <Text className="text-sm font-medium text-red-700 dark:text-red-300">
              {submitError.message || _(msg`An unknown error occurred`)}
            </Text>
            {createdMarket && (
              <Text className="mt-1 text-sm text-red-700/90 dark:text-red-300/90">
                <Trans>
                  The market transaction has already been submitted. Retrying
                  will not create another market.
                </Trans>
              </Text>
            )}
          </View>
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

const firstParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;
