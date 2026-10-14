import { createHmac } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  isAddress,
  keccak256,
  maxUint256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

const RELAYER_URL = "https://relayer-v2.polymarket.com";
const WALLET_FACTORY: Address = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const WALLET_BEACON: Address = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";
const WALLET_IMPLEMENTATION: Address =
  "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
export const POLYMARKET_PUSD_ADDRESS: Address =
  "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const POSITION_MANAGER: Address = "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF";
const CONDITIONAL_TOKENS: Address =
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const V2_EXCHANGE: Address = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
const STANDARD_EXCHANGE: Address = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE: Address = "0xe2222d279d744050d28e00520010520000310F59";
// Legacy CLOB Neg Risk orders still report this adapter as their pUSD spender.
const NEG_RISK_ADAPTER: Address = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
export const MAX_POLYMARKET_APPROVAL_CALLS_PER_BATCH = 8;
const publicClient = createPublicClient({
  chain: polygon,
  transport: fallback([
    http("https://polygon-bor-rpc.publicnode.com"),
    http("https://polygon.drpc.org"),
  ]),
});
const BEACON_PROXY_PREFIX = BigInt("0x6100523d8160233d3973");
const BEACON_PROXY_SUFFIX = "0x60195155f3363d3d373d3d363d602036600436635c60da";
const BEACON_PROXY_MIDDLE =
  "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c";
const BEACON_PROXY_START =
  "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3";
const UUPS_PROXY_PREFIX = BigInt("0x61003d3d8160233d3973");
const UUPS_PROXY_MIDDLE =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const UUPS_PROXY_START =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";

const erc20ApprovalAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const erc1155ApprovalAbi = [
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const approvalSpecs = [
  [POLYMARKET_PUSD_ADDRESS, V2_EXCHANGE, "erc20"],
  [POLYMARKET_PUSD_ADDRESS, STANDARD_EXCHANGE, "erc20"],
  [POLYMARKET_PUSD_ADDRESS, NEG_RISK_EXCHANGE, "erc20"],
  [POSITION_MANAGER, V2_EXCHANGE, "erc1155"],
  [CONDITIONAL_TOKENS, STANDARD_EXCHANGE, "erc1155"],
  [CONDITIONAL_TOKENS, NEG_RISK_EXCHANGE, "erc1155"],
  [POLYMARKET_PUSD_ADDRESS, NEG_RISK_ADAPTER, "erc20"],
  [CONDITIONAL_TOKENS, NEG_RISK_ADAPTER, "erc1155"],
] as const;

export interface PolymarketWalletCall {
  target: Address;
  value: string;
  data: Hex;
}

export interface PolymarketWalletTransaction {
  state: string;
  errorMsg?: string;
}

const approvalCalls = (): PolymarketWalletCall[] =>
  approvalSpecs.map(([token, operator, kind]) => ({
    target: getAddress(token),
    value: "0",
    data:
      kind === "erc20"
        ? encodeFunctionData({
            abi: erc20ApprovalAbi,
            functionName: "approve",
            args: [getAddress(operator), maxUint256],
          })
        : encodeFunctionData({
            abi: erc1155ApprovalAbi,
            functionName: "setApprovalForAll",
            args: [getAddress(operator), true],
          }),
  }));

export function isAllowedPolymarketApprovalCall(call: PolymarketWalletCall) {
  return approvalCalls().some(
    (allowed) =>
      allowed.target === getAddress(call.target) &&
      allowed.value === call.value &&
      allowed.data === call.data,
  );
}

interface RelayerTransaction {
  transactionID: string;
  state: string;
  proxyAddress?: Address;
  errorMsg?: string;
}

export const getPolymarketBuilderHeaders = (
  method: string,
  path: string,
  body = "",
) => {
  const key = process.env.POLYMARKET_BUILDER_API_KEY;
  const secret = process.env.POLYMARKET_BUILDER_SECRET;
  const passphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE;
  if (!key || !secret || !passphrase) {
    const missing: string[] = [];
    if (!key) missing.push("POLYMARKET_BUILDER_API_KEY");
    if (!secret) missing.push("POLYMARKET_BUILDER_SECRET");
    if (!passphrase) missing.push("POLYMARKET_BUILDER_PASSPHRASE");
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Polymarket wallet deployment requires these server environment variables: ${missing.join(", ")}.`,
    });
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${timestamp}${method.toUpperCase()}${path}${body}`;
  const signature = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(message)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return {
    POLY_BUILDER_API_KEY: key,
    POLY_BUILDER_TIMESTAMP: timestamp,
    POLY_BUILDER_PASSPHRASE: passphrase,
    POLY_BUILDER_SIGNATURE: signature,
  };
};

export async function deployPolymarketWallet(signerAddress: Address) {
  const path = "/submit";
  const body = JSON.stringify({
    type: "WALLET-CREATE",
    from: signerAddress,
    to: WALLET_FACTORY,
    metadata: "Deploy Kites Deposit Wallet",
  });
  const response = await fetch(`${RELAYER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getPolymarketBuilderHeaders("POST", path, body),
    },
    body,
  });
  const value = await readJson(response);
  if (!isRecord(value) || typeof value.transactionID !== "string") {
    throw new Error(
      "Polymarket returned an invalid wallet deployment response.",
    );
  }
  return value.transactionID;
}

export async function getPolymarketRelayerTransaction(
  transactionID: string,
): Promise<RelayerTransaction | null> {
  const url = new URL(`${RELAYER_URL}/transaction`);
  url.searchParams.set("id", transactionID);
  const response = await fetch(url, { cache: "no-store" });
  const value = await readJson(response);
  const transaction: unknown = Array.isArray(value) ? value.at(0) : value;
  if (transaction === undefined || transaction === null) return null;
  if (!isRecord(transaction) || typeof transaction.state !== "string") {
    throw new Error("Polymarket returned an invalid relayer transaction.");
  }
  const proxyAddress =
    typeof transaction.proxyAddress === "string" &&
    isAddress(transaction.proxyAddress)
      ? transaction.proxyAddress
      : undefined;
  return {
    transactionID:
      typeof transaction.transactionID === "string"
        ? transaction.transactionID
        : transactionID,
    state: transaction.state,
    ...(proxyAddress ? { proxyAddress } : {}),
    ...(typeof transaction.errorMsg === "string"
      ? { errorMsg: transaction.errorMsg }
      : {}),
  };
}

function derivePolymarketDepositWalletAddresses(
  signerAddress: Address,
): [Address, Address] {
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [WALLET_FACTORY, pad(signerAddress, { size: 32 })],
  );
  const argsByteLength = BigInt((args.length - 2) / 2);
  const beaconPrefix = BEACON_PROXY_PREFIX + (argsByteLength << BigInt(56));
  const uupsPrefix = UUPS_PROXY_PREFIX + (argsByteLength << BigInt(56));
  const beaconInitCodeHash = keccak256(
    concatHex([
      toHex(beaconPrefix, { size: 10 }),
      WALLET_BEACON,
      BEACON_PROXY_SUFFIX,
      BEACON_PROXY_MIDDLE,
      BEACON_PROXY_START,
      args,
    ]),
  );
  const uupsInitCodeHash = keccak256(
    concatHex([
      toHex(uupsPrefix, { size: 10 }),
      WALLET_IMPLEMENTATION,
      "0x6009",
      UUPS_PROXY_MIDDLE,
      UUPS_PROXY_START,
      args,
    ]),
  );
  const salt = keccak256(args);
  const deriveAddress = (initCodeHash: Hex) =>
    getAddress(
      `0x${keccak256(
        concatHex(["0xff", WALLET_FACTORY, salt, initCodeHash]),
      ).slice(-40)}`,
    );
  return [deriveAddress(beaconInitCodeHash), deriveAddress(uupsInitCodeHash)];
}

export async function getDeployedPolymarketWalletAddress(
  signerAddress: Address,
): Promise<Address | null> {
  const addresses = derivePolymarketDepositWalletAddresses(signerAddress);
  for (const wallet of addresses) {
    const url = new URL(`${RELAYER_URL}/deployed`);
    url.searchParams.set("address", wallet);
    url.searchParams.set("type", "WALLET");
    const response = await fetch(url, { cache: "no-store" });
    const value = await readJson(response);
    if (!isRecord(value) || typeof value.deployed !== "boolean") {
      throw new Error(
        "Polymarket returned an invalid wallet deployment status.",
      );
    }
    if (value.deployed) return wallet;
  }
  return null;
}

export async function preparePolymarketTradingApprovals(
  signerAddress: Address,
  depositWalletAddress: Address,
) {
  const wallet = getAddress(depositWalletAddress);
  const [
    v2Allowance,
    standardAllowance,
    negRiskAllowance,
    v2PositionApproval,
    standardPositionApproval,
    negRiskPositionApproval,
    negRiskAdapterAllowance,
    negRiskAdapterPositionApproval,
  ] = await publicClient.multicall({
    contracts: [
      {
        address: POLYMARKET_PUSD_ADDRESS,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, V2_EXCHANGE],
      },
      {
        address: POLYMARKET_PUSD_ADDRESS,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, STANDARD_EXCHANGE],
      },
      {
        address: POLYMARKET_PUSD_ADDRESS,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, NEG_RISK_EXCHANGE],
      },
      {
        address: POSITION_MANAGER,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, V2_EXCHANGE],
      },
      {
        address: CONDITIONAL_TOKENS,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, STANDARD_EXCHANGE],
      },
      {
        address: CONDITIONAL_TOKENS,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, NEG_RISK_EXCHANGE],
      },
      {
        address: POLYMARKET_PUSD_ADDRESS,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [wallet, NEG_RISK_ADAPTER],
      },
      {
        address: CONDITIONAL_TOKENS,
        abi: erc1155ApprovalAbi,
        functionName: "isApprovedForAll",
        args: [wallet, NEG_RISK_ADAPTER],
      },
    ] as const,
    allowFailure: false,
  });
  const approved = [
    v2Allowance >= maxUint256,
    standardAllowance >= maxUint256,
    negRiskAllowance >= maxUint256,
    v2PositionApproval,
    standardPositionApproval,
    negRiskPositionApproval,
    negRiskAdapterAllowance >= maxUint256,
    negRiskAdapterPositionApproval,
  ];
  const calls = approvalCalls().filter((_, index) => !approved[index]);
  if (calls.length === 0) return { status: "complete" as const, calls };

  const path = "/v1/account/transactions/params";
  const url = new URL(`${RELAYER_URL}${path}`);
  url.searchParams.set("address", getAddress(signerAddress));
  url.searchParams.set("type", "WALLET");
  const response = await fetch(url, {
    headers: getPolymarketBuilderHeaders("GET", path),
    cache: "no-store",
  });
  const value = await readJson(response);
  if (!isRecord(value) || typeof value.nonce !== "string") {
    throw new Error("Polymarket returned an invalid wallet nonce.");
  }
  if (!/^\d+$/.test(value.nonce)) {
    throw new Error("Polymarket returned an invalid wallet nonce.");
  }

  return {
    status: "ready" as const,
    nonce: value.nonce,
    calls: calls.slice(0, MAX_POLYMARKET_APPROVAL_CALLS_PER_BATCH),
  };
}

export async function getPolymarketWalletNonce(signerAddress: Address) {
  const path = "/v1/account/transactions/params";
  const url = new URL(`${RELAYER_URL}${path}`);
  url.searchParams.set("address", getAddress(signerAddress));
  url.searchParams.set("type", "WALLET");
  const response = await fetch(url, {
    headers: getPolymarketBuilderHeaders("GET", path),
    cache: "no-store",
  });
  const value = await readJson(response);
  if (!isRecord(value) || typeof value.nonce !== "string") {
    throw new Error("Polymarket returned an invalid wallet nonce.");
  }
  if (!/^\d+$/.test(value.nonce)) {
    throw new Error("Polymarket returned an invalid wallet nonce.");
  }
  return value.nonce;
}

export async function getPolymarketPusdBalance(walletAddress: Address) {
  return publicClient.readContract({
    address: POLYMARKET_PUSD_ADDRESS,
    abi: erc20ApprovalAbi,
    functionName: "balanceOf",
    args: [getAddress(walletAddress)],
  });
}

export async function submitPolymarketTradingApprovals(input: {
  signerAddress: Address;
  depositWalletAddress: Address;
  nonce: string;
  deadline: string;
  signature: Hex;
  calls: PolymarketWalletCall[];
}) {
  return submitPolymarketWalletCalls({
    ...input,
    metadata: "Set up Polymarket trading approvals",
  });
}

export async function submitPolymarketWalletCalls(input: {
  signerAddress: Address;
  depositWalletAddress: Address;
  nonce: string;
  deadline: string;
  signature: Hex;
  calls: PolymarketWalletCall[];
  metadata: string;
}) {
  const path = "/submit";
  const body = JSON.stringify({
    type: "WALLET",
    from: getAddress(input.signerAddress),
    to: WALLET_FACTORY,
    nonce: input.nonce,
    signature: input.signature,
    metadata: input.metadata,
    depositWalletParams: {
      depositWallet: getAddress(input.depositWalletAddress),
      deadline: input.deadline,
      calls: input.calls,
    },
  });
  const response = await fetch(`${RELAYER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getPolymarketBuilderHeaders("POST", path, body),
    },
    body,
  });
  const value = await readJson(response);
  if (!isRecord(value) || typeof value.transactionID !== "string") {
    throw new Error(
      "Polymarket returned an invalid trading approval response.",
    );
  }
  return value.transactionID;
}

export async function getPolymarketWalletTransaction(
  transactionID: string,
): Promise<PolymarketWalletTransaction | null> {
  const path = `/v1/account/transactions/${encodeURIComponent(transactionID)}`;
  const response = await fetch(`${RELAYER_URL}${path}`, {
    headers: getPolymarketBuilderHeaders("GET", path),
    cache: "no-store",
  });
  const value = await readJson(response);
  if (value === null) return null;
  if (!isRecord(value) || typeof value.state !== "string") {
    throw new Error("Polymarket returned an invalid wallet transaction.");
  }
  const errorMsg =
    typeof value.error_msg === "string"
      ? value.error_msg
      : typeof value.errorMsg === "string"
        ? value.errorMsg
        : undefined;
  return {
    state: value.state,
    ...(errorMsg ? { errorMsg } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `Polymarket Relayer returned an invalid response (${response.status}).`,
    );
  }
  if (!response.ok) {
    const message =
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : `Polymarket Relayer request failed (${response.status}).`;
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
