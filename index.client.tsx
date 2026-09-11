import type { PluginClientContext } from "@getpaseo/plugin/client";
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
  // The 60s poll timer lives in the panel's TanStack query, so there is nothing to stop.
  return () => {};
}
