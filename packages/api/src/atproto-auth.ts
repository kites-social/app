import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { PLC_DIRECTORY_URL } from "./atproto-urls";

interface DidDocument {
  id?: string;
  service?: {
    id?: string;
    type?: string;
    serviceEndpoint?: string;
  }[];
}

interface AtprotoSessionResponse {
  did?: string;
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_000_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("AT Protocol request timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined || c === undefined) return true;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return true;
    const firstGroup = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (
      (firstGroup & 0xe000) !== 0x2000 ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("2002:")
    );
  }

  return true;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

async function resolveSafeAddresses(url: URL) {
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Invalid AT Protocol endpoint URL");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localDevelopment = process.env.NODE_ENV === "development";
  const localHost = isLocalHostname(host) || isIP(host) !== 0;
  if (
    url.protocol !== "https:" &&
    !(localDevelopment && localHost && url.protocol === "http:")
  ) {
    throw new Error("AT Protocol endpoints must use HTTPS");
  }
  if (localHost && !localDevelopment) {
    throw new Error("Local endpoint addresses are blocked");
  }

  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await dnsLookup(host, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    (!localDevelopment && addresses.some(({ address }) => isPrivateIp(address)))
  ) {
    throw new Error("Private endpoint addresses are blocked");
  }
  return addresses;
}

async function fetchJson(
  url: URL,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const startedAt = Date.now();
  const addresses = await withTimeout(
    resolveSafeAddresses(url),
    REQUEST_TIMEOUT_MS,
  );
  const targetHost = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const pinnedLookup: NonNullable<RequestOptions["lookup"]> = (
    hostname,
    options,
    callback,
  ) => {
    if (hostname.replace(/^\[|\]$/g, "").toLowerCase() !== targetHost) {
      callback(new Error("Unexpected DNS lookup host"), "", 0);
      return;
    }

    const firstAddress = addresses[0];
    if (!firstAddress) {
      callback(new Error("No public DNS addresses found"), "", 0);
      return;
    }

    if (typeof options === "object" && "all" in options && options.all) {
      callback(null, addresses);
    } else {
      callback(null, firstAddress.address, firstAddress.family);
    }
  };

  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { agent: false, headers, lookup: pinnedLookup, method: "GET" },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          clearTimeout(timeout);
          response.resume();
          reject(new Error("AT Protocol endpoint rejected the request"));
          return;
        }

        const contentLength = Number(response.headers["content-length"] ?? 0);
        if (contentLength > MAX_RESPONSE_BYTES) {
          clearTimeout(timeout);
          response.destroy();
          reject(new Error("AT Protocol response was too large"));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("AT Protocol response was too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          clearTimeout(timeout);
          try {
            resolve(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            );
          } catch {
            reject(new Error("Invalid JSON from AT Protocol endpoint"));
          }
        });
        response.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      },
    );

    const timeout = setTimeout(
      () => req.destroy(new Error("AT Protocol request timed out")),
      Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - startedAt)),
    );
    req.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    req.end();
  });
}

function didWebDocumentUrl(did: string): URL {
  const identifier = did.slice("did:web:".length);
  const [encodedHost, ...encodedPath] = identifier.split(":");
  if (!encodedHost) throw new Error("Invalid did:web identifier");

  const host = decodeURIComponent(encodedHost);
  const path = encodedPath.map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      /[\\/?#]/.test(decoded)
    ) {
      throw new Error("Invalid did:web path");
    }
    return encodeURIComponent(decoded);
  });

  const pathname = path.length
    ? `/${path.join("/")}/did.json`
    : "/.well-known/did.json";
  return new URL(`https://${host}${pathname}`);
}

async function resolvePdsUrl(did: string): Promise<URL> {
  let documentUrl: URL;
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) {
    documentUrl = new URL(`${PLC_DIRECTORY_URL}/${did}`);
  } else if (did.startsWith("did:web:")) {
    documentUrl = didWebDocumentUrl(did);
  } else {
    throw new Error("Unsupported DID method");
  }

  const value = await fetchJson(documentUrl).catch((error: unknown) => {
    throw new Error(
      `PLC lookup failed (${documentUrl.href}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid DID document");
  }
  const document = value as DidDocument;
  if (document.id !== did || !Array.isArray(document.service)) {
    throw new Error("DID document did not match the requested identity");
  }

  const pds = document.service.find(
    (service) =>
      service.id === "#atproto_pds" ||
      service.type === "AtprotoPersonalDataServer",
  )?.serviceEndpoint;
  if (typeof pds !== "string") throw new Error("DID has no PDS service");

  return new URL(pds);
}

export interface AuthenticatedAtprotoUser {
  did: string;
}

/** Dev-only: surface why AT Protocol auth was rejected (it is swallowed below). */
function logAuthFailure(reason: string, detail?: unknown) {
  if (process.env.NODE_ENV === "development") {
    console.error(`[atproto-auth] ${reason}`, detail ?? "");
  }
}

export async function authenticateAtprotoRequest(
  request: Request,
): Promise<AuthenticatedAtprotoUser | null> {
  const authorization = request.headers.get("authorization");
  const did = request.headers.get("x-atproto-did");
  if (!authorization?.startsWith("Bearer ") || !did || did.length > 512) {
    logAuthFailure("missing or invalid auth headers", {
      hasAuthorization: Boolean(authorization),
      did: did ?? null,
    });
    return null;
  }

  const accessJwt = authorization.slice("Bearer ".length).trim();
  if (!accessJwt || accessJwt.length > 8_192) {
    logAuthFailure("empty or oversized access token");
    return null;
  }

  try {
    const pdsUrl = await resolvePdsUrl(did);
    const sessionUrl = new URL(pdsUrl);
    sessionUrl.pathname = `${sessionUrl.pathname.replace(/\/+$/, "")}/xrpc/com.atproto.server.getSession`;

    const value = await fetchJson(sessionUrl, {
      Authorization: `Bearer ${accessJwt}`,
    }).catch((error: unknown) => {
      throw new Error(
        `getSession failed (${sessionUrl.href}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    if (typeof value !== "object" || value === null) {
      logAuthFailure("getSession returned a non-object", { did });
      return null;
    }

    const session = value as AtprotoSessionResponse;
    if (session.did !== did) {
      logAuthFailure("getSession DID mismatch", {
        requested: did,
        returned: session.did ?? null,
      });
      return null;
    }
    return { did };
  } catch (error) {
    logAuthFailure("session validation failed", {
      did,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}
