import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginContext } from "@getpaseo/plugin";
import { z } from "zod";
import { AccountSchema, listUsage, type UsageAccount, type UsageListOutput } from "./contract";
import { UsagePanel } from "./usage.client";

/**
 * Absolute path on purpose: the Paseo daemon's PATH is not the shell's PATH, so `cswap`
 * is never resolved by name. Computed lazily rather than stored in a module-scope
 * constant, because `node:os` and `node:path` are stubbed to `{}` in the client bundle
 * and a module-scope `homedir()` would throw when the panel loads.
 */
function cswapBin(): string {
  return process.env.CSWAP_BIN ?? path.join(homedir(), ".local", "bin", "cswap");
}
// cswap shares a ~28-30 request/hour budget per identity across every surface, so we
// never poll faster than this. See PLAN.md 2.2.
const CACHE_TTL_MS = 60_000;
// Daemon RPCs are cut off at 30s; fail first so the caller sees our message, not a timeout.
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
    return `cswap not found at ${cswapBin()} — set CSWAP_BIN to its absolute path`;
  }
  if (typeof details.code === "string") {
    return `cswap could not run at ${cswapBin()} (${details.code})`;
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
  const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
  return `${path} (${issue.code})`;
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
  const accounts = z.array(AccountSchema).safeParse(envelope.data.accounts);
  if (!accounts.success) {
    throw new CswapPayloadError(`unexpected cswap account: ${describeZodError(accounts.error)}`);
  }
  return {
    activeAccountNumber: envelope.data.activeAccountNumber ?? null,
    accounts: accounts.data,
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

/** Never rejects: single-flight callers all share one settled result. */
async function runCswap(): Promise<UsageListOutput> {
  let snapshot: UsageSnapshot;
  try {
    // promisify is called here, not at module scope: `node:util` is stubbed to `{}`
    // in the client bundle, so a module-scope call would throw on client load.
    const { stdout } = await promisify(execFile)(cswapBin(), ["list", "--json"], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    snapshot = parseSnapshot(stdout);
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

function handleListUsage(): Promise<UsageListOutput> {
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

export default function contribute(plugin: PluginContext) {
  plugin.handle(listUsage, handleListUsage);
  plugin.addWorkspacePanel({
    id: "usage",
    title: "cswap usage",
    icon: "Gauge",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: UsagePanel,
  });
  plugin.addCommandCenterItem({
    id: "open-usage",
    title: "Open cswap usage",
    icon: "Gauge",
    context: "workspace",
    keywords: ["cswap", "usage", "quota"],
    onSelect({ openPanel }) {
      openPanel("usage");
    },
  });
  // The 60s timer lives in the client's TanStack query, so there is nothing to stop here.
  return () => {
    inflight = null;
  };
}
