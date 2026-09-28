import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  AccountSchema,
  type SwitchOutput,
  type UsageAccount,
  type UsageListOutput,
} from "../shared/contract";

const execFileAsync = promisify(execFile);

/**
 * Absolute path on purpose: the Paseo daemon's PATH is not the shell's PATH, so `cswap`
 * is never resolved by name.
 */
const CSWAP_BIN = process.env.CSWAP_BIN ?? path.join(homedir(), ".local", "bin", "cswap");
// cswap shares a ~28-30 request/hour budget per identity across every surface, so we
// never poll faster than this. See "How it works" in README.md.
const CACHE_TTL_MS = 60_000;
// Plugin RPCs are cut off at 30s; fail first so the caller sees our message, not a timeout.
const EXEC_TIMEOUT_MS = 25_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type UsageSnapshot = {
  activeAccountNumber: number | null;
  accounts: UsageAccount[];
};

// Failures keep the previous snapshot and only set `error`, matching cswap's own
// stale-on-error behaviour. `at` is bumped on failure too, so a broken binary cannot
// turn every panel render into a fresh spawn.
let cache: {
  snapshot: UsageSnapshot | null;
  fetchedAt: string | null;
  error: string | null;
  at: number;
} = { snapshot: null, fetchedAt: null, error: null, at: 0 };

let inflight: Promise<UsageListOutput> | null = null;

let switching: Promise<SwitchOutput> | null = null;

// Set by a successful switch. A `cswap list` that was already running when the switch
// landed still reports the old active account, so its snapshot gets this applied on top.
let lastSwitch: { number: number; at: number } | null = null;

/** Raised for payload problems, whose messages are safe to log. */
class CswapPayloadError extends Error {}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line === undefined ? "" : line.trim().slice(0, 200);
}

function describeExecError(error: unknown): string {
  if (!(error instanceof Error)) return "cswap failed: unknown error";
  const details = error as Error & {
    code?: string | number;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
    stderr?: string;
  };
  // `killed` alone is ambiguous: execFile also sets it when it tears the child down for
  // exceeding maxBuffer, which is not a timeout.
  if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `cswap output exceeded ${Math.round(MAX_BUFFER_BYTES / (1024 * 1024))} MiB`;
  }
  if (details.code === "ETIMEDOUT" || (details.killed === true && details.signal === "SIGTERM")) {
    return `cswap timed out after ${Math.round(EXEC_TIMEOUT_MS / 1000)}s`;
  }
  if (details.killed === true && typeof details.signal === "string") {
    return `cswap killed by ${details.signal}`;
  }
  if (details.code === "ENOENT") {
    return `cswap not found at ${CSWAP_BIN} — set CSWAP_BIN to its absolute path`;
  }
  if (typeof details.code === "string") {
    return `cswap could not run at ${CSWAP_BIN} (${details.code})`;
  }
  const stderrLine = typeof details.stderr === "string" ? firstLine(details.stderr) : "";
  if (typeof details.code === "number") {
    return `cswap exited ${details.code}${stderrLine === "" ? "" : `: ${stderrLine}`}`;
  }
  return `cswap failed: ${firstLine(error.message)}`;
}

/** Path + code only. Never the offending value, which carries emails and org names. */
function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "unknown issue";
  const location = issue.path.length === 0 ? "<root>" : issue.path.join(".");
  return `${location} (${issue.code})`;
}

const EnvelopeSchema = z.object({
  schemaVersion: z.number(),
  activeAccountNumber: z.number().nullable().optional(),
  accounts: z.array(z.unknown()),
});

function parseSnapshot(stdout: string): UsageSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    // The parser's own message quotes the input, so it is dropped entirely.
    throw new CswapPayloadError("cswap returned invalid JSON");
  }
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new CswapPayloadError(`unexpected cswap payload: ${describeZodError(envelope.error)}`);
  }
  if (envelope.data.schemaVersion !== 1) {
    throw new CswapPayloadError(`unexpected schemaVersion ${envelope.data.schemaVersion}`);
  }
  // Accounts are validated one at a time so a single malformed entry drops only itself.
  // Before this, one unexpected field shape froze the whole panel at the last good poll.
  const accounts: UsageAccount[] = [];
  let firstIssue: string | null = null;
  envelope.data.accounts.forEach((raw, index) => {
    const account = AccountSchema.safeParse(raw);
    if (account.success) {
      accounts.push(account.data);
      return;
    }
    const issue = `${index}.${describeZodError(account.error)}`;
    firstIssue ??= issue;
    // Path + zod code only — never the payload, which carries emails.
    console.error(`[cswap-usage] skipped cswap account ${issue}`);
  });
  if (accounts.length === 0 && firstIssue !== null) {
    throw new CswapPayloadError(`unexpected cswap account: ${firstIssue}`);
  }
  return {
    activeAccountNumber: envelope.data.activeAccountNumber ?? null,
    accounts,
  };
}

function currentOutput(): UsageListOutput {
  return {
    fetchedAt: cache.fetchedAt,
    error: cache.error,
    activeAccountNumber: cache.snapshot?.activeAccountNumber ?? null,
    accounts: cache.snapshot?.accounts ?? [],
  };
}

/** The snapshot with `number` as the only active account. */
function withActive(snapshot: UsageSnapshot, number: number): UsageSnapshot {
  return {
    activeAccountNumber: number,
    accounts: snapshot.accounts.map((account) =>
      account.active === (account.number === number)
        ? account
        : { ...account, active: account.number === number },
    ),
  };
}

/** Never rejects: single-flight callers all share one settled result. */
async function runCswap(): Promise<UsageListOutput> {
  const startedAt = Date.now();
  let snapshot: UsageSnapshot;
  try {
    const { stdout } = await execFileAsync(CSWAP_BIN, ["list", "--json"], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    snapshot = parseSnapshot(stdout);
    if (lastSwitch !== null && startedAt < lastSwitch.at) {
      snapshot = withActive(snapshot, lastSwitch.number);
    }
  } catch (error) {
    const message =
      error instanceof CswapPayloadError ? error.message : describeExecError(error);
    cache = { ...cache, error: message, at: Date.now() };
    console.error(`[cswap-usage] ${message}`);
    return currentOutput();
  }
  cache = {
    snapshot,
    fetchedAt: new Date().toISOString(),
    error: null,
    at: Date.now(),
  };
  return currentOutput();
}

export function listUsageHandler(): Promise<UsageListOutput> {
  // `at` starts at 0, so the first call always misses.
  if (Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(currentOutput());
  }
  if (inflight !== null) return inflight;
  const pending = runCswap().finally(() => {
    if (inflight === pending) inflight = null;
  });
  inflight = pending;
  return pending;
}

const SwitchResultSchema = z.object({
  schemaVersion: z.number(),
  switched: z.boolean(),
  to: z.object({ number: z.number().nullable() }).nullable().optional(),
  warnings: z.array(z.string()).optional(),
});

// With --json, a handled cswap error exits 1 and prints this envelope to stdout.
const SwitchErrorSchema = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
});

function switchFailure(message: string): SwitchOutput {
  return { switched: false, error: message, warnings: [], usage: currentOutput() };
}

function switchErrorEnvelope(error: unknown): { type: string; message: string } | null {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  if (typeof stdout !== "string") return null;
  try {
    const parsed = SwitchErrorSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

/** Never rejects, like runCswap. stdout names emails, so none of it is logged. */
async function runSwitch(number: number): Promise<SwitchOutput> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(CSWAP_BIN, ["switch", String(number), "--json"], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
    }));
  } catch (error) {
    const envelope = switchErrorEnvelope(error);
    if (envelope !== null) {
      // The message can name an email, so only its type is logged.
      console.error(`[cswap-usage] cswap switch failed (${envelope.type})`);
      return switchFailure(firstLine(envelope.message));
    }
    const message = describeExecError(error);
    console.error(`[cswap-usage] ${message}`);
    return switchFailure(message);
  }

  let result: z.output<typeof SwitchResultSchema> | null = null;
  try {
    const parsed = SwitchResultSchema.safeParse(JSON.parse(stdout));
    if (parsed.success && parsed.data.schemaVersion === 1) result = parsed.data;
  } catch {
    // Handled below: the parser's own message quotes the input.
  }
  if (result === null) {
    // cswap exited 0, so the switch may well have happened. Expire the cache so the next
    // list call reports the real active account instead of a guess.
    cache = { ...cache, at: 0 };
    console.error("[cswap-usage] cswap switch returned an unexpected payload");
    return switchFailure("cswap switch returned an unexpected payload");
  }

  const target = result.to?.number ?? number;
  lastSwitch = { number: target, at: Date.now() };
  if (cache.snapshot !== null) {
    cache = { ...cache, snapshot: withActive(cache.snapshot, target) };
  }
  return {
    switched: result.switched,
    error: null,
    warnings: result.warnings ?? [],
    usage: currentOutput(),
  };
}

export function switchAccountHandler({ number }: { number: number }): Promise<SwitchOutput> {
  if (switching !== null) {
    return Promise.resolve(switchFailure("another switch is still running"));
  }
  // Only accounts from the last list are accepted, so the argument is always a slot
  // cswap itself reported.
  if (cache.snapshot === null) {
    return Promise.resolve(switchFailure("no cswap list yet — try again after it loads"));
  }
  if (!cache.snapshot.accounts.some((account) => account.number === number)) {
    return Promise.resolve(switchFailure(`account ${number} is not in the cswap list`));
  }
  const pending = runSwitch(number).finally(() => {
    if (switching === pending) switching = null;
  });
  switching = pending;
  return pending;
}

/** Entry cleanup. The 60s timer lives in the client, so there is no timer to stop here. */
export function releaseCswap(): void {
  inflight = null;
  switching = null;
}
