import { useState } from "react";

import "~/lib/query-client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";

import { type AppRouter } from "@kites-social/api";

import { store } from "~/lib/storage/storage";

/**
 * A set of typesafe hooks for consuming your API.
 */
export const api = createTRPCReact<AppRouter>();
export { type RouterInputs, type RouterOutputs } from "@kites-social/api";

/**
 * Extend this function when going to production by
 * setting the baseUrl to your production API URL.
 */
export const getBaseUrl = () => {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
  if (configuredUrl) return configuredUrl;

  if (__DEV__) {
    // Local dev services are reached over `adb reverse` (see the justfile), so
    // localhost works on Android and iOS alike. Set EXPO_PUBLIC_API_URL to
    // target a LAN IP or a remote API instead.
    return "http://localhost:3000";
  }

  return "https://kites.social";
};

interface StoredAtprotoSession {
  did?: unknown;
  accessJwt?: unknown;
  session?: {
    did?: unknown;
    accessJwt?: unknown;
  };
}

const getAtprotoHeaders = (): Record<string, string> => {
  const rawSession = store.getString("session");
  if (!rawSession) return {};

  try {
    const stored = JSON.parse(rawSession) as StoredAtprotoSession;
    const session = stored.session ?? stored;
    if (
      typeof session.did !== "string" ||
      typeof session.accessJwt !== "string"
    ) {
      return {};
    }

    return {
      Authorization: `Bearer ${session.accessJwt}`,
      "x-atproto-did": session.did,
    };
  } catch {
    return {};
  }
};

/**
 * A wrapper for your app that provides the TRPC context.
 * Use only in _app.tsx
 */
export const TRPCProvider = ({ children }: { children: React.ReactNode }) => {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          headers: getAtprotoHeaders,
        }),
      ],
    }),
  );

  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </api.Provider>
  );
};
