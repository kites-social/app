# Developing Kites against a local AT Protocol stack

Kites can be pointed at the local development stack from the upstream `atproto` repository. This is useful for testing account, PDS, and AppView behavior without using a production Bluesky account. The upstream stack runs a local PDS, AppView, PLC directory, Ozone, and bsync service, with seeded test data.

## 1. Start the local stack

From the Kites repository root, clone and build `atproto` alongside this repository:

```bash
git clone https://github.com/bluesky-social/atproto.git ../atproto
cd ../atproto
pnpm install
pnpm build
pnpm dev
```

Docker must be installed and its daemon running. The dev environment also requires `jq`. The `pnpm dev` command starts the local services and prints their URLs. The development data is recreated on each run. If you are changing the atproto backend itself, start `pnpm dev:ts` in a second terminal to rebuild TypeScript as you edit.

The usual local ports are:

| Service       | Usual URL               |
| ------------- | ----------------------- |
| Introspection | `http://localhost:2581` |
| PLC directory | `http://localhost:2582` |
| PDS           | `http://localhost:2583` |
| AppView       | `http://localhost:2584` |

Check the URLs printed by your running stack rather than assuming the defaults.

## 2. Get the local AppView DID

The introspection service returns the local service URLs and DIDs. While the stack is running, run this on the host:

```bash
curl -s http://localhost:2581 | jq
```

The AppView DID is the `bsky.did` field. To print only that value:

```bash
curl -s http://localhost:2581 | jq -r '.bsky.did'
```

Use the `plc.url`, `pds.url`, and `bsky.url` values from the same response for the PLC, PDS, and AppView environment variables below. This avoids accidentally using a DID or URL from another dev-env instance.

## 3. Configure Kites

Add the following to the repository-root `.env` file (not `apps/expo/.env`). Replace the example URLs/DID with the values printed by introspection if they differ:

```dotenv
EXPO_PUBLIC_ATPROTO_PDS_URL=http://localhost:2583
EXPO_PUBLIC_ATPROTO_APPVIEW_URL=http://localhost:2584
EXPO_PUBLIC_ATPROTO_PLC_URL=http://localhost:2582
EXPO_PUBLIC_ATPROTO_APPVIEW_DID=did:plc:replace-with-the-local-bsky-did
```

These settings configure Kites's default AppView, login/session PDS, PLC DID resolution, and authenticated AppView proxy. The AppView DID must be the local value from `.bsky.did`, not a production DID.

Other service URL overrides are optional:

```dotenv
EXPO_PUBLIC_ATPROTO_PROFILE_SEARCH_URL=https://search.bsky.social/search/profiles
EXPO_PUBLIC_ATPROTO_CARDY_URL=https://cardyb.bsky.app
EXPO_PUBLIC_ATPROTO_TAG_FEED_URL=https://skyfeed.me
```

They default to the production/third-party endpoints shown above. Set them only if you have alternate compatible services. The local atproto dev-env does not provide equivalent profile-search, Cardy, or Skyfeed services, so leaving these unset means those particular features may still contact external services.

The `EXPO_PUBLIC_` values are bundled into the app's JavaScript and are not secrets. After changing `.env`, restart Expo and fully reload Kites; you do not need to rebuild/reinstall the native development client for these JS endpoint changes.

## 4. Forward the local services to Waydroid

The local stack is reached from the host at `localhost`; the app runs inside Waydroid, so forward the local service ports to the Android device. The repository's `justfile` provides `waydroid-reverse` for this. It forwards ports `2582`, `2583`, and `2584` using ADB, and auto-detects a connected Waydroid device whose serial ends in `:5555`.

Run it directly with:

```bash
just waydroid-reverse
```

Or start the app with:

```bash
just expo
```

`just expo` depends on `waydroid-reverse`, so forwarding is set up before Expo starts. This recipe is a convenience wrapper for `adb reverse`; it does not start Docker, the atproto stack, or Waydroid itself. Start those separately first. If more than one ADB device is connected, select Waydroid explicitly:

```bash
ANDROID_SERIAL=192.168.240.112:5555 just expo
```

Use the serial shown by `adb devices` for your Waydroid instance.

## 5. Sign in with a seeded account

The dev-env seeds these test accounts, all with password `hunter2`:

| Handle       | Password  |
| ------------ | --------- |
| `alice.test` | `hunter2` |
| `bob.test`   | `hunter2` |
| `carla.test` | `hunter2` |

These are disposable local development accounts. The local stack regenerates its seed data when it starts. Use `bob.test` for the market-bot account; leave `alice.test` for app testing.

Start the bot against the local PDS with:

```bash
just market-bot-local
```

It runs in dry-run mode by default. To publish test posts to the local PDS after the initial baseline, run:

```bash
MARKET_BOT_DRY_RUN=false just market-bot-local
```

The recipe uses the local seeded password (`hunter2`), not a production app password. Keep this account and password confined to the disposable local stack.

The market bot stores its cursor and market records in a local SQLite file, so it does not need a MySQL `DATABASE_URL` or `pnpm db:push`. The default file is `apps/market-bot/market-bot.sqlite`; override it with `MARKET_BOT_DATABASE_PATH` if desired.
