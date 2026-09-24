import { DEFAULT_SERVER_HOST } from "@shared/constants";

/** Normalize a page URL without accepting embedded credentials or other schemes. */
export function httpOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Origins trusted to own the webview bridge and business session.
 *
 * Neutral base implementation (community): the configured default host only.
 * Commercial builds overlay this module with a dynamic multi-source version
 * (login domain / loopback gateway / webview override).
 */
export function businessBridgeOrigins(): string[] {
  const origin = httpOrigin(
    /^https?:\/\//i.test(DEFAULT_SERVER_HOST)
      ? DEFAULT_SERVER_HOST
      : `https://${DEFAULT_SERVER_HOST}`,
  );
  return origin ? [origin] : [];
}
