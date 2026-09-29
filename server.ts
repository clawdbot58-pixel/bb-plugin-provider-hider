// bb-plugin-provider-hider — keep chosen agent providers out of BB's pickers.
//
// BB has no "hide provider" setting: the server's provider registry only SORTS
// by the user's providerOrder and never drops unlisted providers, and the
// Cursor ACP agent is shipped with `visibility: "always"` and a reserved id,
// so it cannot be removed or overridden without disabling the whole ACP
// plugin (which would take opencode with it).
//
// This plugin closes that gap with one mechanism: it mirrors the provider
// roster into BB's `providerOrder` app setting. Core sorts by that order and
// reads the default from `defaultProviderId`, so a hidden provider is pushed
// to the end of every picker. Removing a provider here (e.g. Cursor) keeps
// every other provider from the same source (opencode) untouched.
import { defineRpcContract, type BbPluginApi, type AppSettings, type AppSettingsUpdate, type ProviderInfo } from "@get-bb/plugin-sdk";
import { z } from "zod";

const hiddenSchema = z.array(z.string().min(1)).max(64);
type Hidden = z.infer<typeof hiddenSchema>;

/** Everything the settings page renders: intent, roster, and sync health. */
export interface ProviderHiderState {
  hidden: string[];
  providers: { id: string; displayName: string; pluginId: string; available: boolean }[];
  providerOrder: string[];
  defaultProviderId: string | null;
  lastSyncError: string | null;
}

export const rpcContract = defineRpcContract({
  state_get: {
    input: z.null(),
    output: z.object({
      hidden: hiddenSchema,
      /** Roster as the host reports it, in picker order. */
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          pluginId: z.string(),
          available: z.boolean(),
        }),
      ),
      /** The live providerOrder after the last sync. */
      providerOrder: z.array(z.string()),
      defaultProviderId: z.string().nullable(),
      lastSyncError: z.string().nullable(),
    }),
  },
  state_set: {
    input: z.object({ hidden: hiddenSchema }),
    output: z.object({
      hidden: hiddenSchema,
      providerOrder: z.array(z.string()),
      defaultProviderId: z.string().nullable(),
      lastSyncError: z.string().nullable(),
    }),
  },
});

const STORE_KEY = "hidden-providers";
const SYNC_CHANNEL = "provider-hider-sync";
const POLL_INTERVAL_MS = 15_000;

/** Stable relative order for providers, hidden ones pushed to the end. */
function applyOrder(
  current: AppSettings,
  roster: ProviderInfo[],
  hidden: ReadonlySet<string>,
): AppSettingsUpdate {
  const visible = roster.filter((provider) => !hidden.has(provider.id));
  const visibleIds = new Set(visible.map((provider) => provider.id));
  const ordered = [
    // Everything the user (or this plugin) has explicitly ranked, in rank order,
    // excluding ids that are hidden or no longer registered.
    ...current.providerOrder.filter((id) => !hidden.has(id) && visibleIds.has(id)),
    // Anything not yet ranked keeps its roster order, appended.
    ...visible.filter((provider) => !current.providerOrder.includes(provider.id)).map((provider) => provider.id),
  ];
  const update: AppSettingsUpdate = { ...current, providerOrder: ordered };
  // Never leave the default pointing at a hidden provider.
  if (current.defaultProviderId !== null && hidden.has(current.defaultProviderId)) {
    update.defaultProviderId = ordered[0] ?? null;
  }
  return update;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve(undefined);
  }, { once: true });
  return promise;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const hidden = new Set<string>(
    (await bb.storage.kv.get<Hidden>(STORE_KEY)) ?? [],
  );
  let lastSyncError: string | null = null;

  /**
   * Rewrite providerOrder/defaultProviderId from the desired hidden set.
   * Callers tolerate failure: the store keeps the user's intent, so the next
   * load, config change, or registration change retries.
   */
  async function sync(reason: string): Promise<void> {
    try {
      const providers = await bb.sdk.providers.list();
      if (providers.length === 0) return; // roster briefly unavailable; keep intent
      const settings = (await bb.sdk.system.config()).generalSettings;
      const update = applyOrder(settings, providers, hidden);
      await bb.sdk.system.updateGeneralSettings(update);
      lastSyncError = null;
      bb.log.info(`Applied hidden providers (${reason}): order=${update.providerOrder.join(",")}`);
    } catch (error) {
      lastSyncError = error instanceof Error ? error.message : String(error);
      bb.log.error(`Provider order sync failed (${reason}): ${lastSyncError}`);
    }
  }

  async function setHidden(next: Hidden): Promise<void> {
    for (const id of hidden) if (!next.includes(id)) hidden.delete(id);
    for (const id of next) hidden.add(id);
    await bb.storage.kv.set(STORE_KEY, next);
    await sync("config");
    try {
      bb.realtime.publish(SYNC_CHANNEL, { hidden: next });
    } catch {
      // realtime channel unavailable — the settings page refetches on open.
    }
  }

  bb.rpc.register(rpcContract, {
    state_get: async () => {
      const providers = await bb.sdk.providers.list();
      const settings = (await bb.sdk.system.config()).generalSettings;
      return {
        hidden: [...hidden],
        providers: providers.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          pluginId: provider.pluginId,
          available: provider.available,
        })),
        providerOrder: settings.providerOrder,
        defaultProviderId: settings.defaultProviderId,
        lastSyncError,
      };
    },
    state_set: async ({ hidden: next }) => {
      await setHidden(next);
      const settings = (await bb.sdk.system.config()).generalSettings;
      return {
        hidden: next,
        providerOrder: settings.providerOrder,
        defaultProviderId: settings.defaultProviderId,
        lastSyncError,
      };
    },
  });

  // Re-apply whenever a provider plugin (dis)appears: a disabled
  // provider-acp drops, then comes back; new custom agents register; the
  // roster the order was computed against has changed. bb exposes no
  // plugin-side registration-change event, so poll the roster.
  bb.background.service("provider-hider-watch", {
    async start(signal) {
      while (!signal.aborted) {
        await delay(POLL_INTERVAL_MS, signal);
        if (signal.aborted) return;
        try {
          const providers = await bb.sdk.providers.list();
          if (providers.length === 0) continue;
          const settings = (await bb.sdk.system.config()).generalSettings;
          // Drift = the live order differs from what this plugin wants:
          // a user/another tool re-ranked or re-revealed a hidden provider,
          // a provider plugin appeared or vanished, or the default points
          // at a hidden id.
          const desired = applyOrder(settings, providers, hidden).providerOrder;
          const drifted =
            // Compare against the raw live order: a hidden id sitting anywhere
            // in providerOrder (e.g. a user dragged Cursor to the top) is
            // itself drift, even though the visible prefix could match.
            settings.providerOrder.join(",") !== desired.join(",") ||
            (settings.defaultProviderId !== null && hidden.has(settings.defaultProviderId));
          if (drifted) await sync("roster-change");
        } catch {
          // transient errors are logged by sync(); keep polling.
        }
      }
    },
  });

  await sync("load");

  // The `bb provider-hider` command: what agents (and you) use from a shell.
  bb.cli.register({
    name: "provider-hider",
    summary: "Hide agent providers from BB's pickers without uninstalling them",
    commands: [
      { name: "list", summary: "List providers and their hidden state", usage: "bb provider-hider list [--json]" },
      { name: "hide", summary: "Hide one provider", usage: "bb provider-hider hide <provider-id> [--json]" },
      { name: "show", summary: "Unhide one provider (or --all)", usage: "bb provider-hider show <provider-id> | --all [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const providers = await bb.sdk.providers.list();
      const settings = (await bb.sdk.system.config()).generalSettings;
      const idLine = (id: string, provider: ProviderInfo | undefined) =>
        `${hidden.has(id) ? "hidden " : "visible"}  ${id}  ${provider?.displayName ?? id}${settings.defaultProviderId === id ? "  [default]" : ""}`;
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return {
            exitCode: 0,
            stdout: [
              "Usage:",
              "  bb provider-hider list [--json]",
              "  bb provider-hider hide <provider-id> [--json]",
              "  bb provider-hider show <provider-id> [--json]",
              "  bb provider-hider show --all [--json]",
            ].join("\n"),
          };
        case "list": {
          const known = new Set(providers.map((provider) => provider.id));
          const lines = [
            ...providers.map((provider) => idLine(provider.id, provider)),
            ...[...hidden].filter((id) => !known.has(id)).map((id) => `${idLine(id, undefined)}  (not currently registered)`),
          ];
          return reply(providers, lines.length === 0 ? "No providers registered." : lines.join("\n"));
        }
        case "hide": {
          const id = rest[0];
          if (id === undefined || rest.length !== 1) break;
          if (!providers.some((provider) => provider.id === id)) {
            return {
              exitCode: 1,
              stderr: `No provider "${id}". Run "bb provider-hider list" to see ids.`,
            };
          }
          await setHidden([...hidden, id]);
          return reply({ hidden: [...hidden] }, `Hidden: ${id}`);
        }
        case "show": {
          if (rest[0] === "--all" || rest.includes("--all")) {
            await setHidden([]);
            return reply({ hidden: [] }, "All providers visible.");
          }
          const id = rest[0];
          if (id === undefined || rest.length !== 1) break;
          if (!hidden.has(id)) {
            return { exitCode: 1, stderr: `Provider "${id}" is not hidden.` };
          }
          await setHidden([...hidden].filter((candidate) => candidate !== id));
          return reply({ hidden: [...hidden] }, `Visible again: ${id}`);
        }
      }
      return {
        exitCode: 1,
        stderr: [
          "Usage:",
          "  bb provider-hider list [--json]",
          "  bb provider-hider hide <provider-id> [--json]",
          "  bb provider-hider show <provider-id> [--json]",
          "  bb provider-hider show --all [--json]",
        ].join("\n"),
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
