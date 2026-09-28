import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listPinnedHandler, pinnedAccountArg, pinnedProviders } from "./pinned";

describe("pinnedAccountArg", () => {
  it("reads the account from a cswap run command", () => {
    expect(pinnedAccountArg(["/Users/me/.local/bin/cswap", "run", "work", "--share-history", "--"])).toBe(
      "work",
    );
    expect(pinnedAccountArg(["cswap", "run", "--share-history", "2", "--", "--resume"])).toBe("2");
    expect(pinnedAccountArg(["C:\\tools\\cswap.exe", "run", "me@example.com"])).toBe(
      "me@example.com",
    );
  });

  it("returns null when cswap picks the account from the directory mapping", () => {
    expect(pinnedAccountArg(["cswap", "run"])).toBeNull();
    expect(pinnedAccountArg(["cswap", "run", "--share-history", "--", "--resume"])).toBeNull();
  });

  it("returns null for anything that is not cswap run", () => {
    expect(pinnedAccountArg(["claude", "--resume"])).toBeNull();
    expect(pinnedAccountArg(["notcswap", "run", "work"])).toBeNull();
    expect(pinnedAccountArg(["cswap", "switch", "work"])).toBeNull();
    expect(pinnedAccountArg(["run", "work"])).toBeNull();
  });
});

describe("pinnedProviders", () => {
  it("keeps claude providers with a cswap run command and nothing else", () => {
    expect(
      pinnedProviders({
        claude: { enabled: true },
        "claude-work": {
          extends: "claude",
          label: "Claude (work)",
          command: ["/Users/me/.local/bin/cswap", "run", "work", "--"],
          env: { ANTHROPIC_API_KEY: "secret" },
        },
        "claude-plain": { extends: "claude", command: ["claude"] },
        "codex-work": { extends: "codex", command: ["cswap", "run", "work"] },
        "claude-string": { extends: "claude", command: "cswap run work" },
        "claude-mixed": { extends: "claude", command: ["cswap", 1] },
        "claude-empty": null,
      }),
    ).toEqual([{ provider: "claude-work", account: "work" }]);
  });

  it("counts an overridden built-in provider", () => {
    expect(pinnedProviders({ claude: { command: ["cswap", "run", "home"] } })).toEqual([
      { provider: "claude", account: "home" },
    ]);
  });
});

describe("listPinnedHandler", () => {
  afterEach(() => vi.restoreAllMocks());

  function context(get: () => Promise<unknown>): PluginHandlerContext {
    return { paseo: { config: { get } } } as unknown as PluginHandlerContext;
  }

  it("returns only provider ids and account arguments", async () => {
    const result = await listPinnedHandler(
      {},
      context(async () => ({
        config: {
          providers: {
            "claude-home": {
              extends: "claude",
              command: ["cswap", "run", "home"],
              env: { TOKEN: "secret" },
            },
          },
        },
      })),
    );
    expect(result).toEqual({ pinned: [{ provider: "claude-home", account: "home" }] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("pins nothing when the config cannot be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await listPinnedHandler(
      {},
      context(async () => {
        throw new Error("daemon.manage denied");
      }),
    );
    expect(result).toEqual({ pinned: [] });
    expect(log).toHaveBeenCalledWith(
      "[cswap-usage] could not read provider config: daemon.manage denied",
    );
  });
});
