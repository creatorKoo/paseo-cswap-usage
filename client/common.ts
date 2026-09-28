// Helpers shared by the panel and the composer pill. Client-only: it imports the plugin
// client hooks, so it must never be reached from server/ or shared/.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { listUsage, type UsageAccount, type UsageBlock } from "../shared/contract";

export const POLL_INTERVAL_MS = 60_000;

/** One key for the panel, every pill, and every popover, so they share a single poll. */
export const USAGE_QUERY_KEY = ["cswap-usage", "list"] as const;

export function useUsageQuery() {
  const list = useRpc(listUsage);
  return useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: () => list({}),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS - 5_000,
  });
}

export type Locale = "ko" | "en";

/** Korean for Korean systems, English everywhere else. Intl access is guarded: Hermes
 *  builds without full ICU can throw here, and a missing locale must not blank the panel. */
function detectLocale(): Locale {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale.toLowerCase().startsWith("ko") ? "ko" : "en";
  } catch {
    return "en";
  }
}

export const locale: Locale = detectLocale();

export function barColor(theme: PluginTheme, pct: number): string {
  if (pct < 50) return theme.colors.accent;
  if (pct < 90) return theme.colors.statusWarning;
  return theme.colors.statusDanger;
}

export function clockTime(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * The usage block to draw for an account. Live `usage` when the fetch succeeded; otherwise
 * the `lastGoodUsage` cswap carries for an account it could not refresh this pass (for
 * example `token_expired` while a live `cswap run` session owns the credential — cswap
 * leaves that token alone so it does not log the session out). `stale` marks the fallback
 * so callers can dim it and show the status. Null when there is nothing to draw at all.
 */
export function shownUsage(account: UsageAccount): { usage: UsageBlock; stale: boolean } | null {
  if (account.usageStatus === "ok") {
    return account.usage == null ? null : { usage: account.usage, stale: false };
  }
  if (account.lastGoodUsage !== undefined) return { usage: account.lastGoodUsage, stale: true };
  return null;
}

export function accountName(account: UsageAccount): string {
  return account.alias ?? `#${account.number}`;
}
