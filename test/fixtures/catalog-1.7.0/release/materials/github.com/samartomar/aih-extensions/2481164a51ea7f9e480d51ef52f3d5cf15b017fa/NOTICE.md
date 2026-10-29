# Notice

This add-on redistributes material from two MIT-licensed projects. Their license texts are in [`licenses/`](licenses/), and the exact upstream commits are pinned in [`vendor.lock.json`](vendor.lock.json).

| Upstream | Copyright | Commit | Vendored into |
|---|---|---|---|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | (c) 2025 Addy Osmani | `2686b62` | 16 skills under `skills/`, `agents/`, `commands/ship.md`, `commands/webperf.md`, `references/` |
| [mattpocock/skills](https://github.com/mattpocock/skills) | (c) 2026 Matt Pocock | `c55ee46` | `skills/setup-pre-commit/` (from his `misc/` bucket, which his plugin does not ship) |

Vendored files are modified: every change is an exact patch listed in `scripts/upstream.config.mjs`, applied by `scripts/vendor.mjs`. `skills/ask-sam/` and `skills/install-commit-gate/` are original to this repo.
