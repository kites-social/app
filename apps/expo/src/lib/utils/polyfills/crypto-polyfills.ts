import { getRandomValues } from "expo-crypto";

/**
 * Hermes does not provide `crypto.getRandomValues`, which Mera needs to
 * generate WebAuthn challenges and user handles. `expo-crypto` exposes a
 * native implementation with the same signature, so we can install it
 * directly.
 */
if (typeof globalThis.crypto?.getRandomValues !== "function") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { ...globalThis.crypto, getRandomValues },
  });
}
