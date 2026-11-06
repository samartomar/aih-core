# @aihq/core

Core exposes one headless execution path to CLIs and application hosts. A caller supplies a request, Core prepares a
frozen review, and the caller explicitly approves those effects before Apply. Core carries out Catalog plans, your own
changes, environment repairs (CA trust, certificate export, the macOS session) and native client checks, keeps a
receipt for everything it writes, and removes or updates it later from the receipt.

**Unreleased development slice (0.1.0 target).** Every request, result and stored record is a `0.1.0` format; there is
one version of each format and no reader for earlier development formats. Anything a development build installed is not
read by this Core: remove it with that build, or by hand, before upgrading.

The Node host requires **Node >=26.12.1 <27**. The contracts and Harness metadata entries have no Node filesystem,
process, network or installation effects. They can be bundled for a browser; host operations require a Node host with
the relevant filesystem permissions.

Installed tools are tried first; versions are hints, not gates. The user-tool trust checks were tested on Python 3.15.2,
pip 26.2.2, Conda 26.9.4, Git 2.56.0 (Windows 2.56.0.windows.4) and Rust 1.99.1; each observation reports these as
`testedWith`. Another installed version is observed and used as it is, and no second copy is ever installed. When a
selected tool really fails on a version other than the tested one, the result carries `hint: { testedWith, observed }`;
the hint never changes the decision.

## Public imports

The package publishes exactly four entries. Each lists its exports explicitly; nothing else in the package can be
imported by a package specifier.

| Import | Runtime | Exports |
| --- | --- | --- |
| `@aihq/core` | Node | `prepare`, `apply`, `list`, `prepareRemoval`, `prepareUpdate`, `checkFiles`, `inspect`, `verifyClient`, `verifyMacosSession`, `writeSupportReport`, `resolveStateLocation`, and the types of their requests, controls and results |
| `@aihq/core/contracts` | portable | `schemas` (one per format, each with one valid and one invalid fixture), `validateFormat`, `refusalCodes`, `limits`, `validateChange`, `deriveChangeIdentity`, `validateOrganizationPolicy`, `previewAdmission`, `runMemberClaims`, `removalClaims`, `stateLocation`, `contractSupport`, `checkContracts`, `getGuidance`, `renderSupportMarkdown`, report snapshots (`createReport`, `validateSnapshot`, `importSnapshot`, `exportSnapshot`) and claim sets (`validateClaimSet`, `readClaimSet`, `projectClaims`) |
| `@aihq/core/harness` | portable data | `toolRegistry`, `listTools`, `selectTool`, `validateToolRegistry`, `targets`, `repairIndex`, trust metadata (`trustCapabilities`, `trustLimits`, `trustPlatformMatrix`, `consumerProfiles`, `exportDefaultNames`), `macosSessionProfiles`, `signerRecords`, and the native verification definitions (`nativeClientDefinitions`, `validateNativeVerificationDefinition`, `validateNativeTestIdentity`) |
| `@aihq/core/harness/runtime` | Node | `diagnose`, `inspectToolHost`, `detectProjectFacts`, `readGitHubPolicy`, `readLocalPolicy`, trust-source discovery (`discoverTrustSources`, `parseTrustOutput`, `serializeTrustSet`, `reviewTrustDelta`, `hashTrustSourceSet`) and `inspectUserToolTrust` |

Bins: `aih`, and `aih-linux-facility`, the fixed Linux x64 process observer native client verification launches
clients under (an observer, not a sandbox).

No function throws on bad input, a refused step or a broken machine. Every result has a `status`: `ok`; `refused` with
`code` and `reason`; `invalid` with `problems`; or `unsupported-version` with `encountered` and `supported`. Prepare's
status can also be `ready`, `partial` or `blocked`; an Apply run carries `completion` (`complete`, `incomplete`,
`cancelled` or `rejected`). Every refusal code is listed once in `refusalCodes`.

## Formats

Each format has one version, `urn:aihq:core:<name>:0.1.0`, named in the document's `schema` field. `schemas` in
`@aihq/core/contracts` holds exactly these, each with its JSON Schema and one valid and one invalid fixture;
`validateFormat` reads any of them.

| Format | What it is |
| --- | --- |
| `plan-request` | A Catalog plan plus what Core needs to carry it out |
| `change`, `change-request` | A hand-written change, and one or more changes with their input values and groups |
| `repair-request`, `repair-inputs`, `export-request`, `export-inputs` | One repair, the certificate export, and their CLI input files |
| `macos-session-request`, `macos-session-inputs`, `macos-session-verification-request`, `macos-session-verification-result`, `macos-session-profiles` | The macOS session, its verification and its admitted profiles |
| `organization` | An organization document (Enterprise admission) |
| `review`, `run` | A frozen review, and Apply's result; repairs, exports and the macOS session use them too |
| `inventory` | What `list` returns |
| `receipt` | Ownership records inside Core's state |
| `trust-custody`, `macos-session-custody` | Environment ownership inside Core's state |
| `file-check` | The read-only file comparison |
| `inspection` | What `inspect` and `inspectToolHost` return |
| `native-verification-request`, `-result`, `-bundle`, `-definition`, `native-test-identity` | Native client checks |
| `repair`, `trust-capabilities` | Harness repair definitions, and what each repair can do on each platform |
| `tool-registry`, `signer-records` | The tool registry and the default allowed Scan signers |
| `report`, `claims` | Diagnostic snapshots and claim sets |
| `package-support` | Core's own format declarations (`contractSupport`) |

`contractSupport` (`urn:aihq:core:package-support:0.1.0`) names each format once with its role (`accepts`, `produces`
or `both`) and addresses its schema and fixtures in `schemas` as `@aihq/core/contracts#schemas/<id>/schema`,
`…/fixtures/valid` and `…/fixtures/invalid`. `checkContracts` runs supplied readers against such declarations without
host effects. Core no longer reads other packages' declarations; Catalog's own schemas state its formats.

Harness repair definitions are published with their 0.1.0 identities: each `repairIndex` entry is
`urn:aihq:core:repair:0.1.0`, and every repair is named by its repair id (`node-npm-ca`, `node-os-trust`,
`user-tools-ca`, `jvm-ca`), which is also the management id a review, run and `list` show. `trustCapabilities` is
`urn:aihq:core:trust-capabilities:0.1.0`. The admitted trust definitions and their evidence-bound helper bytes are
unchanged underneath this view.

## Commands

```
aih install <plan-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--artifacts <dir>] [--apply [--yes] [--allow-partial]] [--json]
aih change <change-request.json> [--project <path>] [--material-root <id>=<folder>]... [--apply [--yes] [--allow-partial]] [--json]
aih list [--project <path>] [--scope project|user|both] [--json]
aih remove <managementId>... --scope project|user [--project <path>] [--item <item-id>] [--origin chosen] [--cli <id>]... [--apply [--yes] [--allow-partial]] [--json]
aih update <plan-request.json | change-request.json> --scope project|user [--project <path>] [--management-id <id>]... [--source <sourceId>=<folder>]... [--apply [--yes] [--allow-partial]] [--json]
aih repair <repair-id> --target <id>... [--inputs-file <json>] [--offline] [--apply [--yes]] [--json]
aih export-ca [--format pem|pkcs7-der] [--output <path>] [--apply [--yes]] [--json]
aih inspect [--target <id>] [--offline] [--profiles <folder>] [--json]
aih check-files <plan-request.json | change-request.json> [--project <path>] [--source <sourceId>=<folder>]... [--json]
aih verify-client <tool> [--json]
aih report --output <new-directory> [--json]
aih validate <change|change-request|organization|plan-request> <file> [--json]
     Enterprise options: --mode enterprise --org-repository <owner/repo> --org-path <path> --org-ref <ref> | --org-file <path>
     Common: --no-log, --resolutions <file>, --private-input <name>=<ENV>
```

`--project` is required for project scope, and for a user-scope claim made on behalf of a project; the CLI never takes
the project from the working folder. Exit codes: 0 ready or complete; 1 partial, blocked or incomplete; 2 refused,
invalid, unsupported or rejected; 130 cancelled. `aih --version` prints the installed package version and `aih help`
the usage.

## Ask AIH Guide: setup and recovery

The canonical [Ask AIH Guide (`aih-guide`)](https://github.com/samartomar/aih-extensions/blob/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/guide/MANUAL.md)
is a self-contained manual for missing/broken AI CLIs, ignored instructions,
settings and MCP/graph loading failures. [Save the raw Markdown](https://raw.githubusercontent.com/samartomar/aih-extensions/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/guide/MANUAL.md)
before trouble; read it by hand or paste the entire saved manual into any working
agent when Core, native guide loading, MCP or network access is unavailable.
Opening a link alone does not create an offline copy.

Extensions owns the guide source and native entries. This pointer selects source
artifact **0.5.0**, integrated at `0a0ff98`; its [manifest](https://github.com/samartomar/aih-extensions/blob/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/guide/manifest.json)
records source-input commit `5a233343ec63a436dd9a94fcf45613b3fe280c7d`, source-set
SHA-256 and exact file hashes. Those hashes identify bytes, not publisher
authenticity. Source integration is not registry/marketplace publication;
optional Catalog-managed distribution is a separate channel, not a completed
rollout or a prerequisite for reading the manual.

After direct Extensions installation, the manual describes native selection
where the installed client supports it: `kimi --agent aih-guide` in a new session,
`claude --agent aih-guide` (or the supported plugin route), and
`opencode --agent aih-guide`. Codex and Cursor use the saved-manual fallback.
Check installed client help and actual loading; selection syntax alone proves
neither a working conversation nor recovery. The dated [delivery evidence](https://github.com/samartomar/aih-extensions/blob/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/docs/guide-evidence.md)
covers bounded Windows Kimi 2.1.1 conversations and a saved-manual controlled
fixture. Claude conversation remains unverified; OpenCode has primary-agent
parsing evidence only, with full installed-plugin startup timing out. No native
guide sessions on macOS/Linux/WSL or real-user MCP recovery are established.

Before choosing a Core/Harness operation, identify the trusted installed package
and consult its version, help and public contracts; source availability does not
establish installed capability. Preserve the existing Prepare/review/Apply flow
and the actual user's authority. When no applicable installed operation exists,
the guide describes the smallest authorized manual edit to developer-owned
configuration, preserving unrelated content and a recoverable copy. Managed
policy, enterprise credential provisioning and system trust controls belong to
IT/admin; the guide grants no authority to bypass them.

Retry the original failure and relevant client-native checks. Use an existing
installed verifier only when its target, identity, prerequisites, launch authority,
time budget and cleanup contract match. A successful write, Apply result or
fixture does not establish native loading or admission; unavailable checks remain
unverified. For session-sensitive MCP/graph recovery, verify discovery and a known
read-only query in fresh intended sessions without reapplying setup.

## AI tool registry

`toolRegistry` from `@aihq/core/harness` (`urn:aihq:core:tool-registry:0.1.0`) lists every AI tool Core knows: 15
tools, each `{ id, label, surface, binaries, aliases }` with `surface` `"cli"` or `"ide"`. It is portable, frozen data
with no host effects. Registry ids match Catalog's tool profile ids.

| Id (surface) | Aliases | Notes |
|---|---|---|
| `claude-code` (cli) | `claude` | The old id is accepted for selection only |
| `codex`, `kiro`, `copilot`, `antigravity`, `gemini`, `opencode`, `kimi` (cli) | — | Antigravity's CLI (`agy`) is not Gemini CLI |
| `cursor` (cli) | — | The Cursor CLI (`cursor-agent`) |
| `dsh` (cli) | — | DeepSeek Harness |
| `cursor-ide`, `windsurf`, `zed`, `kiro-ide`, `copilot-vscode` (ide) | — | An IDE is never mapped to a CLI profile |

Aliases never appear in plans, receipts or organization documents: a plan whose profile or step names `claude` is
refused `tool-unknown`. What can be selected comes from the registry alone, not from observations.

```js
import { listTools, selectTool, validateToolRegistry } from '@aihq/core/harness';

listTools();                   // { status: 'ok', tools: [...all 15, in registry order] }
listTools({ surface: 'ide' }); // { status: 'ok', tools: [cursor-ide, windsurf, zed, kiro-ide, copilot-vscode] }
selectTool('claude');          // { status: 'ok', tool: { id: 'claude-code', ... }, via: 'alias' }
selectTool('unknown');         // { status: 'refused', code: 'tool-unknown', reason: '...' }
validateToolRegistry(doc);     // { status: 'ok' } | { status: 'invalid', problems } | { status: 'unsupported-version', ... }
```

Being listed does not mean a tool is installed, configured or verified.

## Inspect, compare files and report

**Inspect.** `inspect({ target?, offline?, profiles? }, { signal?, budgetMs? })` returns
`urn:aihq:core:inspection:0.1.0` (`subject: "machine"`, `status: "ok"`, `observation` `complete`, `incomplete` or
`cancelled`), with the retained tools, observations, checks and repair choices. `target` names inspection targets or
registry tools (ids or aliases). `profiles` are Catalog tool profile documents; Core reads only `id`, `version` and
`checkedWith`. For each inspected CLI, `versions` compares the version its own version command printed with the
`checkedWith` entry for that command (matched by the binary that answered first, then the tool's binaries, then its
id, aliases and `<binary>-cli`, so Cursor's `cursor-agent` entry is the CLI's, not the IDE's); an older CLI gives a `cli-older-than-profile` warning and is never blocked or
refused. A CLI without a profile says "Version not compared" (`reason: no-profile`). A malformed profile, or one naming
an alias or an unknown tool, is `invalid` with exact problems. A request with the retained fields (`targets`,
`network`, `probeConfiguredMcp`, `configuration`) keeps the retained result until it retires.

```sh
aih inspect --target codex --offline --profiles ./profiles --json   # exit 0; 130 if cancelled; 2 refused or invalid
```

**Host and project facts.** `inspectToolHost` returns `inspection:0.1.0` with `subject: "tool-host"` and the
registry id; an unknown tool is `refused` `tool-unknown`, a tool without an observed layout `refused`
`tool-not-observed`, and bad input `invalid` with `problems`. `detectProjectFacts` adds `problems` to an `invalid`
answer. `resolveStateLocation()` returns `{ status: 'ok', root, markers }`, or `refused` `home-unavailable`; it never
throws and creates nothing.

**Compare files.** `checkFiles(request, { signal?, catalog?, privateInputs?, materialRoots?, budgetMs? })` compares what
a plan request or change request would write with the disk and returns `urn:aihq:core:file-check:0.1.0`. It has no
effects: no state, history, receipts, network or processes. A plan's write steps are compared with their checked bytes
(supplied, or rendered by the caller's Catalog); program and acquisition steps are listed in `notChecked`. `observation`
is `complete` only when every planned file was compared and nothing was left unchecked; `fileState` is `match` only
then, `changed` when any compared file differs or is absent, and `unverified` otherwise. At most 4,096 targets.

```sh
aih check-files plan-request.json --project ./app --source my-skills=./skills --json   # 0 complete match; 1 otherwise
```

**Reports and claims.** `@aihq/core/contracts` holds `createReport`, `validateSnapshot`, `importSnapshot`,
`exportSnapshot` (`urn:aihq:core:report:0.1.0`, which includes the diagnostic data it reads) and `validateClaimSet`,
`readClaimSet`, `projectClaims` (`urn:aihq:core:claims:0.1.0`), with `getGuidance` and `renderSupportMarkdown`. Each
returns `ok`, `invalid` with problems, or `unsupported-version`, and never throws for bad input. Redaction, bounds,
duplicate-key refusal and the claim predicates are the retained ones: a claim is never inferred from the steps that
succeeded.


## Inspect a tool host

`inspectToolHost({ tool, project, items }, controls?)` from
`@aihq/core/harness/runtime` extends [inspection](#inspect-existing-tools) to one
observed tool and a set of items on this computer. It observes with bounded
reads and **runs nothing**: no tool, hook, MCP server or item content is started,
not even for `--version`. It never writes, removes or edits anything it finds.

```js
import { inspectToolHost } from '@aihq/core/harness/runtime';

const result = await inspectToolHost({
  tool: 'claude',                      // a registry id or alias with an observed binding
  project: '/absolute/project/folder', // an existing folder
  items: [
    { framework: 'example', itemId: 'review', kind: 'skill', key: 'review' },
    { framework: 'example', itemId: 'github', kind: 'mcp-server', key: 'github',
      executables: ['npx'], inputs: ['GITHUB_TOKEN'], requires: [{ framework: 'example', itemId: 'base' }] }
  ]
}, { budgetMs: 10000 });
```

Each item names its Catalog `framework` and `itemId`, a binding `kind`, and
optionally the `key` the tool sees (a skill folder, an agent, command, rule or
document file name, or an MCP server key), the `executables` it needs on `PATH`
(for example a hook's interpreter), its input names (never values) and the
items it `requires`, as resolved by Catalog. The consumer derives these from the
items it already holds. A complete result reports:

- `installedVersion`: `{ state: 'known', version, source }`, read only from files
  beside the tool's executable on `PATH` (the npm package whose `bin` names it,
  through a link or as the one such package beside an npm command shim, or a
  `versions/<version>` file), or `{ state: 'unknown', reason }`.
- per item, each executable as `present`, `absent` or `unknown`. `absent` means
  every `PATH` folder was read and none holds a regular executable file of that
  name; an unset `PATH`, a relative `PATH` entry or an unreadable folder gives
  `unknown`. `absent` is about `PATH` only: on Windows, a shell or
  `CreateProcess` may also search the current or system folders.
- per item, same-key `copies` at `user` level, in `parentFolders` and in
  `plugins`, each `found` (with `paths`), `none` or `unavailable` (with a
  reason). Copies are read only where the tool's binding
  says the tool reads that kind: `roots.user` for the user level (following
  `CODEX_HOME` for Codex; another redirect named in `resolvedBy` that is set
  makes it `unavailable`), and, only where the binding's `alsoReads` records
  reading every folder above the project (today Copilot CLI skills), the project
  root repeated in each of those folders, up to but not including the user home.
  A registration file is read for the item's key in its container (JSON and
  JSONC; other formats and malformed files are `unavailable`). A hook has no key,
  and no binding observes a plugin location yet, so those are `unavailable`.
- per item, the `inputs` still required: input values never reach inspection, so
  every declared input is still required.
- `stale` per item and overall: `true` when the installed version differs from
  every proving observation, or every proving observation on this host platform
  when it has any (`observedVersion` is the newest historical proving version).
  `false` requires an exact proving observation on this OS and architecture,
  and otherwise `'unchecked'`: the installed version is unknown, nothing
  proves the cell, or no proving observation was made on this platform.
- `hostBlockers[]`: `executable-missing` (an `absent` executable),
  `input-required` (each declared input) and `dependency-missing` (a required
  item not among the inspected items).
- `warnings[]`: `same-key-elsewhere` with `where` (`user`, `parent-folder` or
  `plugin`) and the found `path`, and `also-reads` for each of the binding's
  `alsoReads` entries.
- `unchecked[]`: an explicit note, with its reason, for every fact that is
  `unknown` or `unavailable`.

**Unknown never becomes a claim.** An `unknown` executable is never
`executable-missing`, an `unavailable` copy is never `same-key-elsewhere`, and an
unknown version or an unproven cell is never `stale: false`. These are host observations of this
computer only: they do not verify that the tool loads or uses an item, and they
do not satisfy native verification. Platform-scoped support stays the binding's
static answer.

A request outside this shape is `invalid` (`INPUT_INVALID` with the field), an
unknown tool is `refused` with `unknown-tool` and an unobserved tool with
`tool-not-observed`. `controls` take `signal` and `budgetMs` (1 to 60000, default
10000). Reads run synchronously and are bounded by that budget and a fixed read
count in `limits`; past either, the result is `incomplete` and the remaining
facts are unchecked. A signal already aborted gives `cancelled` with no facts.

## Project basics per repository

`detectProjectFacts({ project }, controls?)` from `@aihq/core/harness/runtime` reads a project with
bounded reads and **runs nothing** — no tool, script or package manager is executed, not even for a
version. It reads only a fixed candidate list (`package.json`, the common lockfiles, `.nvmrc`,
`.node-version`), capped per file and per read count, and reports
`facts: { field, value, confidence: 'detected' | 'inferred' }[]` for the stack, the package manager,
the Node version and the test, build and lint commands. A fact is `detected` only from a file the
diagnostic read (a manifest, a lockfile, a script, a version file); the only inferred fact is the
npm default for a manifest with no stronger package-manager signal, and the confidence says so.
A fact it cannot establish is omitted, never fabricated. The result envelope mirrors the other
bounded diagnostics: `complete`, `incomplete`, `invalid` or `cancelled`, with `limits` accounting
and one diagnostic per read failure. The consumer reviews the facts; rendering carries them into
the Project basics selections.

The consumer reviews the facts before using them; they never add operations, inputs or authority.

A rule item with `placement: 'entry-block'` renders one shared guidance block into **each** of the
binding's `entryFiles`, between `<!-- BEGIN aih:shared -->` and `<!-- END aih:shared -->`; a
binding that declares `entryPointer { file, template }` also gets one pointer block in that file,
`<!-- BEGIN aih:shared:pointer -->` … `<!-- END aih:shared:pointer -->`, whose text is the
template with `{projectFolder}` replaced by the reviewed folder name (default `ai-coding`, carried
as a required recipe input). Text outside the blocks is kept byte for byte. Custody records these
as typed `entry-block { file, marker, sha256 }` and `entry-pointer { file, marker, sha256 }`
members (inventory member kinds of the same names), reporting `block-changed` and `block-missing`
like any marker block.

On update, a person's own lines found **added inside** the shared block move to the user-owned
`<projectFolder>/PROJECT.md` — the write is part of the reviewed update, so the preview shows the
move, and the block itself updates instead of conflicting. The notes file is written but never
claimed: removal never touches it and later edits are never conflicts. Edits that delete or change
Core's own lines stay ordinary conflicts, never rescued.

Removal takes only the blocks, with one exception for files Core created:

- **Core created the entry file** (its custody records `createdFile` for that target) and, once
  every AIH block in it is removed, nothing is left but the line endings Core wrote: removal
  deletes the file, so the project returns to its earlier tree. The review lists that step as a
  file removal (`remove-file`), its recovery data keeps the file's bytes like any other removed
  file, and removing an interrupted install follows the same rule.
- **Otherwise** (the file was there before, even empty, or the person wrote anything outside the
  blocks): the entry file and everything outside the blocks stay byte for byte.

Any `preExisting` value a replaced configuration entry had is restored as before. Project-folder items go into the folder the consumer named (default `ai-coding`).

## Explicit native client verification

`verifyClient(request, controls?)` and `aih verify-client` are separate
from ordinary inspection. Inspection retains its presence/version and optional
TLS checks without launching configured MCP commands, servers or client sessions.
Native verification uses explicit input, a disposable cell and bounded evidence.

```js
import { verifyClient } from '@aihq/core';
const result = await verifyClient({
  schema: 'urn:aihq:core:native-verification-request:0.1.0',
  client: 'claude-code',
  maxTurns: selectedTotalTurns,
  maxEstimatedCostUsd: selectedTotalEstimatedUsd
});
```

```sh
aih verify-client claude-code --json
aih verify-client claude-code --candidate-smoke --host-bindings dedicated-test.json --json
```

A request names its tool by tool registry id; the CLI also takes an alias, so
`aih verify-client claude` checks `claude-code`. The result is
`urn:aihq:core:native-verification-result:0.1.0`:

| `status` | Meaning |
| --- | --- |
| `ok` | The check ran. `completion` is `complete`, `incomplete` or `cancelled`, and `verdict` is `verified`, `failed` or `unverified` |
| `refused` | Nothing was looked for or launched. `code` is `tool-unknown` (no registry tool with that id), `client-unsupported` (no definition for the tool), `platform-unsupported` (no definition for this host cell) or `cell-not-admitted` (a candidate cell without `--candidate-smoke`) |
| `invalid` | The request or controls; `diagnostics` name the field |

The rest of the result keeps the retained fields: stages, sessions, proof scope,
admission, security, cleanup and limits. Each format has one 0.1.0 schema in
`/contracts` `schemas`: `native-verification-request`, `-result`, `-bundle` (a
supplied configuration names its tool by registry id), `-definition` and
`native-test-identity` (a dedicated test identity names `claude-code`). The
bundled definitions are published as `nativeClientDefinitions` from
`@aihq/core/harness`. They are the retained definitions with only `schema` and
`client` renamed; definition ids, admission and `evidenceSha256` are unchanged.
The `aih-linux-facility` bin is the fixed Linux x64 process observer the admitted
Linux cell launches the client under: an observer, not a sandbox. A 0.1.0
request reads only a 0.1.0 bundle.

Still pending live observation, and not claimed by any result: an unattended
`plugins.remove` for Claude Code, Codex and Copilot, and whether the Cursor CLI
loads a junctioned skill folder on Windows (Core copies for Cursor until then).
Controlled test fixtures exercise the verification mechanism only; they are not
native loading evidence.

The bundled `claude-linux-x64-wsl2-srt-2.1.285` definition is admitted for
Claude Code 2.1.285 on Linux x64 WSL2, osRelease
`6.18.33.2-microsoft-standard-WSL2`, and selects without `--candidate-smoke`.
Its retained reviewed batch evidence is identified by `evidenceSha256`
`a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947`.
The tested packed artifact was Core `1.0.0-dev.27`; Core `1.0.0-dev.28` promotes
the descriptor. Promotion is not publication: no npm publish has occurred.
Coverage is the bundled mechanism only, not Catalog's cross-client matrix.
Acceptance covers the fixed verifier environment: auto-memory disabled,
marketplace auto-install disabled, fast mode disabled, and MCP connections
awaited before init within the client's bounded timeout. Authentication uses
`provisioning-bound-session` identity, with the owner's recorded acceptance:
it loses the runtime wrong-account/refresh cross-check and is not provider-signed
attestation. The documented proxy and policy limitations still apply.
The Windows definition remains a candidate with null evidence and requires
`--candidate-smoke`; passing a smoke never changes admission. The portable
validator and the 1.1.0 definition schema both accept an admitted state only as
an exact registered admitted descriptor. Every registry tool gets an explicit,
honest outcome; only Claude Code has definitions.

The default whole-check budget is 180000 ms; `--budget-ms` accepts integers
1000–600000. Cancellation uses `controls.signal` or CLI SIGINT. Cleanup has one
additional 10000 ms allowance, with unresolved resources reported explicitly.
JSON output contains one result and no raw process output. Exit codes are 0 for
`ok` `complete` `verified`, 2 for `refused` or `invalid`, 130 for cancellation and 1 otherwise.
No verification result grants Apply approval or organization authority.

Launching sessions also requires explicit `maxTurns` and `maxEstimatedCostUsd`
totals, in the request or controls (never both). CLI equivalents are
`--max-turns` and `--max-estimated-cost-usd`; flags must not duplicate limits in
the request file. Both limits must be supplied together. Turns are safe integers
at least 2; estimated USD is finite and positive, at most `Number.MAX_SAFE_INTEGER`,
and its half must remain positive. There are no default turn or spend numbers.
These controls select one attempt, at most two fresh sessions and no automatic retry.

Before session one, Core reserves half the estimated USD for each session and
splits turns into `floor(maxTurns/2)` and `ceil(maxTurns/2)`. Session two receives
the lesser of its reserved share and the remaining total after session one's
reported usage. Unused first-session share is not added to session two's share.
Only one final, session-bound Claude result with numeric `num_turns` and
`total_cost_usd` establishes usage. Missing, malformed, duplicate or interrupted
results stop the attempt with `usage-unavailable`; absence of usage never means
zero cost. Results record each session's allowance and usage and the total in
`limits.finite`. Unknown totals are null.

The fixed adapter passes `--max-turns` and `--max-budget-usd`. Turn counts measure
agentic tool-use round trips, not individual tools. Estimated USD uses Claude's
local pricing/accounting: the response crossing a threshold finishes, so it can
overshoot and differ from actual charges. A first-session overshoot can reduce
or exhaust session two's remaining allowance. Neither the threshold nor the
deadline is an actual-charge hard cap. Limit termination produces incomplete
acceptance, even if some proof already passed, and follows the same owned-process
cleanup. Dedicated identity, exact artifacts, numeric limits and execution
authorization still require independent operator selection.

The [Claude finite-limit assessment](https://github.com/samartomar/aih-core/blob/main/docs/native-claude-finite-limits.md)
documents the implemented estimated stopping semantics, their limitations and
the remaining native qualification gates. No real provider requests were needed
to test these controls.

The complete request may come from `--configuration <request-json-file>`; its
client must match the positional client. `--host-bindings <host-json-file>`
accepts only `testIdentity` and `configurationSources`, independently selected
by a trusted Node host. Embedded paths are absolute. These files are bounded
strict UTF-8 JSON, reject duplicate keys and links, and are never echoed.
No ambient credentials, arbitrary commands, callbacks, environment maps or
collector endpoints are accepted. Dedicated OAuth provisioning is an operator
step outside verification; the normal user profile is never its credential source.

For supplied Claude bundles, the fixed installed adapter derives verifier-owned
user settings from the independently verified server and query identities. It
approves only that project server and allows only its fixed instruction-attestation
tool and selected query; the built-in deny list and
`enableAllProjectMcpServers=false` remain unchanged. Ambiguous or pattern-like
identities, extra selected tools and additional project MCP servers are refused.
The effective settings bytes, member lengths/hashes and guardrail tree digest are
bound to staging, persistence and Linux launch protection. Selected bundle bytes
and installed definition/admission metadata are unchanged; the bundled fixture
retains its original settings bytes. Approvals live in the disposable user's
`.claude/settings.json`, so a fresh home needs no remembered project approval.
Actual discovery and restrictions still require native observations, and managed
restrictions retain precedence. Controlled permission tests establish neither
native two-session acceptance nor admission.

Supplied configuration uses independent archive/member pins and exact starting
and output trees. The bundled fixture proves only its mechanism; test content
cannot establish production configuration. Both fresh sessions must separately
observe initial instruction loading, MCP discovery and the fixed read-only query.
Before and after the second session, selected configuration and guardrail bytes
must be unchanged, and every other path in the cell must be fixed client-owned
state named by the installed adapter. Such a state tree may change except beneath
its fixed loading exclusions; for Claude, per-project memory and the client's other
reserved non-transcript names stay excluded. The client's global state file is
accepted only when a separate inspection finds bounded bookkeeping, without MCP
servers, tool or permission grants, trust or approval entries, credentials,
environment values or unrecognized keys. Outside uninspected client state, any
new instruction, settings, hook,
plugin, MCP, memory, shell-snapshot, session-environment or managed-policy file
is `configuration-changed`, as are links and other non-regular files in state.

The verifier sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the environment built
from scratch for both sessions on every platform. This disables auto-memory
creation, background extraction and next-session instruction loading. A managed
`autoMemoryEnabled` key or managed `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` key,
with any value, is a `restricted` / `managed-restriction` outcome. A known
restriction takes precedence over unreadable sibling keys or sources; malformed
or unreadable policy alone remains unreadable. Verification never overrides
managed policy, and unobserved managed sources remain an evidence limitation.

Both session environments also fix
`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` and
`CLAUDE_CODE_DISABLE_FAST_MODE=1`, regardless of host values. Either key's presence
in a managed `env` block, including empty, `0` or `false` values, yields
`restricted` / `managed-restriction` with the same precedence. The pinned client
still writes disabled marketplace state: the global state inspector admits only
the complete tuple `officialMarketplaceAutoInstallAttempted=true`,
`officialMarketplaceAutoInstalled=false`, and
`officialMarketplaceAutoInstallFailReason="policy_blocked"`, or all three absent.
Partial tuples, other values, retry counters and timestamps remain refused.
This admits no plugin files, configuration or installation paths.

The exact home `.claude/sessions` path is admitted only as an ordinary empty
directory at each persistence checkpoint, after descendant quiescence. Absence
is also accepted. Any child (including a PID record, socket-path record, nested
directory or link) or enumeration failure is refused; this is not a recursive
state tree. The exact home `.claude/.last-cleanup` path is admitted only as an
ordinary regular file with link count one. It is housekeeping control metadata
whose contents are not inspected; the client reads back only its mtime. Links,
reparse points, hard links, wrong shapes and case/path near-matches are refused.
Per-project `*/memory` remains excluded whether empty or populated, and selected
configuration bytes remain immutable.

This rationale is specific to Claude Code 2.1.285, executable SHA-256
`33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29`.
Native acceptance of the changed packed distribution is pending; controlled
checks do not establish native acceptance.

Claude's home state also includes exactly `.cache/claude-cli-nodejs`, with
`XDG_CACHE_HOME` remaining `<home>/.cache`. For the pinned Claude Code 2.1.285
executable and admitted invocation, the enumerated static trace identifies JSONL
error/MCP log writers and age-based cleanup beneath this tree, under sanitized
working-directory names; no configuration or instruction reader was identified in
that trace. No configuration or instruction discovery into this subtree was established for the traced local inputs; unobserved server-managed policy may alter loader roots. That conclusion is version-specific. `.cache` is accepted only as the directory parent of this
tree; other children, near matches and project-root equivalents are refused.
The uninspected root may be an ordinary single-link file or a directory. Files
named `settings.json` or `CLAUDE.md` within it are accepted as inert state; the
walker checks structure, not log content or loading behavior.

Logs may contain MCP server stderr. Verification never reads, ingests or exports
their contents. Successful whole-cell cleanup deletes them; failed cleanup
retains the cell and reports its opaque recovery name. Retention does not rely
on the client's own pruning. See [persistence diagnostics](docs/native-persistence-diagnostics.md)
for the state boundary and privacy-safe failure records.

Accepted limitation: provider feature-gate and experiment caches recorded by the
client, such as `cachedGrowthBookFeatures`, `cachedDynamicConfigs` and the
`cachedExperiment*` keys, persist from the first session into the second. The
second session's loading, restriction, tool-discovery and authentication evidence
is still observed independently. For Claude Code 2.1.285 this limitation also
includes behavior-relevant `modelAccessCache` (at most 256 closed records with
only `apiName`, a string of at most 65536 characters, and `entitled`, a boolean)
and boolean `penguinModeOrgEnabled`. Selected settings mutations still fail
persistence validation; `lastSeenOrgDefaultUpdatedAt` and
`gzipRequestBodiesLatchedOff` remain refused. Identity, loading, isolation and cleanup remain
distinct; hygiene evidence cannot become full native proof.
Unavailable process/peer-identity facilities fail closed. Native platform acceptance
requires actual observations and separate maintained evidence.

The Windows candidate names Claude Code 2.1.285 on Windows x64
(`10.0.26200`). The package includes a bounded Windows Job launcher, OS-bound
named-pipe peer observation and an explicit protected cell-local OAuth file path.
Facility availability requires actual probes; missing or changed helper/runtime
bytes fail closed. Dedicated identity still requires operator provisioning and
same-session authentication evidence. The candidate has no whole-client isolation
mechanism, so useful hygiene evidence remains incomplete/unverified. See
[Windows facilities and dedicated identity preparation](docs/native-windows-verification.md).
The separate admitted Linux x64 WSL2 definition wraps the entire workload in pinned
Anthropic Sandbox Runtime 0.0.78 and uses a bundled Linux kernel observer for
process ownership, authenticated IPC and cleanup. It requires the exact client,
kernel and runtime byte closure recorded by its definition metadata. Admission
is limited to the exact tested version and environment described above.
See [Linux isolation, prerequisites and limitations](docs/native-linux-verification.md).
Controlled facility and synthetic session checks do not establish native acceptance.

Optional [persistence diagnostics](docs/native-persistence-diagnostics.md) report
closed failure classes and bounded reviewed tokens on `aih.native.diagnostics.v1`
without exporting state values, raw names or project paths.

The native verification request, result, bundle, definition and test identity formats are
`urn:aihq:core:native-verification-*:0.1.0` and `urn:aihq:core:native-test-identity:0.1.0`; `validateFormat` and
`schemas` in `@aihq/core/contracts` read them. Portable import
and validation perform no host work. Host controls belong only in `@aihq/core`.

## Install your own content through a plan request

`urn:aihq:core:plan-request:0.1.0` carries a Catalog plan plus what Core needs to carry it out. Your own folder is a plan
with `data: null`; it gets the same review, receipts and removal as published content. This Core carries out `write`
(including `render`), `fetch`, `merge`, `link` (see [Sharing](#shared-content-across-projects-and-clis)), `acquire` (see [AI setups](#ai-setups-acquire-steps)) and `plugin` steps (see
[Native plugins](#native-plugins-plugin-steps)); every other step kind is refused (`step-unknown`) before any effect. The
format is not marked ready.

```js
import { prepare, apply, list, prepareRemoval } from '@aihq/core';

const request = { schema: 'urn:aihq:core:plan-request:0.1.0', scope: 'project', target: { project: '/work/app' },
  plan,                 // what Catalog's planInstall returned
  contents, profiles,   // the content and tool-profile documents the plan was made from
  // One entry per { sourceId, sourcePath } a step names. `bytes` exists only in the Node API; a saved request has none.
  files: [{ sourceId: 'local-my-skills', sourcePath: 'notes/SKILL.md', sha256: '…', bytes }] };
const prepared = await prepare(request);          // ready | partial | blocked | refused | invalid | unsupported-version
if (prepared.status === 'ready') {
  const run = await apply(prepared.handle, { approved: true, origin: 'interactive', reviewDigest: prepared.review.reviewDigest });
  // run.completion: complete | incomplete | cancelled | rejected (REVIEW_STALE with `changed`)
}
await list({ target: { project: '/work/app' }, scope: 'project' });   // urn:aihq:core:inventory:0.1.0
const removal = await prepareRemoval({ target: { project: '/work/app' }, scope: 'project',
  removals: [{ managementId: 'local-my-skills.skill.notes' }] });      // then apply(removal.handle, …)
```

- **Before any effect**, Prepare refuses a file a step names that has no entry or no bytes (`source-missing`), bytes
  whose sha256 differs from the entry, the content document or the plan (`source-mismatch`), a CLI or profile id with
  no registry tool (`tool-unknown`), a path leaving its root or naming a Git folder or an 8.3 short name
  (`path-escape`), a target in Core's state (`state-path`), an unresolved clash (`plan-unresolved`) and anything over a
  published limit (`limit-exceeded`, naming the limit). Two
  entries for one source file are `invalid` (`duplicate-file`). An entry no step names is ignored and listed in the
  review. An `incomplete` plan whose only reasons are `missing` and `unavailable` is carried out after approval.
- **The review** (`urn:aihq:core:review:0.1.0`) is frozen plain JSON: one sentence per step, the plan's reports, the
  origin (`chosen`), conflicts and `reviewDigest`. It never holds source bytes. One management id per item and scope.
- **Merges** add one entry to a file you may already have and never replace the file: `json` sets one JSON Pointer
  (`key: '/mcpServers/github'`, comments and other keys kept), `toml` one table (`key: 'mcp_servers.github'`, its
  `entry` a table of scalar or scalar-array values; a nested table becomes a sub-table), and `markdown` one block
  between `<!-- aih:begin <key> -->` and `<!-- aih:end <key> -->`. Every other byte is kept, and removal takes away only
  what Core added, including a TOML table header it created. For Codex's `AGENTS.md`, Prepare checks the resulting file,
  your bytes plus every planned block, against 32 KiB and refuses before any write (`file-too-large-for-client`, naming
  the `file` and `size`). A slot an `inputs` binding fills with a secret is a known secret slot of the entry.
- **Conflicts.** A file, entry, table or block Core didn't write makes Prepare `blocked`, with no handle. Each conflict
  carries its `target`, a merge's `key`, `observedSha256` (the whole file's digest, or `null`), the `existing` bytes
  exactly as they are (known secret slots read `[REDACTED]` and are listed in `redacted`) and its `choices`. Prepare
  again with `resolutions: [{ managementId, step, choice, observedSha256 }]`: `replace` keeps your original file in
  protected recovery (receipts name it by digest only) and removal writes your bytes back; `adopt` is offered only for
  bytes identical to Core's and takes them without a write; `skip` leaves the member out and makes the review `partial`
  (Apply then needs `allowPartial: true`). A resolution whose `observedSha256` no longer matches is not used: Prepare
  is `blocked` again with the new facts (`detail: 'resolution-stale'`). A TOML table that already holds a key the entry
  doesn't name is your entry: replace or skip only. Content Core can't edit safely is offered as skip only.
- **Your edit wins.** A member Core wrote that you changed is `managed-content-changed` with no choices: no resolution,
  update or removal overwrites it (`keep-changed`); undo your edit yourself to take Core's version.
- **Apply** binds the exact `reviewDigest`, consumes the handle, and re-checks the request (document and bytes), the
  target bytes, the receipts and the home folder; a change is `rejected` `REVIEW_STALE` naming `changed`. The pending
  receipt and interrupted-install rules are those of [Interrupted installs](#interrupted-installs).
- **Removal** keeps your later edits (`keep-changed`), unregisters missing members and never removes unowned files.
  `removals: [{ managementId, clis }]` releases only those CLIs' claims (see below).

### Shared content across projects and CLIs

- **Claims.** A receipt claim is one management id, scope, CLI and project: the CLI comes from the step's `clis`, the
  project from `target.project`, for user-scope members too. A place several CLIs read (one `write` with `clis:
  ['codex', 'kimi']`) or a user-scope entry two projects plan identically is one member with a claim each. The review
  shows such a step once. A member stays until its last claim is released; removal of the others reports `keep-shared`.
- **`list`** returns one entry per management id and scope, with `clis`, every claim as `{ cli, project }` (`cli: null`
  when the steps recorded no `clis`), and per member the `clis` holding it and, for links, `kind: 'link'` and `linkType`.
  `installState` is `complete` or `interrupted`. An install a run reached its end on without finishing (a step of it
  failed, or was `not-attempted` because of a failure it depends on) stays `interrupted`, as the next Prepare finishes
  it, and carries `lastRun: { runId, outcome: 'failed' | 'not-attempted', reason? }`; an install a run stopped in the
  middle of (a crash, a cancel, a stale review) has none.
- **Removal** names the place: a user-scope removal releases the claims of the project in `target.project` (or of
  requests that named none). With `clis`, only those CLIs' claims go; a management id with no claim for those CLIs is
  `absent`. A claim whose steps recorded no `clis` can't be split: removal by CLI is refused
  (`client-attribution-missing`); remove it for every CLI instead.
- **`link` steps** (`{ op: 'link', root: 'user', path, to, item, clis }`) place a CLI's folder over a shared version
  folder the plan writes. On macOS and Linux it is a symlink. On Windows it is a folder junction when every CLI in `clis`
  is one observed to load junctioned folders (Claude Code, Codex, Copilot CLI, Kimi, Kiro CLI, OpenCode), and otherwise
  (Antigravity, Cursor, dsh, or no `clis`) a copy of the files the plan writes into `to`. The review step and `list`
  name the `linkType`. Core never replaces something already at the link's place (a conflict offered as skip only) and
  never places a link through another link. Each claim on a junction or symlink keeps a record in Core's private state
  (`~/.aih/core/content/<claim>/links/`); when the last claim goes, Core removes the link (only while it still points at its folder) and the parent folders it created
  for it, if empty. A copy's files are ordinary members. These are Core-side placement facts, not evidence that a CLI
  loads a linked folder.
- **Displaced claims (one level of restore).** When another plan's `merge` entry or block holds a different value at
  the same place, unchanged since Core wrote it, the conflict offers `replace` and names the installs it `displaces`.
  After that reviewed replace, those installs hold nothing on disk: `list` shows their members as `state:
  'displaced-by'` with `displacedBy` naming the install whose value is there now. Removing a displaced install only
  drops its claim (`keep-shared`, reason `displaced`). Removing the overriding install writes the shared value back
  (`restore`, reason `displaced-value`) while any displaced install remains, and their claims match again; otherwise
  your original from before any install comes back, or the key goes. A secret the displaced value held by value is
  never kept: the receipt records the slot's template, and that removal is refused `input-missing` (naming `item` and
  `input`) until the secret is passed again in `controls.privateInputs` (`aih remove --private-input`). A value you
  edited is never displaced (`managed-content-changed`, no choices), and an override you edited is kept on removal
  (`keep-changed`). There is one level only: a different value over an install that already displaces others is
  blocked (`second-displacement`, no handle) with `displacedBy`, `displaced` and a `fix`: remove the override through
  review, which restores the displaced installs, then prepare again. Identical sharing and the override's own updates
  add no level and stay allowed. Applies on one root take its lock and re-check the reviewed bytes and receipts, so a
  competing Apply prepared before another changed the value is `rejected` `REVIEW_STALE`.
- **AI setup folders** in `~/.aihq/ai-setup/` stay while any project's claim holds them.
- **Changes** at user scope that name `target.project` are claimed for that project too: two projects pushing the same
  change hold two claims, and the value stays until both are removed. A user-scope change request without a project keeps
  one claim per management id, anchored on the home folder.

### Input values (`inputs` bindings)

An item's declared inputs (`requirements.inputs`: `isRequired`, `isSecret`, optional `default` and `placeholder`) land
only where the plan marks them. A step's `inputs` lists bindings `{ item, input, at }` with exactly one destination:

- `{ pointer }` in a `json` or `toml` merge entry: an absent slot is set (intermediate objects created), a string
  holding the input's marker `{NAME}` has that marker replaced; anything else is `invalid` (`input-binding`).
- `{ argv: n }` in a merge entry: slot `n` of the command and its arguments, where the step's profiles' `mcpFile.stdio`
  say they are (`command` + `args`, or one `argv` array); the slot must hold `{NAME}`.
- `{ env: NAME }` in a merge entry: that variable in the entry's environment field (`mcpFile.stdio.env`).
- `{ placeholder }` in a `write` (after any render) or a Markdown merge: the marker the item declares for that source
  file, which must occur; every occurrence is replaced. In `.json`, `.jsonc` and `.toml` files the value is written with
  JSON string escapes; elsewhere it must be one line without control characters, otherwise `invalid` (`input-value`).

Core does no other substitution. **Values.** Ordinary values come from the request's `inputs` (keyed by item id, then
input), else the `default`; secrets come only from `controls.privateInputs` (same keys) and are `invalid` in the
request. A required input with no value is refused `input-missing` (naming `item` and `input`); an optional one is
left out (an absent slot stays absent, a slot that is only the marker is dropped, other marker text becomes empty).
Undeclared names, a secret passed as an ordinary value or the reverse are `invalid`. An input of a planned item that no
step marks is refused `input-binding-missing`, never guessed; so is a `write` or Markdown merge whose copied or rendered
source file still holds an input's declared placeholder that the step itself does not bind (the step is named). **References.** A secret is written as the client's own
environment reference when every profile the step serves declares one for that surface under `inputReferences`
(`mcp-env`, `mcp-header`, `mcp-argv` for merge entries, by the `mcpFile` field the slot sits in; `file` for
placeholders), for example `{ "syntax": "${<name>}" }` → `${GITHUB_TOKEN}`; then no value is needed. Otherwise its
value is written and the review's `warnings` name the file: "this file will hold a secret". **Where values show.** Each
review step lists its bindings (`inputs`: `at`, `secret`, `written: value|reference|omitted`, `from`, and the ordinary
`value`); a slot holding a secret reads `[REDACTED]` in the review's `entry` and in conflicts. Receipts record the same
facts per management id with ordinary values only; secrets appear in no review, run, history or receipt. Apply
re-checks the private inputs by digest (those passed to Apply, or the object Prepare read): any change is `rejected`
`REVIEW_STALE` `input`. `prepareRemoval` takes `privateInputs` the same way and binds them to its review.
`aih install` and `aih remove` take `--private-input <item>.<input>=<ENV>` (the last literal dot separates the input; a
dot inside either may be written `%2E`), reading the secret from that set environment variable.

### Renders and recipe origins through your Catalog

Core never renders Catalog content itself and never bundles a Catalog. Pass the Catalog that made the plan as
`controls.catalog: { version, renderStep, planRecipe }` (its `@aihq/catalog/reader` functions); Core uses it only for
`write` steps and Markdown `merge` blocks with a `render` and for recipe proofs.

```js
import { renderStep, planRecipe } from '@aihq/catalog/reader';
const controls = { catalog: { version: '<the installed @aihq/catalog version>', renderStep, planRecipe } };
const prepared = await prepare({ ...request, recipeProof: { pluginJson, recipeJson, choices, options } }, controls);
```

- **A render step** records the profile id and version it was planned with (`render: { name, profile, version, … }`,
  or a combined render's `profiles`); a render Catalog makes from the plan alone (`bundle-root` in a shared Markdown
  file, `duplicates-report`) records none. Before calling `renderStep`, Prepare checks each recorded version against the
  supplied profile documents (`profile-mismatch`) and every source byte against its sha256 (`source-mismatch`); it
  passes the Catalog only the checked bytes, and reports the Catalog's own `source-mismatch` or `profile-mismatch`
  refusal as that code. Bytes that don't match the sha256 the Catalog returned, or a failed render, are `invalid`
  (`render-failed`). Without `controls.catalog.renderStep` the step is refused `catalog-required`, naming the step.
- **Source files.** A step's `from` (`{ item?, sourceId, sourcePath, sha256 }`) names an item's file or one of its
  `editions`' files, or, without `item`, a file the step's `items` share: a source notice, or a file of the runtime
  `bundle` the step names. A Markdown `merge` without `entry` takes its block from its `render` or, without one, the
  copied `from` file. Such a shared step is one member each of its items claims. Catalog's own authored items (source
  `aih`, such as the duplicate resolver a plan mixing frameworks adds) are supplied like any content: pass
  `aihContent.content` from `@aihq/catalog/reader` in `contents` and its files in `files`.
- **Root paths.** A merge entry's `rootPaths` (`[{ pointer, root: 'user', path }]`, an acquired executable) are
  written as absolute paths under your home; the entry must hold exactly that path at each pointer. A project-scope merge
  therefore writes an absolute path inside your home into the project's file. Each path must be inside the folder an
  `acquire` step of the same plan places, or inside an AI setup folder Core already acquired (its marker present);
  otherwise Prepare reports a `root-path-unplaced` plan problem naming the step. When that acquire step is skipped, the
  entry is skipped with it.
- **Path references.** A plan with a `path` reference is refused `plan-unresolved`; a plugin-namespaced `name`
  reference is a warning and installs.
- **Receipts** record the Catalog `version` and the profile ids and versions each management id was planned with;
  `list` shows them as `catalog` and `profiles`.
- **Recipe origin.** A plan's `recipe` is only a claim. With `recipeProof` (the recipe plugin's exact `plugin.json` and
  `recipe.json` text, and the planner `choices` and `options`; Core supplies `scope` and `source` itself), Prepare checks
  the `recipe.json` sha256 against `plan.recipe.sha256`, re-runs `planRecipe` with the request's contents, profiles and
  qualifications, and compares the result with the plan byte for byte. A match records the origin
  `{ recipe: { id, sha256, repository, commit }, data }` in the review, the receipt and `list`. No proof, a mismatch or a
  failed reproduction still installs, records `chosen`, and the review says "origin not proven". A plan without
  `recipe` (`planInstall`) is always `chosen`. Only a malformed proof (`invalid`, `recipe-proof`) or a proof without
  `controls.catalog.planRecipe` (`catalog-required`) stops Prepare.
### Native plugins (`plugin` steps)

A `plugin` step installs a framework through the CLI's own plugin commands at the pinned commit. Every step naming a
`framework` is one indivisible install, grouped under that framework id.

- **Commands.** Core fills the supplied tool profile's `plugins.install` argv templates only from the step's own fields
  (`<plugin>`, `<marketplace>`, `<marketplace-name>`, `<repository>`, `<commit>`, `<scope>`). A placeholder the step
  doesn't fill, or a profile without a pinned (`pin: holds`), unattended install at the request's scope, is refused
  (`plugin-command-unresolved`); a missing profile, or a step whose `verify` differs from the profile's, is
  `profile-mismatch`; a CLI this host can't run is `program-unavailable`. All before any effect.
- **Marketplace.** `marketplace` is an https URL or `owner/repo`, or `{ root, path }`: a marketplace folder the plan
  writes itself (Claude Code and Copilot pin a plugin through a `.aihq/marketplaces/...` folder and the plan's `write`
  step of its marketplace file), filled in as that folder's absolute path. The plan's `write` steps run before its plugin
  steps. `repository` is an https URL of plain path segments. Either with credentials, a query, a fragment, another
  scheme or anything a command could read as an option is invalid, as in Catalog's own address grammar.
- **Pin.** A step Catalog marks `pin: "unverified"` (its install names no commit and the plan writes no marketplace)
  shows `pin: unverified` in the review and a "can't promise" line saying the CLI may install another commit; any other
  `pin` value is invalid.
- **The review** shows each exact command with the executable and sha256 Prepare pinned, the removal commands, the
  presence check, the items the plugin's recorded folder holds (`contains`) and a "can't promise" line: Core can't show
  or roll back what the CLI's own program changes. Prepare runs nothing.
- **Apply** runs only those commands, in order, in the project folder or home, with cancellation and `onProgress`
  events for each command's start and finish. The pending receipt is written before the first command, so an
  interrupted command leaves the install `interrupted` and the run step `effectsUncertain`; the next Prepare shows the
  step again (`previous: interrupted`) for a fresh approval and never re-runs it by itself.
- **Presence.** Only the profile's `plugins.verify` readback (`{ argv, expect }`: the expected line in the command's
  output) decides. After install, `present` gives verification `passed`; `absent`, or a check that can't run, fails the
  step and makes the run `incomplete`. With `verify: none` the step is `unverified` (`no-presence-check`). An exit
  status or help output never proves presence or absence.
- **Receipt.** At install the filled removal commands and presence check are copied into the receipt and listed under
  `plugins` by `list`, so removal never needs the old profile.
- **Removal** runs those saved commands first, then the saved check: `absent` is `passed`; still `present`, a failed
  command or a check that can't run fails the step and keeps the receipt for another try. Without a check it stays
  `unverified` (`no-presence-check`). `{ managementId, item }` for one item inside a plugin is never split: the entry is
  `unavailable` with `reason: plugin-indivisible`, lists `contains` and `offers` the whole plugin's removal.
- **Not yet:** real-client evidence.
  The tests use a controlled fake client; an unattended run of each real client's plugin commands is a pending live
  check.

### Local plugins and switching one plugin item off

A `local-plugin` route is not a step kind: Catalog lowers it to `write` steps (the plugin's files, copied from the
framework's recorded plugin folder by `from: { sourceId, sourcePath, sha256 }`) and `merge` steps (its registration,
such as Claude's `extraKnownMarketplaces` and `enabledPlugins`), each naming the `framework` and
`route: "local-plugin"`; the route's first step lists the items it `contains`.

- **One install.** Every step naming a `framework` belongs to that framework id: one review group, one receipt, removed
  whole. Review steps carry `framework`, `route` and, on the first step, `contains`. A plugin file the content
  document's `plugins[].files` doesn't record is `source-missing`; other bytes than it records are `source-mismatch`.
- **Inventory.** `list` shows `localPlugin: { contains, files }`. Without the route's `contains` (an older plan),
  `contains` is `null` and only the files are listed; Core never infers which items the plugin holds.
- **One item.** `{ managementId: <framework>, item }` is `unavailable` `plugin-indivisible`, with `contains` (or, without
  it, the plugin's `files`), `offers` (the whole plugin's removal) and `choices`: `remove-plugin` and, where the CLI
  supports it, `switch-off`. The person chooses, and the caller prepares the same removal again with
  `resolutions: [{ managementId, item, choice }]` (as for conflicts, section 7; `aih remove <framework> --item <id>
  --resolutions <file>`). `remove-plugin` prepares the whole plugin's removal for that entry; a resolution naming no
  entry is invalid `resolution-unknown`.
- **Switching off** (the `switch-off` choice, alone in its request) is offered only for a Codex native plugin whose
  recorded folder holds the item as a skill: Codex keys
  `[[skills.config]]` by the plugin-qualified `plugin:skill` name. Anything else is refused `switch-off-unsupported`;
  Claude and the other CLIs get no invented toggle. The switch-off is a reviewed change owned by the item's own claim:
  one marked block (`# aih:begin <framework>/<item>` … `# aih:end <framework>/<item>`) appended to
  `~/.codex/config.toml`, holding `[[skills.config]] name = "<plugin>:<skill>" enabled = false`, in the file's own line
  endings. Every byte outside the block is kept.
- **Before writing,** Prepare parses the file read-only. Your own unmarked `[[skills.config]]` entry for the same skill,
  two marked blocks for it, or syntax Core can't read is `blocked`: an `existing-content` conflict with the exact bytes,
  offered as skip only, and no handle. Core never edits or replaces your entry.
- **After writing,** Apply reads the file back: the block must parse and hold exactly one table naming the skill with
  `enabled = false` (verification `readback-matched`), otherwise the step fails (`readback-mismatch`) and the run is
  `incomplete`. The plugin and its framework claim stay; `list` shows the switch-off's entry with `switchOff`.
- **Switching on again** is removing that claim (`{ managementId: '<framework>.switch-off.<item>' }`, which the one-item
  entry then offers; an id that would pass 128 characters is `switch-off-<digest>`), never the item's own id, so an item
  also installed on its own keeps that install: the
  block goes and the file is as it was (a file Core created goes with its last block; a line break Core added after
  your last line stays). Removing the whole plugin also removes its items' switch-offs.
- **Not yet:** a local plugin whose CLI can switch one item off (no Catalog profile has that route today). Whether a real
  Codex honours the block is a pending live check.

`@aihq/core/contracts` publishes `schemas` (each 0.1.0 format with one valid and one invalid fixture), `validateFormat`,
`refusalCodes` and `limits`.

```sh
aih install plan-request.json --project /work/app --source local-my-skills=/work/my-skills [--resolutions choices.json]
            [--private-input local-my-setup.mcp.github.GITHUB_TOKEN=GITHUB_TOKEN]... [--apply --yes [--allow-partial]] [--json]
aih list --project /work/app --scope project --json
aih remove local-my-skills.skill.notes --scope project --project /work/app [--apply --yes] [--json]
```

`--source` reads the folder with `readLocalSource` from the `@aihq/catalog` installed beside the CLI; without it the
command is refused `catalog-required`. `aih install` also passes that Catalog's `/reader` `renderStep` and
`planRecipe`, with the version from its `package.json`, as `controls.catalog`. `--resolutions` names a file holding
`{ "resolutions": [...] }`. The CLI never takes the project from the working folder. Exit codes: 0 ready,
complete or ok; 1 partial, blocked, incomplete, or no prepared removal; 2 refused, invalid or rejected; 130 cancelled.

### AI setups (`acquire` steps)

An `acquire` step downloads one AI setup's artifact into `~/.aihq/ai-setup/<name>/<version>/<cell>/`. Pass the
qualification documents the plan's acquire steps name in `qualifications`.

- **Before any effect**, Prepare finds the qualification by its sha256 over canonical JSON (`qualification-missing`
  when none matches) and checks that the step agrees with it: AI setup, version and cell, `qualified` status, the
  artifact's sha256 (and file and byte count where both name them), a native archive's members, a Python tool's wheel
  closure and its fallback interpreter (`qualification-mismatch`). A step for another platform cell is `cell-mismatch`.
  `npm` and `git` distributions are refused `step-unknown` for now. The plan and qualifications are never changed.
- **Where bytes come from.** Prepare fixes one source per download (artifact, closure wheel, fallback interpreter, build
  source, build dependency) and the review step's `acquire.downloads` shows it with the sha256; approval covers it.
  The first that applies: a file of that exact name in the caller's `controls.artifacts` folder (CLI `--artifacts <dir>`;
  an absolute path to an existing folder, only read, Core copies what it uses); the https `url` the step records; or
  resolution by exact identity at Apply: wheels and sdists through PyPI's JSON API (`/pypi/<name>/<version>/json`, the
  `urls[]` entry whose `filename` and `digests.sha256` are the planned ones), a fallback interpreter through its
  python-build-standalone release download (tag = the `+YYYYMMDD` part of its file name). Every byte is checked against
  the qualified sha256 (and byte count when recorded): a mismatch is `artifact-mismatch` and never falls through to
  another source; nothing obtainable is `artifact-unavailable`. Prepare probes each remote source's host (for a PyPI
  source, both `pypi.org` and `files.pythonhosted.org`) with this machine's Node trust: a certificate it doesn't trust is `refused` `tls-untrusted` with `repair: "node-npm-ca"`.
- **Python tools** (`pypi-wheel`): Prepare looks for `python` / `python3` on `PATH` whose version is inside the step's
  `interpreter.range`. The review step's `interpreter` shows that installed interpreter (`in range, not qualified`), the
  qualified fallback with its sha256, and the failures that switch to it (`none-found`, `outside-range`,
  `wheel-install-failed`, `readback-failed`, and `build-failed` when the closure records a build); approval covers both.
  Apply runs the installed interpreter only while its real path and sha256 are those Prepare found; another file at that
  path, whatever its version, is `none-found` and the fallback runs. Core's helper runs with no host `PYTHON*` variable
  (only `PYTHONNOUSERSITE`, `PYTHONSAFEPATH` and `PYTHONUTF8`, as `-I` would isolate it) and its pip with `-I`. Apply downloads the byte-checked closure and wheel,
  makes a dedicated environment (`env/`) in the folder, installs offline (`--no-index --no-deps --only-binary=:all:`)
  and reads the tool's version back. Only after a real failure does it download the fallback interpreter, unpack it into
  `interpreter/` and repeat; the fallback's own failure fails the step. An installed interpreter is never byte-qualified.
- **The named executable.** The program an acquire step names (`executable`, home-relative, inside its folder; the path
  an MCP entry starts) is where Core puts it. A native archive's is one of its qualified executable members. A Python
  tool's is a console script of its environment: Catalog names `bin/<name>` (Windows `Scripts/<name>.exe`), and Core
  links that path to the environment's `env/bin/<name>` with a relative symlink (Core's own `#!/bin/sh` launcher where a
  link can't be made) or, on Windows, a hard link to `env\Scripts\<name>.exe` (pip's launcher; a `.cmd` path gets Core's
  own `.cmd` launcher, and a Windows path without `.exe` or `.cmd` is invalid at Prepare). The readback goes through that
  path: it must be launchable by Core's rules, be the environment's script (same file or Core's launcher bytes), and the
  script must be one of the tool distribution's console scripts before the version is read; otherwise the readback
  fails (`readback-failed`, which switches to the fallback like any readback failure). Core does not run the tool's own
  code for the readback, since the plan names no version command. The receipt and `list` record it as
  `aiSetup.executable { path, placed: member | environment | symlink | hardlink | launcher }`; it is inside the folder,
  so removal takes it with the folder.
- **Source builds.** A closure wheel with a recorded `build` (pinned `source`, exact `dependencies` wheels, observed host
  `tools`) uses its qualified bytes when obtainable and installable on the interpreter in use. Otherwise Core obtains the
  source and every dependency wheel exactly, makes an isolated build environment from that interpreter under the
  folder's `build/`, installs only those wheels offline and builds with `pip wheel --no-index --no-deps
  --no-build-isolation`, with pip configuration, user site and index variables neutralised. The build frontend is the
  pinned pip when the dependencies list one, otherwise the pip of that build environment; pip need not be pinned. The
  build's `HOME`, `USERPROFILE` (and `APPDATA` on Windows) and temporary folders are inside `build/`. The build's
  environment is an allowlist: only the host variables that find programs and describe the machine and locale, plus
  Node's own `NODE_OPTIONS` and certificates, reach it; compiler and linker flags (`CC`, `CFLAGS`, MSVC's `CL`,
  `INCLUDE`, `LIB`, `RUSTFLAGS`), `CARGO_*`, `SETUPTOOLS_*`, `DISTUTILS_*`, package settings and proxies never do. Core
  sets `PIP_NO_INDEX=1` and `CARGO_NET_OFFLINE=true`. When the build record's `tools` name a C compiler (`gcc`, `clang` or `cc`), the build uses it rather
  than the interpreter's recorded default (python-build-standalone's is `clang`): `CC` is that tool as found on PATH,
  `CXX` the same family's driver (`g++`, `clang++`, `c++`) when listed or found beside it, and on Linux `LDSHARED` is
  `<CC> -shared`. The variables Core set are recorded with the built wheel as `built.env`. The
  network is not blocked: the build is offline only through pip's flags, so a build backend that downloads on its own
  is not stopped. The built wheel must be the
  closure entry's name and version; it is recorded as built from pinned source (`byteQualified: false`, with the source
  and dependency sha256s and its own), never as the qualified bytes. Host tools are prerequisites: a missing one is
  `build-failed`; the observed version and executable sha256 are recorded next to the qualification's, without being
  compared. A build failure on the installed interpreter switches to the fallback, which tries qualified bytes and then
  builds again. `build/` is removed once the install finishes. Each failed build is reported in the run step's
  `buildFailures` (and an `onProgress` `build-failed` event): the closure wheel's name and version (for an install that
  fails after a build, the wheel pip's error names, or `"closure"` when it names none of the closure's files), the phase
  (`obtain-source`, `build-deps`, `build`, `install`), the interpreter branch, the reason and the last 40 lines of its
  output, with the plan's secret values and every host variable named like a secret (`TOKEN`, `SECRET`, `PASSWORD`,
  `API_KEY`, ...) reading `[REDACTED]`. The log is kept only there: a failed acquisition's folder, `build/` with it,
  is removed.
- **Native archives** (`.tar.gz`, `.zip`): Apply extracts exactly the qualified members, each byte-checked, with their
  executable bit.
- **Bounds:** one artifact is at most `artifact-bytes`, expands to at most `artifact-expanded-bytes` and
  `artifact-members`; a closure lists at most `closure-wheels` wheels (see `limits`).
- **Outcomes.** Downloaded bytes that differ from the qualification fail that step (`reason: artifact-mismatch`); the
  rest of its item and every item that depends on it (Catalog `dependencies`, or the AI setup's `mcpItem`) are
  `not-attempted`, unrelated items continue, and the run is `incomplete`. The run step's `interpreter`, the receipt and
  `list`'s `aiSetup` record which branch ran and why the fallback did; `aiSetup.downloads` records, per file, its origin:
  `supplied`, `downloaded` with the URL, or `built`. `onProgress` on the Apply call receives each
  acquisition's `start`, `bytes`, `fallback`, `build-failed` and `finish` events. A failed acquisition also removes the
  empty parent folders it made (such as `.aihq/ai-setup/<name>/<version>/`), so later steps' reviewed paths are as they
  were and unrelated items still run.
- **Custody.** The folder holds Core's marker `.aih-acquired`, the receipt member that carries the claims; while an
  acquisition runs the folder also holds `.aih-acquiring`, and a failed, cancelled or interrupted attempt is cleared and
  redone by the next Apply. A folder Core didn't make fails the step (`target-occupied`). The parent folders an
  acquisition made (from the first one absent at review, such as `.aihq` or `.aihq/ai-setup`) are recorded in the
  receipt as Core-created. When removal takes the marker's last claim, the whole folder goes, with its empty version
  and name folders and every empty parent above them that the receipt records as Core-created; a folder the person
  made stays.

### Tool commands, upstream installers and upstream setups

These program steps run an exact argv after approval. Core never shows or promises what a program changes; each review
step carries `effect: run-program`, a "can't promise" line and a `program` block: the argv (secret values
`[REDACTED]`), the program and its sha256, the folder it runs in, the environment names a binding sets, the readback,
the undo, and `cantRemove`, which says what Core can't remove around it.

- **`tool-command`** runs `argv` with the AI setup's acquired `executable` (`{ root: "user", path }`, inside the AI setup
  folder; with the qualified member's sha256 when the qualification lists it), then its `readback` (`{ argv, expected }`).
  A step without `qualification` (a recipe's replacement settings) is accepted: its review says no qualification ran it,
  and the program's sha256 comes from the qualification of the AI setup's `acquire` step when one is supplied.
  The step passes only when one output line of the readback equals `expected` (an empty `expected` needs empty output):
  verification `readback-matched`; otherwise the step fails (`readback-mismatch`). Inputs bind at argv slots (`{NAME}`
  markers) or environment names (`inputs: [{ item, input, at: { argv } | { env } }]`); a secret comes only from
  `controls.privateInputs` (`--private-input`), runs as its value, and is redacted from the review, history and receipt.
  The step is grouped under its `aiSetup` id, after that setup's `acquire`. A step with `restore: { argv }` (Catalog's
  settings commands; `<prior>` exactly once, as a whole argument) puts the earlier value back at removal. Apply runs the
  readback first and keeps its output (trimmed, at most 4096 characters, no control characters) as the prior value; the
  receipt's undo, kept before the command starts, is the restore with `<prior>` replaced by that value and the readback
  expecting it. A readback that fails, or shows a line break or any other control character, fails the step before the
  command runs (`prior-unreadable`); so does, on Windows, a prior value a `.cmd`/`.bat` command shim could not be given
  back (`"`, `%`: `prior-unrestorable`), so no change is made that removal can't undo. A prior value starting with `-`
  (which the tool would read as an option) is `prior-unrestorable` too, unless the restore puts `--` before `<prior>`.
  A prior value that may be a secret is never recorded: one holding any secret value the plan binds (on any step) or the
  value of a host variable named like a secret, or one read by a readback naming a secret (`config get apiKey`). The
  receipt says `prior: "withheld"` with undo `null`, the command still runs, and removal says Core can't undo it. This is the recorded choice; Core does not ask again for the value.
  Installing the same command again (same management id and argv, after an interrupted or complete install) keeps the
  first install's record, withheld included, and never reads the value Core set; a record whose prior value was never
  read (the install stopped before the command) is read again. `list` shows `prior` (`read` or `withheld`). The install review shows `program.prior` (the readback run first) and `program.restore`
  (the planned argv with `<prior>`); the removal review shows the filled restore command and its readback. The receipt
  records where the command ran (`root`, `cwd`) and the environment it ran with (`env`: an ordinary value as it was, a
  secret only by the input that gave it); removal runs the restore and its readback in that folder with that
  environment, and refuses (`input-missing`) until such a secret is passed again. Removal runs
  it before the AI setup folder goes; a failed restore or a readback that doesn't show the prior value fails that step and
  keeps the receipt. Without `restore`, the review and the removal say Core can't undo the command.
- **`upstream-installer`** (`managed: false`) runs the AI setup's own installer argv, whose program is found on `PATH` and
  pinned by sha256 at Prepare. Core clones nothing and can't remove what it installs; removal releases only its receipt.
  Its claim is in the scope of the plan that ran it (the review's `root`), and the program runs from that root: a
  project-scope plan lists and removes it in that project, a user-scope plan at user scope with the project that made
  it. An installer for an AI setup Core already acquired leaves that acquisition and its claim as they are: an install
  never releases a member its review doesn't show (only `prepareUpdate` drops members). Removing the user-scope AI
  setup removes the acquisition and a user-scope installer's receipt; a project-scope installer's receipt is removed
  in its project.
- **`upstream-setup`** clones `repository` at the exact `commit` into `into` with the `git` Prepare pinned (`clone
  --no-checkout`, `checkout --detach <commit>`, and `HEAD` must be that commit), marks the clone with `.aih-setup`, then
  runs `command` inside it: `./<file>` from the clone, or a program on `PATH` pinned at Prepare. The review lists what the
  command `needs`. Removal removes the clone with its marker; what the command wrote elsewhere stays. A folder holding
  files Core didn't clone is `refused` `setup-folder-occupied`.
- **Host support** is checked at Prepare, never halfway through Apply: a program this host can't run (no `git`, an
  installer not on `PATH`, or on Windows a program that is not an `.exe`, `.com`, `.cmd` or `.bat`) is
  `program-unavailable`. On Windows a client, installer or tool command installed as a `.cmd`/`.bat` command shim (as
  npm installs `claude.cmd`) is found in each `PATH` folder in the system's order and pinned like any program: the review
  names the exact shim path and its sha256. npm's own shim form (it starts `node` with a JS entry beside it) is never run
  through `cmd.exe`: Core starts the `node.exe` beside the shim, or the one on `PATH`, with the shim's JS entry, and the
  review's `launcher` names both with their sha256, checked again at Apply. Any other shim runs through `cmd.exe /d
  /v:off /s /c` (by its absolute path) with every argument quoted; an argument the command processor would still read
  inside quotes (`"`, `%`, a line break) is refused at Prepare (`program-unavailable`), before any command runs. Every
  program Core starts gets `NoDefaultCurrentDirectoryInExePath=1`, so a program a shim or tool names is never found in
  its working folder; cancel and deadline stop it with everything it started (`taskkill /T` on Windows, its process
  group on POSIX). A plugin name that starts with `-` or holds `"`, `%` or a control character is invalid.
- **Environment bindings** never set a variable that changes which program or code runs or where programs find their
  configuration (`NODE_OPTIONS`, `PATH`, `PATHEXT`, `LD_*`, `DYLD_*`, `PYTHON*`, `GIT_*`, `HOME` and the like, compared
  without case; Catalog's list for MCP server environments): such a binding is a plan problem (`input-binding`).
- **AI setup folders** (`~/.aihq/ai-setup/`) are filled only by acquire steps: a write, merge or link there is
  `path-escape`. A `tool-command`, like an MCP entry's `rootPaths`, runs a program there only when an acquire step of
  the plan, or an acquisition Core recorded (its marker present), places it (`root-path-unplaced` otherwise).
- **Executable configuration.** The review marks each merge or write that makes a client start a program later with
  `executableConfiguration: { label: "executable-configuration", kind, launches }`: `mcp-server` (an MCP entry with a
  `command`), `hook`, `settings-command` (`apiKeyHelper` and similar keys) or `executable-file`, with each program and
  its arguments, and for a write the bytes' `sha256` and `executable` flag.
- **MCP entries and `server.json`.** When the plan supplies an MCP item's `server.json`, the merge entry must start
  exactly what it declares (the registry's runner `npx` or `uvx`, its flags, `identifier@version` or
  `identifier==version`, the package's arguments) or name its remote's URL; anything else is `source-mismatch`. An AI
  setup's MCP item starts the acquired program instead and is bound by its acquire step.
- **Order and outcomes (D92, C60).** Apply runs every step of the plan in the plan's order across all items: the fixed
  phases (fetch and acquire, write, link, merge, plugin, upstream setup and installer, tool-command), then root and
  path. A failed step makes the not-yet-run steps of its item and of every item that depends on it `not-attempted`
  (Catalog `dependencies`, or the MCP item that starts the AI setup's executable); unrelated items continue and the run
  is `incomplete`. An entry belongs to its item even in a file other items' entries share: when an earlier item's entry
  there is not written, Core writes the later items' entries on the file as it then is, only if each comes out exactly as
  reviewed. So a failed download stops its MCP entry and tool-command, while a failed tool-command leaves the
  MCP entry that already ran `applied`: Core never reorders steps to avoid that, and never rolls it back. A command that started and then failed, was cancelled or
  was interrupted is `effectsUncertain`; the next Prepare shows it again (`previous: interrupted`) for a fresh approval,
  and Core never re-runs or rolls it back by itself. Without a readback an applied command is `unverified`
  (`command-effects-unknown`); an exit status never confirms its effects. `list` shows the saved facts under `programs`.
- **Evidence:** the `tool-command` shape is checked against a real Catalog plan; the tests run fake programs and a local
  git repository, never a real tool.

### Update from a new plan or change request

Core never looks for updates. Bring the complete new request (its files, profiles, qualifications and inputs, read as at
install) and prepare it against the receipts it replaces:

```js
import { prepareUpdate, apply } from '@aihq/core';
const update = await prepareUpdate({ target: { project: '/work/app' }, scope: 'project',
  updates: [{ managementIds: ['local-my-skills.skill.notes'], request: newPlanRequest }] }, { catalog });
// { status: 'ok', entries: [{ managementId, disposition, status, change, members, from, to, note? }], review, handle? }
const run = await apply(update.handle, { approved: true, origin: 'interactive', reviewDigest: update.review.reviewDigest, allowPartial: true });
```

- **Which receipts (C52).** A plan whose recipe origin Core proves (as at install) replaces the receipts here whose origin
  has the same recipe `id` and `repository`, whatever their recipe or data commit. An unproven plan, or a change, replaces
  exactly the `managementIds` it names; none named is `refused` `update-target-required`, and so is a request item
  installed here that the update doesn't name. Two different installed origins of that recipe here are `refused`
  `update-ambiguous`, naming them. A named id with no claim here is an `absent` entry.
- **Several updates in one call.** Each update targets its own receipts and its entries carry its `update` index; one
  review (`updates` lists each update's request, plan, origin and own digest; steps and conflicts carry `update`) and one
  handle cover them all. With several updates, a target error is that update's `unavailable` entry (`code`, `reason`), and
  two updates that act on one management id or one file are both `unavailable` `update-conflict`; the others go ahead.
  Apply runs them in order. Each later update is prepared again once the earlier ones ran and runs only if that shows
  exactly the reviewed work and its files are as reviewed; otherwise it is `not-attempted` and the run `incomplete`
  (`REVIEW_STALE`).
- **What happens to members (C39, C58).** New members are added; members Core wrote and the request changes are replaced;
  members the request no longer has are removed, unless another claim (another CLI, project or install) still holds
  them (`keep-shared`). A member you edited is never overwritten: a changed one is a `managed-content-changed` conflict
  with no choices, listed `keep-changed`, and the review is `partial` (approve with `allowPartial`); a dropped one is
  kept (`keep-changed`). An item the request no longer has is an entry with `change: remove` and the note "removed in
  data commit X". The review is `request: update` and lists each cleanup as its own step.
- **Moved version folders.** A `link` whose target folder moved (a new version) is repointed after the new version's
  files are written; the old version's files go once no claim holds them, and a file you edited there stays. A link
  another install (another project's or CLI's claim this update doesn't replace) still holds to the old version keeps
  pointing there, with the old folder: that link step is left out (`skipped`, partial) with a warning naming the install.
- **Data and origin.** The receipts record the new data commit and origin only after the update's run carried out
  every reviewed step (your kept edits aside). A rejected, failed, cancelled or interrupted run keeps the earlier ones.
- **CLI.** `aih update <plan-request.json | change-request.json> --scope project|user [--project <path>]
  [--management-id <id>]... [--source <sourceId>=<folder>]... [--material-root <id>=<folder>]... [--resolutions <file>]
  [--apply [--yes] [--allow-partial]] [--private-input <name>=<ENV>]... [--json]`. Exit 0 when every prepared entry is
  `ready` or the run completed; 1 for a partial or blocked entry, no prepared entry, or an incomplete run; 2 refused,
  invalid or rejected.
- The retained replacement-selection form (`updates: [{ managementId, replacement }]`, below) keeps its own result until
  it retires.

### Scan evidence with a plan request (`scans`)

A plan request may carry the Scan summaries you want shown, each with its Sigstore bundle, any withdrawals (each with
its own bundle at the same position) and, optionally, the complete inventory of the scanned tree. Core never fetches
evidence or trees, and Scan never decides what runs: no status, refusal or exit code depends on a score, a label, a
signer, a match, or whether Scan is installed.

```js
const prepared = await prepare({ ...planRequest, scans: [{ summary: summaryText, bundle,
  withdrawn: null, withdrawnBundle: null,
  inventory: null /* or [{ path, mode: '100644' | '100755', bytes }] for a tree the plan's files don't make up */ }] });
// prepared.review.scans: [{ index, status: 'verified' | 'not-verified' | 'unavailable', reason?, sentence, scanKey, revision,
//   label, coverage, score, signer: { identity, trusted, issuer, subject } | null, withdrawn, older, lastSeen, withdrawals,
//   managementIds, match: { status: 'matches' | 'differs' | 'refused' | 'not-checked', reason?, source?, differences? } }]
// prepared.review.notScanned: [{ step, op, reason: 'rendered' | 'fetched' | 'program' | 'not-scanned', sentence }]
```

- **One dependency.** Core imports only `@aihq/scan/read` (`verifySummary`, `matchScan`), declared as an optional peer
  (`@aihq/scan` `>=0.0.0-0 <0.2.0`: the temporary prerelease 0.0.0-dev.1 and 0.1.x). It is loaded only when `scans` are supplied. Without it each entry is `unavailable`
  (`scan-unavailable`), and the install goes ahead as reviewed.
- **Signers.** Core passes the allowed signers: the default `signerRecords` (`@aihq/core/harness`,
  `urn:aihq:core:signer-records:0.1.0`: AIHQ's Scan publishing workflow), replaced or extended by an Enterprise
  organization's `scanSigners`. `identity` is only a label: trust comes from the authenticated issuer and certificate
  subject. A valid signature by anyone else shows `trusted: false` ("not by a trusted publisher").
- **Matching.** Core passes the exact verified result to `matchScan` with the key's **source** tree: the item's (or
  edition's, bundle's or plugin folder's) files at their item-relative paths with the source bytes Core checked and their
  modes from `executable`. Where the plan's files don't make up the tree, the entry's `inventory` is used; without it
  the match is `not-checked` (`inventory-not-supplied`, "match not checked: inventory not supplied"). Rendered output,
  fetched files and program effects are listed in `notScanned` and never presented as covered by the source's scan.
- **Memory.** `~/.aih/core/scans.json` keeps the highest revision and withdrawn-through seen per scan key and
  authenticated issuer and subject, so it outlives removal and reinstall. A summary below a revision seen before is
  `older` ("older than the last result seen"); a summary at or below a remembered withdrawn-through is `withdrawn`. Only
  authenticated summaries and withdrawals move it: a withdrawal for the same key and signer moves withdrawn-through even
  when it arrives with a later revision; one for another key or signer moves nothing. It is bounded at 2 MiB: the oldest
  entries for keys no receipt holds go first; if only held keys remain, the oldest of those goes too and the review warns
  `scan-memory-full`. Nothing is refused for memory pressure, and the memory is never sent anywhere.
- **Receipts and inventory.** Each management id's receipt records the key, revision, signer, label, coverage,
  withdrawal and match shown; `list` shows them as the entry's `scans`. Apply never re-checks Scan evidence (C18):
  changing `scans`, the memory or the installed Scan after Prepare does not reject the reviewed Apply.

## Apply authored changes through a change request

A change (`urn:aihq:core:change:0.1.0`) is a hand-written, reviewed edit that is not Catalog content: a settings key, an
array member, a team file, a marked text block, an owned hook group or an exact approved command. It has today's
authoring shape and rules, under one version: the operation kinds `file.write`, `file.remove`, `config.entries`
(JSON, JSONC, TOML, INI, YAML subset, properties), `config.member`, `text.block`, `hook.group` and `process.run`; the
bounded editors of [One complete authoring example](#one-complete-authoring-example); inputs, private inputs, prerequisites
and checks of [Inputs and outcomes](#inputs-and-outcomes); one-server approval of [Allow one MCP server](#allow-one-mcp-server);
and [owned hook groups](#owned-hook-groups). Two names differ from the recipe form: a target `root` is `project` or `user`
(your home folder), and `config.entries` sets keys with `set: [{ path, value }]` (or `{ path, input }` for a declared input)
and removes them with `remove: [{ path }]`. Recipe documents are not changes: `validateChange` answers
`unsupported-version` for any other format id. The formats are not marked ready.

A change request (`urn:aihq:core:change-request:0.1.0`) carries one or more changes for one scope, the ordinary input
values beside each, the management ids each `requires`, and named `groups`:

```js
import { prepare, apply, list, prepareRemoval } from '@aihq/core';
import { validateChange, deriveChangeIdentity } from '@aihq/core/contracts';

const change = { schema: 'urn:aihq:core:change:0.1.0', id: 'codex-approval-on-request', description: 'Ask before Codex runs commands',
  inputs: {}, materials: [], targets: ['user'], prerequisites: [], checks: [],
  operations: [{ id: 'set', purpose: 'Ask before Codex runs commands', kind: 'config.entries', scope: 'user', format: 'toml',
    target: { root: 'user', segments: [{ literal: '.codex' }, { literal: 'config.toml' }] },
    set: [{ path: ['approval_policy'], value: 'on-request' }], requires: [], checks: [] }] };
validateChange(change);                       // { status: 'ok', schema } | invalid | unsupported-version
await deriveChangeIdentity({ change });       // { status: 'ok', changeIdentity: 'sha256:…', changeSha256, materials }
const prepared = await prepare({ schema: 'urn:aihq:core:change-request:0.1.0', mode: 'vibe', scope: 'user', target: { project: null },
  changes: [{ managementId: 'codex-approval-on-request', change, inputs: {}, requires: [] }],
  groups: [{ id: 'team-settings', members: ['codex-approval-on-request'] }] });
if (prepared.status === 'ready')
  await apply(prepared.handle, { approved: true, origin: 'interactive', reviewDigest: prepared.review.reviewDigest });
await prepareRemoval({ target: {}, scope: 'user', removals: [{ managementId: 'codex-approval-on-request' }] });
```

- **One engine.** Each change is one management id and scope. Its operations go through the same Prepare, custody,
  recovery and Apply as every other request, and its review and run are `urn:aihq:core:review:0.1.0` (`request: 'change'`)
  and `urn:aihq:core:run:0.1.0`. In a change review and run, `step` is the operation id; each step has one sentence, the
  operations it `requires`, and its exact `details` (target, edits, block, hook group, member, and for `process.run` the
  executable and its sha256, argv, working folder, environment, accepted exit codes and bounds). Private values are
  redacted. A command's effects are opaque (`effect: 'opaque-process'`), with the line that Core can't show or undo them;
  a failed or cancelled command is reported `effectsUncertain` and never claims a rollback.
- **Materials** are inline, or a change acquired by `reference` instead of `change`: a pinned local folder named by
  `controls.materialRoots: { id: absolutePath }`, an HTTPS archive, or one exact GitHub commit archive, each checked by
  length and sha256 exactly as in [Install from an exact git commit](#install-from-an-exact-git-commit). The referenced
  member is itself a change document.
- **Inputs.** Ordinary values sit in `changes[].inputs`. Secret values go in `controls.privateInputs`, keyed by management
  id; they never appear in the review, history or receipts, and a changed value rejects Apply (`REVIEW_STALE` `input`).
- **`requires`.** A required change cannot be removed while its dependant is installed: removal names it `retained`.
- **Named groups (C50).** A group states the whole set it manages. Leaving a member out of the next request proposes,
  after review, removing that member's content; an empty `members` proposes removing all the group's earlier members.
  Unrelated content, and your edits to shared files, stay.
- **Identity.** `deriveChangeIdentity` hashes the canonical change (or, for a reference, its exact bytes) and its
  material closure; Prepare records the same identity in custody.
- **Conflicts.** Your existing file or value is a conflict and Prepare is `blocked` with no handle. Prepare again with
  `resolutions: [{ managementId, step: <operation id>, choice: 'replace' | 'adopt' | 'skip', observedSha256 }]`; `replace`
  keeps your original and removal writes it back; `skip` leaves that operation out, with every operation of the change
  that waits for it, and makes the review `partial` (Apply then needs `allowPartial: true`).
- **Enterprise.** With `mode: 'enterprise'` and `controls.organization`, each change is admitted by its identity, inputs
  and lifecycle permissions (see [Enterprise admission](#enterprise-admission-010-in-development)).

```sh
aih change change-request.json [--project <path>] [--material-root <id>=<folder>]... [--private-input <managementId>.<input>=<ENV>]...
           [--resolutions <file>] [--apply [--yes] [--allow-partial]] [--no-log] [--json]
aih validate change change.json --json
aih validate change-request change-request.json --json
```

Exit codes are those of the plan request commands above.

## Enterprise admission

Enterprise applies only when a plan, change or removal request says `mode: 'enterprise'` **and** the controls name the
organization source: `controls.organization` is `{ provider: 'local', path }` (an absolute path to one regular file, read
offline) or `{ provider: 'github', repository: { owner, name }, path, revision: { kind: 'branch' | 'tag' | 'commit', value } }`
(read through the Harness GitHub reader; `controls.authentication` may carry `{ kind: 'bearer', token }` for a private
repository). Either one alone is not admitted: the mode without a source is `refused` `organization-required`, a source
without the mode is `invalid` (`organization-vibe`). Core reads the document fresh at Prepare and again at Apply; a
different document, or the same path at another commit, makes Apply `rejected` `REVIEW_STALE` `changed: policy` before
anything runs. A source that can't be read is `refused` `organization-unavailable`; a document over 1,000,000 bytes is
`refused` `limit-exceeded` (`document-bytes`); one deeper than 32 levels or otherwise malformed is `invalid`.

```js
import { prepare, apply } from '@aihq/core';
const request = { ...planRequest, mode: 'enterprise',
  target: { project: '/work/app', client: { id: 'codex', surface: 'cli' }, repository: 'github.com/acme/app' } };
const controls = { organization: { provider: 'local', path: '/etc/acme/organization.json' }, catalog };
const prepared = await prepare(request, controls);
// prepared.review.organization: { id, source, contentDigest, target, admitted, denials, advisory, fulfilment, scanSigners }
// A denial: { status: 'blocked', code: 'AUTHORITY_DENIED', reason, review } with no handle.
const run = await apply(prepared.handle, approval, controls);
// run.organization: { id, fulfilment } over the claims the run left.
```

The organization document `urn:aihq:core:organization:0.1.0` holds `entries`, `sources` and `scanSigners`:

- **Content entries** `{ id, obligation, scopes?, clients?, repositories?, content: { item?, kind?, framework?, recipe? } }`
  (C31). `obligation` is `permitted`, `recommended`, `required` or `prohibited`. Every named field must match: `item`
  matches a step's `item` or `items` (or a framework step's `contains`), `framework` and `kind` come from the content
  documents the plan was made from, and `recipe: { id, sha256?, commit? }` matches **only an origin Core proved** (C44).
  A plan that merely names a recipe, unproven, never satisfies a recipe selector; a prohibition on that recipe fails
  closed on it. `scopes`, `clients` (registry ids) and `repositories` narrow an entry; omitted, they impose nothing.
- **Change entries** `{ id, obligation, change: { identity }, inputs?, lifecycle?: { replace?, adopt?, remove? } }` admit
  changes by `deriveChangeIdentity`, as recipe entries did: a change no entry admits is denied
  (`change-not-admitted`); each explicit, default or secret input needs a permission (`allowDeclared`, `fixed` or
  `choices`; a secret only `allowDeclared`); a reviewed `replace` or `adopt` needs that lifecycle permission; removing
  a change needs `lifecycle.remove`. Content entries govern plans and change entries govern changes.
- **Sources** (C31): `sources.published: [{ repository, commit? }]` lists the data repositories a plan may come from,
  optionally pinned (`source-published`, `source-pin`); `sources.own.kinds` lists the kinds own content (`data: null`)
  may have (`own-content`). Without a rule, any repository and all own content are allowed.
- **Scan signers** (C35): `scanSigners.replace` and `scanSigners.add` are carried into the review as declared; they change
  which Scan results show as trusted and never block anything.
- A `required` and a `prohibited` entry that provably select the same content on overlapping targets make the document
  `invalid` (`obligation-contradiction`); so do duplicate entry ids and client ids that are not registry ids.

**Targets.** The caller declares `target.client` (`{ id, surface }`, a registry tool) and optionally `target.repository`;
Core never infers them. A plan step's client is the CLI the plan records for it, and the declared client otherwise.

**Three kinds of result.**
- **Enforced:** a prohibition that applies, a disallowed source or an unpermitted change input or lifecycle denies the
  whole request: Prepare is `blocked` with `code: 'AUTHORITY_DENIED'`, its `reason` naming the entry or source rule,
  and no handle; a removal is `ok` with every prepared entry `blocked`, `code: 'AUTHORITY_DENIED'` and no handle. A
  prohibition that needs a fact that was not declared or recorded (a client, a repository, an item's kind) fails closed
  (`target-unknown`). Removing plan content is not gated.
- **Advisory:** each `recommended` entry is `taken` or `not-taken` by what this request adds. Never a gate.
- **Fulfilment:** each `required` entry is `fulfilled`, `not-fulfilled`, `not-applicable` or `unknown`, projected in the
  review over the claims after the request (the receipts for this project, scope and client, plus what it adds, minus
  what it removes or replaces), and reported in the run over the claims the run actually left (C71). `unknown` (with the
  missing facts) never means fulfilled. Never a gate.

Updates are admitted like installs: each update's request carries its own `mode` and is prepared with the same controls;
a denial leaves every entry `blocked` and the update without a handle.

**Preview.** `previewAdmission({ organization, request, target?, installed? })` from `@aihq/core/contracts` answers the
enforced, advisory and fulfilment results for a plan or change request document in one call, with no host effects
(asynchronous: change identities use Web Crypto). `installed` is the caller's copy of `list`'s inventory for that target;
without it, fulfilment counts only this request. `list` names each installed change's identity (`change: { identity }`, as
`deriveChangeIdentity` derived it at install), so a required change entry reads `fulfilled` from the inventory. A preview proves no recipe origin, so a required recipe reads
`unknown`. `validateOrganizationPolicy` reads an organization 0.1.0 document as `{ status }` (older documents keep their
retained result).

**CLI.** `aih install`, `aih change`, `aih update` and `aih remove` take `--mode enterprise` with `--org-file <path>`, or
`--org-repository <owner/repo> --org-path <path> --org-ref <branch:name|tag:name|commit:sha> [--org-token-env <NAME>]`.
`aih validate organization <file>` reads a document (exit 0 `ok`, 2 otherwise). A denial exits 1, like any blocked
preparation.

Receipts of plan installs now record the item's `kind` and `framework` (from the content documents) so fulfilment can
count installs made before; `list` shows them. Receipts made before they were recorded read as `unknown` for kind and
framework selectors.

## Repair, export and the macOS session through the 0.1.0 review

Environment work takes the shared review and run: `prepare` returns `ready`, `partial`, `blocked`, `refused`, `invalid`
or `unsupported-version`, the review is `urn:aihq:core:review:0.1.0` with `request` set to `repair`, `export` or
`macos-session`, and `apply` returns `urn:aihq:core:run:0.1.0`. Each request is carried out by the retained repair,
trust or session preparation below, so source, host, target and custody checks, restoration and managed removal are
unchanged. Standalone repair takes no organization document.

```js
import { prepare, apply } from '@aihq/core';

const prepared = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'user-tools-ca', targets: ['git'],
  route: 'file', sources: { os: false, supplied: [{ id: 'company', file: '/abs/company-ca.pem' }] } });
// prepared.review.environment: job, repair, targets, route, network, facts (sources, certificates, outputs and each
// target's admission), observations and anything `unavailable` on this host.
if (prepared.status === 'ready')
  await apply(prepared.handle, { approved: true, origin: 'interactive', reviewDigest: prepared.review.reviewDigest });
```

| Request | Carries |
| --- | --- |
| `urn:aihq:core:repair-request:0.1.0` | `repair` (`node-npm-ca`, `node-os-trust`, `user-tools-ca`, `jvm-ca`), `targets`, `route` (`file` by default, or `native`), `sources` (by default the OS trust), `inputs` (such as `baselineStore`), `network`, `resolutions` |
| `urn:aihq:core:export-request:0.1.0` | `format`, `output`, `sources`, `network`, `resolutions` |
| `urn:aihq:core:macos-session-request:0.1.0` | a trust repair's fields plus `session` (`context`, `applications`) |

- **Supplied file trust is not native trust.** A supplied-file route is admitted per target only for that file route;
  `native` routes and OS-sourced file routes stay `blocked`, naming the reason in `environment.unavailable`, until a real
  client binding is admitted. Certificate export needs an admitted platform cell; elsewhere it is `blocked`
  (`trust-platform-unsupported` or `trust-format-unavailable`) with no effects. The macOS session is admitted only on
  macOS with an admitted profile. No new native profile or platform is admitted by this format.
- **Conflicts.** An edited managed output whose bytes still read as certificates is `existing-content` with `replace`;
  prepare again with `resolutions: [{ managementId, step, choice: 'replace', observedSha256 }]` taken from the review.
  Bytes that no longer read back are `managed-content-changed` with no choices and are kept. A resolution that names no
  reviewed conflict is refused (`resolution-unknown`).
- **Apply** binds the exact `reviewDigest` and the request object, then re-checks sources, configuration files,
  executables, helpers and custody; a change is `rejected` `REVIEW_STALE`.
- **Custody** is stored as `urn:aihq:core:trust-custody:0.1.0` and `urn:aihq:core:macos-session-custody:0.1.0`.
- **The macOS session check.** `verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:0.1.0',
  managementId })` returns `urn:aihq:core:macos-session-verification-result:0.1.0`; it only observes, and an unsupported
  host is `incomplete` with its reason. Admitted session profiles are described by `urn:aihq:core:macos-session-profiles:0.1.0`;
  the bundled list admits none.

The CLI takes 0.1.0 inputs files whose supplied paths resolve from the file's own folder:

```sh
aih repair user-tools-ca --target git --inputs-file repair-inputs.json [--offline] [--apply --yes] [--json]
aih export-ca --format pem --output exports/company.pem --inputs-file export-inputs.json [--apply --yes] [--json]
```

`repair-inputs.json` is `{ "schema": "urn:aihq:core:repair-inputs:0.1.0", "route": "file", "sources": { "os": false,
"supplied": [{ "id": "company", "file": "company-ca.pem" }] } }`; `export-inputs.json` uses
`urn:aihq:core:export-inputs:0.1.0` with `sources`, and a macOS session uses `urn:aihq:core:macos-session-inputs:0.1.0`
with `session`. Without an inputs file, `aih repair` prepares the OS-sourced file route.

Without `--apply` both commands print the preparation. With `--apply` the command prepares again and approves that
review, so it prints `{ "review": …, "run": … }`: the review it approved, and the run, whose `reviewDigest` names it.
A preview printed by an earlier command is a separate preparation; its `reviewDigest` differs, and only the review
printed with the run was approved.

A repair run lists each member it touched in `members`, checked on disk after Apply (`present-matching`,
`present-different`, `absent` or `unchecked`). Removing a repair with `prepareRemoval` (`aih remove <repair-id>
--scope user`) checks every member it releases the same way, and each removal step is verified from those checks
(`passed` `member-checked`). A configuration file the repair created, such as a `pip.conf` that did not exist before,
is removed with its last entry; a file you already had keeps your own settings, byte for byte.

The `user-tools-ca` file route writes a CA file setting, so it needs the selected Git or Cargo to use a TLS backend
that reads one: OpenSSL, Schannel (Windows) or GnuTLS. Git's backend is its `http.sslBackend` setting, or GnuTLS when
`git version --build-options` names libcurl with GnuTLS; Cargo's is the `ssl:` line of `cargo -Vv`, or the TLS library
its `libcurl:` line names (`ssl:GnuTLS/…` on Ubuntu). Any other backend is `backend-unconfirmed`
(`cargo-effective-backend-unconfirmed`), and the review names the target that blocked it.

## What each result status lets you claim

Check install and removal wording against this table. Each status establishes only what its row says; the fields are independent, so read them together. Operation `application` and `verification` are per operation in a run result; `completion` is the whole run; `disposition` is the `prepareRemoval` (`aih remove`) entry before any Apply.

| Field | Value | Establishes | May claim | May not claim |
|---|---|---|---|---|
| `application` | `applied` | Core performed this operation's reviewed effect in this run. | "Applied", or for a removal operation "removal applied". | "Installed", "working" or "removed" from this value alone (see the install and removal wording below); that the effect was checked (see `verification`). |
| `application` | `already-satisfied` | The target already had the desired state, so Core wrote no target bytes for it; a reviewed adoption or custody-only step may still record Core's custody. | "Already in place" or "no change needed". | That Core wrote it, or that matching unowned bytes became managed without reviewed adoption. |
| `application` | `failed` | The operation was attempted and did not succeed; `reason` and `effectsUncertain` say more. | "Failed"; with `effectsUncertain`, "may be partly changed". | "Nothing changed" or "rolled back". Prepare again before further changes. |
| `application` | `not-attempted` | Core did not run this operation in this run, for example after an earlier stop, cancellation or rejection. | "Not attempted". | "Failed", "unchanged by anyone" or any outcome for the target. |
| `verification.status` | `passed` | Every check supplied for the operation passed in this run, at that time. A removal step is instead checked on disk and reports reason `member-checked` (see that row). | "Verified by its supplied checks". | More than those checks test, or that the state persists later. |
| `verification.status` | `failed` | At least one supplied check did not pass, including a check that was itself unavailable. | "Check failed". | That the effect is absent or reverted; `application` reports the effect separately. |
| `verification.status` | `unverified` | Nothing confirmed the operation's effect in this run. An operation that was not attempted also stays `unverified`. | "Not verified". | "Verified", "confirmed" or "removed". |
| `verification.status` | `unverified`, reason `no-supplied-check` | In a `complete` run, with `application` `applied` or `already-satisfied`: no check was supplied for the operation, so Core ran none. Convenience removals and generated lifecycle cleanup carry no supplied checks, so under run results 1.0 to 1.3 they keep this value; under run result 1.4 or 1.5 a removal operation reports `member-checked`, `member-changed` or `member-unchecked` instead. Every operation starts with this value, so in any other run, or with any other `application`, it says nothing about supplied checks; read `checks` for that operation. | "Applied, not verified" when `application` is `applied`. | That the target was checked, or that an applied removal is gone from disk. |
| `verification.status` | `passed`, reason `member-checked` | A removal operation in a run result 1.4 or 1.5: after Apply, Core read every member the operation removed, kept or restored from disk, and each owned path is `absent` or the value it kept or restored is `present-matching`. | "Removal verified on disk" for that operation, at that time. | That it stays removed later, or anything about unowned content or members another claim keeps. |
| `verification.status` | `failed`, reason `member-changed` | A removal operation in a run result 1.4 or 1.5: at least one of its members is `present-different` after Apply, so something else wrote the path or the member cannot be selected uniquely. The run is `incomplete` and keeps its recovery data. | "Removal not confirmed: changed on disk". | "Removed", or that Core's own effect was undone. |
| `verification.status` | `unverified`, reason `member-unchecked` | A removal operation in a run result 1.4 or 1.5: no member is `present-different`, but at least one is `unchecked` (not attempted, or its target was unreadable). | "Removal not verified". | "Removed" or "changed on disk". |
| `verification.status` | `unavailable` | Verification stopped without a result: the run was cancelled during the operation's checks, or offline repair suppressed network verification. | "Verification unavailable". | "Passed" or "failed". |
| `verification.status` | `skipped` | Reserved by the schema for verification deliberately not performed; Core does not currently report it for an operation (check rows in `checks` can be `skipped`). | "Verification skipped". | "Passed" or "failed". |
| `disposition` | `prepared` | A live claim was found and the inner cleanup-only Prepare ran; read its `preparation.status`. Only `ready` or `partial` carries an Apply handle, and `partial` omits conflicting work that needs explicit partial approval. `blocked` (for example locally edited managed content or an Enterprise authority denial) offers nothing to Apply; its `diagnostics` say why. Nothing has been removed yet. | "Removal ready for review" only when `preparation.status` is `ready`; "Removal partly ready for review" when `partial`; otherwise "Removal blocked" with its diagnostics. | "Removed" or "removal applied"; "ready for review" from `prepared` alone. Approve and Apply a reviewable preparation first. |
| `disposition` | `absent` | No claim for this management ID is recorded in that scope. | "Not managed by Core in this scope". | That the target bytes are absent; unowned content is never inspected or deleted. |
| `disposition` | `retained` | Another managed selection still requires this one, so its claim is kept and no removal was prepared. | "Kept because another selection needs it". | "Removed" or "removal pending"; remove the dependent selection first. |
| `disposition` | `reconcile-required` | Recorded custody and the live state disagree, or a legacy member has no claim, so nothing was prepared. | "Needs reconciliation before removal". | "Removed" or "not managed". |
| `disposition` | `unavailable` | Custody or a prerequisite could not be verified, so nothing was prepared. | "Could not check". | "Absent", "not managed" or "removed". |
| `disposition` | `invalid` | The request was malformed or its organization source was wrong. | "Request invalid". | Anything about custody or the target. |
| `disposition` | `cancelled` | Preparation stopped on cancellation. | "Cancelled". | Anything about custody or the target. |
| `removals[].members[].action` | `remove` | The reviewed plan removes Core's bytes of this member. | "Will be removed" before Apply. | "Removed" before `removalClaims` says so. |
| `removals[].members[].action` | `restore` | The reviewed plan writes back the person's earlier value. | "Will be restored" before Apply. | "Restored" before the run's member check. |
| `removals[].members[].action` | `unregister` | The member was already gone; the plan releases only Core's claim. | "Already gone; Core stops managing it". | That Core removed it. |
| `removals[].members[].action` | `keep-shared` | Another selection or origin still owns this member. | "Kept for another selection" or "kept for another set". | "Removed". |
| `removals[].members[].action` | `keep-changed` | The person changed this member; it stays, under Core's claim. | "Kept because you changed it". | "Removed" or "unchanged". |
| `removals[].members[].action` | `keep-required` | A licence or notice file kept with an item that keeps a changed member. | "Kept: the item's licence or notice". | "Removed". |
| `updates[].members[].action` | `add`, `replace`, `remove`, `restore`, `unregister` | The reviewed update plans this change to the member. | "Will be added", "will be updated", "will be removed" or "will be restored" before Apply. | "Updated" before a `complete` run's member checks confirm it. |
| `updates[].members[].action` | `conflict` | The review leaves the member exactly as it is, for the named `reason`; a local edit is never overwritten. | "Kept as you changed it" for `managed-content-changed`; otherwise "not updated", with the reason. | "Updated", or that the whole item now matches the replacement. |
| `updateState` after an incomplete update | `current` | Custody records the replacement's identities with the members an `incomplete` update run wrote. | "Recorded as the replacement", reading each member's `fileState`. | That the item matches the replacement while any member reads `changed`, or while a member the replacement dropped is still listed. |
| `completion` | `complete` | Every reviewed operation was `applied` or `already-satisfied` with verification `passed` or `unverified`, and nothing was omitted. | "Run complete". | "Verified" while any operation is `unverified`; read each operation. |
| `completion` | `incomplete` | Apply ran, but some operation did not end `applied` or `already-satisfied` with verification `passed` or `unverified`, or something was omitted, or a post-Apply custody or session check failed although every operation succeeded (see `diagnostics`), or a removal operation's member check reported `failed` with reason `member-changed`. It may have changed nothing; completed effects are kept. | "Not complete", naming any operations that were applied. | "Complete", "rolled back" or that the applied subset is the whole result. |
| `completion` | `cancelled` | The run stopped on cancellation. Effects completed before it are kept. | "Cancelled", naming the operations that were applied. | "Nothing changed". |
| `completion` | `rejected` | Apply refused the request before starting work, for example a stale review or missing approval. | "Not run". | Any change to the target. |
| `members[].intent` | `write` | The reviewed plan writes this member. | Nothing on its own; read `outcome` and `check`. | That it was written. |
| `members[].intent` | `remove` | The reviewed plan removes this member, or restores the person's value it replaced. | Nothing on its own; read `outcome` and `check`. | That it was removed. |
| `members[].intent` | `keep` | The plan released this selection's claim, but another claim keeps the member. | "Kept for another selection". | "Removed". |
| `members[].outcome` | `written` | The run wrote this member, or found it already in place. | "Written", with `check`. | "Confirmed on disk" without the run-level rule below. |
| `members[].outcome` | `claim-removed` | The run removed Core's claim and the member's bytes Core owned. | "Removal applied" for this member. | "Removed" unless `check` is `absent`. |
| `members[].outcome` | `restored` | The run wrote back the value the person had before Core replaced it. | "Restored" when `check` is `present-matching`. | "Removed" while `check` is anything else. |
| `members[].outcome` | `kept` | The run left the member as it was: shared, preserved, failed or never attempted. | "Not changed by this run". | "Written", "removed" or "failed" from this value alone. |
| `members[].check` | `present-matching` | After Apply the member is on disk exactly as this run left it. | "Present as expected" at that time. | That it persists later, or works. |
| `members[].check` | `present-different` | The member is present but not as this run left it, or cannot be selected uniquely. | "Changed or ambiguous on disk". | "Written", "restored" or "absent". |
| `members[].check` | `absent` | The member is not on disk (file missing, block markers or entry gone, no matching hook group). | "Absent" at that time. | "Present". |
| `members[].check` | `unchecked` | Core did not check it: the run never attempted it, or the target was unreadable. | "Not checked". | Anything about the member. |

An applied removal is not by itself "removed". `application: applied` means Core performed the reviewed removal. Apply checks each cleanup step's members on disk after the run: `passed` (reason `member-checked`) means each one is `absent`, or `present-matching` for a value it kept or restored; any `present-different` member makes the operation `failed` (reason `member-changed`) and the run `incomplete`. Use the member claims below for such a result. A removal step with no member checks stays `unverified` (reason `no-supplied-check`): nothing confirmed the result. To confirm such a removal:

1. Require `completion: complete` with every removal operation `applied` or `already-satisfied`. Otherwise prepare again.
2. Call `list` (`aih list`) for the same project and scope. Only an inventory with `observation: complete` that no longer lists the management ID confirms the claim is gone; an `incomplete` one confirms nothing.
3. Call `prepareRemoval` again for that management ID and scope. `absent` confirms Core holds no claim; any other disposition means the removal is not confirmed.
4. These confirm Core's custody only. Shared members another owner keeps, preserved directories and unowned content stay in place. Inspect the target yourself before saying the content is gone.

Only then say "removed from Core management"; say "removed from disk" only for files you have inspected. Before confirmation, say "removal applied, not verified".

Install wording follows the same rule. Say "installed" only for an operation that is `applied` or `already-satisfied` in a `complete` run; in any other run name only the applied operations, as the `completion` rows say. Then:

- with verification `passed`, say "installed and verified by its supplied checks";
- with verification `unverified`, say "installed, not verified";
- say "confirmed on disk" only under the run result 1.4 rule below, and "working" only for what you have checked yourself, because no status establishes it.

Run result 1.4 member checks ([samartomar/aih-core#99](https://github.com/samartomar/aih-core/issues/99)) settle both claims directly, and `runMemberClaims(result)` applies them:

- **"Confirmed on disk"** requires run `completion: complete`, every `intent: write` member `outcome: written`, and each of those `check: present-matching`. An `incomplete`, failed, `cancelled` or `rejected` run never qualifies, even when its written subset matches.
- **"Removed"** means every `intent: remove` member is `claim-removed` and `absent`, or `restored` and `present-matching` (back to the person's pre-existing value). Members kept for another claim are not removed.

These claims cover the members the run touched; use them instead of the confirmation steps above when the result carries `members`.

## Guidance and support reports

The portable `@aihq/core/contracts` entry derives actionable guidance from an
existing public result without any host access, process execution, network,
writes or state lookup. Wrap the result you already have as
`{kind: 'inspect'|'prepare'|'run', result, repair?}` (`repair` carries only the
published repair `id` and selected `targets`) and pass an explicit
`{platform}` (`win32`/`darwin`/`linux`/`unknown`):

```js
import { getGuidance, renderSupportMarkdown } from '@aihq/core/contracts';

const guidance = getGuidance({ kind: 'inspect', result: inspection }, { platform: 'win32' });
const rendered = renderSupportMarkdown({ kind: 'inspect', result: inspection }, { platform: 'win32' });
```

Prepare and run results are interpreted from the stored trust and macOS session review and run records the
guidance reads. Each must satisfy the schema and contract rules of its exact `schema` ID, so undeclared fields or a
document relabelled with another known ID return `INPUT_INVALID`; an unknown or future ID returns `SCHEMA_UNSUPPORTED`. Inspection results and the Prepare
wrapper (`status`, `runId`, `diagnostics`, `record`) have no published schema and
keep their bounded shape checks. Support reads each input once as strict JSON
limited to 1,000,000 canonical UTF-8 bytes and depth 32 for the whole
`{kind, result, repair?}` wrapper (a Prepare result's live `prepared` handle is
skipped, not read). A larger result returns `INPUT_INVALID` even when it is
otherwise valid; Core's produced-format validators themselves set no such cap.

`getGuidance` returns ordered items naming the audience, summary, steps and any
applicable published repair with its required inputs; `renderSupportMarkdown`
returns a sanitized Markdown summary of the same content. Guidance never
executes a command, reruns an observation, or authorizes anything; a suggested
repair still needs its own explicit Prepare/Apply review.

The Node host adds `writeSupportReport(input, {platform, path, signal?})` on
`@aihq/core`, and the CLI adds `--support-markdown <path>` to `inspect`
and `repair` (preview and `--apply` forms export the one final result
of that invocation):

```sh
aih inspect --target node --offline --json --support-markdown inspection-report.md
```

The report is written only on this explicit request, to the exact absolute path
(a relative path is resolved against the current directory by the CLI). The
path must end in `.md` (any letter case) with a plain file name, its directory must already exist, and creation is
exclusive: an existing file is left byte-for-byte untouched, links and
nonregular destinations are refused, nothing creates directories, chooses
suffixes, overwrites, shares or uploads. JSON stdout is unchanged with or
without the flag; stderr carries one receipt (`Support report written: <path>`)
or one failure line (`Support report not written: <reason>`). A successful
operation whose export fails exits 1; existing nonzero exits are preserved.
Non-JSON `inspect` and `repair` invocations also append the same human next
actions to stderr; JSON mode never prints that prose.

Report content follows a strict allowlist rather than secret-pattern search:
freeform diagnostic messages, check details, paths, URLs, configuration and
credential material are omitted, so a report is safe to review. Review the
report yourself before sharing it — nothing shares it for you.

## State and recovery

Core uses the current account's `~/.aih/core` for protected ownership records, recovery manifests, private original-file snapshots and redacted run history. Required state protection or persistence failure prevents/marks incomplete the affected mutation. A history-write failure is returned as `record.status: failed` separately from target outcomes. One history record holds the redacted run result and is at most 1 MiB (1,048,576 bytes), the bound of every file in Core's state except an ownership record; a larger result is not recorded and reports `record-limit`. An ownership record is at most 2 MiB (2,097,152 bytes) as stored. It holds a member for each file of each tool's copy of each selection, so it grows with tools × items × files, and it is stored without what it can derive from itself: a file member's descriptor (its key, or just its path where that differs from the key in case, as on Windows), a claim's management ID and sets and requires when they are its owner's and its selection record's, each item's typed members, and Catalog facts shared by the tool copies of one item (stored once). A Prepare whose record would exceed the bound, or the record's 8,192 members, 4,096 selection records or 4,096 items, is `blocked` with `SOURCE_LIMIT` reason `custody-record-limit` before any effect. A policy Prepare's record names a required selection once: an operation that requires every operation of another selection lists that selection in `requiresSelections` (every operation of the record's review with that `selectionId`) and keeps its other required ids in `requires`, so the two together are exactly the reviewed requirements. The record also leaves out `operationSelections` when each entry is the review operation at its position, with that operation's `selectionId` and the rest of its `id`. Set `controls.logging: 'off'` to suppress routine history; required ownership and recovery records are still written.

New files use reviewed mode 0600 by default and newly needed parent directories use 0700 on POSIX; Windows files inherit the selected directory's ACL. Core's private state has restricted ownership/ACLs. A recovery manifest points to private original-file snapshots for manual inspection; it is never a resumable plan.

A removal run deletes its own recovery folder and drops `recovery` from its result only when all of these hold: the result is run result 1.4 or 1.5, the run is `complete`, at least one cleanup member was checked and every checked member is `absent` or `present-matching`, and nothing was kept (no kept, conflicting or unavailable cleanup step, and no claim still held). If the deletion fails, the result keeps `recovery` and `diagnostics` reports `recovery-cleanup`. Install runs and every other removal keep their recovery data, including removals under run results 1.0 to 1.3. There is no automatic expiry or cleanup of run history or of kept recovery data.

Strict document admission limits each document to 1,000,000 UTF-8 bytes and depth 32. Duplicate decoded keys, non-NFC/malformed strings, nonfinite/negative-zero/unsafe integer values, number tokens that lose their value, accessors, cycles and non-data objects reject. Canonical JSON uses UTF-16 key ordering, authored array order, UTF-8 and no whitespace. This restricted profile is not unrestricted RFC 8785.

### Published state location

Read where Core keeps its state instead of hard-coding it, for example to refuse a
project folder inside Core's state. The location is information only: it is not
permission to write there. Core alone creates, protects and changes its state, and
its operations refuse supplied targets inside it.

`stateLocation` from `@aihq/core/contracts` is portable and holds relative
descriptors only. It imports nothing from Node and does not discover host paths.
`root` is relative to the current account's home folder; each `projectMarkers`
path is relative to `root`, `/`-separated, and names a child holding Core's records
of the changes it makes to project folders (or home):

```js
import { stateLocation } from '@aihq/core/contracts';

stateLocation.root;           // { base: 'userHome', segments: ['.aih', 'core'] }
stateLocation.projectMarkers; // [{ path: 'ownership', meaning }, { path: 'recovery', meaning }, { path: 'runs', meaning }]
```

| Marker | Meaning |
| --- | --- |
| `ownership` | Ownership records: one per project folder (or home) whose files Core manages. |
| `recovery` | Recovery manifests and private original-file snapshots, one folder per run that changed files. |
| `runs` | Redacted run history, one record per run. |

A marker may be absent until Core first needs it. Core writes no marker file into
project folders. The values are frozen.

`resolveStateLocation()` from `@aihq/core` (Node) returns the same descriptors as
absolute paths for the running host: `{ root, projectMarkers: { path, meaning }[] }`.
It resolves the home folder as Core's operations do, creates and reads nothing,
and throws when the home folder is not an existing absolute directory.

```js
import { resolveStateLocation } from '@aihq/core';

const { root } = resolveStateLocation(); // for example /home/me/.aih/core
```

## Effective Node and npm trust

Inspection records the selected Node host's version separately from npm's
version command, and reports absent or conflicting PATH candidates. Node is the
host running Core, even when PATH points to another Node or contains none.
An unparseable version command is reported without an invented version.

`npm/tls/effective` runs the selected npm process against its configured HTTPS
registry, retaining its environment, project/user configuration, CA overrides
and proxy selection. It requires effective `strict-ssl=true` and refuses an
inherited TLS verification bypass. A pass describes that npm process and
endpoint. The existing `<target>/tls/node/<host>` checks describe Core's Node
TLS view, including the managed configuration projection when requested; they
do not establish npm's effective trust. Offline inspection skips the npm probe.

Prefer inspection before selecting a persistent supplied-CA repair. For
`node-os-trust`, an already trusted endpoint returns the existing `blocked`
preparation status with diagnostic `REPAIR_NOT_NEEDED`, reason
`node-already-trusted`, and no prepared handle or repair effects. No Apply is
needed for that result. A system-CA candidate refuses explicit conflicting
Node trust flags, environment selection or extra-CA override. Supplied bundles
remain an explicit fallback with the existing conflict, exclusion and rollback
review. Nothing disables TLS verification or changes an OS trust store.

The Linux process fixtures use an isolated `SSL_CERT_FILE` and loopback HTTPS
server to verify trusted/untrusted outcomes, npm CA precedence and refusal of
disabled verification. They do not qualify Windows/macOS stores, Linux native
admission, real user accounts or client sessions. Those exact native tuples
remain independently gated.

## Development checks

Source lives in [`samartomar/aih-core`](https://github.com/samartomar/aih-core).
Use Node 26 within the declared engine range. Clone this repository and run the
following commands inside it. Generic engine source lives in `src/core/`; supplied
repair definitions and bounded helpers live in `src/harness/`. Harness does not
import the engine. There is one root manifest and one published distribution;
no sibling checkout is needed.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Ordinary CI runs on pull requests and pushes to `main`, with superseded runs
cancelled. Feature pushes do not duplicate PR checks. Documentation-only edits
report an explicit no-applicable-tests result. Portable reporting changes run
their owning tests and affected package consumers on Linux; platform-facility
changes run the full suite on their affected OS. Shared contracts, dependencies,
build/workflow changes, unknown paths and deleted/renamed paths use the full
four-cell OS/Node matrix. The **Run workflow** action explicitly selects that
full matrix. `Core checks result` fails if any selected job fails or is cancelled.
Other native acceptance and publication workflows retain their own triggers.

Use `npm test -- --suite report` for reporting iteration, or
`npm test -- --files <test paths>` for a focused local check. `npm test` retains
the complete suite.

Create a qualified Core distribution with `npm run pack:distribution --
--pack-destination <existing directory>`. The command builds and packs the root
package, preserves every archive entry's bytes and metadata except the Linux
facility's executable mode, refuses to overwrite an existing artifact, and
reports the final archive's SHA-256 and integrity. Use this command on all
producer platforms; raw `npm pack` can preserve missing executable bits from a
Windows producer. Pack from a real `npm ci` install: npm bundles the bundled
dependencies' own dependencies (such as `@sigstore/core`) only from installed
files, so the command refuses a missing or linked `node_modules` (a symlink or
Windows junction to another checkout's). See the [Linux packaging checks](docs/native-linux-verification.md#build-records-and-development-checks).

Linux native verification pins exact runtime bytes. After distro updates change a
pinned library, verification refuses with `isolation-unobserved`; see
[Re-capturing the platform record](docs/native-linux-verification.md#re-capturing-the-platform-record-after-distro-updates).
On the reference host the developer-only report command is read-only:

```sh
node scripts/recapture-linux-runtime-platform.mjs --client <path>
```

Tests exercise public boundaries with temporary homes and target directories.
`npm test` includes the migrated Harness CA/candidate tests. The package test
installs one Core tarball into an isolated consumer, imports public schemas and
APIs, runs the installed CLI and repair, and bundles/runs both portable entries
without Node globals. It also rejects prepared repair after bundled helper bytes
change, builds and installs a new Core version with changed Harness content, and
restores the original artifact. Never target a source checkout with the product
CLI during development. Build/pack needs no donor checkout, Catalog, Scan, vendor
engine or private engineering files.

The public-consumer gate installs an explicitly selected Core artifact into an isolated consumer and checks what a
consumer observes: exactly the four entries and two bins, nothing from contract section 17 importable, one schema per
format with its fixtures, Scan reached only through the optional `@aihq/scan/read` peer, an own-content plan and a
change installed, listed, compared and removed with receipts in the one receipt format, and the published Harness data.
It writes `acceptance.json` with every check and what it did not exercise. Run after building and packing Core:

```sh
npm run verify:public-consumer -- --core /artifacts/core.tgz [--catalog /artifacts/catalog.tgz] [--scan /artifacts/scan.tgz] --output /new/consumer-evidence
```

The output directory must not exist. Without `--catalog` and `--scan`, the plan uses Core-side fixtures and
`notExercised` names the producer checks that need the delivered Catalog and Scan artifacts.

The build removes obsolete generated output and copies only shipped Harness
files. Portable package identity is generated from the root manifest, shared by
both modules, and checked against the installed manifest by host operations.
Repair review/result `inputs.package` names that Core distribution;
`helperSha256` binds the manifest, generated identity and shipped Harness helper
bytes, while `sourceSha256` binds selected repair inputs. Schema IDs retain their
independent versions. Published Harness changes require a new Core package
version and a deliberate Core update through ordinary package management.
Unpublished local builds are distinguished by source commit and artifact digest.

CI runs these gates on Linux, Windows and macOS. The separate manually invoked
native macOS trust acceptance uses a disposable runner, installs a temporary CA
in its OS keychain and exercises packed system-CA and supplied npm repair. It
requires a macOS 26 arm64 runner and establishes native evidence only when run.

## Reporting

`aih report --output <new-directory> --json` acquires bounded offline Node/Git diagnostics and writes the projected `urn:aihq:core:report:0.1.0` snapshot as `report.json`. Use repeated `--target` for selected offline Harness diagnostics. `aih report --snapshot <report.json> --output <new-directory> --json` validates and re-exports supplied data without acquisition; the CLI accepts snapshot files up to 1,000,000 bytes, while the portable JSON import API has a 2 MiB raw-input limit and its own documented structural bounds. Core writes no HTML: presentation is done by the consuming application from the snapshot data. Report-only options are rejected by other commands. Outputs require a new directory and do not overwrite existing reports.

`@aihq/core/contracts` exports `createReport`, `validateSnapshot`, `importSnapshot`, `exportSnapshot`, `validateClaimSet`, `readClaimSet`, `projectClaims` and the `report:0.1.0`/`claims:0.1.0` identities; `schemas` holds their JSON Schemas. The data import has no host effects, and Core ships no report renderer. Both formats are **experimental**, with runtime validation and explicit unsupported-version rejection.

Read [reporting contracts](docs/reporting/CONTRACT.md), [field/source mapping](docs/reporting/FIELDS.md) and [reproduction](docs/reporting/REPRODUCE.md). Consumer-owned [data](examples/reporting/data-only.mjs) and [loopback HTTP](examples/reporting/http.mjs) examples use only public imports. Unsupported analytics stay EMPTY. Supplied assertions remain unauthenticated; presence/configuration is not verification, and importing or serving a snapshot does not collect observations.
