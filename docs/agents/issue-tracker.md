# Issue tracker

Use the fully qualified delivery issue supplied with the task. Preserve the existing intake transition in AGENTS.md; source visibility alone does not activate a new intake route. Verify the current tracker before creating a new issue.

Public-safe Core product issues live in GitHub Issues on `samartomar/aih-core`. Use the `gh` CLI with an explicit `--repo samartomar/aih-core`. A supplied delivery issue on that tracker, with its specification parent and sub-issues, is the delivery record for its work.

Resolve fully qualified issue references before pickup. Reuse an existing issue for the same outcome. Before a tracker write, verify the selected repository identity, intended visibility, issues-enabled state and archival status.

Use `gh issue view <number> --repo <owner/repository> --comments` to read a ticket. For multiline issue or comment content, use a body file. Read-only inspection and local changes grant no authority for tracker writes, pushes, pull requests, merges or publication; carry explicit authorization within its scope.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When a skill says to publish to the tracker, use the route above and verify authorization. When it says to fetch a ticket, read the fully qualified issue and its acceptance links.
