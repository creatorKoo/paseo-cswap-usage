import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listUsageHandler, releaseCswap, switchAccountHandler } from "./server/cswap";
import { listPinnedHandler } from "./server/pinned";
import { listPinned, listUsage, switchAccount } from "./shared/contract";
import { panelSettings, pillSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(pillSettings);
  server.registerSettings(panelSettings);
  server.handle(listUsage, listUsageHandler);
  server.handle(switchAccount, switchAccountHandler);
  server.handle(listPinned, listPinnedHandler);
  return releaseCswap;
}
