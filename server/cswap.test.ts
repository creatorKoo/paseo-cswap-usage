import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Every spawn is captured here and answered by the test, so no real cswap ever runs.
type Spawn = {
  args: string[];
  callback: (error: unknown, result?: { stdout: string; stderr: string }) => void;
};
const spawns: Spawn[] = [];

vi.mock("node:child_process", () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: Spawn["callback"]) => {
    spawns.push({ args, callback });
  },
}));

type CswapModule = typeof import("./cswap");
let cswap: CswapModule;
let log: MockInstance<typeof console.error>;

// What Paseo's own usage call answers. Only a pass that finds no cswap ever reaches it.
let paseoUsage: () => Promise<unknown>;
const context = {
  paseo: { providers: { listUsage: () => paseoUsage() } },
} as unknown as PluginHandlerContext;

/** `usage.list` the way the daemon calls it. */
function list() {
  return cswap.listUsageHandler({}, context);
}

const EMAIL = "one@example.com";

function listPayload(active: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: active,
    accounts: [
      {
        number: 4,
        alias: "work",
        email: EMAIL,
        organizationName: "Private Org",
        active: active === 4,
        usageStatus: "ok",
        usage: { fiveHour: { pct: 10, countdown: "2h 1m", projectedExhaustionAt: "later" } },
      },
      { number: 5, alias: "home", email: "two@example.com", active: active === 5, usageStatus: "ok", usage: null },
    ],
  });
}

function switchPayload(from: number, to: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    switched: from !== to,
    from: { number: from, email: EMAIL },
    to: { number: to, email: EMAIL },
    strategy: "direct",
    reason: from === to ? "already-active" : "switched",
    message: `Switched to Account-${to} (${EMAIL})`,
    warnings: [],
  });
}

function answer(index: number, stdout: string): void {
  spawns[index]?.callback(null, { stdout, stderr: "" });
}

function fail(index: number, error: object): void {
  spawns[index]?.callback(Object.assign(new Error("cswap failed"), error));
}

/** Loads the list once so the cache holds a snapshot with `active` as the active account. */
async function primeList(active = 4) {
  const pending = list();
  answer(spawns.length - 1, listPayload(active));
  return pending;
}

beforeEach(async () => {
  spawns.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
  log = vi.spyOn(console, "error").mockImplementation(() => {});
  paseoUsage = () => Promise.reject(new Error("Paseo usage is not part of this test"));
  // Fresh module state (cache, single-flight, last switch) for every test.
  vi.resetModules();
  cswap = await import("./cswap");
});

afterEach(() => {
  const logged = log.mock.calls.map((call) => String(call[0]));
  // Clean up first, so a failed check below cannot leak timers or spies into the next test.
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Nothing cswap printed may reach the logs: it carries emails and organization names.
  for (const line of logged) {
    expect(line).not.toContain("example.com");
    expect(line).not.toContain("Private Org");
  }
});

describe("usage.list", () => {
  it("parses the list and strips what the panel never draws", async () => {
    const result = await primeList();
    expect(spawns[0]?.args).toEqual(["list", "--json"]);
    expect(result.activeAccountNumber).toBe(4);
    expect(result.error).toBeNull();
    expect(result.accounts).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("Private Org");
    expect(JSON.stringify(result)).not.toContain("projectedExhaustionAt");
  });

  it("serves the cache for 60 seconds, then spawns again", async () => {
    await primeList();
    vi.advanceTimersByTime(59_000);
    await list();
    expect(spawns).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1_001);
    void list();
    expect(spawns).toHaveLength(2);
  });

  it("shares one spawn between concurrent calls", async () => {
    const first = list();
    const second = list();
    expect(spawns).toHaveLength(1);
    answer(0, listPayload(4));
    expect(await first).toEqual(await second);
  });

  it("keeps the last snapshot when a later call fails", async () => {
    await primeList();
    vi.setSystemTime(Date.now() + 61_000);
    const pending = list();
    fail(1, { code: "ENOENT" });
    const result = await pending;
    expect(result.accounts).toHaveLength(2);
    expect(result.error).toMatch(/^cswap not found at .* — set CSWAP_BIN/);
  });

  it("drops a malformed account but keeps the rest", async () => {
    const pending = list();
    const payload = JSON.parse(listPayload(4));
    payload.accounts.push({ number: "six", email: "three@example.com" });
    answer(0, JSON.stringify(payload));
    const result = await pending;
    expect(result.accounts.map((account) => account.number)).toEqual([4, 5]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped cswap account 2\.number/));
  });

  it("reports invalid JSON and an unknown schema without quoting them", async () => {
    let pending = list();
    answer(0, `{"email": "${EMAIL}"`);
    expect((await pending).error).toBe("cswap returned invalid JSON");

    vi.setSystemTime(Date.now() + 61_000);
    pending = list();
    answer(1, JSON.stringify({ schemaVersion: 2, accounts: [] }));
    expect((await pending).error).toBe("unexpected schemaVersion 2");
  });
});

describe("usage.switch", () => {
  it("refuses before any list and for accounts not in it", async () => {
    expect((await cswap.switchAccountHandler({ number: 4 })).error).toMatch(/^no cswap list yet/);
    await primeList();
    expect((await cswap.switchAccountHandler({ number: 9 })).error).toBe(
      "account 9 is not in the cswap list",
    );
    expect(spawns).toHaveLength(1);
  });

  it("switches and marks the new active account without another list", async () => {
    await primeList(4);
    const pending = cswap.switchAccountHandler({ number: 5 });
    expect(spawns[1]?.args).toEqual(["switch", "5", "--json"]);
    answer(1, switchPayload(4, 5));
    const result = await pending;
    expect(result).toMatchObject({ switched: true, error: null, warnings: [] });
    expect(result.usage.activeAccountNumber).toBe(5);
    expect(result.usage.accounts.map((account) => account.active)).toEqual([false, true]);
    // The cached list now agrees, still without a second `cswap list`.
    expect((await list()).activeAccountNumber).toBe(5);
    expect(spawns).toHaveLength(2);
  });

  it("reports an already active account as not switched", async () => {
    await primeList(4);
    const pending = cswap.switchAccountHandler({ number: 4 });
    answer(1, switchPayload(4, 4));
    expect(await pending).toMatchObject({ switched: false, error: null });
  });

  it("runs one switch at a time", async () => {
    await primeList(4);
    const first = cswap.switchAccountHandler({ number: 5 });
    const second = await cswap.switchAccountHandler({ number: 5 });
    expect(second.error).toBe("another switch is still running");
    answer(1, switchPayload(4, 5));
    expect((await first).switched).toBe(true);
    expect(spawns).toHaveLength(2);
  });

  it("returns cswap's error message but logs only its type", async () => {
    await primeList(4);
    const pending = cswap.switchAccountHandler({ number: 5 });
    fail(1, {
      code: 1,
      stdout: JSON.stringify({
        schemaVersion: 1,
        error: { type: "AccountNotFoundError", message: `No account for ${EMAIL}` },
      }),
    });
    const result = await pending;
    expect(result.error).toBe(`No account for ${EMAIL}`);
    expect(result.usage.activeAccountNumber).toBe(4);
    expect(log).toHaveBeenCalledWith("[cswap-usage] cswap switch failed (AccountNotFoundError)");
  });

  it("expires the cache when a switch answers with something unexpected", async () => {
    await primeList(4);
    const pending = cswap.switchAccountHandler({ number: 5 });
    answer(1, "Switched!");
    expect((await pending).error).toBe("cswap switch returned an unexpected payload");
    // Within the 60 seconds, yet the next list spawns so it can report the real account.
    void list();
    expect(spawns).toHaveLength(3);
  });

  it("keeps the new active account over a list that started before the switch", async () => {
    await primeList(4);
    vi.setSystemTime(Date.now() + 61_000);
    const staleList = list();
    vi.setSystemTime(Date.now() + 1);
    const pending = cswap.switchAccountHandler({ number: 5 });
    answer(2, switchPayload(4, 5));
    await pending;
    // The list that was already running read cswap before the switch landed.
    answer(1, listPayload(4));
    expect((await staleList).activeAccountNumber).toBe(5);
  });
});

describe("without cswap", () => {
  // The clock is fixed at 2026-09-28T00:00:00Z.
  const PASEO_FETCHED_AT = "2026-09-27T23:58:00.000Z";

  function paseoPayload(status: "available" | "unavailable" = "available") {
    const available = status === "available";
    return {
      fetchedAt: PASEO_FETCHED_AT,
      providers: [
        { providerId: "codex", displayName: "Codex", status: "available", windows: [] },
        {
          providerId: "claude",
          displayName: `Claude (${EMAIL})`,
          status,
          planLabel: available ? "Max 20x" : null,
          windows: available
            ? [
                { id: "five_hour", label: "Session", usedPct: 42, resetsAt: "2026-09-28T02:03:30Z" },
                { id: "weekly", label: "Weekly", usedPct: 14, resetsAt: "2026-10-01T09:00:00Z" },
                { id: "weekly_model_fable", label: "Weekly · Fable", usedPct: 19, resetsAt: null },
              ]
            : [],
          error: available ? null : "Login expired 3h ago. Run claude to refresh it.",
        },
      ],
    };
  }

  /** One list pass on a host where the cswap binary does not exist. */
  async function listWithoutCswap() {
    const pending = list();
    fail(spawns.length - 1, { code: "ENOENT" });
    return pending;
  }

  it("shows the default login as Paseo reads it", async () => {
    paseoUsage = async () => paseoPayload();
    const result = await listWithoutCswap();
    expect(result.error).toBeNull();
    expect(result.cswapNotFoundAt).toMatch(/cswap$/);
    expect(result.fetchedAt).toBe(PASEO_FETCHED_AT);
    expect(result.activeAccountNumber).toBe(-1);
    expect(result.accounts).toEqual([
      {
        number: -1,
        alias: "Claude",
        email: EMAIL,
        active: true,
        usageStatus: "ok",
        usage: {
          fiveHour: { pct: 42, countdown: "2h 3m" },
          sevenDay: { pct: 14, countdown: "3d 9h" },
          scoped: [{ pct: 19, name: "Fable" }],
        },
      },
    ]);
    // Nothing is wrong, so nothing is logged.
    expect(log).not.toHaveBeenCalled();
  });

  it("asks Paseo once per pass and keeps to the 60 second cache", async () => {
    const asked = vi.fn(async () => paseoPayload());
    paseoUsage = asked;
    await listWithoutCswap();
    vi.advanceTimersByTime(59_000);
    await list();
    expect(spawns).toHaveLength(1);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("reports cswap as not found when Paseo lists no Claude login", async () => {
    paseoUsage = async () => ({ fetchedAt: PASEO_FETCHED_AT, providers: [] });
    const result = await listWithoutCswap();
    expect(result.accounts).toEqual([]);
    expect(result.cswapNotFoundAt).toBeNull();
    expect(result.error).toMatch(/^cswap not found at .* — set CSWAP_BIN/);
  });

  it("reports cswap as not found when Paseo cannot list usage, logging only the type", async () => {
    paseoUsage = () => Promise.reject(new TypeError(`no usage for ${EMAIL}`));
    const result = await listWithoutCswap();
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/^cswap not found at /);
    expect(log).toHaveBeenCalledWith("[cswap-usage] Paseo usage unavailable (TypeError)");
  });

  it("goes back to the cswap list as soon as cswap answers", async () => {
    paseoUsage = async () => paseoPayload();
    await listWithoutCswap();
    vi.setSystemTime(Date.now() + 61_000);
    const pending = list();
    answer(1, listPayload(4));
    const result = await pending;
    expect(result.cswapNotFoundAt).toBeNull();
    expect(result.accounts.map((account) => account.number)).toEqual([4, 5]);
  });

  it("shows Paseo's status and reason for a login it can no longer read", async () => {
    paseoUsage = async () => paseoPayload();
    await listWithoutCswap();
    vi.setSystemTime(Date.now() + 61_000);
    paseoUsage = async () => paseoPayload("unavailable");
    const result = await listWithoutCswap();
    expect(result.error).toBe("Login expired 3h ago. Run claude to refresh it.");
    expect(result.accounts).toEqual([
      { number: -1, alias: "Claude", email: EMAIL, active: true, usageStatus: "unavailable", usage: null },
    ]);
  });

  it("never switches on the default login", async () => {
    paseoUsage = async () => paseoPayload();
    await listWithoutCswap();
    const result = await cswap.switchAccountHandler({ number: -1 });
    expect(result.error).toMatch(/^cswap not found at /);
    expect(result.switched).toBe(false);
    expect(spawns).toHaveLength(1);
  });
});
