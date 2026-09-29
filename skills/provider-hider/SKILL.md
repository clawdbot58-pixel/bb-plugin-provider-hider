---
name: provider-hider
description: Hide agent providers (Cursor, codex, claude-code, ACP agents) from BB's pickers with `bb provider-hider`, or when the user asks to remove/hide a provider without uninstalling others.
---

# Provider Hider

The Provider Hider plugin keeps chosen agent providers at the bottom of every
provider picker and out of the default slot, without uninstalling any provider
plugin. Hiding one provider never affects others from the same source: hiding
`acp-cursor` (Cursor) keeps `acp-opencode` (opencode) intact.

## Commands

| Command | Effect |
| --- | --- |
| `bb provider-hider list` | Show every registered provider and whether it is hidden. |
| `bb provider-hider hide <provider-id>` | Hide one provider. |
| `bb provider-hider show <provider-id>` | Unhide one provider. |
| `bb provider-hider show --all` | Unhide everything. |

Add `--json` to any command when the output drives code.

## Procedure

1. Run `bb provider-hider list` first and use the exact provider ids it prints.
   Common ids: `pi`, `codex`, `claude-code`, `acp-cursor`, `acp-opencode`,
   `acp-omp`, `acp-grok`, `acp-hermes-agent`.
2. Hide with the id, never with a display name: `bb provider-hider hide acp-cursor`.
3. Verify with `bb provider-hider list` — the hidden entry shows `hidden`.

## Notes

- The UI page lives in the sidebar under **Provider Hider** with the same
  toggles; both surfaces stay in sync.
- Hidden providers are pushed to the end of `providerOrder` in BB's general
  settings and are skipped when picking a new default. They are not
  uninstalled and existing threads keep working.
- Provider cycling shortcuts (`modelPicker.cycleProvider`) skip hidden
  providers only because they sort last; a visible provider is never removed
  from the registry.
