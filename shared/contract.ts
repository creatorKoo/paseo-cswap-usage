// Shared RPC contract. Everything under shared/ is bundled into both the client and
// the server target, so it must stay free of Node and React Native code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Every window field except `pct` is optional: cswap omits `resetsAt` / `countdown` /
// `clock` while a window has not opened yet. `projectedExhaustionAt` is deliberately
// absent so zod strips it before it ever reaches the client.
const WindowSchema = z.object({
  pct: z.number(),
  resetsAt: z.string().optional(),
  countdown: z.string().optional(),
  clock: z.string().optional(),
  expectedPct: z.number().optional(),
  aheadOfPace: z.boolean().optional(),
  willLastToReset: z.boolean().optional(),
});

const ScopedSchema = WindowSchema.extend({ name: z.string() });

const SpendSchema = z.object({
  used: z.number(),
  limit: z.number(),
  pct: z.number(),
  currency: z.string(),
});

// One usage block: either the live `usage` or the `lastGoodUsage` cswap keeps for an
// account whose current fetch could not run.
const UsageBlockSchema = z.object({
  fiveHour: WindowSchema.optional(),
  sevenDay: WindowSchema.optional(),
  spend: SpendSchema.optional(),
  scoped: z.array(ScopedSchema).optional(),
});

// `organizationName` / `organizationUuid` / `isOrganization` / `usageAgeSeconds` /
// `lastGoodAgeSeconds` are intentionally omitted: the panel never renders them (age is
// derived client-side), so they never leave the daemon.
export const AccountSchema = z.object({
  number: z.number(),
  alias: z.string().optional(),
  email: z.string().optional(),
  active: z.boolean(),
  usageStatus: z.string(),
  // `null` (not just absent) whenever `usageStatus` is not "ok" — e.g. `token_expired`
  // while a live `cswap run` session owns the credential and cswap defers the refresh.
  usage: UsageBlockSchema.nullable().optional(),
  usageFetchedAt: z.string().optional(),
  /** The most recent successful fetch, kept by cswap while `usage` is null. */
  lastGoodUsage: UsageBlockSchema.optional(),
  lastGoodFetchedAt: z.string().optional(),
});

const ListOutputSchema = z.object({
  /**
   * Last successful cswap call (ISO), or when Paseo last read the default login. Null until
   * the first success.
   */
  fetchedAt: z.string().nullable(),
  /** Message from the most recent failure, or null when the last call succeeded. */
  error: z.string().nullable(),
  activeAccountNumber: z.number().nullable(),
  accounts: z.array(AccountSchema),
  /**
   * Null while cswap answers. When cswap is not installed, the path it was looked for at:
   * `accounts` is then Paseo's own reading of the host's default Claude login, numbered
   * below zero so that none can pass for a cswap slot.
   */
  cswapNotFoundAt: z.string().nullable(),
});

export const listUsage = defineRpc({
  name: "usage.list",
  input: z.object({}),
  output: ListOutputSchema,
});

// The one state-changing call: `cswap switch <number> --json`, run only when the user
// presses a switch button. `usage` is the list with the new active account already
// applied, so the caller can update its query without spawning `cswap list` again.
export const switchAccount = defineRpc({
  name: "usage.switch",
  input: z.object({ number: z.number().int().positive() }),
  output: z.object({
    /** False when cswap found the account already active, or when the switch failed. */
    switched: z.boolean(),
    /** Failure message, or null when cswap accepted the switch. */
    error: z.string().nullable(),
    warnings: z.array(z.string()),
    usage: ListOutputSchema,
  }),
});

// Providers whose command is `cswap run <account>` are pinned to that account, so their
// agents get a pill for it rather than for the active one. Read from Paseo's own provider
// config on the server; only the provider id and the account argument come back, never the
// rest of the provider entry (its `env` can hold API keys).
export const listPinned = defineRpc({
  name: "usage.pinned",
  input: z.object({}),
  output: z.object({
    pinned: z.array(
      z.object({
        provider: z.string(),
        /** The `cswap run` argument as written: a slot number, an alias, or an email. */
        account: z.string(),
      }),
    ),
  }),
});

export type UsageWindow = z.output<typeof WindowSchema>;
export type UsageScoped = z.output<typeof ScopedSchema>;
export type UsageSpend = z.output<typeof SpendSchema>;
export type UsageBlock = z.output<typeof UsageBlockSchema>;
export type UsageAccount = z.output<typeof AccountSchema>;
export type UsageListOutput = z.input<typeof listUsage.output>;
export type SwitchOutput = z.input<typeof switchAccount.output>;
export type PinnedOutput = z.input<typeof listPinned.output>;
