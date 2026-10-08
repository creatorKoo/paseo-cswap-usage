import { z } from "zod";
import type { UsageAccount, UsageBlock, UsageScoped, UsageWindow } from "../shared/contract";

/** The one Paseo call this module makes. A handler's `paseo` satisfies it. */
export type UsageLister = { providers: { listUsage(): Promise<unknown> } };

// Paseo files its own usage rows under the built-in provider's id. Since 0.11 there is one
// row per Claude login it finds on the host, so there can be several.
const CLAUDE_PROVIDER = "claude";
// Plugin RPCs are cut off at 30s, and a call that never settled would hold the list's
// single flight open for good.
const USAGE_TIMEOUT_MS = 25_000;

// Only what the panel draws. A window's id names its quota period, not its position.
const WindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullish(),
  resetsAt: z.string().nullish(),
});

const LoginSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  status: z.string(),
  windows: z.array(z.unknown()),
  error: z.string().nullish(),
});

const UsageSchema = z.object({
  fetchedAt: z.string().optional(),
  providers: z.array(z.unknown()),
});

type Login = z.output<typeof LoginSchema>;

export type DefaultLogin = {
  accounts: UsageAccount[];
  /** When Paseo read it, which can be minutes ago: Paseo caches its own fetch. */
  fetchedAt: string;
  /** Paseo's reason the first login has no reading, when it gives one. */
  error: string | null;
};

/** Time left until `resetsAt`, the way cswap prints it: `3d 9h`, `2h 3m`, `21m`. */
export function countdownTo(resetsAt: string, now: number): string | undefined {
  const minutes = Math.floor((Date.parse(resetsAt) - now) / 60_000);
  // NaN for a date that does not parse; negative once a cached window has already reset.
  if (!(minutes >= 0)) return undefined;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function usageBlock(windows: readonly unknown[], now: number): UsageBlock {
  const block: UsageBlock = {};
  const scoped: UsageScoped[] = [];
  for (const raw of windows) {
    const parsed = WindowSchema.safeParse(raw);
    // A window without a percentage has nothing to draw.
    if (!parsed.success || typeof parsed.data.usedPct !== "number") continue;
    const { id, label, usedPct, resetsAt } = parsed.data;
    const countdown = resetsAt == null ? undefined : countdownTo(resetsAt, now);
    const usageWindow: UsageWindow =
      countdown === undefined ? { pct: usedPct } : { pct: usedPct, countdown };
    if (id === "five_hour") block.fiveHour = usageWindow;
    else if (id === "weekly") block.sevenDay = usageWindow;
    // Every other Claude window is a weekly limit scoped to one model or one surface.
    else scoped.push({ ...usageWindow, name: label.replace(/^Weekly\s*·\s*/, "") });
  }
  if (scoped.length > 0) block.scoped = scoped;
  return block;
}

function toAccount(login: Login, index: number, now: number): UsageAccount {
  // 0.11 names the login inside the display name: "Claude (you@example.com)".
  const named = /^(.+) \((\S+@\S+)\)$/.exec(login.displayName);
  const available = login.status === "available";
  return {
    // Not a cswap slot. Below zero, so that no `cswap run <n>` argument and no switch can
    // ever name it.
    number: -(index + 1),
    alias: named?.[1] ?? login.displayName,
    ...(named === null ? {} : { email: named[2] }),
    // Paseo lists Claude Code's own login first: the one the built-in provider runs on.
    active: index === 0,
    // A login Paseo cannot read shows Paseo's status. No last reading is kept for it: Paseo
    // stops naming a login whose token expired, so one could not be matched to its account.
    usageStatus: available ? "ok" : login.status,
    usage: available ? usageBlock(login.windows, now) : null,
  };
}

/** Rejects once `ms` have passed, so a call that never settles cannot hold its caller. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
      ms,
    );
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Paseo's own reading of the Claude logins it finds on this host, as accounts, for a host
 * without cswap. Paseo fetches and caches that reading for itself, so asking for it sends
 * no request of ours to the usage endpoint. Null when Paseo lists no Claude login or
 * cannot list usage at all. Never rejects.
 */
export async function readDefaultLogin(
  paseo: UsageLister,
  now: number,
): Promise<DefaultLogin | null> {
  let raw: unknown;
  try {
    raw = await settleWithin(paseo.providers.listUsage(), USAGE_TIMEOUT_MS);
  } catch (error) {
    // The type only. The message is Paseo's, and the rows it describes carry emails.
    const type = error instanceof Error ? error.name : "unknown error";
    console.error(`[cswap-usage] Paseo usage unavailable (${type})`);
    return null;
  }
  const usage = UsageSchema.safeParse(raw);
  if (!usage.success) {
    console.error("[cswap-usage] unexpected Paseo usage payload");
    return null;
  }
  // Rows are validated one at a time, so a malformed one drops only itself.
  const logins = usage.data.providers.flatMap((entry) => {
    const login = LoginSchema.safeParse(entry);
    return login.success && login.data.providerId === CLAUDE_PROVIDER ? [login.data] : [];
  });
  if (logins.length === 0) return null;
  return {
    accounts: logins.map((login, index) => toAccount(login, index, now)),
    fetchedAt: usage.data.fetchedAt ?? new Date(now).toISOString(),
    error: logins[0]?.error ?? null,
  };
}
