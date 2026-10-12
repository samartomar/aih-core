# Claude native verification: finite-limit feasibility

Assessed 2026-10-12 for Claude Code **2.1.285**, the dedicated
`claude-oauth-otel.v1` identity route and Core source
`5da3ca97bad7ca102ea1ecbdd098d17dd7fc3ebf` (`1.0.0-dev.35`).

**No compliant execution is available when the requirement is a strict USD
spending ceiling across the two fresh native sessions.** Claude has turn and
estimated-cost stopping controls, but its cost control does not guarantee that
actual charges stay below the requested amount. This assessment adds no launch
controls, model execution, admission or replacement package artifact.

## What each bound means

| Bound | Capability and limitation |
| --- | --- |
| Acceptance attempts | The operator can reserve one verifier invocation, with no automatic retry. This is an operation rule, not a new Core attempt-limit field. |
| Sessions | Core starts at most two distinct fresh processes, stages once and stops on a failed/unavailable gate. Each process has its own client accounting. |
| Wall clock | Existing `budgetMs` defaults to 180000, accepts integers 1000–600000, and covers the whole check. Session one gets half the remaining time; session two gets the remaining whole-check deadline. Cleanup has one additional 10000 ms allowance. None of these limits caps charges. |
| Turns | Claude's `--max-turns` limits agentic tool-use round trips in print mode. A turn can contain several tool calls; a turn count is neither a tool-call count nor a dollar limit. Core's existing closed controls do not expose it. |
| Estimated USD | Claude's `--max-budget-usd` stops against locally accounted cost. It is a positive amount, evaluated after responses. It permits overshoot and is not an authoritative billing cap. Core's fixed argv does not currently pass it. |
| Total actual USD | Neither the existing Core contract nor the examined client establishes a strict total charge ceiling on the selected OAuth route. Two per-process thresholds do not provide that guarantee. |

Anthropic's [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags)
documents both flags and distinguishes estimated spend from billing. Its
[agent-loop documentation](https://code.claude.com/docs/en/agent-sdk/agent-loop#turns-and-budget)
explains tool-use turns and budget headroom: the response crossing the threshold
finishes, and already running subagents can add cost before stopping. Setting a
small threshold or terminating at a deadline does not remove that exposure.

[Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
describes client estimates based on local pricing data and identifies provider
billing as authoritative. A final result or telemetry observation arrives after
usage; it cannot retroactively prevent charges. An absent/zero cost result after
a crash is not evidence of zero consumption.

## Evidence for the exact pin

Current documentation is not, by itself, version-specific execution evidence.
The following registry artifact was downloaded and inspected as inert bytes;
the executable was never run:

| Resource | Bytes | SHA-256 |
| --- | ---: | --- |
| [`@anthropic-ai/claude-code-linux-x64@2.1.285` archive](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.285.tgz) | 107536804 | `3fea1abf2d5f42236ebf7e59126698e347ac80437a145dd6e85b87c8c3341ffe` |
| Archive member `package/claude` | 240327864 | `33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29` |

Static inspection of embedded JavaScript identifies both flag registrations
(byte offsets 212432979 and 212433205), the positive-budget parser error, and
`error_max_turns` / `error_max_budget_usd` result variants. At offset 203624930,
the run-cost helper subtracts restored cost from the local cost ledger; the
threshold predicate immediately following it compares that value to the limit.
The ledger accessor is at 195422423. Embedded pricing metadata at 196131006
explicitly characterizes the figures used by the budget flag as estimates.
These locations use zero-based byte offsets into the exact member above.

This confirms flag presence and client-local accounting in the selected Linux
pin, consistent with the documented limitation. It does not establish live
OAuth billing, provider enforcement, native limit termination or a Windows
binary's behavior. No client help/version command, credential access or provider
request was needed. No strict cap can be inferred from these static observations.

## OAuth and the remaining decision

The selected verifier stages an independently provisioned dedicated OAuth file;
it excludes ambient authentication and retains independent expected account and
organization binding. [Authentication documentation](https://code.claude.com/docs/en/authentication)
distinguishes subscription OAuth, Console and other provider methods. OAuth
identity alone does not specify plan, credit settings or an operation's bill.
[Cost-management documentation](https://code.claude.com/docs/en/costs)
describes account/organization usage-credit and spend settings. Those settings
are separate provider controls; this investigation neither inspected nor changed
them and establishes no exact two-session hard cap through them.

The smallest alternatives require an explicit owner decision:

1. Revise the requirement to a **client-estimated stopping threshold with accepted
   overshoot**, plus finite turns, one attempt and the existing deadline. A later
   implementation must validate closed numeric controls, define per-session and
   total accounting, pass only supported fixed arguments, stop before session two
   when its allocation is exhausted, classify limit termination and verify owned
   cleanup with nonbillable tests. It must not label the threshold a hard USD cap.
2. Retain a strict actual-charge ceiling and qualify an independently enforced
   provider spending boundary for the dedicated account/route. Its scope,
   concurrent usage, enforcement delay and overshoot semantics must be verified;
   no such suitable boundary is established here. A different authentication or
   provider route requires separate selection and qualification, not an implicit
   fallback.
3. Keep native execution unavailable and use the existing nonbillable staging and
   controlled mechanism checks, without claiming native acceptance.

Splitting a desired total `B` into `B/2` for each process still permits overshoot
in both processes. Subtracting the first result's estimate before session two
would improve estimated accounting but would not establish a strict charge cap.
No partial turn-only change resolves the present spending requirement, so the
public types, schemas, generated bindings and fixed adapter argv remain unchanged.

## Qualification handoff for the selected Linux cell

Retain these unpublished input identities; version strings do not select bytes:

| Input | Identity |
| --- | --- |
| Core | `@aihq/core@1.0.0-dev.35`; source `8d64b1514cd67609fba2b0395ee379ef75936a4b`, merged source `5da3ca97bad7ca102ea1ecbdd098d17dd7fc3ebf`; archive 6881796 bytes, SHA-256 `2e4ff1ca31a295c71a5b440b7c49a8743c2d055dd062dbff2eeb0d2cf705c0cf` |
| Catalog | `@aihq/catalog@0.1.0`; source `955754624f968b3823edddd2dcf1c9bacf33ccf4`; archive 6369030 bytes, SHA-256 `850304c96bda9dd66573c7e3e28bb45aab6ca195a815407f62c2f6ff3d75f7c3` |
| Supplied bundle | `aihq.catalog.claude.graph-fixture.v1`; manifest SHA-256 `a13662f48588eb28c3c253693900aaaab52e1646e1efb7a6587cf3cbac3958e0` |
| Manifest member | `package/release/materials/aihq/native-bundles/aihq.native-bundle.claude.graph-fixture/aihq.catalog.claude.graph-fixture.v1.json`, 3484 bytes |
| Output tree | SHA-256 `0c069ad30618037922217561b4fc725b2cc91665e205b614b606b34be9b20b6b` |
| Item | `aihq.mcp.claude.graph-fixture`; SHA-256 `e2f5b3577728ebf894a330748a71882a134f00d4d512b91b17370c8bcf80c1f3` |
| Recipe | SHA-256 `9866c407f4a1dcc4e78442b429aaa602dd33f966a259983dbb5db603a0ad5498` |
| Inputs | SHA-256 `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` |
| Starting tree | SHA-256 `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| Selected client/platform | The exact Linux executable above; x64 WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`; recorded Ubuntu 26.04.1 LTS, non-root UID1000, NAT; Node v24.19.0 |

The retained Core archive's Linux facility is not executable after the recorded
owner-only installation (archive mode 0644, installed mode 0600). Packaging is a
separate prerequisite: qualify an explicitly selected corrected artifact and
its helper/runtime pins before native execution. Do not chmod or substitute bytes
while claiming to use the immutable archive above. See the
[Linux verification guide](native-linux-verification.md) for facility and pin
qualification; bundled admission does not automatically admit supplied content.

Once the spending decision and packaging prerequisite are resolved, the native
owner must independently select the executor/cell, dedicated identity, trusted
expected account/organization, supported numeric limits and explicit run
authorization. Reserve **one acceptance attempt, two fresh sessions, no automatic
retry**. There is currently no compliant strict-spend execution command.

Rehash both archives and independently bind the manifest through trusted
`configurationSources`. Preserve selected bytes and derived narrow settings:
only `aihq-graph-fixture` approved, only instruction attestation and the selected
query allowed, fixed denies retained and `enableAllProjectMcpServers=false`.
Stage once. Each real session must separately attest initial instructions with
its challenge, discover the connected selected MCP server, run
`aihq_graph_callees({"symbol":"loadConfig"})` and observe `readFile`. Session two
must prove unchanged selected configuration and guardrails before and after
execution without reapplying them. Preserve identity proof kind and its limits,
observed whole-client containment and effective managed restrictions.

Stop on a failed/unavailable gate. Cancellation/deadline/limit handling must stop
only owned descendants, IPC and collector, confirm process cleanup and remove
only the exact generated cell. Unresolved resources remain failures with a
bounded recovery handoff. Preserve provisioned sources and evidence; credential
revocation is a separate operator decision. Controlled receipts and successful
staging do not prove real loading, acceptance or admission.

The final qualification record must join the independently selected archive and
bundle manifest, item, recipe, inputs, starting/expected/actual output trees,
policy/review/run evidence and native-result digests. Record the actual installed
Core artifact, client/runtime/helper pins, admission/containment state, identity
proof kind, limits actually enforced and cleanup result together. A recipe result
or matching output-tree digest alone cannot stand in for native-session evidence.
