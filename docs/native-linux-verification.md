# Linux native verification candidate

The bundled Claude Code 2.1.285 Linux x64 WSL2 candidate remains unadmitted.
It selects kernel `6.18.33.2-microsoft-standard-WSL2`, Node 24.19.0 and the exact
runtime bytes in `dist/harness/native/linux/runtime-platform.json`. Other Linux,
Windows and macOS environments need their own definitions and evidence. An
ordinary `verify-client` call cannot promote a candidate or select a custom policy.

## Fixed workload boundary

Harness wraps the version probe and each complete client session in a fresh
instance of Anthropic Sandbox Runtime 0.0.78. The unmodified dependency and its
transitive JavaScript closure are bundled and checked against `runtime-lock.json`.
The wrapper imports the SDK entry, never the vendor CLI. The implementation uses
the [released vendor source](https://github.com/anthropic-experimental/sandbox-runtime/tree/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b).

The fixed profile denies filesystem reads outside enumerated runtime files,
selected cell roots and authenticated IPC paths. Only cell home, project and
scratch are writable; selected configuration and guardrails stay read-only.
Library aliases are materialized from independently pinned bytes. The sole loader
directory grant requires an exact root-owned, single-symlink inventory. Missing,
changed or unexpected files refuse the candidate; verification never installs,
downloads, compiles or repairs prerequisites.

The vendor also supplies its pinned seccomp support and Java proxy agent. Its
implicit mounts and environment changes are part of the reviewed vendor closure.
Pre-existing vendor convenience write roots are refused. The fixed configuration
has no TLS interception, credential injection, ask callback or live policy update.
Only the exact local telemetry collector and fixed provider destinations can pass
the proxy allowlist. `NO_PROXY` and `no_proxy` are removed after vendor setup so
the collector must traverse that proxy.

Both acceptance sessions share one immutable base and once-staged supporting
files. Reuse checks their exact bytes and file identities; concurrent use or a
changed input refuses the session. The earlier version preflight has its own
fixed profile and receives no dedicated identity or selected configuration.
Per-launch derivation adds only the exact collector IP/port and enumerated IPC
socket paths. Both the host and runner compare the full derived profile and its
serialized bytes with the fixed base. Public requests accept no wrapper,
environment, proxy endpoint, hostname list or sandbox configuration.

## Evidence and cleanup

The bundled static PIE helper pins executable/runtime bytes, holds kernel process
identities, observes Unix-socket credentials and adopts descendants as a Linux
subreaper. The workload, client and selected MCP peer must have matching PID,
mount, user and network namespaces, each distinct from the host. A namespace PID
claimed in a protocol message is only a cross-check after kernel authentication.
The observer launches the real client itself and holds it behind a private
launch gate. Before releasing that gate it attaches with unprivileged
`PTRACE_SEIZE` to this one root only, so kernel fork, vfork, clone, exec and exit
stops apply before the client's first instruction and to every traced descendant.
Each new process is held at its kernel stop while its executable, namespaces and
actual argv are read twice with matching results; each captured generation is
classified and then explicitly acknowledged. A failed capture may be resumed for
lifecycle progress and bounded cleanup, but its argument coverage is then
unavailable or a permanent gap and can never become clean. If tracing is denied,
for example by Yama ptrace scope, another security module or seccomp, the launch
is unavailable. There is no untraced fallback or exemption.

Before the client continues, synthetic probes check host-home, sibling,
provisioner and outside temporary files; pathname and abstract agent sockets;
inherited environment and descriptors; host process access; wrong loopback ports;
unapproved egress; the allowed collector; writable roots; and selected read-only
files. They never probe real host secrets. Missing proof stays unavailable, and
proven access fails isolation. Uncorrelated traffic to a host canary prevents
admission but cannot itself prove that the workload escaped.

WSL2 additionally checks mounted Windows volumes, interop entry points and a
known executable synthetic Windows canary. A native helper calls `execve`
directly, avoiding shell fallback. It recognizes a missing interpreter, or an
access refusal with the executable canary intact and `/init` independently
observed as the vendor's non-executable `/dev/null` mask. The current candidate
requires independently observed NAT networking. Mirrored networking remains
unavailable pending a separate Windows-side loopback denial proof.

One ten-second cleanup allowance covers the owned tree, including outer proxy
helpers and detached descendants. An empty process group alone is insufficient.
The helper must reap all owned children, close authenticated transports and
confirm cleanup. Synthetic files and exact vendor leftovers are removed only
after process cleanup; unexpected material is preserved and cleanup stays unresolved.

## Identity and acknowledged limits

Dedicated OAuth provisioning remains an operator step separate from verification;
the normal login profile is never a credential source. A protected credential
file alone is not authentication proof. Both fresh sessions require successful
same-session API telemetry bound to the independently selected account and
organization. File-based Linux managed policy and verified Windows host managed
policy are checked outside the sandbox. Restricting policy wins; unreadable or
unknown policy gives unavailable. Registry, MDM and server-managed policy retain
their explicitly unobserved limitations.

Process observation requires the host to let an unprivileged process trace a
child it launched: the observer uses only `PTRACE_SEIZE` on its own held client,
with no added capability, setuid helper or host policy change. Where Yama ptrace
scope, another security module or seccomp denies that, the session is unavailable
rather than exempted. Every captured argument generation is retained until it is
classified and acknowledged; a pending generation, or a lifetime that ended without
an acknowledged capture, keeps argument proof unavailable. A confirmed executable
replacement needs its own captured and acknowledged generation; a different image
appearing before that capture, or the lifetime ending first, is a permanent gap.
Matching argument reads that span a namespace change are kept as a generation to
classify, any earlier acknowledgement stops counting, and coverage returns only
after a consistent capture in the new namespaces is itself acknowledged; ending
before that capture is a permanent gap. A complete argument observation that
differs from the last retained one, or spans a namespace change, is never
discarded because the process then exits: it is kept for classification and the
lifetime is a permanent gap. Capture is sampled at
kernel stops and audits, so arguments rewritten in place between samples, clones
created explicitly with `CLONE_UNTRACED` and exec from a non-leader thread are
outside the claim; the last fails closed.

The client's ordinary state persists in the cell between the two sessions,
including provider feature-gate and experiment caches in its global state file
(for example `cachedGrowthBookFeatures`, `cachedDynamicConfigs` and the
`cachedExperiment*` keys). Those caches can change how the second session starts.
This is an accepted limitation: the second session's loading, restriction,
tool-discovery and authentication evidence is still observed independently, and
new instruction, settings, MCP, memory or managed-policy files remain configuration
changes.

The vendor places a fresh local proxy capability in its bubblewrap environment
arguments and shell command. This is an acknowledged argv exposure: local readers
permitted by host process visibility may reuse the capability for the same
allowlisted egress or denial of service while the proxy lives. It is not an OAuth,
identity, telemetry or evidence credential. The latter values must never appear
in argv. The observer audits the held client before it continues and each traced
process generation while the session runs; detected leaks remain failures after a
process exits. An owned lifetime without an acknowledged capture, a missing kernel
receipt or an unreadable live identity leaves argument proof unavailable. Accepted
limits: argv rewritten in place between captures is outside this observation,
clones created explicitly with `CLONE_UNTRACED` are not held by the kernel, and
exec from a non-leader thread is unsupported and fails closed. No raw capability
or argv is retained in admission records. The fixed
integration does not claim protection from a hostile host account or kernel.

Optional process-local subscribers to `aih.native.admission.v1` through Node's
`diagnostics_channel` receive profile/argv digests, closed proof booleans, fixed
restriction counts and cleanup status. There is no default file or network sink.
These records accompany acceptance evidence; they do not authorize or admit a cell.

## Build records and development checks

The package carries helper source, executable and build record. Linux CI compiles
the helper twice with fixed hardening flags, compares both outputs, and verifies
the committed binary. `scripts/build-linux-facility.mjs --check` is a developer/CI
operation; consumers use the supplied binary. The harmless Windows canary has a
separate source/compiler/binary record without a reproducible-build claim.

Explicit developer commands maintain the vendor and observer locks. Ordinary
builds check those locks and never regenerate them. Package acceptance validates
the installed resource bytes, schema 1.1, portable contracts and public API/CLI
failure behavior. Kernel facility tests and controlled synthetic sessions remain
distinct from real native account/configuration acceptance. Admission requires
the latter evidence for the exact packed distribution.

The host-only installed-package preparation gate in
`test/harness/native-linux-installed.test.mjs` needs a non-root Linux x64 WSL2 host
with the pinned runtime and an npm-installed `@aihq/core` package. Set
`AIHQ_TEST_LINUX_INSTALLED_CORE` to its absolute package directory under
`node_modules/@aihq/core` and `AIHQ_TEST_LINUX_CLIENT_PIN` to a JSON
`{path, sha256, byteLength}` pin for the client, then run
`node --test test/harness/native-linux-installed.test.mjs`. The gate prepares and
terminates the real sandbox without executing the client; CI skips it because
these variables are unset.
The same gate also re-reads every merged runtime pin except the client through
Core's pinned-file reader and checks its SHA-256 without executing the client.
