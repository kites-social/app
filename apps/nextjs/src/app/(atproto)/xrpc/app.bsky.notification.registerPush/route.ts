import { type NextRequest } from "next/server";
import { type AppBskyNotificationRegisterPush } from "@atproto/api";
import { DidResolver, MemoryCache } from "@atproto/identity";
import { AuthRequiredError, verifyJwt } from "@atproto/xrpc-server";

import { db } from "@kites-social/db";

const didCache = new MemoryCache();
const didResolver = new DidResolver({
  plcUrl: "https://plc.directory",
  didCache,
});

export async function POST(req: NextRequest) {
  try {
    const serviceDid = process.env.KITES_SERVICE_DID;
    if (!serviceDid) return new Response(null, { status: 503 });

    const auth = req.headers.get("authorization");
    if (!auth || !auth.startsWith("Bearer "))
      throw new AuthRequiredError("authorization required");

    const token = auth.slice("Bearer ".length);

    const { iss: did, aud } = await verifyJwt(
      token,
      serviceDid,
      null,
      async (did: string) => didResolver.resolveAtprotoKey(did),
    );

    if (aud !== serviceDid) throw new AuthRequiredError("invalid audience");

    const body =
      (await req.json()) as AppBskyNotificationRegisterPush.InputSchema;

    if (body.platform === "ios" || body.platform === "android") {
      const platform = body.platform as "ios" | "android";
      await db.user.upsert({
        where: { did },
        create: {
          did,
          tokens: {
            create: {
              platform: platform,
              token: body.token,
            },
          },
        },
        update: {
          tokens: {
            upsert: {
              where: {
                did_platform: { did, platform },
              },
              create: {
                platform,
                token: body.token,
              },
              update: {
                token: body.token,
                disabled: false,
              },
            },
          },
        },
      });
    } else {
      throw new Error("invalid platform");
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    return new Response(null, {
      status: err instanceof AuthRequiredError ? 401 : 500,
    });
  }
}
