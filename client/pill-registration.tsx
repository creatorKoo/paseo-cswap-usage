import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { PillIcon, PillPopover } from "./pill";

/**
 * The pill follows the active cswap account, which only the built-in provider runs on.
 * Providers that extend it (`claude-skt`, …) pin their own account with `cswap run <alias>`,
 * so an active-account pill on them would show the wrong account.
 */
const PILL_PROVIDER = "claude";

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
): PluginButtonRegistration {
  // The icon pushes the label and tooltip through this, after the registration exists:
  // update only ever runs from an effect, which is after addComposerPill has returned.
  let registration: PluginButtonRegistration | undefined;
  const update = (patch: Partial<PluginButton>) => registration?.update(patch);
  const Icon = (props: PluginButtonIconProps) => <PillIcon {...props} update={update} />;
  const Content = (props: PluginButtonContentProps) => (
    <PillPopover {...props} onOpenPanel={() => client.openPanel("usage", { workspaceId })} />
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

/** Keeps one pill on every live built-in claude agent. Returns the entry cleanup. */
export function registerUsagePills(client: PluginClientContext): () => void {
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  const lifetime = new AbortController();
  let subscription: { release(): Promise<void> } | undefined;
  let stopped = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  const sync = (agent: AgentLike) => {
    if (stopped) return;
    const workspaceId = agent.workspaceId ?? null;
    if (
      workspaceId === null ||
      (agent.archivedAt ?? null) !== null ||
      providerId(agent.provider) !== PILL_PROVIDER
    ) {
      remove(agent.id);
      return;
    }
    if (pills.get(agent.id)?.workspaceId === workspaceId) return;
    // Same target, new workspace: the old registration has to go first, since a duplicate
    // id in one target throws.
    remove(agent.id);
    pills.set(agent.id, { workspaceId, registration: addPill(client, agent.id, workspaceId) });
  };

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
          for (const agentId of [...pills.keys()]) {
            if (!live.has(agentId)) remove(agentId);
          }
          for (const { agent } of entries) sync(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
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
    void subscription?.release();
    subscription = undefined;
    for (const agentId of [...pills.keys()]) remove(agentId);
  };
}
