# @aihq/harness

This unreleased development package supplies the installed tool definitions and bounded diagnostic helper used by `@aihq/core` inspection. Its `/contracts` export is portable static data; `/runtime` is the Node-only diagnostic entry. Harness does not import Core or the old ai-harness engine at runtime.

The current slice inspects existing tools and offers manual follow-up guidance. It does not install tools, start configured MCP servers, apply a repair, or publish selectable repair recipes. Core reports the Harness package version it actually resolves rather than assuming a sibling installation or registry latest.

## Exports

| Import | Purpose |
| --- | --- |
| `@aihq/harness/contracts` | Installed package support, targets and diagnostic metadata |
| `@aihq/harness/runtime` | Bounded `diagnose` helper for a known published diagnostic |

The runtime requires Node `>=24.6.0 <25`. Inspect through Core's public API or `aih inspect`; Core owns the caller-facing result and CLI.
