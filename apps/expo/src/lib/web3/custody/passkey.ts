import { requireWalletRpId, WALLET_RP_NAME } from "./config";

/**
 * The React Native WebAuthn client imports `react-native-passkey`, which loads
 * a native module at import time. Import it lazily so the app can start in
 * environments without the native module (for example Expo Go) and only fail
 * when a wallet ceremony is actually requested.
 */
let webAuthnClientPromise:
  | Promise<typeof import("@category-labs/mera/react-native-webauthn-client")>
  | undefined;

const getWebAuthnClient = async () => {
  webAuthnClientPromise ??=
    import("@category-labs/mera/react-native-webauthn-client");
  const { reactNativeWebAuthnClient } = await webAuthnClientPromise;
  return reactNativeWebAuthnClient;
};

export interface WalletPasskeyResult {
  /** 32-byte PRF output. Treat as secret key material and clear it when done. */
  prfOutput: Uint8Array;
  /** Identifier used to request the same passkey PRF output or dev seed. */
  credentialId: string;
}

/** Reports whether the platform thinks passkeys are supported. Diagnostics. */
export async function isPasskeySupported(): Promise<boolean> {
  try {
    const { Passkey } = await import("react-native-passkey");
    return Passkey.isSupported();
  } catch {
    return false;
  }
}

/**
 * How long to wait for a native passkey ceremony before giving up. WebAuthn's
 * own `timeout` is only a hint and is not reliably enforced, and some
 * providers (notably on Waydroid / partial GMS) dismiss the ceremony activity
 * without ever resolving or rejecting the promise. Without this race the
 * caller — and any busy flag it sets — hangs forever.
 */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 120_000;

const withCeremonyTimeout = async <T>(
  ceremony: Promise<T>,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ceremony,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${PASSKEY_CEREMONY_TIMEOUT_MS}ms; the passkey ceremony did not return`,
              ),
            ),
          PASSKEY_CEREMONY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Creates a new discoverable, user-verified passkey and returns its PRF output. */
export async function createWalletPasskey(
  userName: string,
): Promise<WalletPasskeyResult> {
  const [{ createPasskeyWithPrfOutput }, webAuthnClient] = await Promise.all([
    import("@category-labs/mera"),
    getWebAuthnClient(),
  ]);

  const credential = await withCeremonyTimeout(
    createPasskeyWithPrfOutput({
      rp: { id: requireWalletRpId(), name: WALLET_RP_NAME },
      user: { name: userName, displayName: userName },
      timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
      webAuthnClient,
    }),
    "createPasskeyWithPrfOutput",
  );

  return {
    prfOutput: credential.prfOutput,
    credentialId: credential.credentialId,
  };
}

/**
 * Requests the PRF output from an existing passkey. With no credential ID the
 * platform may offer any passkey for the relying party, which is what lets a
 * passkey created on the web sign in on mobile.
 */
export async function requestWalletPrfOutput(
  credentialId?: string,
): Promise<WalletPasskeyResult> {
  const [{ getPasskeyPrfOutput }, webAuthnClient] = await Promise.all([
    import("@category-labs/mera"),
    getWebAuthnClient(),
  ]);

  const result = await withCeremonyTimeout(
    getPasskeyPrfOutput({
      rpId: requireWalletRpId(),
      ...(credentialId ? { credential: { credentialId } } : {}),
      timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
      webAuthnClient,
    }),
    "getPasskeyPrfOutput",
  );

  return {
    prfOutput: result.prfOutput,
    credentialId: result.credentialId,
  };
}
