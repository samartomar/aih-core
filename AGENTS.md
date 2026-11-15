# AIH-Core

Source repository: `samartomar/aih-core`. Package: `@aihq/core`.
Generic engine source lives in `src/core/`; bundled repair/support definitions
and helpers live in `src/harness/`. Portable Harness metadata is exposed through
`@aihq/core/harness`; Node helpers use `@aihq/core/harness/runtime`. Both modules
share this repository's single package version. Resolve the Git root, branch and push URL before
committing. Keep shared/private engineering plans outside this repository.

Read the [README](README.md) for implemented contracts, development setup and
checks. Preserve the generic engine boundary: vendor/tool-specific definitions
and helpers belong in Harness or supplied content. Portable contracts must work
without Node host effects. Treat schemas and public API behavior as contracts.

Published Harness changes require a new Core distribution version. Identify
unpublished local builds by source commit and artifact digest. Preserve the actual
installed package identity and selected helper/input byte binding.
Build only the root package; no nested package or sibling checkout is required.

For maintainer assignments, keep the coordinating session in its supplied
workspace and target this Git root explicitly for commands and edits. Load these
product rules from that session; command working directories do not create a
separate workflow. Public contributors can use this repository independently.

Run focused checks for the change and the applicable package checks before
handoff. Use `npm test` so package tests receive npm's executable path. Exercise
product operations only against temporary homes and target directories; never
use this source checkout as the product's repair or policy target.

Start code discovery in source and tests at this Git root. When navigation
helpers are available, select this explicit root and verify their freshness;
an unavailable or stale index does not block source search. Generated indexes
stay ignored. A parent graph does not establish this repository's coverage.

## Issue and delivery routing

Use the fully qualified delivery issue supplied with the task. Verify the current
repository visibility and intake route before use. Existing pre-release work
retains its supplied delivery issue. After public intake activation, accepted Core
and Harness bugs/enhancements use the Core tracker, including internally
discovered work. Reuse existing reports.

At pickup identify the owning issue, actual source/worktree, affected module and
release unit. Link the PR and actual package/version evidence to the owning issue
under existing authorization. A merged change is not a published package; keep
required publication pending or name its follow-up owner. Confidential details and
private coordination links stay outside public text. Private maintainer handoffs
carry any additional internal instructions explicitly.

## Workflow references

Use the managed Matt Pocock skills and Extensions within this repository's rules.
Keep upstream skills in their managed installation, unchanged by repository cleanup.

- [Issue routing](docs/agents/issue-tracker.md): owning delivery issue and intake.
- [Triage](docs/agents/triage-labels.md): existing label roles and mappings.
- [Domain documentation](docs/agents/domain.md): vocabulary and decision homes.
