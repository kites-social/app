import { AtpAgent, type AtpAgentOptions } from "@atproto/api";

const normalizeUrl = (value: string | undefined) =>
  value?.trim().replace(/\/+$/, "") || undefined;

export const atprotoUrls = {
  appView:
    normalizeUrl(process.env.EXPO_PUBLIC_ATPROTO_APPVIEW_URL) ??
    "https://public.api.bsky.app",
  pds: normalizeUrl(process.env.EXPO_PUBLIC_ATPROTO_PDS_URL),
  plcDirectory:
    normalizeUrl(process.env.EXPO_PUBLIC_ATPROTO_PLC_URL) ??
    "https://plc.directory",
  profileSearch:
    normalizeUrl(process.env.EXPO_PUBLIC_ATPROTO_PROFILE_SEARCH_URL) ??
    "https://search.bsky.social/search/profiles",
  cardy:
    normalizeUrl(process.env.EXPO_PUBLIC_ATPROTO_CARDY_URL) ??
    "https://cardyb.bsky.app",
  tagFeed:
    normalizeUrl(process.env.EXPO_PUBLIC_ATPROTO_TAG_FEED_URL) ??
    "https://skyfeed.me",
  appViewDid: process.env.EXPO_PUBLIC_ATPROTO_APPVIEW_DID?.trim() || undefined,
};

export const defaultPdsUrl = atprotoUrls.pds ?? "https://bsky.social";

export function createAtprotoAgent(options: AtpAgentOptions) {
  const agent = new AtpAgent(options);

  return atprotoUrls.appViewDid
    ? agent.withProxy("bsky_appview", atprotoUrls.appViewDid)
    : agent;
}
