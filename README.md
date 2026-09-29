# @aihq/core

Core exposes one headless execution path to CLIs and application hosts. An author supplies data, the host prepares a review, and the caller explicitly authorizes those effects before application.

**Unreleased development slice:** this candidate implements policy-free inspection of existing tools and Vibe policies containing inline `file.write` recipes for project files. File delivery creates absent files, recognizes matching files without adopting them, and blocks conflicting content. Repair execution, Enterprise authority, referenced materials, other operations, replacement/adoption and lifecycle reconciliation arrive in subsequent delivery slices. Unsupported requests are rejected; this artifact is not the completed product release. The included schemas describe this slice of the approved first-release formats and are not yet a published compatibility promise.

The Node host requires **Node >=24.6.0 <25**. The contracts entry has no Node filesystem, process, network or installation effects. It can be bundled for a browser; host operations require a Node host with the relevant filesystem permissions.

## Public imports

| Import | Exports |
| --- | --- |
| `@aihq/core` | `inspect`, `prepare`, `apply`, public request/review/result types |
| `@aihq/core/contracts` | `parsePolicy`, `validatePolicy`, `validateRecipe`, `contractSupport`, document/diagnostic types |
| `@aihq/core/schemas/execution-policy/1.0.0.json` | Execution-policy JSON Schema |
| `@aihq/core/schemas/recipe/1.0.0.json` | Recipe JSON Schema |
| `@aihq/core/schemas/prepared-work/1.0.0.json` | Serializable review JSON Schema |
| `@aihq/core/schemas/run-result/1.0.0.json` | Run-result JSON Schema |

Read `contractSupport` for the actual package version, accepted/produced format IDs and runtime requirements. Schema versions and npm versions are independent. An unsupported ID yields `SCHEMA_UNSUPPORTED` with the encountered and supported IDs. Read the owning release's changelog before upgrading. Do not infer compatibility from a tuple of package version numbers.

JSON Schema establishes structure. The portable validators also check strict JSON data, unique IDs, dependency cycles, input definitions and bindings. These checks do not grant organization authority or permission to execute.

## Inspect existing tools

Inspection reads the installed `@aihq/harness` definitions and reports their actual resolved package version. It requires no policy, Catalog or Scan. It observes detected tools by default, runs only their declared bounded diagnostics, and makes no repair or history changes.

```sh
aih inspect --json
aih inspect --target node --target npm --offline --json
aih inspect --target claude --probe-configured-mcp --project /absolute/project --json
```

The API exposes the same result:

```js
import { inspect } from '@aihq/core';

const result = await inspect({ targets: ['node', 'npm'], network: 'off' });
```

`network` defaults to `declared`; `off` retains local observations and marks network checks as skipped. Configured MCP endpoint probes require a separate opt-in, and offline mode suppresses them too. Results distinguish a requested missing executable, an unselected absent tool, a failed performed check and an unavailable or skipped check. `effectiveOptions` records each default or explicit choice. `repairChoices` currently provides manual guidance; selectable repair recipes arrive in later slices. A result does not authorize installation or repair.

## One complete authoring example

Save this as `policy.json`:

```json
{
  "schema": "urn:aihq:core:execution-policy:1.0.0",
  "mode": "vibe",
  "selections": [{
    "id": "guidance", "managementId": "team-guidance", "scope": "project",
    "configuration": {"text": "Read the project's contribution guide.\n"},
    "requires": [],
    "recipe": {"inline": {
      "schema": "urn:aihq:core:recipe:1.0.0", "id": "guidance-file",
      "description": "Deliver project guidance",
      "inputs": {"text": {"type": "string", "required": true, "maxLength": 65536}},
      "materials": [], "targets": ["project"], "prerequisites": [],
      "operations": [{
        "id": "write", "purpose": "Write shared project guidance", "kind": "file.write",
        "scope": "project", "target": {"root": "project", "segments": [{"literal": "TEAM.md"}]},
        "content": {"input": "text"}, "requires": [], "checks": []
      }],
      "checks": []
    }}
  }]
}
```

Preview and then deliberately apply through the CLI:

```sh
aih policy policy.json --project /absolute/project --json
aih policy policy.json --project /absolute/project --apply
# Explicit automation authorization for this invocation:
aih policy policy.json --project /absolute/project --apply --yes --json
```

Each invocation prepares again. `--yes` requires `--apply`. Interactive review goes to stderr; `--json` emits one structured result on stdout. Noninteractive application without `--yes` rejects. Exit codes are 0 for successful preview/complete application, 1 for blocked or incomplete work, 2 for invalid/rejected requests, and 130 for cancellation. No write without a supplied check is reported as verified.

A UI-owned backend can use the same policy and engine:

```js
import { parsePolicy } from '@aihq/core/contracts';
import { prepare, apply } from '@aihq/core';

const parsed = parsePolicy(policyText);
if (!parsed.valid) throw new Error(JSON.stringify(parsed.diagnostics));
const preparation = await prepare({
  useCase: 'policy', policy: parsed.document,
  target: { project: absoluteProjectPath }
});
// Show preparation.review and obtain the user's explicit approval in your UI.
// Retain preparation.prepared on this host; do not send it as executable JSON.
if (preparation.status === 'ready' && userExplicitlyApproved) {
  const result = await apply(preparation.prepared, {
    approved: true, origin: 'interactive',
    reviewDigest: preparation.review.reviewDigest
  });
  display(result);
}
```

The handle belongs to the running module instance and is consumed on application. Restarting the host or losing the handle requires preparation and approval again. Saved policies/reviews/results remain readable JSON. A digest alone does not establish custody or consent. Editing a caller-owned policy or private input after preparation invalidates the work. Editing review JSON cannot alter the engine's frozen review or executable state.

## Inputs and outcomes

Inputs are scalar strings, booleans, finite numbers or safe integers with optional bounds/defaults/enums. There is no coercion or recursive interpolation. Unknown configuration names reject. A string slot is exactly `{ "literal": "text" }` or `{ "input": "declaredName" }`.

Sensitive inputs declare `sensitive: true`, omit the portable value/default, and arrive through `prepare` controls: `{ privateInputs: { selectionId: { inputName: value } } }`. The CLI maps an existing environment value with `--private-input selection.input=ENV_NAME`. They are redacted in reviews and omitted from routine history. Keep returned handles private to your host; authenticating your UI's requests is your application's responsibility.

Reported operation and input IDs use `selectionId/localId`; `/` cannot occur in an authored ID. For CLI private-input mappings, percent-encode a dot inside either component as `%2E`, preserving the one literal separator dot: `team%2Eguidance.text%2Econtent=ENV_NAME`.

`apply` requires `approved: true`, `origin` and the review's `reviewDigest`. `allowPartial` defaults to false and its default/explicit origin is recorded. This slice blocks a conflicting file request entirely; it does not use that flag to bypass conflicts. Cancellation is supplied as `controls.signal` or SIGINT. Results distinguish `applied`, `already-satisfied`, `failed`, and `not-attempted`; verification is independently `unverified` when no check was supplied.

Target paths are explicitly scoped and reject traversal, links, unsafe host filenames and Core's reserved state paths. Existing matching unowned bytes remain unowned. This is guarded local file handling, not a sandbox against arbitrary concurrently privileged software.

## State and recovery

Core uses the current account's `~/.aih/core` for protected ownership records, recovery manifests and redacted run history. Required state protection or persistence failure prevents/marks incomplete the affected mutation. A history-write failure is returned as `record.status: failed` separately from target outcomes. Set `controls.logging: 'off'` to suppress routine history; required ownership and recovery records remain.

New project files use reviewed mode 0600 and newly needed parent directories use 0700 on POSIX; Windows files inherit the selected project directory's ACL. Core's private state has restricted ownership/ACLs. A recovery manifest describes observed/intended bytes for manual inspection; it is never a resumable plan. There is no automatic history expiry or cleanup.

Strict document admission limits each document to 1,000,000 UTF-8 bytes and depth 32. Duplicate decoded keys, non-NFC/malformed strings, nonfinite/negative-zero/unsafe integer values, number tokens that lose their value, accessors, cycles and non-data objects reject. Canonical JSON uses UTF-16 key ordering, authored array order, UTF-8 and no whitespace. This restricted profile is not unrestricted RFC 8785.

## Development checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Tests exercise public boundaries with temporary homes and target directories. The package test installs local Core and Harness tarballs into an isolated consumer, imports public schemas and APIs, runs the installed CLI, and bundles/runs the portable contracts in an environment without Node globals. Never target a source checkout with the product CLI during development. Build/pack needs no donor checkout, Catalog, Scan, vendor engine or private engineering files.
