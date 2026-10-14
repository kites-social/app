# Polymarket Deposit Wallet derivation and lifecycle

Investigation notes for a possible refactor of Kites' Polymarket wallet flow.
Checked against the repository and public Polymarket/Polygon sources on
2026-10-11. This is a technical reference, not a deployment guarantee: the
factory is upgradeable and its active derivation scheme can change.

## Summary

- A Deposit Wallet address is deterministic and can be computed before the
  wallet contract is deployed. The address is a CREATE2 address whose salt and
  init-code hash are fully determined by the Polygon factory, signer, and proxy
  generation.
- Polymarket documents two generations. Wallets deployed before the
  **2026-06-29** upgrade use UUPS proxies. Wallets deployed after it use beacon
  proxies. New `WALLET-CREATE` requests therefore use the beacon generation.
- Kites' current derivation in `src/polymarket-relayer.ts` reproduces both
  formulas. It returns `[beacon, UUPS]`, checks those addresses against the
  Relayer `/deployed` endpoint, and prefers the confirmed transaction's
  `proxyAddress` when that field is present.
- Kites does **not** currently expose a predicted address before deployment:
  `wallet.polymarketDepositWallet` returns `not-created` or `pending` without
  an address until confirmation.
- Refactor direction: expose the **current beacon-derived address** separately
  from deployment status, then keep Relayer polling and use the confirmed
  `proxyAddress` as the deployed result. Do not present an undeployed UUPS
  candidate as the address for a new wallet.

## Polymarket's documented deployment parameters

Polygon mainnet is chain ID `137`. The current documented wallet factory and
beacon are:

| Purpose | Address | Meaning in derivation |
| --- | --- | --- |
| Deposit Wallet factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | CREATE2 deployer and first ABI argument |
| Deposit Wallet beacon | `0x7A18EDfe055488A3128f01F563e5B479D92ffc3a` | Embedded in beacon-proxy creation code |
| Legacy wallet implementation | `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB` | Embedded in pre-upgrade UUPS-proxy creation code |

The `0x58CA…` address is a **legacy implementation**, not the implementation
used to derive the current beacon proxy. A beacon proxy embeds the beacon
address in its creation code; the beacon selects the implementation for wallet
behavior. Upgrading the implementation behind that beacon does not change the
CREATE2 address. Changing the factory, beacon, salt inputs, or creation code
does.

Primary references:

- [Polymarket: derive a Deposit Wallet address](https://docs.polymarket.com/trading/wallets-auth#derive-a-deposit-wallet-address) documents the pre-deployment algorithm, addresses, and June 29 generation change.
- [Polymarket contract addresses](https://docs.polymarket.com/resources/contracts) lists the current Polygon factory and beacon.
- [Polymarket contract-security repository](https://github.com/Polymarket/contract-security) distinguishes the current Deposit Wallet implementation from the legacy implementation.
- [Polymarket TypeScript SDK wallet derivation](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/wallet.ts) implements both proxy init-code hashes and queries the factory's `BEACON()` selector (`0x49493a4d`) to choose the current generation.

## Address derivation

For a signer address `S` and factory `F`, Polymarket documents this sequence:

```text
walletId = bytes32(S)                 // 12 zero bytes, then the 20-byte address
args     = abi.encode(address, bytes32)(F, walletId)  // 64 bytes
salt     = keccak256(args)
```

Then select the init-code hash for the proxy generation:

```text
beaconInitCodeHash = keccak256(beaconProxyInitCode(F, beacon, args))
uupsInitCodeHash   = keccak256(uupsProxyInitCode(F, implementation, args))
```

The 10-byte creation-code prefix has its embedded total-length field adjusted
for the 64 trailing argument bytes. In the current implementation this is
written as `prefixBase + (64 << 56)`.

```text
beacon prefix base = 0x6100523d8160233d3973
UUPS prefix base   = 0x61003d3d8160233d3973
```

The concrete byte sequences reproduced by Kites and the official TypeScript
SDK are:

```text
Beacon init code:
  adjusted beacon prefix
  || beacon address
  || 0x60195155f3363d3d373d3d363d602036600436635c60da  (CONST3)
  || 0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c  (CONST2)
  || 0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3  (CONST1)
  || args

UUPS init code:
  adjusted UUPS prefix
  || legacy implementation address
  || 0x6009
  || 0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076  (CONST2)
  || 0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3  (CONST1)
  || args
```

Finally, apply the standard CREATE2 formula and take the low 20 bytes:

```text
address = last20(keccak256(0xff || F || salt || initCodeHash))
```

Important encoding detail: the salt is `keccak256(abi.encode(F, walletId))`.
It is not `keccak256(abi.encodePacked(S))`, and `walletId` is a left-padded
`bytes32`, not the raw 20-byte signer. Those encodings produce different
addresses.

### Which candidate is valid?

Both outputs are deterministic and correspond to real proxy generations:

- **Beacon candidate:** address produced with beacon proxy init code. This is
  the expected address for new deployments under the documented post-upgrade
  flow.
- **UUPS candidate:** address produced with the legacy implementation in UUPS
  init code. This is the address for legacy wallets deployed under the prior
  factory implementation. It is not the address to advertise for a new wallet
  after the upgrade.

The formulas can produce two distinct addresses for the same signer. A
precomputed address alone does not prove that it is deployed or that the
Relayer recognizes it as the user's active account.

## Deployment and status flow

`deployPolymarketWallet(signerAddress)` in `src/polymarket-relayer.ts` posts
this body to `https://relayer-v2.polymarket.com/submit`:

```json
{
  "type": "WALLET-CREATE",
  "from": "<signer address>",
  "to": "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  "metadata": "Deploy Kites Deposit Wallet"
}
```

It signs the exact serialized body with Builder HMAC headers. This matches
Polymarket's documented request fields, endpoint, and signing construction;
the metadata text is Kites-specific. The signature input is:

```text
message = unixTimestampSeconds || "POST" || "/submit" || exactJsonBody
signature = base64urlWithPadding(
  HMAC-SHA256(base64Decode(builderSecret), message)
)
```

The response provides a `transactionID`.
Polymarket documents polling `/transaction?id=<transaction_id>` until
`STATE_CONFIRMED`; the confirmed result includes `proxyAddress`, the deployed
wallet address. `STATE_FAILED` and `STATE_INVALID` are terminal failures.

In Kites:

1. `wallet.deployPolymarketDepositWallet` claims a database deployment lock
   and submits `WALLET-CREATE`.
2. `wallet.polymarketDepositWallet` returns an already stored address if one
   exists. Otherwise it reports `not-created`/`pending` until it has a
   transaction ID.
3. Once the Relayer reports `STATE_CONFIRMED`, Kites uses `proxyAddress` first.
   If absent, `getDeployedPolymarketWalletAddress` derives both candidates and
   asks `/deployed?address=<candidate>&type=WALLET` for each, in beacon-then-
   UUPS order. It persists the address only after finding a deployed candidate.

Code pointers: `src/polymarket-relayer.ts` (`deployPolymarketWallet`,
`getPolymarketRelayerTransaction`, `derivePolymarketDepositWalletAddresses`,
`getDeployedPolymarketWalletAddress`) and `src/router/wallet.ts`
(`polymarketDepositWallet`, deployment mutation).

Polymarket's documented flow is described in [Wallets and Authentication](https://docs.polymarket.com/trading/wallets-auth): create request at `/submit`, poll for `STATE_CONFIRMED`, then read `proxyAddress` from the transaction result.

## On-chain cross-checks

I reproduced the CREATE2 calculation locally with Foundry `cast` from the
documented byte strings, then compared it with PolygonScan `WalletDeployed`
logs. In each case the matching candidate was exact:

| Deployment | Signer / owner | Event wallet | Event implementation | Recomputed candidate |
| --- | --- | --- | --- | --- |
| 2026-05-16, before upgrade | `0x31999943149fE6DbF69D73CDCef6bB176E39E24a` | `0x04445931c1aeb1cd70e88327d58d8e77e14d55a5` | Legacy implementation `0x58CA…` | UUPS = event wallet; beacon = `0xea5947BD3D5c4903dE7D98a9d872580C85584395` |
| 2026-07-14, after upgrade | `0x32c7189014Df362913798f79C7D8Aadd0469EcBE` | `0xDd453eC705f88ef1ae84f1a8d5a9b3D2970c4081` | Beacon `0x7A18…` | Beacon = event wallet; UUPS = `0xd73489eE8C6ce79Aed061593e952B5D32Fc37dA0` |

Receipts: [May 16 UUPS deployment](https://polygonscan.com/tx/0xecdb176118f346072bb94b58e01331e64ec2558d4c13c78fb64969e49df005c7) and [July 14 beacon deployment](https://polygonscan.com/tx/0xd5aa422dee77525b763b3fcd692e9f02a334508f87a1a0f3c279a8f2ee6b3d95).

## Refactoring guidance

Keep generation-specific derivation explicit instead of treating the two
addresses as interchangeable:

1. Split the pure calculation into named functions such as
   `deriveBeaconDepositWalletAddress` and `deriveUupsDepositWalletAddress`.
2. For a new wallet, select the active generation. Polymarket's official
   TypeScript SDK reads `BEACON()` (`0x49493a4d`) from the factory and selects
   beacon when nonzero, otherwise UUPS. Pin the chain ID to Polygon and track
   the configured factory/beacon values.
3. Return a predicted address separately from deployment state, for example
   `{ status: "not-created" | "pending" | "deployed", predictedAddress,
   address? }`. Only `address` should mean the Relayer-confirmed deployed
   address; a prediction can be shown as the counterfactual funding address.
4. Continue polling the Relayer and prefer its confirmed `proxyAddress`. If it
   is missing, verify the expected candidate using `/deployed` (or on-chain
   code) before persisting it. If the returned address differs from the
   current predicted candidate, handle that explicitly instead of silently
   assuming the derivation is current.
5. For existing accounts, retain a known stored address. When resolving from
   candidates, do not let array order silently decide which wallet is active.
   The official Python SDK checks whether the legacy UUPS wallet is deployed
   first and otherwise selects the beacon address. Kites currently checks
   beacon first. If both are reported deployed, use the transaction's
   `proxyAddress` or an explicit existing-wallet policy; `/deployed` only
   answers whether a candidate is deployed, not which candidate belongs to a
   particular transaction.

### Safety and drift conditions

- **Signer identity:** the exact EOA that owns/signs the wallet must be used.
  A changed signer or key derives a different wallet. A passkey-derived Kites
  wallet address, rather than some other linked account address, must be the
  `from`/owner that Polymarket uses.
- **Network:** these parameters are for Polygon mainnet (chain ID `137`). Do
  not reuse them on another chain or relayer environment without checking that
  its factory deployment matches.
- **Factory upgrades:** the factory is a proxy. New implementation logic can
  change deployment behavior or the active proxy generation. The June 29
  upgrade already changed the new-wallet formula from UUPS to beacon.
- **Beacon changes:** the beacon implementation may change while the beacon
  proxy address remains the same. Replacing the beacon used for newly created
  proxies changes the CREATE2 init-code hash and address.
- **Counterfactual funding:** an undeployed address can receive assets, but
  Kites must ensure it is the address the current factory/Relayer will deploy.
  Sending funds to an obsolete UUPS prediction after the upgrade risks funds
  sitting at an address the ordinary new-wallet flow will not deploy.
- **Relayer data:** the confirmed transaction's `proxyAddress` is the clearest
  transaction-specific result. `/deployed` is useful as a fallback but does
  not establish the transaction-to-wallet association by itself.
- **Beacon semantics:** the proxy address is stable across beacon
  implementation upgrades, but the code executing behind it can change.
  Address determinism does not freeze wallet behavior.

## Limits of this check

The public Polymarket docs and SDK sources, PolygonScan deployment receipts,
and local CREATE2 recomputations were available. Direct Polygon RPC and live
Relayer requests returned HTTP 403 in the investigation environment, so no
live `BEACON()` or `/deployed` response was queried. Re-check those endpoints
and the official address page before implementing a long-lived refactor.
