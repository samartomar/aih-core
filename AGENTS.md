# AIH-Core

**Hard rule for maintainer sessions.** This checkout belongs to a larger maintainer workspace. Start every session at that workspace's root and target this repository from there; never start one here. Create no worktree of this repository alone: a needed worktree is created under the workspace root, with the session still at that root.

The workspace owns workflow, issue routing, triage, delivery and release process. This file holds only this repository's own rules; outside contributors without the workspace follow the public documentation and these rules.

Package `@aihq/core`. The generic engine lives in `src/core/`; bundled repair/support definitions and helpers (Harness) live in `src/harness/`. Portable Harness metadata is exposed through `@aihq/core/harness`; Node helpers use `@aihq/core/harness/runtime`. Both modules share this repository's single package version. [README.md](README.md) owns implemented contracts, development setup and checks.

- Preserve the generic engine boundary: vendor/tool-specific definitions and helpers belong in Harness or supplied content. Portable contracts must work without Node host effects. Treat schemas and public API behavior as contracts.
- Published Harness changes require a new Core distribution version. Identify unpublished local builds by source commit and artifact digest. Preserve the actual installed package identity and selected helper/input byte binding.
- Build only the root package; no nested package or sibling checkout is required.
- Run focused checks for the change and the applicable package checks before handoff. Use `npm test` so package tests receive npm's executable path.
- Exercise product operations only against temporary homes and target directories; never use this source checkout as the product's repair or policy target.
