import {
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import { logFlow } from "~/lib/flow-log";
import {
  getPolymarketTokenBalance,
  polymarketFundingAdapter,
  sendToPolymarket,
} from "~/lib/venues/funding";
import {
  enrollPerplApiKey,
  hasPerplApiCredentials,
} from "~/lib/venues/perpetual-markets/perpl/api-credentials";
import {
  capturePerplSetupError,
  logPerplSetup,
} from "~/lib/venues/perpetual-markets/perpl/logging";
import { perplOnboarding } from "~/lib/venues/perpetual-markets/perpl/onboarding";
import {
  fetchPerplProtocolConfig,
  hasPerplOnchainAccount,
  PerplFaucetCooldownError,
  requestPerplTestnetAUsd,
} from "~/lib/venues/perpetual-markets/perpl/protocol";
import {
  clearPendingPolymarketApprovalTransaction,
  clearPendingPolymarketInitialDepositTransaction,
  createPolymarketApprovalTypedData,
  getPendingPolymarketApprovalTransaction,
  getPendingPolymarketInitialDepositTransaction,
  polymarketOnboarding,
  savePendingPolymarketApprovalTransaction,
  savePendingPolymarketInitialDepositTransaction,
  syncPolymarketCollateralAllowance,
} from "~/lib/venues/prediction-markets/polymarket/onboarding";
import { erc20Abi, getAppChain } from "~/lib/web3";
import { type CustodySession } from "./session";

export type AutomaticVenueId = "polymarket" | "perpl" | "hyperliquid";
export type AutomaticVenueSetupTarget = Exclude<
  AutomaticVenueId,
  "hyperliquid"
>;
export type AutomaticVenueStatus =
  | "waiting"
  | "running"
  | "complete"
  | "failed";

const logPolymarket = (event: string, data: Record<string, unknown> = {}) =>
  logFlow("polymarket", event, data);

const POLYMARKET_INITIAL_PUSD_AMOUNT = "0.01";
const POLYMARKET_INITIAL_PUSD_AMOUNT_RAW = parseUnits(
  POLYMARKET_INITIAL_PUSD_AMOUNT,
  polymarketFundingAdapter.token.decimals,
);

export interface AutomaticVenueState {
  status: AutomaticVenueStatus;
  step: string;
  error?: string;
  updatedAt: number;
}

type DepositWalletResult =
  | { status: "missing" | "not-created" | "pending" }
  | { status: "deployed"; address: Address }
  | { status: "failed"; error: string };

type ApprovalBatch =
  | { status: "complete"; depositWalletAddress: Address }
  | {
      status: "ready";
      depositWalletAddress: Address;
      nonce: string;
      deadline: string;
      calls: { target: Address; data: Hex }[];
    };

export interface AutomaticVenueSetupApi {
  deployPolymarketDepositWallet: () => Promise<unknown>;
  getPolymarketDepositWallet: () => Promise<DepositWalletResult>;
  ensurePolymarketInitialFunding: () => Promise<{
    status: "complete" | "pending" | "retryable";
    depositComplete: boolean;
  }>;
  completePolymarketInitialDeposit: () => Promise<{ status: "complete" }>;
  preparePolymarketTradingApprovals: () => Promise<ApprovalBatch>;
  submitPolymarketTradingApprovals: (input: {
    nonce: string;
    deadline: string;
    signature: Hex;
    calls: { target: Address; value: "0"; data: Hex }[];
  }) => Promise<{ transactionID: string }>;
  getPolymarketTransaction: (transactionID: string) => Promise<{
    state: string;
    errorMsg?: string | null;
  } | null>;
}

export async function runAutomaticVenueSetup(input: {
  venue: AutomaticVenueSetupTarget;
  session: CustodySession;
  api: AutomaticVenueSetupApi;
  setState: (venue: AutomaticVenueId, state: AutomaticVenueState) => void;
  onTransaction?: (event: {
    venue: "Perpl" | "Polymarket";
    chainId: number;
    hash: Hex;
    kind: "approval" | "funding";
    status: "pending" | "submitted" | "confirmed" | "failed";
    title: string;
    detail: string;
  }) => void;
}) {
  const { setState } = input;
  const update = (
    venue: AutomaticVenueId,
    status: AutomaticVenueStatus,
    step: string,
    error?: string,
  ) => setState(venue, { status, step, error, updatedAt: Date.now() });

  update("hyperliquid", "complete", "Wallet linked");
  if (input.venue === "polymarket") {
    await runPolymarketSetup(input, update);
  } else {
    await runPerplSetup(input, update);
  }
}

async function runPolymarketSetup(
  input: Parameters<typeof runAutomaticVenueSetup>[0],
  update: (
    venue: AutomaticVenueId,
    status: AutomaticVenueStatus,
    step: string,
    error?: string,
  ) => void,
) {
  try {
    const walletAddress = addressOf(input.session);
    logPolymarket("setup_started", { walletAddress });
    const depositWallet = await input.api.getPolymarketDepositWallet();
    logPolymarket("deposit_wallet_status", { ...depositWallet });
    if (depositWallet.status === "failed") {
      throw new Error(depositWallet.error);
    }
    const existingDepositWalletAddress =
      depositWallet.status === "deployed"
        ? getAddress(depositWallet.address)
        : undefined;
    const steps = await polymarketOnboarding.getSteps({
      walletAddress,
      depositWalletAddress: existingDepositWalletAddress,
    });
    const needsSetup = steps.some(
      (step) => step.kind === "action" && step.status !== "complete",
    );
    logPolymarket("onboarding_steps", {
      needsSetup,
      steps: steps.map((step) => `${step.id}:${step.status}`),
    });
    if (!needsSetup) {
      if (depositWallet.status !== "deployed") {
        throw new Error("The Polymarket deposit wallet is not available yet.");
      }
      await ensurePolymarketFundingAndDeposit(
        input,
        getAddress(depositWallet.address),
        update,
      );
      update("polymarket", "complete", "Trading account ready");
      return;
    }

    update("polymarket", "running", "Preparing deposit wallet");
    logPolymarket("deploy_deposit_wallet_requested");
    const deployment = input.api.deployPolymarketDepositWallet();

    // CLOB credentials are independent of deposit-wallet deployment, so get
    // them while the relayer provisions the wallet.
    const authentication = polymarketOnboarding
      .runStep("clob-authentication", {
        walletAddress,
        signTypedData: (request) =>
          input.session.account.signTypedData(request),
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await deployment;
    logPolymarket("deploy_deposit_wallet_request_returned");

    let result = await input.api.getPolymarketDepositWallet();
    for (
      let attempt = 0;
      (result.status === "pending" || result.status === "not-created") &&
      attempt < 60;
      attempt++
    ) {
      update("polymarket", "running", "Waiting for deposit wallet");
      await delay(2_000);
      result = await input.api.getPolymarketDepositWallet();
    }
    if (result.status === "failed") throw new Error(result.error);
    if (result.status !== "deployed") {
      throw new Error("Polymarket wallet deployment is still processing.");
    }
    const depositWalletAddress = getAddress(result.address);
    logPolymarket("deposit_wallet_deployed", { depositWalletAddress });
    const authResult = await authentication;
    logPolymarket("clob_authentication_result", { ok: authResult.ok });
    if (!authResult.ok) throw authResult.error;

    const waitForApproval = async (transactionID: string) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const transaction =
          await input.api.getPolymarketTransaction(transactionID);
        const state = transaction?.state.toUpperCase();
        if (state === "STATE_CONFIRMED") {
          await clearPendingPolymarketApprovalTransaction(
            input.session.address,
          );
          return;
        }
        if (state === "STATE_FAILED" || state === "STATE_INVALID") {
          await clearPendingPolymarketApprovalTransaction(
            input.session.address,
          );
          throw new Error(
            transaction?.errorMsg ?? "Polymarket approval failed.",
          );
        }
        await delay(2_000);
      }
      throw new Error("Polymarket approval is still processing.");
    };

    const pendingId = await getPendingPolymarketApprovalTransaction(
      input.session.address,
    );
    if (pendingId) await waitForApproval(pendingId);

    update("polymarket", "running", "Configuring trading permissions");
    let previousBatch = "";
    while (true) {
      const batch = await input.api.preparePolymarketTradingApprovals();
      logPolymarket("approval_batch", {
        status: batch.status,
        calls: batch.status === "ready" ? batch.calls.length : 0,
      });
      if (batch.status === "complete") break;
      const calls = batch.calls.map((call) => ({
        target: getAddress(call.target),
        value: "0" as const,
        data: call.data,
      }));
      if (!calls.length)
        throw new Error("Polymarket returned an empty approval batch.");
      const fingerprint = JSON.stringify(calls);
      if (fingerprint === previousBatch) {
        throw new Error("Polymarket approvals are still missing on-chain.");
      }
      previousBatch = fingerprint;
      const approvalSignature = await input.session.account.signTypedData(
        createPolymarketApprovalTypedData({
          depositWalletAddress,
          nonce: batch.nonce,
          deadline: batch.deadline,
          calls,
        }),
      );
      const { transactionID } =
        await input.api.submitPolymarketTradingApprovals({
          nonce: batch.nonce,
          deadline: batch.deadline,
          signature: approvalSignature,
          calls,
        });
      logPolymarket("approval_submitted", { transactionID });
      await savePendingPolymarketApprovalTransaction(
        input.session.address,
        transactionID,
      );
      await waitForApproval(transactionID);
      logPolymarket("approval_confirmed", { transactionID });
    }
    logPolymarket("approvals_complete");
    await syncPolymarketCollateralAllowance(input.session.address, (request) =>
      input.session.account.signTypedData(request),
    );
    await ensurePolymarketFundingAndDeposit(
      input,
      depositWalletAddress,
      update,
    );
    logPolymarket("setup_complete");
    update("polymarket", "complete", "Trading account ready");
  } catch (error) {
    logPolymarket("setup_failed", {
      error: error instanceof Error ? error.stack : String(error),
    });
    update(
      "polymarket",
      "failed",
      "Setup needs attention",
      error instanceof Error ? error.message : "Polymarket setup failed.",
    );
  }
}

async function ensurePolymarketFundingAndDeposit(
  input: Parameters<typeof runAutomaticVenueSetup>[0],
  depositWalletAddress: Address,
  update: (
    venue: AutomaticVenueId,
    status: AutomaticVenueStatus,
    step: string,
    error?: string,
  ) => void,
) {
  update("polymarket", "running", "Funding Polygon wallet");
  const walletAddress = getAddress(input.session.address);
  const pendingHash = await getPendingPolymarketInitialDepositTransaction(
    walletAddress,
    depositWalletAddress,
  );
  logPolymarket("funding_started", {
    walletAddress,
    depositWalletAddress,
    pendingHash,
  });
  if (!pendingHash) {
    const depositBalance =
      await getPolymarketTokenBalance(depositWalletAddress);
    logPolymarket("funding_initial_deposit_balance", {
      depositBalance: depositBalance.toString(),
    });
    if (depositBalance >= POLYMARKET_INITIAL_PUSD_AMOUNT_RAW) {
      await input.api.completePolymarketInitialDeposit();
      logPolymarket("funding_already_deposited");
      return;
    }
  }

  let fundingComplete = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const funding = await input.api.ensurePolymarketInitialFunding();
    logPolymarket("funding_poll", { attempt, ...funding });
    if (funding.depositComplete && !pendingHash) return;
    if (funding.status === "complete") {
      fundingComplete = true;
      break;
    }
    if (funding.status === "retryable") {
      throw new Error(
        "Could not fund the Polygon wallet. Check the backend funding wallet and retry Polymarket setup.",
      );
    }
    await delay(2_000);
  }
  if (!fundingComplete) {
    throw new Error(
      "Polygon funding is still processing. Retry Polymarket setup shortly.",
    );
  }

  if (!pendingHash) {
    const depositBalance =
      await getPolymarketTokenBalance(depositWalletAddress);
    if (depositBalance >= POLYMARKET_INITIAL_PUSD_AMOUNT_RAW) {
      await input.api.completePolymarketInitialDeposit();
      return;
    }
  }

  let hash: Hash;
  if (pendingHash) {
    hash = pendingHash;
  } else {
    const depositBalance =
      await getPolymarketTokenBalance(depositWalletAddress);
    if (depositBalance >= POLYMARKET_INITIAL_PUSD_AMOUNT_RAW) {
      await input.api.completePolymarketInitialDeposit();
      return;
    }

    const walletBalance = await getPolymarketTokenBalance(walletAddress);
    if (walletBalance < POLYMARKET_INITIAL_PUSD_AMOUNT_RAW) {
      throw new Error(
        "The 0.01 pUSD grant is confirmed, but it is not yet available in your Kites wallet. Retry setup shortly.",
      );
    }

    update("polymarket", "running", "Depositing initial pUSD");
    logPolymarket("deposit_sending", {
      depositWalletAddress,
      walletBalance: walletBalance.toString(),
    });
    hash = await sendToPolymarket(
      input.session.account,
      depositWalletAddress,
      POLYMARKET_INITIAL_PUSD_AMOUNT,
    );
    logPolymarket("deposit_sent", { hash });
    await savePendingPolymarketInitialDepositTransaction(
      walletAddress,
      depositWalletAddress,
      hash,
    );
  }

  const reportTransaction = (status: "pending" | "confirmed" | "failed") => {
    input.onTransaction?.({
      venue: "Polymarket",
      chainId: polymarketFundingAdapter.sourceChainId,
      hash,
      kind: "funding",
      status,
      title: `Polymarket deposit · ${POLYMARKET_INITIAL_PUSD_AMOUNT} pUSD`,
      detail: "Kites wallet → Polymarket deposit wallet · Polygon",
    });
  };
  reportTransaction("pending");
  logPolymarket("deposit_waiting_for_receipt", { hash });

  let receipt;
  try {
    receipt = await getAppChain(
      polymarketFundingAdapter.sourceChainId,
    ).publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (error) {
    throw new Error(
      `The initial Polymarket pUSD deposit is still pending. Retry setup to resume it. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  logPolymarket("deposit_receipt", { hash, status: receipt.status });
  if (receipt.status !== "success") {
    await clearPendingPolymarketInitialDepositTransaction(
      walletAddress,
      depositWalletAddress,
    );
    reportTransaction("failed");
    throw new Error("The initial Polymarket pUSD deposit failed on Polygon.");
  }

  const depositBalance = await getPolymarketTokenBalance(depositWalletAddress);
  if (depositBalance < POLYMARKET_INITIAL_PUSD_AMOUNT_RAW) {
    throw new Error(
      "The Polymarket pUSD transfer confirmed, but the deposit has not appeared yet. Retry setup to verify it.",
    );
  }
  await clearPendingPolymarketInitialDepositTransaction(
    walletAddress,
    depositWalletAddress,
  );
  reportTransaction("confirmed");
  await input.api.completePolymarketInitialDeposit();
}

async function runPerplSetup(
  input: Parameters<typeof runAutomaticVenueSetup>[0],
  update: (
    venue: AutomaticVenueId,
    status: AutomaticVenueStatus,
    step: string,
    error?: string,
  ) => void,
) {
  const walletAddress = getAddress(input.session.address);
  try {
    const preflightSteps = await perplOnboarding.getSteps({ walletAddress });
    // Collateral funding is user-controlled, not part of automatic setup.
    const setupStepIds = new Set([
      "create-account",
      "api-key-enrollment",
      "enable-order-forwarding",
      "revoke-order-forwarding",
    ]);
    const needsSetup = preflightSteps.some(
      (step) => setupStepIds.has(step.id) && step.status !== "complete",
    );
    if (!needsSetup) {
      update("perpl", "complete", "Trading account ready");
      return;
    }

    update("perpl", "running", "Enabling in-app trading");
    logPerplSetup("setup_started", { walletAddress });
    const config = await fetchPerplProtocolConfig();
    logPerplSetup("protocol_config_loaded", {
      walletAddress,
      chainId: config.chainId,
      exchangeAddress: config.exchangeAddress,
      collateralAddress: config.collateralAddress,
      collateralSymbol: config.collateralSymbol,
      collateralDecimals: config.collateralDecimals,
      minAccountOpenAmount: formatUnits(
        config.minAccountOpenAmount,
        config.collateralDecimals,
      ),
    });
    const signingContext = {
      walletAddress,
      signTypedData: (
        request: Parameters<typeof input.session.account.signTypedData>[0],
      ) => input.session.account.signTypedData(request),
      sendTransaction: async (
        chainId: number,
        transaction: { to: Address; data: Hex; value?: bigint },
      ) => {
        const chain = getAppChain(chainId);
        return createWalletClient({
          account: input.session.account,
          chain: chain.chain,
          transport: http(),
        }).sendTransaction(transaction);
      },
      onTransaction: (event: {
        chainId: number;
        hash: Hex;
        kind: "approval" | "funding";
        status: "pending" | "submitted" | "confirmed" | "failed";
        title: string;
        detail: string;
      }) => input.onTransaction?.({ ...event, venue: "Perpl" }),
    };
    let accountExists = await hasPerplOnchainAccount(walletAddress, config);
    logPerplSetup("onchain_account_checked", {
      walletAddress,
      chainId: config.chainId,
      exchangeAddress: config.exchangeAddress,
      accountExists,
    });
    if (!accountExists) {
      const chain = getAppChain(config.chainId);
      let balance = await chain.publicClient.readContract({
        address: config.collateralAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      });
      let nativeBalance = await chain.publicClient.getBalance({
        address: walletAddress,
      });
      logPerplSetup("initial_funding_preflight", {
        walletAddress,
        chainId: config.chainId,
        collateralAddress: config.collateralAddress,
        collateralBalance: formatUnits(balance, config.collateralDecimals),
        collateralBalanceRaw: balance.toString(),
        nativeBalance: formatEther(nativeBalance),
        minAccountOpenAmount: formatUnits(
          config.minAccountOpenAmount,
          config.collateralDecimals,
        ),
      });
      const initialNativeBalance = nativeBalance;
      for (
        let attempt = 0;
        nativeBalance < parseEther("0.05") && attempt < 90;
        attempt++
      ) {
        update("perpl", "waiting", "Waiting for Monad testnet gas");
        await delay(2_000);
        nativeBalance = await chain.publicClient.getBalance({
          address: walletAddress,
        });
      }
      if (nativeBalance !== initialNativeBalance) {
        logPerplSetup("native_gas_balance_wait_finished", {
          walletAddress,
          chainId: config.chainId,
          initialNativeBalance: formatEther(initialNativeBalance),
          currentNativeBalance: formatEther(nativeBalance),
          requiredNativeBalance: "0.05",
        });
      }
      if (nativeBalance < parseEther("0.05")) {
        logPerplSetup("native_gas_balance_below_minimum", {
          walletAddress,
          chainId: config.chainId,
          nativeBalance: formatEther(nativeBalance),
          requiredNativeBalance: "0.05",
        });
        throw new Error(
          "Monad testnet funds have not arrived yet. Setup will resume when retried.",
        );
      }

      balance = await chain.publicClient.readContract({
        address: config.collateralAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      });
      logPerplSetup("collateral_balance_checked_before_faucet", {
        walletAddress,
        chainId: config.chainId,
        collateralAddress: config.collateralAddress,
        collateralSymbol: config.collateralSymbol,
        collateralBalance: formatUnits(balance, config.collateralDecimals),
        collateralBalanceRaw: balance.toString(),
        minAccountOpenAmount: formatUnits(
          config.minAccountOpenAmount,
          config.collateralDecimals,
        ),
      });
      if (balance < config.minAccountOpenAmount) {
        update("perpl", "running", "Requesting Perpl testnet AUSD");
        logPerplSetup("automatic_faucet_request_started", {
          walletAddress,
          chainId: config.chainId,
          collateralAddress: config.collateralAddress,
          collateralBalance: formatUnits(balance, config.collateralDecimals),
          minAccountOpenAmount: formatUnits(
            config.minAccountOpenAmount,
            config.collateralDecimals,
          ),
        });
        await requestPerplAUsdWithCooldownRetry(signingContext, update);
        balance = await chain.publicClient.readContract({
          address: config.collateralAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [walletAddress],
        });
        logPerplSetup("collateral_balance_checked_after_faucet", {
          walletAddress,
          chainId: config.chainId,
          collateralAddress: config.collateralAddress,
          collateralSymbol: config.collateralSymbol,
          collateralBalance: formatUnits(balance, config.collateralDecimals),
          collateralBalanceRaw: balance.toString(),
          minAccountOpenAmount: formatUnits(
            config.minAccountOpenAmount,
            config.collateralDecimals,
          ),
        });
      } else {
        logPerplSetup("faucet_request_skipped_balance_sufficient", {
          walletAddress,
          chainId: config.chainId,
          collateralAddress: config.collateralAddress,
          collateralBalance: formatUnits(balance, config.collateralDecimals),
          minAccountOpenAmount: formatUnits(
            config.minAccountOpenAmount,
            config.collateralDecimals,
          ),
        });
      }
      if (balance < config.minAccountOpenAmount) {
        logPerplSetup("collateral_balance_still_below_minimum", {
          walletAddress,
          chainId: config.chainId,
          collateralAddress: config.collateralAddress,
          collateralBalance: formatUnits(balance, config.collateralDecimals),
          collateralBalanceRaw: balance.toString(),
          minAccountOpenAmount: formatUnits(
            config.minAccountOpenAmount,
            config.collateralDecimals,
          ),
        });
        throw new Error(
          "Perpl testnet AUSD funds have not arrived yet. Setup will resume when retried.",
        );
      }
      update("perpl", "running", "Creating Perpl account");
      await perplOnboarding.runStep("create-account", signingContext);
      accountExists = await hasPerplOnchainAccount(walletAddress, config);
    }

    if (!accountExists) throw new Error("Perpl account is not available yet.");
    // Perpl's enrollment endpoint returns 404 until this wallet has an
    // exchange profile, so create the on-chain account before enrolling its
    // API key.
    if (!(await hasPerplApiCredentials(walletAddress))) {
      update("perpl", "running", "Enabling in-app trading");
      await enrollPerplApiKey(
        walletAddress,
        signingContext.signTypedData,
        "testnet",
      );
    }

    const steps = await perplOnboarding.getSteps({ walletAddress });
    const forwarding = steps.find(
      (step) =>
        step.id === "enable-order-forwarding" ||
        step.id === "revoke-order-forwarding",
    );
    if (forwarding?.status !== "complete") {
      if (forwarding?.status === "blocked") {
        throw new Error(
          "Perpl order permission could not be checked. Retry setup shortly.",
        );
      }
      update("perpl", "running", "Allowing Perpl to submit signed orders");
      await perplOnboarding.runStep("enable-order-forwarding", signingContext);
    }
    update("perpl", "complete", "Trading account ready");
    logPerplSetup("setup_completed", { walletAddress });
  } catch (error) {
    capturePerplSetupError(error, walletAddress);
    const isWaitingForFunds =
      error instanceof Error &&
      error.message.includes("funds have not arrived");
    const isFaucetRateLimited =
      error instanceof Error &&
      (error.message.includes("frequency limit") ||
        error.message.includes("global cooldown"));
    update(
      "perpl",
      isWaitingForFunds || isFaucetRateLimited ? "waiting" : "failed",
      isFaucetRateLimited
        ? "Waiting for faucet cooldown"
        : isWaitingForFunds
          ? "Waiting for testnet funds"
          : "Setup needs attention",
      error instanceof Error ? error.message : "Perpl setup failed.",
    );
  }
}

function addressOf(session: CustodySession): Address {
  return getAddress(session.address);
}

async function requestPerplAUsdWithCooldownRetry(
  context: Parameters<typeof requestPerplTestnetAUsd>[0],
  update: (
    venue: AutomaticVenueId,
    status: AutomaticVenueStatus,
    step: string,
    error?: string,
  ) => void,
) {
  while (true) {
    try {
      return await requestPerplTestnetAUsd(context);
    } catch (error) {
      if (!(error instanceof PerplFaucetCooldownError)) throw error;

      const seconds = error.remainingSeconds + 2;
      update(
        "perpl",
        "waiting",
        "Waiting for shared AUSD faucet cooldown",
        `The shared testnet faucet is rate-limited. Retrying automatically in about ${seconds} seconds.`,
      );
      await delay(seconds * 1_000);
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
