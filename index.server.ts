import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listUsageHandler, releaseCswap, switchAccountHandler } from "./server/cswap";
import { listUsage, switchAccount } from "./shared/contract";
import { pillSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(pillSettings);
  server.handle(listUsage, listUsageHandler);
  server.handle(switchAccount, switchAccountHandler);
  return releaseCswap;
}
