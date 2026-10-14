import { z } from "zod";

export const runtime = "nodejs";

const infoRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("allMids"),
    dex: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal("metaAndAssetCtxs"),
    dex: z.string().max(128).optional(),
  }),
  z.object({ type: z.literal("outcomeMeta") }),
  z.object({
    type: z.literal("candleSnapshot"),
    dex: z.string().max(128).optional(),
    req: z.object({
      coin: z.string().min(1).max(128),
      interval: z.string().min(1).max(8),
      startTime: z.number().int().nonnegative(),
      endTime: z.number().int().nonnegative(),
    }),
  }),
]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  const parsed = infoRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Unsupported Hyperliquid market-data request." },
      { status: 400 },
    );
  }

  try {
    const response = await fetch("https://api.hyperliquid-testnet.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Hyperliquid testnet is temporarily unavailable." },
      { status: 502 },
    );
  }
}
