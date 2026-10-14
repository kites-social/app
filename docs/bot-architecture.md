# Market bots

Bots discover markets and publish feed posts. They do not trade or hold user funds.

## Structure

```text
apps/market-bot/src/
  bots/       one adapter per source; register it in bots/index.ts
  publisher   shared ATProto publishing
  worker      shared Effect polling, retries, and persistence

packages/venues/src/
  prediction-markets/ venue-owned market discovery and data access
```

Adding a source means implementing `MarketBotAdapter` and adding it to the registry.

## Bots

- **Polymarket** discovers new events with active YES/NO markets and publishes one post per event.
- **Hyperliquid outcomes** discovers newly added, unsettled prediction outcomes on testnet. Its first run saves a baseline without posting historical outcomes.
- **Hyperliquid perps** randomly selects a testnet DEX (including HIP-3 deployer DEXes), then a non-delisted market from that DEX, and posts it every 35 minutes.
- **Perpl** randomly selects an open testnet market and posts it every 35 minutes.

The two scheduled bots use unique records per 35-minute slot, so a retry within the same slot does not create a duplicate post.

## Polymarket

- Discover events through the shared `@kites-social/venues` Polymarket provider and official TypeScript SDK.
- The Kites embed is event-based and renders its markets.
- Use a stable ATProto record key and database mapping to avoid duplicate posts on retries.
- Poll every 60 seconds by default; override with `MARKET_BOT_POLL_INTERVAL_SECONDS`.

The bot owns publishing and its durable discovery cursor; Polymarket API access, pagination, and data normalization belong to the shared venue provider. The SDK requires Node.js 24 or newer for the market bot. The 35-minute posting interval is separate from `MARKET_BOT_POLL_INTERVAL_SECONDS`.

The publisher reuses its authenticated session across polls, tracks its process-local share of the PDS request and repository-write budgets, and pauses polling after HTTP 429 until the server's `Retry-After` or `ratelimit-reset` time. Repository writes reserve the maximum `putRecord` cost (3 points) to account for creates as well as updates; the server remains authoritative for shared account and IP usage.

## Run

The bot keeps its cursor and published-market records in a local SQLite file, `apps/market-bot/market-bot.sqlite` by default. Override the path with `MARKET_BOT_DATABASE_PATH`. No MySQL `DATABASE_URL` or Prisma setup is needed for the bot.

For publishing, set `MARKET_BOT_HANDLE` and `MARKET_BOT_APP_PASSWORD` in the repository-root `.env`, using an ATProto app password. Then:

```sh
pnpm dev:market-bot
```

Dry-run is on by default. It saves the initial baseline, logs later candidates, and does not publish or advance past them. Set `MARKET_BOT_DRY_RUN=false` to publish.

The worker uses its local SQLite file for market records and cursors; keep that file on persistent storage when deploying the worker. Effect handles polling and retry logic.
