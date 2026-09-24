import { DEFAULT_SERVER_HOST } from "@shared/constants";
import { readSetting } from "../../db";

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

/** Commercial pages allowed to own the webview bridge and business session. */
export function businessBridgeOrigins(): string[] {
  const step1 = readSetting("step1_config") as { serverHost?: string } | null;
  const loopback = readSetting("nuwax.loopback") as { enabled?: boolean; origin?: string } | null;
  const override = readSetting("nuwax.webviewOverride") as { origin?: string } | null;
  const businessHost = step1?.serverHost || DEFAULT_SERVER_HOST;
  return [...new Set([
    // Settings accepts a hostname without a scheme and treats it as HTTPS.
    httpOrigin(/^https?:\/\//i.test(businessHost) ? businessHost : `https://${businessHost}`),
    loopback?.enabled ? httpOrigin(loopback.origin) : null,
    httpOrigin(override?.origin),
  ].filter((origin): origin is string => origin !== null))];
}
