# @aihq/harness

This unreleased development package supplies installed tool definitions, bounded diagnostics, and the `node-npm-ca` repair definition used by `@aihq/core`. Its `/contracts` export is portable static data; `/runtime` contains Node-only diagnostics, complete-input CA validation, and a fixed repair renderer. Harness does not import Core or the old ai-harness engine at runtime.

The repair definition accepts a local certificate-only PEM file through Core's public `prepare`/`apply` path. It never installs tools, starts configured MCP servers, writes system trust or evaluates organization policy. Core reports the Harness package version it actually resolves rather than assuming a sibling installation or registry latest.

## Exports

| Import | Purpose |
| --- | --- |
| `@aihq/harness/contracts` | Installed package support, targets, repair index and helper metadata |
| `@aihq/harness/runtime` | Bounded `diagnose`, `validateSuppliedCa`, `composeExistingTrust` and fixed `renderRepair` helpers |

The runtime requires Node `>=24.6.0 <25`. Inspect through Core's public API or `aih inspect`; Core owns the caller-facing result and CLI.
