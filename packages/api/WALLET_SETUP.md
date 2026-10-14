# Wallets

Each authenticated AT Protocol DID can link one EVM wallet on Monad Testnet.

Wallets are **self-custodied on the device**. The app creates a WebAuthn
passkey, derives the EVM key from the passkey's PRF output with the standard
BIP-44 path (`m/44'/60'/0'/0/{index}`), and signs locally. The private key and
the PRF output never reach the server. The server stores only the public address
in `EvmWallet.address` and uses it for reads, funding, and display.

This means:

- The signing session lives in app memory only. It is ended (and zeroed) on
  sign-out, session expiry, or when the user locks the wallet.
- There is no server-side key to recover. Recovering the wallet requires the
  synced passkey, and the same `rpId` and derivation index.
- The `encryptedPrivateKey`/DEK columns in `EvmWallet` are legacy: they are
  nullable, hold data only for older server-custodied wallets, and are never
  written for new registrations.

## Configure the passkey relying party

Set a host the project controls as the WebAuthn relying party:

```dotenv
EXPO_PUBLIC_WALLET_RP_ID="wallets.kites.social"
```

Use the bare host, without `https://` or a path. A web app that shares accounts
with the mobile app must create its passkeys with the same `rpId`.

Passkeys need a real host with a publicly trusted TLS certificate. The native
platform verifiers fetch the association files over the public internet, so a
hosts-file entry or a self-signed certificate is not sufficient.

### Association files

The sibling `../pm-static` Cloudflare Pages project serves both files from
`/.well-known` on the relying-party host. If the relying party is a subdomain,
point that subdomain at the Pages deployment. Generate the files there from env:

```dotenv
# iOS: apple-app-site-association
APPLE_TEAM_ID="ABCDE12345"
# Comma-separated; include every shipping bundle identifier (e.g. a .dev variant)
IOS_BUNDLE_IDS="social.kites.app"

# Android: assetlinks.json
ANDROID_PACKAGE_NAME="social.kites.app"
# Comma-separated; debug keystore + upload key + Play App Signing key
ANDROID_SHA256_CERT_FINGERPRINTS="AA:BB:...:FF"
```

Verify each responds `200` with `content-type: application/json` and no
redirect:

```sh
curl -i https://wallets.kites.social/.well-known/apple-app-site-association
curl -i https://wallets.kites.social/.well-known/assetlinks.json
```

Print the Android debug fingerprint after `expo prebuild`:

```sh
keytool -list -v \
  -keystore android/app/debug.keystore \
  -alias androiddebugkey \
  -storepass android \
  -keypass android
```

### Build the app

The associated domain is baked into the build, so reloading Metro is not
enough: change the env, re-run `expo prebuild`, and reinstall.

For development, `DEV_CLIENT=true` appends `?mode=developer` to the iOS
associated domain so the device fetches the association file directly instead
of waiting on Apple's CDN cache. Production builds omit it.

`react-native-passkey` is a native module, so the app must run in a development
build; Expo Go cannot run it.

### Development testing

Development builds use the same WebAuthn passkey flow as production. Set
`EXPO_PUBLIC_WALLET_RP_ID` to the relying-party host and configure its
association files before testing. If the RP ID is missing, wallet setup fails;
there is no software-seed fallback. Run a development build rather than Expo
Go because the passkey integration requires native code.

## Funding

New wallets are funded from a testnet admin wallet: 3 MON for gas and 100,000
testnet USDC for trading. Configure the funding key:

```sh
openssl rand -hex 32   # then fund the resulting address with testnet MON
```

```dotenv
MONAD_ADMIN_PRIVATE_KEY="0x..."
```

The API also uses this same key for Polygon mainnet Polymarket onboarding. It
sends 0.1 POL and 0.01 pUSD to the user's Kites wallet, then the unlocked app
automatically transfers the 0.01 pUSD to that user's Polymarket deposit wallet.
The backend funding address must hold the Polygon POL and pUSD grants, plus
additional POL to pay for its own transaction fees. Keep this key in the API
server environment; never use an `EXPO_PUBLIC_` variable.

The Monad testnet grant remains best-effort: registration succeeds even when it
fails, and the next `wallet.register` call retries it. Polygon funding is
retried when Polymarket setup runs again. `EVM_WALLET_MASTER_KEY` is only needed
to decrypt legacy server-custodied wallets.

## Database

The Prisma schema targets SQLite. Point `DATABASE_URL` at a file in the root
`.env`:

```dotenv
DATABASE_URL="file:./dev.db"
```

The path is relative to `packages/db/prisma/`, so the database is created at
`packages/db/prisma/dev.db` (gitignored). Apply the schema from the repository
root with `pnpm db:push`. No external database server is required.

## Runtime behavior

- After login the app no longer provisions a wallet automatically. The first
  wallet action creates the passkey, derives the address, and calls the
  protected `wallet.register` mutation.
- `wallet.register` validates proof of address control. The signed Bluesky
  wallet-link record determines the active address; the database keeps venue
  metadata keyed by address. If an older database row still points to a
  different address, registration detaches that row without deleting its
  metadata and makes the signed address active. An address already assigned to
  another DID is rejected with `CONFLICT`.
- `wallet.mine` returns the linked address, or `null` when none is linked.

## Migration status

Trades (`trades.approve`, `trades.execute` behavior) are now signed on the
device. The market lifecycle mutations in `markets` (`contribute`, `create`,
`proposeResolution`, `claimWinningShares`, and related) still sign with
server-held key material and therefore only work for legacy wallets. Migrating
them to device signing is the next step.

## API endpoint cleanup decisions

The endpoint audit completed the two wallet endpoint removals below. The other
items remain follow-up decisions.

- Removed `wallet.challenge`. The app now generates the timestamp and nonce
  when creating the signed ownership proof; `wallet.register` verifies the
  signed fields directly.
- Removed `wallet.addressForDid`. No in-repository app caller was found.
- Remove `markets.contribute`, `markets.claimFunding`, and
  `markets.proposeResolution` with the legacy custody signing path. These
  mutations decrypt and use legacy server-held wallet keys. If these market
  actions remain supported, move signing to the device before removing their
  current implementations.
- Keep `wallet.mine` and the Polymarket wallet status, deployment, and approval
  endpoints; they are used by current wallet and onboarding flows.
- Keep `translate.post` for now. It uses server-held provider credentials and
  stores shared translation results; cleanup is low priority.
- Defer GIF endpoint cleanup. The GIF routes were skipped from further review;
  no GIF removal is scheduled by this audit.

The remaining custom prediction-market endpoints were not reviewed as part of
this audit.
