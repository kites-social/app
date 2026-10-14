import { defaultAgent } from "../agent";
import { atprotoUrls, defaultPdsUrl } from "../atproto-urls";

interface DidDocument {
  service?: {
    id: string;
    type: string;
    serviceEndpoint: string;
  }[];
}

/**
 * Resolve a DID to find the PDS URL from the DID document.
 * Falls back to bsky.social if resolution fails.
 */
export async function resolvePdsFromDid(did: string): Promise<string> {
  try {
    // For did:plc, fetch the DID document from plc.directory
    if (did.startsWith("did:plc:")) {
      const res = await fetch(`${atprotoUrls.plcDirectory}/${did}`);
      if (res.ok) {
        const didDoc = (await res.json()) as DidDocument;
        const pdsService = didDoc.service?.find(
          (s) =>
            s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
        );
        if (pdsService?.serviceEndpoint) {
          return pdsService.serviceEndpoint;
        }
      }
    }

    // For did:web, fetch from the domain's .well-known
    if (did.startsWith("did:web:")) {
      const domain = did.replace("did:web:", "");
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (res.ok) {
        const didDoc = (await res.json()) as DidDocument;
        const pdsService = didDoc.service?.find(
          (s) =>
            s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
        );
        if (pdsService?.serviceEndpoint) {
          return pdsService.serviceEndpoint;
        }
      }
    }
  } catch {
    // Fall through to default
  }

  return defaultPdsUrl;
}

/**
 * Resolve a handle or identifier to find the user's PDS URL.
 * Falls back to bsky.social if resolution fails.
 */
export async function resolvePdsUrl(identifier: string): Promise<string> {
  // A configured PDS supports local/dev handles unknown to the public network.
  if (atprotoUrls.pds) return atprotoUrls.pds;

  const normalizedIdentifier = identifier
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  // Emails and Bluesky-hosted handles use the default PDS without resolution.
  if (
    normalizedIdentifier.includes("@") ||
    normalizedIdentifier.endsWith(".bsky.social") ||
    (!normalizedIdentifier.startsWith("did:") &&
      !normalizedIdentifier.includes("."))
  ) {
    return defaultPdsUrl;
  }

  if (normalizedIdentifier.startsWith("did:")) {
    return resolvePdsFromDid(normalizedIdentifier);
  }

  try {
    // Resolve handle to DID
    const resolution = await defaultAgent.resolveHandle({
      handle: normalizedIdentifier,
    });
    if (!resolution.success) {
      return defaultPdsUrl;
    }

    return resolvePdsFromDid(resolution.data.did);
  } catch {
    // Fall through to default
  }

  return defaultPdsUrl;
}
