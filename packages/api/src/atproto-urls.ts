/**
 * PLC directory used by server-side AT Protocol identity resolution. Prefer a
 * server-specific URL, then the shared Expo setting used by local dev stacks.
 */
const configuredPlcUrl =
  process.env.ATPROTO_PLC_URL?.trim() ||
  process.env.EXPO_PUBLIC_ATPROTO_PLC_URL?.trim();

export const PLC_DIRECTORY_URL = (
  configuredPlcUrl ?? "https://plc.directory"
).replace(/\/+$/, "");
