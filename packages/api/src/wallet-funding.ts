import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  isHex,
  parseEther,
  parseUnits,
  type Address,
  type Hash,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet, polygon } from "viem/chains";

import { COLLATERAL_DECIMALS, COLLATERAL_TOKEN_ADDRESS } from "./evm-config";
import { POLYMARKET_PUSD_ADDRESS } from "./polymarket-relayer";

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});
const createPolygonTransport = () =>
  fallback([
    http("https://polygon-bor-rpc.publicnode.com"),
    http("https://polygon.drpc.org"),
  ]);
const polygonPublicClient = createPublicClient({
  chain: polygon,
  transport: createPolygonTransport(),
});

const collateralMintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const tokenTransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface InitialFundingProgress {
  monTxHash: string | null;
  usdcTxHash: string | null;
  saveMonTxHash: (hash: Hash | null) => Promise<void>;
  saveUsdcTxHash: (hash: Hash | null) => Promise<void>;
  withAdminNonceLock: <T>(action: () => Promise<T>) => Promise<T>;
}

export interface PolymarketInitialFundingProgress {
  polTxHash: string | null;
  pusdTxHash: string | null;
  savePolTxHash: (hash: Hash | null) => Promise<void>;
  savePusdTxHash: (hash: Hash | null) => Promise<void>;
  withAdminNonceLock: <T>(action: () => Promise<T>) => Promise<T>;
}

function parseStoredHash(hash: string | null): Hash | undefined {
  if (hash === null) return undefined;
  if (!isHex(hash, { strict: true }) || hash.length !== 66) {
    throw new Error("Invalid initial funding transaction hash in database");
  }
  return hash;
}

async function waitForSuccessfulReceipt(
  hash: Hash,
  clearHash: () => Promise<void>,
  failureMessage: string,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    await clearHash();
    throw new Error(failureMessage);
  }
}

export async function fundNewWallet(
  address: Address,
  progress: InitialFundingProgress,
): Promise<void> {
  const configuredPrivateKey = process.env.MONAD_ADMIN_PRIVATE_KEY;
  if (
    !configuredPrivateKey ||
    !isHex(configuredPrivateKey, { strict: true }) ||
    configuredPrivateKey.length !== 66
  ) {
    throw new Error(
      "MONAD_ADMIN_PRIVATE_KEY must be configured as a 32-byte hex private key",
    );
  }

  const account = privateKeyToAccount(configuredPrivateKey, { nonceManager });
  const walletClient = createWalletClient({
    account,
    chain: monadTestnet,
    transport: http(),
  });

  let monHash = parseStoredHash(progress.monTxHash);
  if (monHash === undefined) {
    monHash = await progress.withAdminNonceLock(async () => {
      const hash = await walletClient.sendTransaction({
        to: address,
        value: parseEther("3"),
      });
      await progress.saveMonTxHash(hash);
      return hash;
    });
  }
  await waitForSuccessfulReceipt(
    monHash,
    () => progress.saveMonTxHash(null),
    "Initial MON transfer failed",
  );

  let usdcHash = parseStoredHash(progress.usdcTxHash);
  if (usdcHash === undefined) {
    usdcHash = await progress.withAdminNonceLock(async () => {
      const hash = await walletClient.writeContract({
        address: COLLATERAL_TOKEN_ADDRESS,
        abi: collateralMintAbi,
        functionName: "mint",
        args: [address, parseUnits("100000", COLLATERAL_DECIMALS)],
      });
      await progress.saveUsdcTxHash(hash);
      return hash;
    });
  }
  await waitForSuccessfulReceipt(
    usdcHash,
    () => progress.saveUsdcTxHash(null),
    "Initial USDC mint failed",
  );
}

async function waitForSuccessfulPolygonReceipt(
  hash: Hash,
  clearHash: () => Promise<void>,
  failureMessage: string,
): Promise<void> {
  const receipt = await polygonPublicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    await clearHash();
    throw new Error(failureMessage);
  }
}

export async function fundPolymarketWallet(
  address: Address,
  progress: PolymarketInitialFundingProgress,
): Promise<void> {
  const configuredPrivateKey = process.env.MONAD_ADMIN_PRIVATE_KEY;
  if (
    !configuredPrivateKey ||
    !isHex(configuredPrivateKey, { strict: true }) ||
    configuredPrivateKey.length !== 66
  ) {
    throw new Error(
      "MONAD_ADMIN_PRIVATE_KEY must be configured as a 32-byte hex private key",
    );
  }

  const account = privateKeyToAccount(configuredPrivateKey);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: createPolygonTransport(),
  });

  let polHash = parseStoredHash(progress.polTxHash);
  if (polHash === undefined) {
    polHash = await progress.withAdminNonceLock(async () => {
      const hash = await walletClient.sendTransaction({
        to: address,
        value: parseEther("0.1"),
      });
      await progress.savePolTxHash(hash);
      return hash;
    });
  }
  await waitForSuccessfulPolygonReceipt(
    polHash,
    () => progress.savePolTxHash(null),
    "Initial Polygon POL transfer failed",
  );

  let pusdHash = parseStoredHash(progress.pusdTxHash);
  if (pusdHash === undefined) {
    pusdHash = await progress.withAdminNonceLock(async () => {
      const hash = await walletClient.writeContract({
        address: POLYMARKET_PUSD_ADDRESS,
        abi: tokenTransferAbi,
        functionName: "transfer",
        args: [address, parseUnits("0.01", 6)],
      });
      await progress.savePusdTxHash(hash);
      return hash;
    });
  }
  await waitForSuccessfulPolygonReceipt(
    pusdHash,
    () => progress.savePusdTxHash(null),
    "Initial Polymarket pUSD transfer failed",
  );
}
