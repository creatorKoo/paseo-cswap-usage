// Pure helpers for the panel and the pill. No React, React Native, or plugin runtime
// imports, so the tests can load this module in plain Node.
import type { PluginTheme } from "@getpaseo/plugin";
import type { UsageAccount, UsageBlock, UsageListOutput, UsageWindow } from "../shared/contract";
import type { LabelFormat } from "../shared/settings";

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

export function activeAccount(data: UsageListOutput | undefined): UsageAccount | null {
  return data?.accounts.find((account) => account.active) ?? null;
}

/**
 * The account a `cswap run <account>` argument names. cswap takes a slot number, an alias,
 * or an email there; aliases and emails are matched without regard to case.
 */
export function resolveAccount(
  accounts: readonly UsageAccount[],
  argument: string,
): UsageAccount | null {
  if (/^\d+$/.test(argument)) {
    return accounts.find((account) => account.number === Number(argument)) ?? null;
  }
  const wanted = argument.toLowerCase();
  return (
    accounts.find((account) => account.alias?.toLowerCase() === wanted) ??
    accounts.find((account) => account.email?.toLowerCase() === wanted) ??
    null
  );
}

/**
 * The account a pill follows: the active one, or the one its provider's `cswap run`
 * argument names when `pinned` is not null.
 */
export function followedAccount(
  data: UsageListOutput | undefined,
  pinned: string | null,
): UsageAccount | null {
  if (pinned === null) return activeAccount(data);
  // Without a cswap list there is nothing a `cswap run` argument could name. The default
  // login must not answer to one, or a pinned pill would show another account's numbers.
  if (data?.cswapNotFoundAt != null) return null;
  return resolveAccount(data?.accounts ?? [], pinned);
}

export function percent(usageWindow: UsageWindow | undefined): string {
  return usageWindow === undefined ? "—" : `${Math.round(usageWindow.pct)}%`;
}

/** `2h 31m` → `2h31m`: the pill label has roughly fifteen characters to spend. */
export function tightCountdown(usageWindow: UsageWindow | undefined): string {
  return usageWindow?.countdown?.replace(/\s+/g, "") ?? "";
}

/** The numbers part of the label, before the alias. */
export function labelHead(account: UsageAccount, format: LabelFormat): string {
  const usage = shownUsage(account)?.usage;
  if (usage === undefined) return "—";
  const fiveHour = usage.fiveHour;
  if (format === "5h-7d") return `${percent(fiveHour)} / ${percent(usage.sevenDay)}`;
  if (format === "short") return percent(fiveHour);
  return [percent(fiveHour), tightCountdown(fiveHour)].filter(Boolean).join(" ");
}

/**
 * The one-line label after the gauge icon. The alias goes last so that the host's
 * single-line ellipsis cuts a long alias, never the numbers.
 */
export function pillLabel(account: UsageAccount, format: LabelFormat): string {
  return `${labelHead(account, format)} · ${accountName(account)}`;
}

/** The words the tooltip needs, in the caller's locale. */
export type TitleWords = {
  /** Badge for the account the pill follows: the active one, or the pinned one. */
  badge: string;
  resetsIn: (countdown: string) => string;
  lastGood: (time: string) => string;
};

function windowSummary(
  label: string,
  usageWindow: UsageWindow | undefined,
  words: TitleWords,
): string | null {
  if (usageWindow === undefined) return null;
  const reset =
    usageWindow.countdown === undefined ? "" : ` · ${words.resetsIn(usageWindow.countdown)}`;
  return `${label} ${percent(usageWindow)}${reset}`;
}

/**
 * Tooltip and accessibility label: everything the label had no room for. The host caps
 * the tooltip at 280px and its Text keeps newlines, so it is one short line per fact.
 * `fallback` names the account when it is not in the list, such as a pinned argument.
 */
export function pillTitle(
  account: UsageAccount | null,
  error: string | null,
  words: TitleWords,
  fallback = "cswap",
): string {
  const lines: string[] = [];
  if (account === null) {
    lines.push(fallback);
  } else {
    lines.push(`${accountName(account)} · ${words.badge}`);
    const shown = shownUsage(account);
    for (const summary of [
      windowSummary("5h", shown?.usage.fiveHour, words),
      windowSummary("7d", shown?.usage.sevenDay, words),
    ]) {
      if (summary !== null) lines.push(summary);
    }
    if (account.usageStatus !== "ok") {
      lines.push(
        shown?.stale === true
          ? `${account.usageStatus} · ${words.lastGood(clockTime(account.lastGoodFetchedAt ?? null))}`
          : account.usageStatus,
      );
    }
  }
  if (error !== null) lines.push(error);
  return lines.join("\n");
}
