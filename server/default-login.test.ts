import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { countdownTo, readDefaultLogin } from "./default-login";

let log: MockInstance<typeof console.error>;

const NOW = Date.parse("2026-09-28T00:00:00Z");
const EMAIL = "one@example.com";

function paseo(answer: () => Promise<unknown>) {
  return { providers: { listUsage: answer } };
}

function login(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    windows: [{ id: "five_hour", label: "Session", usedPct: 10, resetsAt: null }],
    error: null,
    ...overrides,
  };
}

function read(providers: unknown[], fetchedAt?: string) {
  return readDefaultLogin(
    paseo(async () => ({ fetchedAt, providers })),
    NOW,
  );
}

beforeEach(() => {
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  const logged = log.mock.calls.map((call) => String(call[0]));
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Paseo's rows carry emails just as cswap's do, and none may reach the logs.
  for (const line of logged) expect(line).not.toContain("example.com");
});

describe("countdownTo", () => {
  it("prints the time left the way cswap does", () => {
    expect(countdownTo("2026-10-01T09:59:59Z", NOW)).toBe("3d 9h");
    expect(countdownTo("2026-09-28T02:03:00Z", NOW)).toBe("2h 3m");
    expect(countdownTo("2026-09-28T00:21:00Z", NOW)).toBe("21m");
    expect(countdownTo("2026-09-28T00:00:30Z", NOW)).toBe("0m");
  });

  it("has nothing to say about a window that already reset or a date it cannot read", () => {
    expect(countdownTo("2026-09-27T23:59:59Z", NOW)).toBeUndefined();
    expect(countdownTo("soon", NOW)).toBeUndefined();
  });
});

describe("readDefaultLogin", () => {
  it("keeps Claude rows only and numbers them below zero, the first one active", async () => {
    const result = await read([
      login({ providerId: "codex", displayName: "Codex" }),
      login({ displayName: `Claude (${EMAIL})` }),
      login({ displayName: "Claude (two@example.com)" }),
    ]);
    expect(result?.accounts.map(({ number, alias, email, active }) => [number, alias, email, active])).toEqual([
      [-1, "Claude", EMAIL, true],
      [-2, "Claude", "two@example.com", false],
    ]);
  });

  it("keeps a display name without an email whole", async () => {
    const result = await read([login({ displayName: "Claude (work)" })]);
    expect(result?.accounts[0]).toMatchObject({ alias: "Claude (work)" });
    expect(result?.accounts[0]).not.toHaveProperty("email");
  });

  it("skips what it cannot draw and drops malformed rows one at a time", async () => {
    const result = await read([
      { providerId: "claude", displayName: 7 },
      login({
        windows: [
          { id: "five_hour", label: "Session", usedPct: null },
          { id: "weekly", label: "Weekly", usedPct: 55.5, resetsAt: "2026-09-28T05:00:00Z" },
          { id: "weekly_surface_design", label: "Weekly · Design", usedPct: 3 },
          { label: "no id", usedPct: 9 },
          "not a window",
        ],
      }),
    ]);
    expect(result?.accounts).toHaveLength(1);
    expect(result?.accounts[0]?.usage).toEqual({
      sevenDay: { pct: 55.5, countdown: "5h 0m" },
      scoped: [{ pct: 3, name: "Design" }],
    });
  });

  it("carries Paseo's fetch time and its reason for a login it cannot read", async () => {
    const result = await read(
      [login({ status: "error", windows: [], error: "Claude usage API returned 429" })],
      "2026-09-27T23:58:00.000Z",
    );
    expect(result).toMatchObject({
      fetchedAt: "2026-09-27T23:58:00.000Z",
      error: "Claude usage API returned 429",
      accounts: [{ usageStatus: "error", usage: null }],
    });
  });

  it("is null when there is no Claude row or the payload is not what Paseo sends", async () => {
    expect(await read([login({ providerId: "codex" })])).toBeNull();
    expect(
      await readDefaultLogin(
        paseo(async () => ({ accounts: EMAIL })),
        NOW,
      ),
    ).toBeNull();
    expect(log).toHaveBeenCalledWith("[cswap-usage] unexpected Paseo usage payload");
  });

  it("gives up on a call that never settles", async () => {
    vi.useFakeTimers();
    const pending = readDefaultLogin(
      paseo(() => new Promise(() => {})),
      NOW,
    );
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toBeNull();
    expect(log).toHaveBeenCalledWith("[cswap-usage] Paseo usage unavailable (TimeoutError)");
  });
});
