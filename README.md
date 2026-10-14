# Kites

Kites is an independent fork of [Graysky](https://github.com/mozzius/graysky), a Bluesky client originally developed by Samuel Newman. This fork is maintained separately. The original MIT license and copyright notice are retained in [LICENSE](LICENSE).

Source code: https://github.com/cantaloupebob/pm-social-app

## Codebase

This is a pnpm monorepo managed with Turborepo:

| Path | Purpose |
| --- | --- |
| `apps/expo` | React Native mobile app for iOS and Android |
| `apps/nextjs` | Next.js service for tRPC and AT Protocol endpoints, policy pages, and shared-post GIF previews |
| `apps/push-notifs` | Push notification service |
| `apps/market-bot` | Scheduled market-posting bots, deployable to Cloudflare |
| `packages/api` | Shared tRPC API |
| `packages/db` | Prisma client and database schema |
| `packages/venues` | Shared venue and chain utilities |
| `tooling/` | Shared ESLint, Prettier, Tailwind, and TypeScript configuration |

## Getting started

### Requirements

- Node.js `>=22.18` (the market-bot package requires Node.js `>=24`)
- pnpm `9.15.4` (the version pinned in `package.json`)
- Xcode for iOS simulator/device builds, or Android Studio and the Android SDK for Android builds

Enable pnpm with Corepack if needed, then install dependencies and create your local environment file:

```bash
corepack enable
pnpm install
cp .env.example .env
```

Fill in the values needed for the features you plan to run. `DATABASE_URL` is required for database-backed services and Prisma commands. The other variables in `.env.example` configure wallet and Polymarket integrations; keep secrets private and do not put server credentials in `EXPO_PUBLIC_*` variables.

If using the database, point `DATABASE_URL` at a development database, then sync the Prisma schema and generate the client:

```bash
pnpm db:push
```

Start the mobile app:

```bash
pnpm dev
```

Start other services from the repository root with `pnpm dev:next`, `pnpm dev:push`, or `pnpm dev:market-bot`. `pnpm dev:both` starts the Expo and Next.js apps together. Expo may prompt you to select a simulator/device; native device builds require the corresponding platform tooling above.

Common checks:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Market bot deployment (optional)

The market bots use [Alchemy](https://alchemy.run) to provision a scheduled Cloudflare Worker and its D1 database. Configure these variables in the shell or `apps/market-bot/.env`:

```dotenv
MARKET_BOT_HANDLE=your-bot.bsky.social
MARKET_BOT_APP_PASSWORD=your-app-password
MARKET_BOT_DRY_RUN=true
```

Authenticate Alchemy with Cloudflare, then deploy from the repository root:

```bash
pnpm --dir apps/market-bot exec alchemy profile edit --add Cloudflare
pnpm market-bot:alchemy:deploy
```

Bots default to dry-run mode. Set `MARKET_BOT_DRY_RUN=false` to publish posts. The first scheduled run saves a baseline and skips historical posts. The Worker runs once per minute; the Hyperliquid and Perpl bots use their own 35-minute posting interval. Follow the deployed Worker with `pnpm market-bot:alchemy:logs`.

## Mobile builds

For an Expo development client, run from the repository root:

```bash
pnpm --dir apps/expo build:dev-client:ios-simulator
pnpm --dir apps/expo build:dev-client:android
```

The app also includes platform build scripts in `apps/expo` for local iOS and Android builds. EAS builds additionally require EAS project configuration (`EAS_PROJECT_ID`, `APP_ID`, and `OWNER`).

## Upstream contributors

These acknowledgements are inherited from the original Graysky project:

- [@alice.bsky.sh](https://bsky.app/profile/alice.bsky.sh)
- [@holden.bsky.social](https://bsky.app/profile/holden.bsky.social)
- [@matthewstanciu.com](https://bsky.app/profile/matthewstanciu.com)
- [@mary.my.id](https://bsky.app/profile/mary.my.id)
- [@st-cyr.bsky.social](https://bsky.app/profile/st-cyr.bsky.social)
