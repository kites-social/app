// Taken from the official app; override the endpoint when using another network.
import { atprotoUrls } from "../atproto-urls";

const PROFILES_ENDPOINT = atprotoUrls.profileSearch;

export interface ProfileSearchItem {
  $type: string;
  avatar: {
    cid: string;
    mimeType: string;
  };
  banner: {
    cid: string;
    mimeType: string;
  };
  description: string | undefined;
  displayName: string | undefined;
  did: string;
}

export async function searchProfiles(
  query: string,
  signal?: AbortSignal,
): Promise<ProfileSearchItem[]> {
  return await doFetch<ProfileSearchItem[]>(PROFILES_ENDPOINT, query, signal);
}

async function doFetch<T>(
  endpoint: string,
  query: string,
  signal?: AbortSignal,
): Promise<T> {
  const uri = new URL(endpoint);
  uri.searchParams.set("q", query);

  const res = await fetch(String(uri), {
    method: "get",
    headers: {
      accept: "application/json",
    },
    signal,
  });

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((value: string, key: string) => {
    resHeaders[key] = value;
  });
  const resBody = (await res.json()) as unknown as T;

  return resBody ?? ([] as T);
}
