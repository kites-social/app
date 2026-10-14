import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { type Address } from "viem";

import { showWalletStatusToast } from "~/components/toastable/toastable";
import { useAgent } from "~/lib/agent";
import { callerHint, logFlow } from "~/lib/flow-log";
import { store } from "~/lib/storage/storage";
import { api } from "~/lib/utils/api";
import { saveWalletActivity, walletActivityQueryKey } from "../activity";
import {
  runAutomaticVenueSetup,
  type AutomaticVenueId,
  type AutomaticVenueSetupTarget,
  type AutomaticVenueState,
} from "./automatic-venue-setup";
import {
  createWalletPasskey,
  requestWalletPrfOutput,
  type WalletPasskeyResult,
} from "./passkey";
import { createCustodySession, type CustodySession } from "./session";
import {
  createWalletLinkProof,
  deletePublicWalletLinkIfMatches,
  publishPublicWalletLink,
  resolvePublicWalletLink,
  type PublicWalletLink,
  type WalletLinkProof,
} from "./wallet-link";

interface WalletContextValue {
  /** True while a passkey ceremony or registration is in flight. */
  isBusy: boolean;
  /** True once the passkey-derived key is unlocked for this app session. */
  isUnlocked: boolean;
  /** Address of the unlocked session, or null when locked. */
  address: Address | null;
  /** Previous linked address after replacement, kept only for this session. */
  previousWalletAddress: Address | null;
  /**
   * Returns an unlocked session, creating and registering a passkey when the
   * account has no linked wallet yet.
   */
  ensureUnlocked: (options?: {
    existingAddress?: Address | null;
    userName?: string;
  }) => Promise<CustodySession>;
  /** Unlocks with an existing passkey, optionally matching a linked address. */
  unlock: (existingAddress?: Address | null) => Promise<CustodySession>;
  /** Creates a new passkey, derives its address, and registers it. */
  createAndRegister: (userName: string) => Promise<CustodySession>;
  /** Creates and registers a replacement for a deliberately abandoned link. */
  replaceWallet: (options: {
    existingAddress: Address;
    userName: string;
  }) => Promise<CustodySession>;
  /** Returns the unlocked session or throws. */
  requireSession: () => CustodySession;
  /** Setup progress for venues, persisted locally so background work can resume. */
  venueSetup: Partial<Record<AutomaticVenueId, AutomaticVenueState>>;
  /** Retries setup for one venue, or all venues, for the current wallet. */
  retryVenueSetup: (venue?: AutomaticVenueSetupTarget) => Promise<void>;
  /** Ends the signing session and clears the key from memory. */
  lock: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);
const credentialStorageKey = (address: Address) =>
  `wallet-passkey-credential:${address.toLowerCase()}`;
const rememberCredentialSelector = (address: Address, credentialId: string) => {
  try {
    store.set(credentialStorageKey(address), credentialId);
  } catch (error) {
    // The credential ID only selects a local passkey; the platform can still
    // offer matching credentials if this hint cannot be saved.
    console.warn("Could not save the wallet passkey selector:", error);
  }
};
const venueSetupStorageKey = (address: Address) =>
  `wallet-venue-setup.v1:${address.toLowerCase()}`;
const automaticSetupVenues = ["perpl", "polymarket"] as const;
const WALLET_ADDRESS_CONFLICT =
  "This wallet address is already linked to another account.";

function isWalletAddressConflict(error: unknown) {
  return (
    error instanceof Error && error.message.includes(WALLET_ADDRESS_CONFLICT)
  );
}

function parseVenueSetup(
  value: string | undefined,
): Partial<Record<AutomaticVenueId, AutomaticVenueState>> {
  if (!value) return {};

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};

    const setup: Partial<Record<AutomaticVenueId, AutomaticVenueState>> = {};
    for (const [venue, candidate] of Object.entries(parsed)) {
      if (
        venue !== "polymarket" &&
        venue !== "perpl" &&
        venue !== "hyperliquid"
      ) {
        continue;
      }
      if (!isRecord(candidate)) continue;
      const status = candidate.status;
      if (
        status !== "waiting" &&
        status !== "running" &&
        status !== "complete" &&
        status !== "failed"
      ) {
        continue;
      }
      if (
        typeof candidate.step !== "string" ||
        typeof candidate.updatedAt !== "number" ||
        !Number.isFinite(candidate.updatedAt)
      ) {
        continue;
      }
      setup[venue] = {
        status,
        step: candidate.step,
        updatedAt: candidate.updatedAt,
        ...(typeof candidate.error === "string"
          ? { error: candidate.error }
          : {}),
      };
    }
    return setup;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

export function WalletProvider({
  children,
  onLockAvailable,
}: {
  children: React.ReactNode;
  onLockAvailable?: (lock: () => void) => void;
}) {
  const { _ } = useLingui();
  const agent = useAgent();
  const utils = api.useUtils();
  const queryClient = useQueryClient();
  const registerWallet = api.wallet.register.useMutation();
  const ensureInitialFunding = api.wallet.ensureInitialFunding.useMutation();
  const ensurePolymarketInitialFunding =
    api.wallet.ensurePolymarketInitialFunding.useMutation();
  const completePolymarketInitialDeposit =
    api.wallet.completePolymarketInitialDeposit.useMutation();
  const deployPolymarketDepositWallet =
    api.wallet.deployPolymarketDepositWallet.useMutation();
  const preparePolymarketTradingApprovals =
    api.wallet.preparePolymarketTradingApprovals.useMutation();
  const submitPolymarketTradingApprovals =
    api.wallet.submitPolymarketTradingApprovals.useMutation();
  const [session, setSessionState] = useState<CustodySession | null>(null);
  const [previousWalletAddress, setPreviousWalletAddress] =
    useState<Address | null>(null);
  const sessionRef = useRef<CustodySession | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [venueSetup, setVenueSetup] = useState<
    Partial<Record<AutomaticVenueId, AutomaticVenueState>>
  >({});
  const setupRuns = useRef(new Map<string, Promise<void>>());
  const showVenueSetupToast = useCallback(
    (
      venue: AutomaticVenueSetupTarget,
      stage: "started" | "waiting" | "complete" | "failed",
      message?: string,
    ) => {
      const venueName = venue === "perpl" ? "Perpl" : "Polymarket";
      logFlow("wallet", "toast", { venue, stage, message });
      const title =
        stage === "started"
          ? _(msg`Setting up ${venueName}…`)
          : stage === "waiting"
            ? _(msg`${venueName} setup is waiting`)
            : stage === "complete"
              ? _(msg`${venueName} setup complete`)
              : _(msg`${venueName} setup needs attention`);
      const toastMessage =
        message ??
        (stage === "complete"
          ? _(msg`Your trading account is ready.`)
          : _(msg`Setup is continuing in the background.`));
      showWalletStatusToast({
        id: `venue-setup:${venue}`,
        title,
        message: toastMessage,
        status:
          stage === "started" || stage === "waiting"
            ? "progress"
            : stage === "complete"
              ? "success"
              : "danger",
      });
    },
    [_],
  );

  const updateVenueSetup = useCallback(
    (address: Address, venue: AutomaticVenueId, state: AutomaticVenueState) => {
      const key = venueSetupStorageKey(address);
      const next = { ...parseVenueSetup(store.getString(key)), [venue]: state };
      logFlow("wallet", "venue state", { venue, ...state });
      store.set(key, JSON.stringify(next));
      setVenueSetup(next);
    },
    [],
  );

  const startAutomaticSetup = useCallback(
    async (
      activeSession: CustodySession,
      venue?: AutomaticVenueSetupTarget,
    ) => {
      const key = venueSetupStorageKey(activeSession.address);
      const persistedSetup = parseVenueSetup(store.getString(key));
      logFlow("wallet", "startAutomaticSetup", {
        address: activeSession.address,
        venue: venue ?? "all",
        persistedSetup,
      });

      setVenueSetup(persistedSetup);

      const runVenue = (target: AutomaticVenueSetupTarget) => {
        const runKey = `${key}:${target}`;
        const existingRun = setupRuns.current.get(runKey);
        if (existingRun) {
          logFlow("wallet", "setup run already in flight", { target });
          return existingRun;
        }
        logFlow("wallet", "setup run begin", { target });

        let lastToastState = "";
        let startedToastShown = false;
        const run = runAutomaticVenueSetup({
          venue: target,
          session: activeSession,
          api: {
            deployPolymarketDepositWallet: () =>
              deployPolymarketDepositWallet.mutateAsync(),
            getPolymarketDepositWallet: () =>
              utils.wallet.polymarketDepositWallet.fetch(),
            ensurePolymarketInitialFunding: () =>
              ensurePolymarketInitialFunding.mutateAsync(),
            completePolymarketInitialDeposit: () =>
              completePolymarketInitialDeposit.mutateAsync(),
            preparePolymarketTradingApprovals: () =>
              preparePolymarketTradingApprovals.mutateAsync(),
            submitPolymarketTradingApprovals: (input) =>
              submitPolymarketTradingApprovals.mutateAsync(input),
            getPolymarketTransaction: (transactionID) =>
              utils.wallet.polymarketWalletTransaction.fetch({
                transactionID,
              }),
          },
          setState: (venueId, state) => {
            updateVenueSetup(activeSession.address, venueId, state);
            if (venueId !== target) return;
            if (state.status === "running") {
              if (!startedToastShown) {
                startedToastShown = true;
                showVenueSetupToast(target, "started");
              }
              return;
            }
            if (
              (state.status === "complete" && !startedToastShown) ||
              (state.status !== "waiting" &&
                state.status !== "complete" &&
                state.status !== "failed")
            ) {
              return;
            }
            const toastState = `${state.status}:${state.step}`;
            if (lastToastState === toastState) return;
            lastToastState = toastState;
            showVenueSetupToast(
              target,
              state.status,
              state.status === "complete"
                ? undefined
                : (state.error ?? state.step),
            );
          },
          onTransaction: (transaction) => {
            const did = agent.session?.did;
            if (!did) return;
            saveWalletActivity(did, {
              id: `tx:${transaction.chainId}:${transaction.hash}`,
              kind: transaction.kind,
              status: transaction.status,
              title: transaction.title,
              detail: transaction.detail,
              chainId: transaction.chainId,
              transactionHash: transaction.hash,
              venue: transaction.venue,
            });
            void queryClient.invalidateQueries({
              queryKey: walletActivityQueryKey(did),
            });
          },
        })
          .then(async () => {
            logFlow("wallet", "setup run finished, invalidating queries", {
              target,
            });
            await Promise.all([
              utils.wallet.mine.invalidate(),
              queryClient.invalidateQueries({
                queryKey: ["venue-onboarding"],
              }),
              queryClient.invalidateQueries({
                queryKey: ["wallet", "venue-balances"],
              }),
              queryClient.invalidateQueries({
                queryKey: ["wallet", "positions"],
              }),
            ]);
            logFlow("wallet", "post-setup invalidation done", { target });
          })
          .catch((error: unknown) => {
            logFlow("wallet", "setup run failed", {
              target,
              error: describeError(error),
            });
            throw error;
          })
          .finally(() => {
            if (setupRuns.current.get(runKey) === run) {
              setupRuns.current.delete(runKey);
            }
          });
        setupRuns.current.set(runKey, run);
        return run;
      };

      // Venues are independent (separate chains and state), so run them together.
      const venues = venue ? [venue] : automaticSetupVenues;
      const results = await Promise.allSettled(venues.map(runVenue));
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      logFlow("wallet", "startAutomaticSetup settled", {
        results: results.map((result) => result.status),
      });
      if (failure) throw failure.reason;
    },
    [
      agent.session?.did,
      deployPolymarketDepositWallet,
      completePolymarketInitialDeposit,
      ensurePolymarketInitialFunding,
      preparePolymarketTradingApprovals,
      queryClient,
      showVenueSetupToast,
      submitPolymarketTradingApprovals,
      updateVenueSetup,
      utils.wallet.polymarketDepositWallet,
      utils.wallet.polymarketWalletTransaction,
    ],
  );

  const beginInitialFunding = useCallback(() => {
    logFlow("wallet", "beginInitialFunding");
    const funding = ensureInitialFunding.mutateAsync();
    void utils.wallet.mine.invalidate();
    void funding
      .then(async (result) => {
        logFlow("wallet", "ensureInitialFunding done", { result });
        await utils.wallet.mine.invalidate();
      })
      .catch((error: unknown) => {
        logFlow("wallet", "ensureInitialFunding failed", {
          error: describeError(error),
        });
      });
  }, [ensureInitialFunding, utils.wallet.mine]);

  const setSession = useCallback((next: CustodySession | null) => {
    logFlow("wallet", "setSession", { address: next?.address ?? null });
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const linkAddress = useCallback(
    async (address: Address, account: CustodySession["account"]) => {
      const did = agent.session?.did;
      logFlow("wallet", "linkAddress begin", { address, did });
      if (!did) throw new Error("Sign in to link your wallet to Bluesky.");
      // wallet.mine verifies the signed link and registration for this DID.
      const registeredWallet = utils.wallet.mine.getData();
      if (
        registeredWallet?.did === did &&
        registeredWallet.registered &&
        registeredWallet.address.toLowerCase() === address.toLowerCase()
      ) {
        logFlow("wallet", "linkAddress already registered");
        await queryClient.invalidateQueries({
          queryKey: ["wallet", "public-link", did],
        });
        beginInitialFunding();
        return;
      }
      const existing = await resolvePublicWalletLink(agent, did);
      if (
        existing &&
        existing.address.toLowerCase() !== address.toLowerCase()
      ) {
        throw new Error(
          "This Bluesky account is already linked to a different wallet. Unlock the linked wallet before changing its address.",
        );
      }
      logFlow("wallet", "linkAddress proof creating", {
        hasExistingLink: Boolean(existing),
      });
      const proof = await createWalletLinkProof(account, did);
      // The ATProto record is the source of truth for the linked wallet. Write
      // it before syncing server-side venue metadata, so an API failure cannot
      // leave a created passkey looking like a first-time setup on the retry.
      if (!existing) {
        logFlow("wallet", "linkAddress publishing public link");
        await publishPublicWalletLink(agent, did, proof);
        logFlow("wallet", "linkAddress published public link");
      }
      try {
        logFlow("wallet", "linkAddress wallet.register");
        await registerWallet.mutateAsync({
          address,
          proof: {
            nonce: proof.nonce,
            issuedAt: proof.issuedAt,
            audience: proof.audience,
            signature: proof.signature,
          },
        });
      } catch (error) {
        logFlow("wallet", "linkAddress wallet.register failed", {
          error: describeError(error),
        });
        if (!isWalletAddressConflict(error)) throw error;

        const expectedProof = existing?.proof ?? proof;
        let removed: boolean;
        try {
          removed = await deletePublicWalletLinkIfMatches(
            agent,
            did,
            expectedProof,
          );
        } catch (cleanupError) {
          void queryClient.invalidateQueries({
            queryKey: ["wallet", "public-link", did],
          });
          console.error(
            "Could not safely remove the public wallet link after a wallet ownership conflict.",
            { error, cleanupError },
          );
          throw new Error(
            "The wallet address belongs to another account, but its public wallet link could not be safely removed.",
          );
        }
        void queryClient.invalidateQueries({
          queryKey: ["wallet", "public-link", did],
        });
        if (!removed) {
          throw new Error(
            "The public wallet link changed during conflict recovery. Refresh and try setting up your wallet again.",
          );
        }
        throw error;
      }
      logFlow("wallet", "linkAddress registered");
      await utils.wallet.mine.invalidate();
      await queryClient.invalidateQueries({
        queryKey: ["wallet", "public-link", did],
      });
      beginInitialFunding();
      logFlow("wallet", "linkAddress done");
    },
    [agent, beginInitialFunding, queryClient, registerWallet, utils],
  );

  const createAndRegister = useCallback(
    async (userName: string) => {
      const did = agent.session?.did;
      if (!did) throw new Error("Sign in before setting up your wallet.");
      setIsBusy(true);
      logFlow("wallet", "createAndRegister begin", { did });
      let passkey: WalletPasskeyResult | null = null;
      let created: CustodySession | null = null;
      try {
        passkey = await createWalletPasskey(userName);
        logFlow("wallet", "createAndRegister passkey created");
        created = createCustodySession(passkey.prfOutput, passkey.credentialId);
        await linkAddress(created.address, created.account);
        store.set(credentialStorageKey(created.address), created.credentialId);
        setSession(created);
        logFlow("wallet", "createAndRegister done", {
          address: created.address,
        });
        return created;
      } catch (error) {
        logFlow("wallet", "createAndRegister failed", {
          error: describeError(error),
        });
        created?.session.end();
        throw error;
      } finally {
        passkey?.prfOutput.fill(0);
        setIsBusy(false);
      }
    },
    [agent, linkAddress, setSession],
  );

  const replaceWallet = useCallback(
    async (options: { existingAddress: Address; userName: string }) => {
      const did = agent.session?.did;
      if (!did) throw new Error("Sign in before replacing your wallet.");

      setIsBusy(true);
      let passkey: WalletPasskeyResult | null = null;
      let created: CustodySession | null = null;
      let keepSession = false;

      const restoreOldLinkIfCurrent = async (
        oldLink: PublicWalletLink,
        replacementProof: WalletLinkProof,
        expectedCid?: string,
      ): Promise<
        "restored" | "already-old" | "replacement" | "changed" | "unknown"
      > => {
        let current: PublicWalletLink | null;
        try {
          current = await resolvePublicWalletLink(agent, did);
        } catch {
          return "unknown";
        }
        if (!current) return "changed";
        const isOldLink =
          current.address.toLowerCase() === oldLink.address.toLowerCase() &&
          current.proof.nonce === oldLink.proof.nonce &&
          current.proof.signature === oldLink.proof.signature;
        if (isOldLink) return "already-old";
        const isReplacement =
          current.address.toLowerCase() ===
            replacementProof.address.toLowerCase() &&
          current.proof.nonce === replacementProof.nonce &&
          current.proof.signature === replacementProof.signature;
        if (!isReplacement) return "changed";
        if (expectedCid && current.cid !== expectedCid) return "replacement";
        try {
          await publishPublicWalletLink(agent, did, oldLink.proof, {
            swapRecord: current.cid,
            createdAt: oldLink.createdAt,
          });
          return "restored";
        } catch {
          return "unknown";
        }
      };

      try {
        const oldLink = await resolvePublicWalletLink(agent, did);
        if (
          !oldLink ||
          oldLink.address.toLowerCase() !==
            options.existingAddress.toLowerCase()
        ) {
          throw new Error(
            "The Bluesky wallet link changed. Refresh the wallet and review the address before replacing it.",
          );
        }

        let passkeyResult: WalletPasskeyResult;
        try {
          passkeyResult = await createWalletPasskey(options.userName);
        } catch (error) {
          const detail = error instanceof Error ? ` ${error.message}` : "";
          throw new Error(
            `Passkey creation was canceled or unavailable. Your existing Bluesky wallet link is unchanged.${detail}`,
          );
        }
        passkey = passkeyResult;
        const replacement = createCustodySession(
          passkeyResult.prfOutput,
          passkeyResult.credentialId,
        );
        created = replacement;
        if (
          replacement.address.toLowerCase() === oldLink.address.toLowerCase()
        ) {
          throw new Error(
            "This passkey matches the existing wallet. Try unlocking that wallet instead.",
          );
        }

        const proof = await createWalletLinkProof(replacement.account, did);
        if (agent.session?.did !== did) {
          throw new Error(
            "Your signed-in Bluesky account changed. Sign in again before replacing the wallet.",
          );
        }

        let publishedCid: string;
        try {
          publishedCid = await publishPublicWalletLink(agent, did, proof, {
            swapRecord: oldLink.cid,
          });
        } catch {
          const rollback = await restoreOldLinkIfCurrent(oldLink, proof);
          if (rollback === "unknown" || rollback === "replacement") {
            rememberCredentialSelector(
              replacement.address,
              passkeyResult.credentialId,
            );
            throw new Error(
              rollback === "replacement"
                ? "The replacement wallet link is still active, but the update could not be confirmed. Your new passkey is saved on this device; refresh the wallet before trying again."
                : "The wallet-link update could not be confirmed. Your new passkey is saved on this device; refresh the wallet before trying again.",
            );
          }
          throw new Error(
            rollback === "already-old"
              ? "The wallet link could not be updated. Your existing Bluesky wallet link is unchanged; please try again."
              : "The Bluesky wallet link changed during replacement. Refresh it and review the address before trying again.",
          );
        }

        let registrationFailed = false;
        let registrationError: unknown;
        try {
          if (agent.session?.did !== did) {
            throw new Error(
              "Your signed-in Bluesky account changed. Sign in again before replacing the wallet.",
            );
          }
          const registered = await registerWallet.mutateAsync({
            address: replacement.address,
            proof: {
              nonce: proof.nonce,
              issuedAt: proof.issuedAt,
              audience: proof.audience,
              signature: proof.signature,
            },
          });
          if (
            registered.address.toLowerCase() !==
            replacement.address.toLowerCase()
          ) {
            throw new Error(
              "The server registered a different wallet address than the one just created.",
            );
          }
        } catch (error) {
          registrationFailed = true;
          registrationError = error;
        }

        if (registrationFailed) {
          const rollback = await restoreOldLinkIfCurrent(
            oldLink,
            proof,
            publishedCid,
          );
          if (rollback === "restored" || rollback === "already-old") {
            const cause =
              registrationError instanceof Error
                ? ` ${registrationError.message}`
                : "";
            throw new Error(
              `Registration did not finish. Your original Bluesky wallet link is active.${cause}`,
            );
          }

          let currentLink: PublicWalletLink | null | undefined;
          try {
            currentLink = await resolvePublicWalletLink(agent, did);
          } catch {
            currentLink = undefined;
          }
          const replacementIsLinked =
            currentLink !== null &&
            currentLink !== undefined &&
            currentLink.address.toLowerCase() ===
              replacement.address.toLowerCase() &&
            currentLink.proof.nonce === proof.nonce &&
            currentLink.proof.signature === proof.signature;
          const linkIsUnknown = currentLink === undefined;
          if (replacementIsLinked || linkIsUnknown) {
            rememberCredentialSelector(
              replacement.address,
              passkeyResult.credentialId,
            );
          }
          throw new Error(
            replacementIsLinked
              ? "Registration did not finish, and the replacement wallet is still linked. Your new passkey is saved on this device; refresh the wallet before trying again."
              : linkIsUnknown
                ? "Registration did not finish and the Bluesky wallet link could not be checked. Your new passkey is saved on this device; refresh before trying again."
                : currentLink?.address.toLowerCase() ===
                    oldLink.address.toLowerCase()
                  ? "Registration did not finish. Your original Bluesky wallet link is still active; refresh the wallet before trying again."
                  : "Registration did not finish and the Bluesky wallet link changed. Refresh the wallet and review the linked address before trying again.",
          );
        }

        rememberCredentialSelector(
          replacement.address,
          passkeyResult.credentialId,
        );
        setPreviousWalletAddress(oldLink.address);
        sessionRef.current?.session.end();
        setSession(replacement);
        keepSession = true;
        void utils.wallet.mine.invalidate();
        void queryClient.invalidateQueries({
          queryKey: ["wallet", "public-link", did],
        });
        beginInitialFunding();
        void startAutomaticSetup(replacement).catch((error: unknown) => {
          logFlow("wallet", "replacement automatic setup rejected", {
            error: describeError(error),
          });
        });
        return replacement;
      } catch (error) {
        if (created && !keepSession) created.session.end();
        void queryClient.invalidateQueries({
          queryKey: ["wallet", "public-link", did],
        });
        throw error;
      } finally {
        passkey?.prfOutput.fill(0);
        setIsBusy(false);
      }
    },
    [
      agent,
      beginInitialFunding,
      queryClient,
      registerWallet,
      setSession,
      startAutomaticSetup,
      utils,
    ],
  );

  const unlock = useCallback(
    async (existingAddress?: Address | null) => {
      const did = agent.session?.did;
      if (!did) throw new Error("Sign in before unlocking your wallet.");
      setIsBusy(true);
      logFlow("wallet", "unlock begin", { did, existingAddress });
      let passkey: WalletPasskeyResult | null = null;
      let opened: CustodySession | null = null;
      try {
        const credentialId = existingAddress
          ? store.getString(credentialStorageKey(existingAddress))
          : undefined;
        passkey = await requestWalletPrfOutput(credentialId);
        logFlow("wallet", "unlock passkey asserted");
        opened = createCustodySession(passkey.prfOutput, passkey.credentialId);
        if (
          existingAddress &&
          opened.address.toLowerCase() !== existingAddress.toLowerCase()
        ) {
          throw new Error(
            "The selected passkey does not match this account's linked wallet. Try unlocking with the passkey used to set up this wallet.",
          );
        }
        await linkAddress(opened.address, opened.account);
        store.set(credentialStorageKey(opened.address), opened.credentialId);
        setSession(opened);
        logFlow("wallet", "unlock done", { address: opened.address });
        return opened;
      } catch (error) {
        logFlow("wallet", "unlock failed", { error: describeError(error) });
        opened?.session.end();
        throw error;
      } finally {
        passkey?.prfOutput.fill(0);
        setIsBusy(false);
      }
    },
    [agent, linkAddress, setSession],
  );

  const ensureUnlocked = useCallback(
    async (options?: {
      existingAddress?: Address | null;
      userName?: string;
    }) => {
      const current = sessionRef.current;
      logFlow("wallet", "ensureUnlocked", {
        hasCurrent: Boolean(current),
        existingAddress: options?.existingAddress ?? null,
        caller: callerHint(),
      });
      if (current) {
        if (
          options?.existingAddress &&
          current.address.toLowerCase() !==
            options.existingAddress.toLowerCase()
        ) {
          current.session.end();
          setSession(null);
        } else {
          return current;
        }
      }
      const startSetup = (walletSession: CustodySession) => {
        void startAutomaticSetup(walletSession).catch((error: unknown) => {
          logFlow("wallet", "automatic setup rejected", {
            error: describeError(error),
          });
        });
        return walletSession;
      };
      if (options?.existingAddress) {
        return startSetup(await unlock(options.existingAddress));
      }
      const did = agent.session?.did;
      if (!did) throw new Error("Sign in before setting up your wallet.");
      const publicLink = await resolvePublicWalletLink(agent, did);
      const userName = options?.userName ?? "Kites wallet";
      if (publicLink) {
        try {
          return startSetup(await unlock(publicLink.address));
        } catch (error) {
          if (!isWalletAddressConflict(error)) throw error;
          console.warn(
            "The linked wallet belongs to another account; creating a fresh wallet for this account.",
            error,
          );
        }
      }
      const created = await createAndRegister(userName);
      return startSetup(created);
    },
    [agent, createAndRegister, setSession, startAutomaticSetup, unlock],
  );

  const requireSession = useCallback(() => {
    const current = sessionRef.current;
    if (!current) {
      throw new Error(
        "Unlock your wallet passkey before signing. No wallet data was changed.",
      );
    }
    return current;
  }, []);

  const retryVenueSetup = useCallback(
    async (venue?: AutomaticVenueSetupTarget) => {
      const current = sessionRef.current;
      if (!current) {
        throw new Error(
          "Unlock your Kites wallet before retrying venue setup.",
        );
      }
      if (!venue || venue === "perpl") beginInitialFunding();
      logFlow("wallet", "retryVenueSetup", { venue: venue ?? "all" });
      await startAutomaticSetup(current, venue);
    },
    [beginInitialFunding, startAutomaticSetup],
  );

  const lock = useCallback(() => {
    logFlow("wallet", "lock", {
      wasUnlocked: Boolean(sessionRef.current),
      caller: callerHint(),
    });
    sessionRef.current?.session.end();
    setSession(null);
  }, [setSession]);

  useEffect(() => {
    onLockAvailable?.(lock);
  }, [lock, onLockAvailable]);

  // The wallet is never unlocked or created automatically on sign-in. It is
  // created from the wallet tab and unlocked on demand (wallet tab or trade).
  const activeDid = agent.session?.did ?? null;
  const previousDid = useRef(activeDid);
  useEffect(() => {
    if (previousDid.current === activeDid) return;
    logFlow("wallet", "active DID changed, locking", {
      from: previousDid.current,
      to: activeDid,
    });
    lock();
    setVenueSetup({});
    setPreviousWalletAddress(null);
    previousDid.current = activeDid;
  }, [activeDid, lock]);

  const value = useMemo<WalletContextValue>(
    () => ({
      isBusy,
      isUnlocked: session !== null,
      address: session?.address ?? null,
      previousWalletAddress,
      ensureUnlocked,
      unlock,
      createAndRegister,
      replaceWallet,
      requireSession,
      venueSetup,
      retryVenueSetup,
      lock,
    }),
    [
      isBusy,
      session,
      previousWalletAddress,
      ensureUnlocked,
      unlock,
      createAndRegister,
      replaceWallet,
      requireSession,
      venueSetup,
      retryVenueSetup,
      lock,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
}
