import { describe, expect, it } from "vitest";
import type { UsageAccount } from "../shared/contract";
import {
  activeAccount,
  labelHead,
  pillLabel,
  pillTitle,
  resolveAccount,
  shownUsage,
  tightCountdown,
} from "./format";

const words = {
  badge: "active",
  resetsIn: (countdown: string) => `resets in ${countdown}`,
  lastGood: (time: string) => `last value ${time}`,
};

function account(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return {
    number: 4,
    alias: "work",
    email: "one@example.com",
    active: true,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: 42.4, countdown: "2h 31m" },
      sevenDay: { pct: 14, countdown: "1d 23h" },
    },
    ...overrides,
  };
}

describe("labelHead", () => {
  it("renders each format", () => {
    expect(labelHead(account(), "5h")).toBe("42% 2h31m");
    expect(labelHead(account(), "5h-7d")).toBe("42% / 14%");
    expect(labelHead(account(), "short")).toBe("42%");
  });

  it("drops a missing countdown and dashes a missing window", () => {
    expect(labelHead(account({ usage: { fiveHour: { pct: 7 } } }), "5h")).toBe("7%");
    expect(labelHead(account({ usage: { sevenDay: { pct: 9 } } }), "5h-7d")).toBe("— / 9%");
    expect(labelHead(account({ usage: { sevenDay: { pct: 9 } } }), "5h")).toBe("—");
  });

  it("dashes an account with nothing to draw", () => {
    expect(labelHead(account({ usage: null }), "5h")).toBe("—");
    expect(labelHead(account({ usageStatus: "token_expired", usage: null }), "5h")).toBe("—");
  });

  it("falls back to the last good reading", () => {
    const stale = account({
      usageStatus: "token_expired",
      usage: null,
      lastGoodUsage: { fiveHour: { pct: 25, countdown: "0m" } },
    });
    expect(labelHead(stale, "short")).toBe("25%");
  });
});

describe("pillLabel", () => {
  it("puts the alias last so the ellipsis cuts it first", () => {
    expect(pillLabel(account({ alias: "team-lab" }), "5h")).toBe("42% 2h31m · team-lab");
  });

  it("names an alias-less account by its slot", () => {
    expect(pillLabel(account({ alias: undefined }), "short")).toBe("42% · #4");
  });
});

describe("pillTitle", () => {
  it("is one short line per fact", () => {
    expect(pillTitle(account(), null, words).split("\n")).toEqual([
      "work · active",
      "5h 42% · resets in 2h 31m",
      "7d 14% · resets in 1d 23h",
    ]);
  });

  it("adds the status, with the last good time when there is one", () => {
    const expired = pillTitle(account({ usageStatus: "relogin_required", usage: null }), null, words);
    expect(expired.split("\n")).toEqual(["work · active", "relogin_required"]);

    const stale = pillTitle(
      account({
        usageStatus: "token_expired",
        usage: null,
        lastGoodUsage: { fiveHour: { pct: 25 } },
        lastGoodFetchedAt: "2026-09-28T01:00:00Z",
      }),
      null,
      words,
    ).split("\n");
    expect(stale.slice(0, 2)).toEqual(["work · active", "5h 25%"]);
    expect(stale[2]).toMatch(/^token_expired · last value \d{2}:\d{2}:\d{2}$/);
  });

  it("uses the fallback name and ends with the error", () => {
    expect(pillTitle(null, "cswap timed out after 25s", words, "cswap run x: missing")).toBe(
      "cswap run x: missing\ncswap timed out after 25s",
    );
  });
});

describe("resolveAccount", () => {
  const accounts = [
    account(),
    account({ number: 5, alias: "Home", email: "Two@Example.com", active: false }),
    account({ number: 6, alias: undefined, email: "three@example.com", active: false }),
  ];

  it("matches a slot number, then an alias or email without case", () => {
    expect(resolveAccount(accounts, "5")?.number).toBe(5);
    expect(resolveAccount(accounts, "home")?.number).toBe(5);
    expect(resolveAccount(accounts, "two@example.com")?.number).toBe(5);
    expect(resolveAccount(accounts, "three@example.com")?.number).toBe(6);
  });

  it("returns null for an argument cswap would not resolve here", () => {
    expect(resolveAccount(accounts, "9")).toBeNull();
    expect(resolveAccount(accounts, "nobody")).toBeNull();
  });
});

describe("small helpers", () => {
  it("tightens countdowns", () => {
    expect(tightCountdown({ pct: 1, countdown: "1d 23h" })).toBe("1d23h");
    expect(tightCountdown({ pct: 1 })).toBe("");
    expect(tightCountdown(undefined)).toBe("");
  });

  it("finds the active account", () => {
    const list = {
      fetchedAt: null,
      error: null,
      activeAccountNumber: 5,
      accounts: [account({ active: false }), account({ number: 5, active: true })],
    };
    expect(activeAccount(list)?.number).toBe(5);
    expect(activeAccount(undefined)).toBeNull();
  });

  it("marks the last good fallback as stale", () => {
    expect(shownUsage(account())?.stale).toBe(false);
    expect(
      shownUsage(account({ usageStatus: "token_expired", usage: null, lastGoodUsage: {} }))?.stale,
    ).toBe(true);
    expect(shownUsage(account({ usageStatus: "token_expired", usage: null }))).toBeNull();
  });
});
