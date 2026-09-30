# AIH-Harness

Source repository: `samartomar/aih-harness`. Package: `@aihq/harness`.
This is repair/support content, distinct from the legacy `ai-harness` engine.
Resolve this repository's Git root, branch and push URL before committing.
Keep shared/private engineering plans outside this repository.

Read the [README](README.md) for exports, runtime requirements and checks.
Harness supplies definitions and bounded helpers; Core owns preparation,
authorization, execution and caller-facing results. Keep portable contracts free
of Node host effects and runtime imports from Core or the legacy engine.

Test helpers with temporary fixtures. Run `node --test test/*.test.mjs` on a
supported Node runtime. Changes to shared exports also need the consumer checks
documented in Core's README. Never apply repairs to the source checkout.

Start code discovery at this Git root. Pass its absolute path to
code-review-graph, refresh after source/ref changes, and verify findings in source
and tests. For codebase-memory-mcp, select the project returned for this root by
`list_projects`; for Serena, read its initial instructions and activate this root.
Generated indexes stay ignored. A parent graph does not establish this repo's
coverage or freshness.
