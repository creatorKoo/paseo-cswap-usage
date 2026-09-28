// The usage query shared by the panel, every pill, and every popover. Client-only: it
// imports the plugin client hooks, so it must never be reached from server/ or shared/.
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { listUsage } from "../shared/contract";

export const POLL_INTERVAL_MS = 60_000;

/** One key for the panel, every pill, and every popover, so they share a single poll. */
export const USAGE_QUERY_KEY = ["cswap-usage", "list"] as const;

export function useUsageQuery() {
  const list = useRpc(listUsage);
  return useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: () => list({}),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS - 5_000,
  });
}
