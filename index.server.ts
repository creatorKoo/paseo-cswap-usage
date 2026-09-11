import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listUsageHandler, releaseCswap } from "./server/cswap";
import { listUsage } from "./shared/contract";

export default function contribute(server: PluginServerContext) {
  server.handle(listUsage, listUsageHandler);
  return releaseCswap;
}
