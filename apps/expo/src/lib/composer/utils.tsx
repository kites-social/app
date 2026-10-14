import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { showToastable } from "react-native-toastable";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import {
  AppBskyFeedDefs,
  AppBskyFeedPost,
  AppBskyRichtextFacet,
  RichText,
  type AppBskyEmbedExternal,
  type AppBskyEmbedImages,
  type AppBskyEmbedRecord,
  type AppBskyEmbedRecordWithMedia,
  type AppBskyFeedThreadgate,
  type BlobRef,
  type BskyAgent,
  type ComAtprotoLabelDefs,
  type ComAtprotoRepoStrongRef,
} from "@atproto/api";
import { type I18n } from "@lingui/core";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import Sentry from "@sentry/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import RNFetchBlob from "rn-fetch-blob";
import { z } from "zod";

import { resolveVenueMarketUrl } from "@kites-social/venues/src/market-links";
import { getPerplMarketIdForTicker } from "@kites-social/venues/src/perpetual-markets/perpl";

import { useAgent } from "../agent";
import { atprotoUrls } from "../atproto-urls";
import {
  VENUE_MARKET_EMBED_TYPE,
  VENUE_MARKET_EMBED_VIEW_TYPE,
  type VenueMarketEmbedRecord,
  type VenueMarketEmbedView,
} from "../market-embed";
import {
  useMostRecentLanguage,
  usePrimaryLanguage,
} from "../storage/app-preferences";
import { uploadBlob } from "../utils/upload-blob";
import {
  HYPERLIQUID_TESTNET_APP_URL,
  useHyperliquidMarketSymbols,
} from "../venues/hyperliquid";
import { useComposerState } from "./state";

export const MAX_IMAGES = 4;
export const MAX_LENGTH = 300;

const MAX_SIZE = 976_560;
const MAX_DIMENSION = 2048;

export interface ImageWithAlt {
  asset: ImagePicker.ImagePickerAsset;
  alt: string;
}

const strongRefSchema = z.object({
  cid: z.string(),
  uri: z.string(),
});

const replyRefSchema = z.object({
  root: strongRefSchema,
  parent: strongRefSchema,
});
const getReplyRef = (post: AppBskyFeedDefs.PostView) => {
  if (AppBskyFeedPost.isRecord(post.record)) {
    return post.record.reply;
  }
};

export const useComposer = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  return {
    open: () => router.push("/composer"),
    proposeMarket: (post: AppBskyFeedDefs.PostView) => {
      queryClient.setQueryData(["context", post.uri], {
        post,
      } satisfies AppBskyFeedDefs.ThreadViewPost);
      router.push(
        `/composer/propose-market?postUri=${encodeURIComponent(post.uri)}&postCid=${encodeURIComponent(post.cid)}`,
      );
    },
    reply: (post: AppBskyFeedDefs.PostView) => {
      if (post.viewer?.replyDisabled) {
        Alert.alert(
          "Replying disabled",
          "This post has been threadgated, so you cannot reply to it",
        );
        return;
      }
      queryClient.setQueryData(["context", post.uri], {
        post,
      } satisfies AppBskyFeedDefs.ThreadViewPost);

      const parent = {
        uri: post.uri,
        cid: post.cid,
      } satisfies ComAtprotoRepoStrongRef.Main;

      const root = getReplyRef(post)?.root ?? parent;

      const replyRef = {
        parent,
        root,
      } satisfies AppBskyFeedPost.ReplyRef;

      router.push(
        `/composer?reply=${encodeURIComponent(JSON.stringify(replyRef))}`,
      );
    },
    quote: (ref: ComAtprotoRepoStrongRef.Main) =>
      router.push(`/composer?quote=${encodeURIComponent(JSON.stringify(ref))}`),
  };
};

export const useReply = (reply?: string) => {
  const ref = reply
    ? replyRefSchema.parse(JSON.parse(decodeURIComponent(reply)))
    : undefined;

  const thread = useContextualPost(ref?.parent.uri);

  return { thread, ref };
};

export const useQuote = (quote?: string) => {
  const ref = quote
    ? {
        $type: "app.bsky.embed.record",
        record: strongRefSchema.parse(JSON.parse(decodeURIComponent(quote))),
      }
    : undefined;

  const thread = useContextualPost(ref?.record.uri);

  return { thread, ref };
};

export const useContextualPost = (uri?: string) => {
  const agent = useAgent();

  const thread = useQuery({
    queryKey: ["context", uri],
    queryFn: async () => {
      if (!uri) return null;
      const post = await agent.getPostThread({ uri });
      if (!post.success) throw new Error("Failed to fetch post");
      if (!AppBskyFeedDefs.isThreadViewPost(post.data.thread))
        throw new Error("Invalid post");
      return post.data.thread;
    },
  });

  return thread;
};

export const useSendPost = ({
  text,
  images,
  external,
  reply,
  quote,
  onPostCreated,
}: {
  text: string;
  images: ImageWithAlt[];
  external?: ReturnType<typeof useExternal>["external"]["query"]["data"];
  reply?: AppBskyFeedPost.ReplyRef;
  quote?: AppBskyEmbedRecord.Main;
  onPostCreated?: (post: { uri: string; cid: string }) => void;
}) => {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const primaryLanguage = usePrimaryLanguage();
  const mostRecentLanguage = useMostRecentLanguage();
  const [{ labels, languages, gif, threadgate }] = useComposerState();
  const { _ } = useLingui();

  return useMutation({
    mutationKey: ["send"],
    mutationFn: async () => {
      if (!agent.hasSession) throw new Error("Not logged in");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const rt = await generateRichText(text.trimEnd(), agent);
      if (rt.graphemeLength > MAX_LENGTH) {
        throw new Error(
          _(
            msg`Your post is too long - there is a character limit of 300 characters`,
          ),
        );
      }

      const uploadedImages = await Promise.all(
        images.map(async (img) => {
          const uri = await compressToMaxSize(img);

          const uploaded = await uploadBlob(agent, uri, "image/jpeg");
          if (!uploaded.success)
            throw new Error(_(msg`Failed to upload image`));
          return {
            image: uploaded.data.blob,
            alt: img.alt.trim(),
            aspectRatio: {
              // note: may not be the size of the compressed image,
              // but it just has to be proportional
              width: img.asset.width,
              height: img.asset.height,
            },
          } satisfies AppBskyEmbedImages.Image;
        }),
      );

      const media =
        uploadedImages.length > 0
          ? {
              $type: "app.bsky.embed.images",
              images: uploadedImages,
            }
          : undefined;

      // Upload the external-card thumbnail without mutating React Query data.
      let externalForPost = external;
      try {
        if (external?.type === "external" && external.view.external.thumb) {
          const thumbUrl = external.view.external.thumb;
          let thumb: BlobRef | undefined;

          const thumbUri = await downloadThumbnail(thumbUrl);
          let encoding;
          if (thumbUri.endsWith(".png")) {
            encoding = "image/png";
          } else if (thumbUri.endsWith(".jpeg") || thumbUri.endsWith(".jpg")) {
            encoding = "image/jpeg";
          } else {
            console.warn(`Unknown thumbnail extension, skipping: ${thumbUri}`);
            Sentry.captureMessage(
              `Unknown thumbnail extension, skipping: ${thumbUri}`,
              { level: "warning" },
            );
          }
          if (encoding) {
            const thumbUploadRes = await uploadBlob(agent, thumbUri, encoding);
            if (thumbUploadRes.success) {
              thumb = thumbUploadRes.data.blob;
            }
          }

          externalForPost = {
            ...external,
            main: {
              ...external.main,
              external: { ...external.main.external, thumb },
            },
          };
        }
      } catch (err) {
        console.error("thumbnail upload failed", err);
        Sentry.captureException(err);
      }

      let mergedEmbed: AppBskyFeedPost.Record["embed"] | VenueMarketEmbedRecord;

      // embed priorities
      // 1. quote with media
      // 2. quote
      // 3. media
      // 4. external

      if (quote) {
        if (gif) {
          mergedEmbed = {
            $type: "app.bsky.embed.recordWithMedia",
            record: quote,
            media: gif.main,
          } satisfies AppBskyEmbedRecordWithMedia.Main;
        } else if (media) {
          mergedEmbed = {
            $type: "app.bsky.embed.recordWithMedia",
            record: quote,
            media,
          } satisfies AppBskyEmbedRecordWithMedia.Main;
        } else if (externalForPost?.type === "external") {
          mergedEmbed = {
            $type: "app.bsky.embed.recordWithMedia",
            record: quote,
            media: externalForPost.main,
          } satisfies AppBskyEmbedRecordWithMedia.Main;
        } else {
          mergedEmbed = quote;
        }
      } else if (gif?.main) {
        mergedEmbed = gif.main;
      } else if (media) {
        if (externalForPost?.type === "record") {
          mergedEmbed = {
            $type: "app.bsky.embed.recordWithMedia",
            record: externalForPost.main,
            media,
          } satisfies AppBskyEmbedRecordWithMedia.Main;
        } else {
          mergedEmbed = media;
        }
      } else if (externalForPost) {
        mergedEmbed = externalForPost.main;
      }

      let selfLabels: ComAtprotoLabelDefs.SelfLabels | undefined;
      if (labels?.length) {
        selfLabels = {
          $type: "com.atproto.label.defs#selfLabels",
          values: labels.map((val) => ({ val })),
        };
      }

      const post = await agent.post({
        text: rt.text,
        facets: rt.facets,
        reply,
        // Custom embed Lexicons are not yet included in @atproto/api's generated union.
        embed: mergedEmbed as AppBskyFeedPost.Record["embed"],
        langs: languages ?? [mostRecentLanguage ?? primaryLanguage],
        labels: selfLabels,
      });
      onPostCreated?.({ uri: post.uri, cid: post.cid });

      if (threadgate.length > 0) {
        const allow: (
          | AppBskyFeedThreadgate.MentionRule
          | AppBskyFeedThreadgate.FollowingRule
          | AppBskyFeedThreadgate.ListRule
        )[] = [];
        if (!threadgate.find((v) => v.type === "nobody")) {
          for (const rule of threadgate) {
            if (rule.type === "mention") {
              allow.push({ $type: "app.bsky.feed.threadgate#mentionRule" });
            } else if (rule.type === "following") {
              allow.push({ $type: "app.bsky.feed.threadgate#followingRule" });
            } else if (rule.type === "list") {
              allow.push({
                $type: "app.bsky.feed.threadgate#listRule",
                list: rule.list,
              });
            }
          }
        }

        await agent.app.bsky.feed.threadgate.create(
          { repo: agent.assertDid, rkey: post.uri.split("/").pop() },
          { post: post.uri, createdAt: new Date().toISOString(), allow },
        );
      }

      return { uri: post.uri, cid: post.cid };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (err) => Sentry.captureException(err),
  });
};

export const useImages = () => {
  const [images, setImages] = useState<ImageWithAlt[]>([]);
  const { _, i18n } = useLingui();

  const imagePicker = useMutation({
    mutationFn: async (action: "camera" | "gallery") => {
      if (images.length >= MAX_IMAGES) return;

      switch (action) {
        case "camera":
          if (!(await getCameraPermission(i18n))) {
            return;
          }
          void ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsMultipleSelection: true,
            selectionLimit: MAX_IMAGES - images.length,
            exif: false,
            quality: 0.7,
          }).then((result) => {
            if (!result.canceled) {
              setImages((prev) => [
                ...prev,
                ...result.assets.map((a) => ({ asset: a, alt: "" })),
              ]);
            }
          });
          break;
        case "gallery":
          if (!(await getGalleryPermission(i18n))) {
            return;
          }
          void ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsMultipleSelection: true,
            selectionLimit: MAX_IMAGES - images.length,
            exif: false,
            quality: 0.7,
            orderedSelection: true,
            legacy: true,
          }).then((result) => {
            if (!result.canceled) {
              setImages((prev) => {
                // max images prop not enforced on android due to the `browse` patch
                if (result.assets.length + prev.length > MAX_IMAGES) {
                  showToastable({
                    title: _(msg`Too many images selected`),
                    message: _(
                      msg`You can only attach up to ${MAX_IMAGES} images, additional images will be ignored`,
                    ),
                  });
                }
                return [
                  ...prev,
                  ...result.assets
                    .slice(0, MAX_IMAGES - prev.length)
                    .map((a) => ({ asset: a, alt: "" })),
                ];
              });
            }
          });
          break;
      }
    },
  });

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const copy = [...prev];
      copy.splice(index, 1);
      return copy;
    });
  }, []);

  const addAltText = useCallback(
    (index: number, alt: string) => {
      setImages((prev) => {
        const copy = [...prev];
        if (!copy[index]) throw new Error("Invalid index");
        copy[index].alt = alt;
        return copy;
      });
    },
    [setImages],
  );

  // const handlePaste = useCallback(
  //   async (err: string | null, files: PastedFile[]) => {
  //     if (images.length >= MAX_IMAGES) return;

  //     if (err) {
  //       console.error(err);
  //       return;
  //     }
  //     const uris = files.map((f) => f.uri);
  //     const uri = uris.find((uri) => /\.(jpg|jpeg|png).*$/.test(uri));

  //     if (uri) {
  //       try {
  //         const { width, height } = await new Promise<{
  //           width: number;
  //           height: number;
  //         }>((resolve, reject) => {
  //           Image.getSize(
  //             uri,
  //             (width, height) => {
  //               resolve({ width, height });
  //             },
  //             reject,
  //           );
  //         });
  //         setImages((prev) => [
  //           ...prev,
  //           {
  //             asset: {
  //               uri,
  //               width,
  //               height,
  //             },
  //             alt: "",
  //           },
  //         ]);
  //       } catch (err) {
  //         Sentry.captureException(err);
  //         return;
  //       }
  //     }
  //   },
  //   [images.length],
  // );

  return {
    images,
    imagePicker,
    removeImage,
    addAltText,
    // handlePaste,
  };
};

export const generateRichText = async (text: string, agent: BskyAgent) => {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  return rt;
};

export const getGalleryPermission = async (i18n: I18n) => {
  const canChoosePhoto = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (!canChoosePhoto.granted) {
    if (canChoosePhoto.canAskAgain) {
      const { granted } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!granted) {
        showToastable({
          title: i18n._(msg`Permission required`),
          message: i18n._(
            msg`Please enable photo gallery access in your settings`,
          ),
          status: "warning",
        });
        return false;
      }
    } else {
      showToastable({
        title: i18n._(msg`Permission required`),
        message: i18n._(
          msg`Please enable photo gallery access in your settings`,
        ),
        status: "warning",
      });
      return false;
    }
  }
  return true;
};

export const getCameraPermission = async (i18n: I18n) => {
  const canTakePhoto = await ImagePicker.getCameraPermissionsAsync();
  if (!canTakePhoto.granted) {
    if (canTakePhoto.canAskAgain) {
      const { granted } = await ImagePicker.requestCameraPermissionsAsync();
      if (!granted) {
        showToastable({
          title: i18n._(msg`Permission required`),
          message: i18n._(msg`Please enable camera access in your settings`),
          status: "warning",
        });
        return false;
      }
    } else {
      showToastable({
        title: i18n._(msg`Permission required`),
        message: i18n._(msg`Please enable camera access in your settings`),
        status: "warning",
      });
      return false;
    }
  }
  return true;
};

export const compress = async ({
  uri,
  width,
  height,
  needsResize,
}: {
  uri: string;
  width?: number;
  height?: number;
  needsResize: boolean;
}) => {
  const current = uri;
  // compress iteratively, reducing quality each time
  for (let i = 10; i > 0; i--) {
    try {
      // Float precision - not sure what's going on here
      const factor = Math.round(i) / 10;
      const compressed = await ImageManipulator.manipulateAsync(
        current,
        needsResize ? [{ resize: { width, height } }] : [],
        {
          compress: factor,
          base64: true,
          format: ImageManipulator.SaveFormat.JPEG,
        },
      );

      if (!compressed.base64) throw new Error("Failed to compress");

      const compressedSize = Math.round((compressed.base64?.length * 3) / 4);

      if (compressedSize < MAX_SIZE) {
        return compressed.uri;
      }
    } catch (err) {
      throw new Error("Failed to resize", { cause: err });
    }
  }
  throw new Error("Failed to compress - image may be incompressable");
};

const compressToMaxSize = async (image: ImageWithAlt) => {
  let uri = image.asset.uri;
  const size = image.asset.fileSize ?? MAX_SIZE + 1;
  let targetWidth,
    targetHeight = MAX_DIMENSION;

  const needsResize =
    image.asset.width > MAX_DIMENSION || image.asset.height > MAX_DIMENSION;

  if (image.asset.width > image.asset.height) {
    targetHeight = image.asset.height * (MAX_DIMENSION / image.asset.width);
  } else {
    targetWidth = image.asset.width * (MAX_DIMENSION / image.asset.height);
  }

  // compress if > 1mb

  if (size > MAX_SIZE) {
    uri = await compress({
      uri: image.asset.uri,
      width: targetWidth,
      height: targetHeight,
      needsResize,
    });
  }

  return uri;
};

export const useExternal = (
  facets: AppBskyRichtextFacet.Main[] = [],
  text = "",
) => {
  const [selectedEmbed, setSelectedEmbed] = useState<string | null>(null);
  const autoSelectedEmbeds = useRef(new Set<string>());
  const agent = useAgent();

  const mentionedTickers = useMemo(() => {
    const tickers = new Set<string>();
    const pattern = /(?:^|[^\w])\$([A-Z][A-Z0-9]*)\b/gi;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) tickers.add(match[1].toUpperCase());
    }
    return Array.from(tickers);
  }, [text]);
  const hyperliquidMarketSymbols = useHyperliquidMarketSymbols(
    mentionedTickers.length > 0,
  );
  const potentialPerpetualTickers = useMemo(
    () =>
      mentionedTickers.filter(
        (ticker) =>
          getPerplMarketIdForTicker(ticker) ||
          hyperliquidMarketSymbols.data?.includes(ticker),
      ),
    [mentionedTickers, hyperliquidMarketSymbols.data],
  );

  const urls = useMemo(() => {
    const set = new Set<string>();

    for (const facet of facets) {
      for (const feature of facet.features) {
        if (AppBskyRichtextFacet.isLink(feature)) {
          set.add(feature.uri);
        }
      }
    }

    return Array.from(set);
  }, [facets]);

  useEffect(() => {
    const selectedMarket = selectedEmbed
      ? resolveVenueMarketUrl(selectedEmbed)
      : null;
    const selectedTickerStillPresent =
      selectedMarket?.marketType === "perpetual" &&
      potentialPerpetualTickers.includes(selectedMarket.marketId);
    if (
      selectedEmbed &&
      !urls.includes(selectedEmbed) &&
      !selectedTickerStillPresent
    ) {
      setSelectedEmbed(null);
      return;
    }

    if (!selectedEmbed) {
      const ticker = potentialPerpetualTickers.find((value) => {
        const perplMarketId = getPerplMarketIdForTicker(value);
        const url = perplMarketId
          ? `https://testnet.perpl.xyz/trade/${perplMarketId}`
          : `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(value)}`;
        return !autoSelectedEmbeds.current.has(url);
      });
      if (ticker) {
        const perplMarketId = getPerplMarketIdForTicker(ticker);
        setSelectedEmbed(
          perplMarketId
            ? `https://testnet.perpl.xyz/trade/${perplMarketId}`
            : `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(ticker)}`,
        );
        return;
      }

      const marketUrl = urls.find(
        (url) =>
          resolveVenueMarketUrl(url) && !autoSelectedEmbeds.current.has(url),
      );
      if (marketUrl) {
        autoSelectedEmbeds.current.add(marketUrl);
        setSelectedEmbed(marketUrl);
      }
    }
  }, [potentialPerpetualTickers, selectedEmbed, urls]);

  const selectEmbed = (url: string | null) => {
    if (url === null && selectedEmbed) {
      autoSelectedEmbeds.current.add(selectedEmbed);
    }
    setSelectedEmbed(url);
  };

  const embed = useQuery({
    enabled: !!selectedEmbed,
    queryKey: ["embed", selectedEmbed],
    queryFn: async (): Promise<
      | {
          type: "record";
          view: AppBskyEmbedRecord.View;
          main: AppBskyEmbedRecord.Main;
        }
      | {
          type: "external";
          view: AppBskyEmbedExternal.View;
          main: AppBskyEmbedExternal.Main;
        }
      | {
          type: "market";
          view: VenueMarketEmbedView;
          main: VenueMarketEmbedRecord;
        }
      | null
    > => {
      if (!selectedEmbed) return null;

      // check if it's a url via zod
      if (!z.string().trim().url().safeParse(selectedEmbed).success)
        return null;

      const url = new URL(selectedEmbed.trim());
      const market = resolveVenueMarketUrl(url.toString());
      if (market) {
        return {
          type: "market",
          view: {
            $type: VENUE_MARKET_EMBED_VIEW_TYPE,
            ...market,
          },
          main: {
            $type: VENUE_MARKET_EMBED_TYPE,
            ...market,
          },
        };
      }

      const [_0, handle, type, rkey] = url.pathname.split("/").filter(Boolean);

      if (url.hostname === "bsky.app" && handle && type && rkey) {
        let did = handle;
        if (did && !did.startsWith("did:")) {
          const { data } = await agent.resolveHandle({ handle: did });
          did = data.did;
        }

        switch (type) {
          case "post": {
            const data = await agent.getPostThread({
              uri: `at://${did}/app.bsky.feed.post/${rkey}`,
            });
            if (!data.success) return null;

            const thread = data.data.thread;

            if (
              AppBskyFeedDefs.isBlockedPost(thread) ||
              AppBskyFeedDefs.isNotFoundPost(thread)
            ) {
              return null;
            }

            if (AppBskyFeedDefs.isThreadViewPost(thread)) {
              return {
                type: "record",
                view: {
                  $type: "app.bsky.embed.record#view",
                  record: {
                    $type: "app.bsky.embed.record#viewRecord",
                    author: thread.post.author,
                    uri: thread.post.uri,
                    cid: thread.post.cid,
                    indexedAt: thread.post.indexedAt,
                    labels: thread.post.labels,
                    value: thread.post.record,
                    embeds: thread.post.embed ? [thread.post.embed] : undefined,
                  } satisfies AppBskyEmbedRecord.ViewRecord,
                } satisfies AppBskyEmbedRecord.View,
                main: {
                  $type: "app.bsky.embed.record",
                  record: {
                    uri: thread.post.uri,
                    cid: thread.post.cid,
                  },
                } satisfies AppBskyEmbedRecord.Main,
              };
            }

            return null;
          }
          case "feed": {
            const generator = await agent.app.bsky.feed.getFeedGenerator({
              feed: `at://${did}/app.bsky.feed.generator/${rkey}`,
            });

            if (!generator.success) return null;

            return {
              type: "record",
              view: {
                $type: "app.bsky.embed.record#view",
                record: generator.data.view,
              } satisfies AppBskyEmbedRecord.View,
              main: {
                $type: "app.bsky.embed.record",
                record: {
                  uri: generator.data.view.uri,
                  cid: generator.data.view.cid,
                },
              } satisfies AppBskyEmbedRecord.Main,
            };
          }
          default:
            return null;
        }
      } else {
        // fetch external embed
        // uses the cardyb api (lol)

        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 5e3);

        const response = await fetch(
          `${atprotoUrls.cardy}/v1/extract?url=${encodeURIComponent(
            url.toString(),
          )}`,
          { signal: controller.signal },
        );

        const body = (await response.json()) as {
          description?: string;
          error?: string;
          image?: string;
          title?: string;
        };
        clearTimeout(to);

        const { error, title = "", description = "", image } = body;

        if (error) throw new Error(error);

        return {
          type: "external",
          view: {
            $type: "app.bsky.embed.external#view",
            external: {
              $type: "app.bsky.embed.external#viewExternal",
              uri: url.toString(),
              title,
              description,
              thumb: image,
              url: selectedEmbed,
            } satisfies AppBskyEmbedExternal.ViewExternal,
          } satisfies AppBskyEmbedExternal.View,
          main: {
            $type: "app.bsky.embed.external",
            external: {
              $type: "app.bsky.embed.external#external",
              uri: url.toString(),
              title,
              description,
              // thumb is filled in later
              thumb: undefined,
              url: selectedEmbed,
            } satisfies AppBskyEmbedExternal.External,
          } satisfies AppBskyEmbedExternal.Main,
        };
      }
    },
  });

  const selectedMarket = selectedEmbed
    ? resolveVenueMarketUrl(selectedEmbed)
    : null;
  return {
    potentialExternalEmbeds: urls,
    potentialPerpetualTickers,
    selectedPerpetualTicker:
      selectedMarket?.marketType === "perpetual" &&
      potentialPerpetualTickers.includes(selectedMarket.marketId)
        ? selectedMarket.marketId
        : undefined,
    external: {
      url: selectedEmbed,
      query: embed,
    },
    selectExternal: selectEmbed,
    hasExternal:
      urls.length > 0 ||
      potentialPerpetualTickers.length > 0 ||
      !!selectedEmbed,
  };
};

const downloadThumbnail = async (url: string) => {
  let appendExt = "jpeg";
  try {
    const urip = new URL(url);
    const ext = urip.pathname.split(".").pop();
    if (ext === "png") {
      appendExt = "png";
    }
  } catch (err) {
    throw new Error(`Invalid url: ${url}`, { cause: err });
  }

  let downloadRes;
  try {
    const downloadResPromise = RNFetchBlob.config({
      fileCache: true,
      appendExt,
    }).fetch("GET", url);
    downloadRes = await downloadResPromise;

    let localUri = downloadRes.path();
    if (!localUri.startsWith("file://")) {
      localUri = `file://${localUri}`;
    }

    return await compress({
      uri: localUri,
      needsResize: true,
      width: MAX_DIMENSION / 2,
    });
  } finally {
    if (downloadRes) {
      downloadRes.flush();
    }
  }
};
