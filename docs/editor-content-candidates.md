# Editor content candidate preparation

These are unqualified source candidates for Cursor **3.27.14**, VS Code
**1.143.1** with **GitHub.copilot-chat 0.48.1**, Kiro IDE **1.4.26** and
Zed **1.25.3**. No editor has a shipped native binding observation. The package
therefore continues to refuse editor delivery and compatibility selection with
`PREREQUISITE_UNAVAILABLE` / `tool-not-observed`. This preparation does not
activate a client, install an extension or advertise native support.

The public fixture
`@aihq/core/fixtures/harness/tool-binding/1.0.0/editor-candidates.json`
carries candidate identities, source URL/retrieval time/SHA-256, existing
`tool-binding:1.0.0` layout documents, and explicit gates for each of the six
Windows/macOS/Linux × x64/arm64 cells. It is a preparation example, not a new
registry, format or native run record. Each binding validates with
`validateToolBinding`; its digest covers canonical JSON without `digest`.
The observed `toolBindings` table and original native records remain unchanged.

```js
import candidates from '@aihq/core/fixtures/harness/tool-binding/1.0.0/editor-candidates.json'
  with { type: 'json' };
import { deriveCellSupport, renderDelivery } from '@aihq/core/harness';

const candidate = candidates.find(entry => entry.tool === 'zed');
const platform = { os: 'linux', arch: 'x64' };
deriveCellSupport({ kind: 'skill', observations: candidate.binding.layouts.skill.observations,
  platform, installedVersion: candidate.installedVersion });
// { support: 'unconfirmed', observed: 'none', stale: false }
// Given a checked Catalog item:
// renderDelivery({ tool: candidate.tool, binding: candidate.binding, item,
//   scope: 'project', platform, installedVersion: candidate.installedVersion });
// Refused: tool-not-observed. A configured path does not enable delivery.
```

## Candidate surfaces

| Candidate | Documented preparation | Qualification still needed |
| --- | --- | --- |
| Cursor editor | One `.agents/skills` copy; `.cursor/rules/*.mdc`; `.cursor/hooks.json` | Exact editor artifact, same-name skill precedence, `.mdc` frontmatter conversion, event/payload/response and shell behavior, trusted-workspace loading/use |
| Copilot in VS Code | `.github/skills`; `.github/copilot-instructions.md` | Exact installed editor/extension pair, settings, enabled proposed APIs, skill/instruction loading/use |
| Kiro IDE | `.kiro/steering`; standalone `.kiro/hooks/*.json`; `.kiro/settings/mcp.json` | IDE-specific hooks, steering inclusion, MCP approval and actual use, workspace trust and isolation |
| Zed Agent | Shared `.agents/skills`; native `AGENTS.md` with legacy precedence | Direct-child skills, same-name conflicts, first existing instruction file, actual Zed Agent loading/use |

These paths come from moving official documentation retrieved on October 27,
2026 (Zed source hashes retain the October 26 retrieval). Documentation is not
proof of the selected build's behavior. The candidate bindings leave unselected
kinds without roots and all observations empty. There is no observed converter,
new hook adapter or inferred event mapping. In particular, plain `.md` files in
Cursor's rules folder are not substituted for `.mdc` rules, and a Claude hook
group is not converted to a Cursor or Kiro hook.

The Copilot extension manifest was fetched independently from the exact
[marketplace manifest](https://GitHub.gallerycdn.vsassets.io/extensions/github/copilot-chat/0.48.1/1778884121163/Microsoft.VisualStudio.Code.Manifest).
It identifies `GitHub.copilot-chat` **0.48.1**, declares VS Code `^1.120.0`,
Node `>=22.14.0`, npm `>=9.0.0`, and enabled proposed APIs. Manifest SHA-256:
`b70ad0b117bc4b202df5eb39a079575e6493b21676310a0c8d071d239c12f585`.
This is a sourced candidate input, not an installed observation or proof that
this extension works with VS Code 1.143.1. Its VSIX/transitive closure and the
selected editor's proposed-API compatibility remain unqualified.

Zed's project instruction precedence is the first existing file in this order:
`.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`,
`.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`. Delivering `AGENTS.md` while an earlier file exists cannot establish
that it is loaded. Personal instructions use `~/.config/zed/AGENTS.md` or
`%APPDATA%/Zed/AGENTS.md`; no common user rule root is supplied. Keep one shared
skill copy and inspect conflicts before any later native operation. Zed external
ACP agents use their own content-loading contracts.

CLI IDs (`copilot`, `kiro`) and editor IDs (`copilot-vscode`, `kiro-ide`) remain
independent. Cursor editor and agent CLI builds are different subjects. No CLI,
Linux patch-metadata or extension-manifest observation qualifies an editor,
another architecture or another content kind.

## Evidence and remaining acceptance

The packed candidate consumer validates identities/digests/layouts, checks all
six platform cells and exact/mismatched-version refusals, and confirms that
missing or supplied MCP approval and unselected content kinds cannot bypass the
editor gate. The existing packed delivery consumer separately covers exact
successful rendering, version mismatch, per-server approval refusal and
Enterprise policy refusal using observed CLI controls. Those controls do not
prove successful editor rendering or policy execution in an editor.

Successful editor render/Prepare/Apply and native recognition/use remain gates.
Before promotion, select immutable editor, extension, runtime and material bytes;
obtain separately scoped native authority; prove harmless loading and use under
qualifying isolation, exact hook allow/block behavior where selected, per-server
MCP approval, policy refusal and cleanup. Capture configured path, registration,
listing, actual loading/use and native admission as separate facts. Do not add
synthetic observations to turn an unconfirmed candidate into support. Unknown
kinds and platforms remain unsupported for selection and unconfirmed as evidence.
Product **0.1.0 remains unreleased/not-ready**.

Sources: [Cursor skills](https://cursor.com/docs/skills),
[Cursor rules](https://cursor.com/docs/rules),
[Cursor hooks](https://cursor.com/docs/hooks),
[VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills),
[Kiro steering](https://kiro.dev/docs/steering/),
[Kiro hooks](https://kiro.dev/docs/hooks/),
[Kiro MCP](https://kiro.dev/docs/mcp/),
[Zed instructions](https://zed.dev/docs/ai/instructions),
[Zed skills](https://zed.dev/docs/ai/skills).
