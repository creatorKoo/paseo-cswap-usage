import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerUsagePills } from "./client/pill-registration";
import { PillSettingsScreen } from "./client/settings";
import { UsagePanel } from "./client/usage";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "usage",
    title: "cswap usage",
    icon: "Gauge",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: UsagePanel,
  });
  client.addCommandCenterItem({
    id: "open-usage",
    title: "Open cswap usage",
    icon: "Gauge",
    context: "workspace",
    keywords: ["cswap", "usage", "quota"],
    onSelect({ openPanel }) {
      openPanel("usage");
    },
  });
  client.addSettingsScreen({
    id: "pill",
    title: "cswap usage",
    icon: "Gauge",
    Component: PillSettingsScreen,
  });
  // The 60s poll timer lives in the shared TanStack query, so the pills' agent
  // observation is the only thing to stop.
  return registerUsagePills(client);
}
