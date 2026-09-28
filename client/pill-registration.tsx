import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { listPinned } from "../shared/contract";
import { PillIcon, PillPopover } from "./pill";

/** The built-in provider. Unless its command is overridden, it runs the active account. */
const BUILT_IN_PROVIDER = "claude";

type AgentLike = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  provider?: string | null;
};

/** `claude/claude-opus-5-5` and `claude` both → `claude`. */
function providerId(provider: string | null | undefined): string | null {
  const id = provider?.split("/")[0]?.trim() ?? "";
  return id === "" ? null : id;
}

function addPill(
  client: PluginClientContext,
  agentId: string,
  workspaceId: string,
  pinned: string | null,
): PluginButtonRegistration {
  // The icon pushes the label and tooltip through this, after the registration exists:
  // update only ever runs from an effect, which is after addComposerPill has returned.
  let registration: PluginButtonRegistration | undefined;
  const update = (patch: Partial<PluginButton>) => registration?.update(patch);
  const Icon = (props: PluginButtonIconProps) => (
    <PillIcon {...props} update={update} pinned={pinned} />
  );
  const Content = (props: PluginButtonContentProps) => (
    <PillPopover
      {...props}
      pinned={pinned}
      onOpenPanel={() => client.openPanel("usage", { workspaceId })}
    />
  );
  registration = client.addComposerPill({
    id: "usage",
    workspaceId,
    agentId,
    button: {
      title: "cswap usage",
      icon: Icon,
      label: "…",
      behavior: { kind: "popover", Content },
    },
  });
  return registration;
}

/**
 * Keeps one pill on every live claude agent: an active-account pill on the built-in
 * provider, and a pinned pill on providers whose command is `cswap run <account>`.
 * Returns the entry cleanup.
 */
export function registerUsagePills(client: PluginClientContext): () => void {
  const pills = new Map<
    string,
    { workspaceId: string; pinned: string | null; registration: PluginButtonRegistration }
  >();
  const agents = new Map<string, AgentLike>();
  // Provider id → `cswap run` argument. Empty until the server answers, so providers that
  // extend claude get their pill a moment after the built-in ones.
  let pinnedByProvider = new Map<string, string>();
  const lifetime = new AbortController();
  let subscription: { release(): Promise<void> } | undefined;
  let stopped = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  /** What this agent's pill follows: a pinned argument, the active account, or nothing. */
  const targetOf = (agent: AgentLike): { pinned: string | null } | null => {
    const id = providerId(agent.provider);
    if (id === null) return null;
    const pinned = pinnedByProvider.get(id);
    if (pinned !== undefined) return { pinned };
    return id === BUILT_IN_PROVIDER ? { pinned: null } : null;
  };

  const sync = (agent: AgentLike) => {
    if (stopped) return;
    agents.set(agent.id, agent);
    const workspaceId = agent.workspaceId ?? null;
    const target = targetOf(agent);
    if (workspaceId === null || (agent.archivedAt ?? null) !== null || target === null) {
      remove(agent.id);
      return;
    }
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === workspaceId && existing.pinned === target.pinned) return;
    // Same target, new workspace or account: the old registration has to go first, since a
    // duplicate id in one target throws.
    remove(agent.id);
    pills.set(agent.id, {
      workspaceId,
      pinned: target.pinned,
      registration: addPill(client, agent.id, workspaceId, target.pinned),
    });
  };

  const forget = (agentId: string) => {
    agents.delete(agentId);
    remove(agentId);
  };

  // Provider config can change at any time; the catalog update is the signal to re-read it.
  // Only the newest answer counts, and a failure keeps the last map.
  let pinnedRequest = 0;
  const refreshPinned = async () => {
    const request = ++pinnedRequest;
    try {
      const { pinned } = await client.rpc(listPinned, {});
      if (stopped || request !== pinnedRequest) return;
      pinnedByProvider = new Map(pinned.map((entry) => [entry.provider, entry.account]));
      for (const agent of agents.values()) sync(agent);
    } catch (error: unknown) {
      if (!stopped) console.error("[cswap-usage] pinned providers failed", error);
    }
  };
  const unsubscribeProviders = client.paseo.providers.subscribe(() => {
    void refreshPinned();
  });
  void refreshPinned();

  void client.paseo.agents
    .list({ scope: "active", page: { limit: 200 }, subscribe: {}, signal: lifetime.signal })
    .then((result) => {
      if (stopped) {
        void result.subscription.release();
        return;
      }
      subscription = result.subscription;
      for (const { agent } of result.entries) sync(agent);
      result.subscription.subscribe({
        // A fresh snapshot arrives after every reconnect. Agents missing from it are gone.
        snapshot: ({ entries }) => {
          const live = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...agents.keys()]) {
            if (!live.has(agentId)) forget(agentId);
          }
          for (const { agent } of entries) sync(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") forget(update.agentId);
          else sync(update.agent);
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[cswap-usage] agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    unsubscribeProviders();
    void subscription?.release();
    subscription = undefined;
    for (const agentId of [...pills.keys()]) remove(agentId);
    agents.clear();
  };
}
