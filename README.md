# @aihq/harness

This unreleased development package supplies installed tool definitions, bounded diagnostics, and the `node-npm-ca` repair definition used by `@aihq/core`. Its `/contracts` export is portable static data; `/runtime` contains Node-only diagnostics, complete-input CA validation, and a fixed repair renderer. Harness does not import Core or the old ai-harness engine at runtime.

The repair definition accepts a local certificate-only PEM file through Core's public `prepare`/`apply` path. It never installs tools, starts configured MCP servers, writes system trust or evaluates organization policy. Core reports the Harness package version it actually resolves rather than assuming a sibling installation or registry latest.

## Exports

| Import | Purpose |
| --- | --- |
| `@aihq/harness/contracts` | Installed package support, targets, repair index and helper metadata |
| `@aihq/harness/runtime` | Bounded `diagnose`, `validateSuppliedCa`, `composeExistingTrust` and fixed `renderRepair` helpers |

The runtime requires Node `>=24.6.0 <25`. Inspect through Core's public API or `aih inspect`; Core owns the caller-facing result and CLI.

## Development

Source lives in [`samartomar/aih-harness`](https://github.com/samartomar/aih-harness),
with its own Git history and remote. Run `node --test test/*.test.mjs` on Node 24
within the declared engine range. There is no build step.

For Core consumer checks, clone [`samartomar/aih-core`](https://github.com/samartomar/aih-core)
beside this repository as sibling directories `aih-core/` and `aih-harness/`, then
follow Core's development checks. The initial split pairs Harness source commit
`d505dea` with Core source commit `a36fc32`. Core's package test installs both
tarballs into an isolated consumer; Harness itself has no dependency on Core.
