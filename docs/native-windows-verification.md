# Windows native verification facilities

The bundled Claude Code 2.1.285 Windows x64 candidate remains unadmitted. Its
selected OS release is `10.0.26200`. A successful facility test establishes
process or IPC behavior; it does not establish native client acceptance.

The installed Windows helper creates the client suspended, assigns it to a
kill-on-close Job without breakaway permission, and then resumes it. It owns the
Job, root process and named-pipe server handles. Cleanup queries the Job's actual
active process count and accounts for partial launches. Helper loss or missing
cleanup observations stay unresolved. A Job does not isolate secrets or prevent
every broker-mediated process launch. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

A pipe peer must match its OS-observed PID, held process birth/image identity,
Job membership and the selected exact absolute runtime entry. The selected
executable and runtime files are pinned separately. The relative MCP launch
configuration stays unchanged: the fixture and recorder relaunch their exact
absolute entry once on Windows, and only that child opens evidence. A claimed PID,
token or an unmatched image/entry is insufficient. The WMI command line is
process-controlled metadata: matching it does not independently attest loaded
JavaScript bytes or launch provenance. Another process in the owned Job can
attempt to reproduce the selected launch. These hygiene checks assume a trusted
host account and do not isolate hostile code running as that account.
[Named-pipe peer identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid)

The package contains the reviewed helper source, executable and build record.
Its helper identity includes all three resources. No compiler, download or install
runs on a consumer machine. The build record binds source, compiler and executable
bytes; it makes no reproducible-build claim. Other platforms retain separate
definitions and evidence; see the [Linux candidate](native-linux-verification.md).

Cell protection requires the current user to own every object. Windows derives
the owner of a newly created file or directory from the creator token, separately
from its inherited permissions. An elevated token can default to the
Administrators group even inside a user-owned protected parent. That context
remains unavailable: the verifier refuses the owner mismatch rather than taking
ownership or accepting an Administrator-owned credential. Run native verification
from the standard user context; standard-user facility evidence does not establish
elevated-context support.
[Windows object ownership](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object)

## Dedicated identity preparation

Provisioning is separate from verification. The trusted host creates a dedicated
login directory and a separate provisioner-owned identity directory, verifies
their owner and protected permissions, and retains their identities. These paths
must be designated explicitly; the normal profile, Credential Manager and Keychain
are never credential sources.

The operator signs in to the dedicated test account with `claude auth login` using
an explicitly scoped `CLAUDE_CONFIG_DIR` supplied by the host. On Windows the
documented file channel is `.claude/.credentials.json`; the config-directory
override relocates that file. This step does not authorize a verifier session.
[Claude authentication](https://code.claude.com/docs/en/authentication)

The host then captures only the designated dedicated login file into `oauth.json`,
validates its closed OAuth shape, computes its byte length and digest, and generates
`identity.json` plus the host bindings. The directory contains exactly these two
protected files. Expected account and organization IDs come from an independently
trusted account or organization source, not from self-matching bundle metadata.
The operator supplies the human login and trusted identity facts; the host owns
manifest generation, hashing, permission checks and schema validation.

Before each use, the verifier rechecks the provisioned source and stages the
credential once in its owned cell. `CLAUDE_CONFIG_DIR`, home and state paths select
that cell; ambient authentication and credential-bearing host environment values
are excluded. Refreshes remain disposable client state and never overwrite the
provisioned source. No automatic login, refresh, logout or revocation occurs.

## Candidate evidence and its limits

One explicit bounded candidate authorization selects the installed artifact,
exact client/configuration/runtime bytes and dedicated host bindings. The packed
API and CLI must observe initial instructions, MCP discovery and a fixed read-only
query in two fresh sessions without reapplying configuration. Authentication needs
same-session successful API telemetry; a protected credential file alone is not
account proof. After this run's identity binding and exact credential/configuration
staging pass, account and organization telemetry attributes may be absent; every
present value must match the provisioned expectation. Empty, malformed or repeated
identity attributes and contradictory identity on any authenticated bound-session
event invalidate authentication. Optional session diagnostics record
`telemetry-identity` when a qualifying API success carries both matching IDs,
otherwise `provisioning-bound-session`. The latter loses the runtime
wrong-account/refresh cross-check; promotion evidence must record this limitation
and the owner's acceptance. Neither kind is provider-signed attestation. See the
[collector diagnostics contract](native-linux-verification.md) for the shared
counts-only record. Managed policy remains effective, and unobserved policy sources
remain limitations.

This Claude candidate has no whole-client isolation mechanism. The documented
sandbox covers shell commands and their children, while built-in file tools, MCP
servers, hooks and other helpers remain outside it. Native Windows shell commands
are unsandboxed. Moving to Linux, macOS or WSL2 does not supply the required
whole-client coverage. HOME redirection, a Job or an isolated test runner therefore
provides hygiene evidence only. [Claude sandboxing](https://code.claude.com/docs/en/sandboxing)

Hygiene evidence stays `incomplete/unverified` with CLI exit 1. Full acceptance
requires an observed admitted boundary covering the client and helpers,
including synthetic denied-access canaries. Candidate execution never changes
admission automatically, and no cell is admitted by this development artifact.
