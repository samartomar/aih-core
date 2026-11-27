# AIH-Core

**Hard rule for maintainer sessions.** In the maintainer workspace, this checkout sits under the workspace root. Start every maintainer session at that root and target this repository from there; never start one in this repository or in a worktree of it. Create no worktree by default. When the workspace's rules call for one, create it under the workspace root and keep the session at that root; never create one elsewhere.

The workspace owns the engineering workflow, issue routing, triage, delivery coordination and navigation-helper setup; this repository's own documents own its checks and release requirements. This file holds only this repository's own rules; outside contributors without the workspace follow the public documentation and these rules.

Package `@aihq/core`. The generic engine lives in `src/core/`; bundled repair/support definitions and helpers (Harness) live in `src/harness/`. Portable Harness metadata is exposed through `@aihq/core/harness`; Node helpers use `@aihq/core/harness/runtime`. Both modules share this repository's single package version. [README.md](README.md) owns implemented contracts, development setup and checks.

- Preserve the generic engine boundary: vendor/tool-specific definitions and helpers belong in Harness or supplied content. Portable contracts must work without Node host effects. Treat schemas and public API behavior as contracts.
- Published Harness changes require a new Core distribution version. Identify unpublished local builds by source commit and artifact digest. Preserve the actual installed package identity and selected helper/input byte binding.
- Build only the root package; no nested package or sibling checkout is required.
- Use `npm test` so package tests receive npm's executable path.
- Exercise product operations only against temporary homes and target directories; never use this source checkout as the product's repair or policy target.
