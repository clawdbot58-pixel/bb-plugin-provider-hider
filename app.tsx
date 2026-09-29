// bb-plugin-provider-hider — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled). The page lists every registered agent provider with a Hide
// toggle; hidden providers drop to the bottom of every provider picker and
// cannot become the default.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ProviderHiderState, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function useProviderState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ProviderHiderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("state_get").then((next) => {
      setState(next);
      setError(null);
    }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("provider-hider-sync", refetch);
  const setHidden = useCallback(
    async (hidden: string[]) => {
      setBusy(true);
      try {
        const next = await rpc.call("state_set", { hidden });
        setState(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );
  return { state, error, busy, refetch, setHidden };
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ProviderRow({
  provider,
  isHidden,
  isDefault,
  busy,
  onToggle,
}: {
  provider: { id: string; displayName: string; pluginId: string; available: boolean };
  isHidden: boolean;
  isDefault: boolean;
  busy: boolean;
  onToggle: (hidden: boolean) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {provider.displayName}
          {isDefault && !isHidden ? (
            <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">default</span>
          ) : null}
          {!provider.available ? (
            <span className="ml-2 text-xs text-muted-foreground">unavailable</span>
          ) : null}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {provider.id} · {provider.pluginId}
        </p>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
        {isHidden ? "Hidden" : "Visible"}
        <Switch
          checked={!isHidden}
          disabled={busy}
          onCheckedChange={(visible) => onToggle(!visible)}
          aria-label={`${isHidden ? "Show" : "Hide"} provider ${provider.displayName}`}
        />
      </label>
    </li>
  );
}

// Tailwind classes compile against the host theme's live CSS variables —
// derive colors from the theme tokens, never hardcoded grays.
function ProviderHiderPage() {
  const { state, error, busy, setHidden } = useProviderState();
  const hiddenCount = state?.hidden.length ?? 0;
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="EyeOff" className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Provider Hider</h1>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Hidden providers move to the bottom of every provider picker, are skipped
        by provider-cycling shortcuts, and cannot stay the default. Hiding one
        provider never touches others from the same source (hiding Cursor keeps
        opencode). Nothing is uninstalled — flip a toggle back to restore.
      </p>
      {error !== null ? (
        <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>
      ) : null}
      {state?.lastSyncError != null ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          Last sync failed: {state.lastSyncError}
        </p>
      ) : null}
      {state === null ? (
        <EmptyState>Loading providers…</EmptyState>
      ) : state.providers.length === 0 ? (
        <EmptyState>No agent provider is registered right now.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {state.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                isHidden={state.hidden.includes(provider.id)}
                isDefault={state.defaultProviderId === provider.id}
                busy={busy}
                onToggle={(hidden) => {
                  const next = hidden
                    ? [...state.hidden, provider.id]
                    : state.hidden.filter((id) => id !== provider.id);
                  void setHidden(next);
                }}
              />
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {hiddenCount === 0 ? "All providers visible." : `${hiddenCount} hidden.`}
            </p>
            {hiddenCount > 0 ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void setHidden([])}
              >
                Show all
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "providers",
    title: "Provider Hider",
    icon: "EyeOff",
    path: "providers",
    component: ProviderHiderPage,
  });
});
