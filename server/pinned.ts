import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PinnedOutput } from "../shared/contract";

/**
 * The account a provider command pins with `cswap run <account> [flags] [-- claude args]`,
 * or null when the command is not `cswap run` or leaves the account to cswap's directory
 * mapping. Every `cswap run` flag is a boolean, so the first bare argument before `--` is
 * the account.
 */
export function pinnedAccountArg(command: readonly string[]): string | null {
  const run = command.findIndex(
    (arg, index) => index > 0 && arg === "run" && /(^|[/\\])cswap(\.exe)?$/.test(command[index - 1] ?? ""),
  );
  if (run === -1) return null;
  for (const arg of command.slice(run + 1)) {
    if (arg === "--") return null;
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

type ProviderEntry = { extends?: unknown; command?: unknown };

/** Pinned providers from a Paseo config's `providers` record (`agents.providers` on disk). */
export function pinnedProviders(providers: Record<string, unknown>): PinnedOutput["pinned"] {
  const pinned: PinnedOutput["pinned"] = [];
  for (const [provider, raw] of Object.entries(providers)) {
    const entry = (raw ?? {}) as ProviderEntry;
    // The built-in provider counts too: overriding its command pins it just the same.
    if (provider !== "claude" && entry.extends !== "claude") continue;
    const command = entry.command;
    if (!Array.isArray(command) || !command.every((arg) => typeof arg === "string")) continue;
    const account = pinnedAccountArg(command);
    if (account !== null) pinned.push({ provider, account });
  }
  return pinned;
}

export async function listPinnedHandler(
  _input: unknown,
  { paseo }: PluginHandlerContext,
): Promise<PinnedOutput> {
  try {
    const { config } = await paseo.config.get();
    return { pinned: pinnedProviders(config.providers ?? {}) };
  } catch (error) {
    // Without the config nothing is pinned: every pill falls back to the active account's
    // rules. The message is the daemon's own and carries no provider values.
    console.error(
      `[cswap-usage] could not read provider config: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { pinned: [] };
  }
}
