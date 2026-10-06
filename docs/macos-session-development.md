# macOS session development candidate

On macOS 26, supplied-file Node/npm terminal repairs use the existing file
repair engine and retain protected session custody alongside ordinary ownership
and trust provenance. Prepare shows intended configuration; Apply requires its
exact review digest. An unchanged repeat retains the managed selection. Removal
previews managed operations and preserves unrelated shell settings.

Save this input beside `team-ca.pem`:

```json
{
  "schema": "urn:aihq:core:repair-inputs:1.1.0",
  "route": "file",
  "repairs": { "node-npm-ca": {} },
  "sources": { "os": false, "supplied": [{ "id": "team", "file": "team-ca.pem" }] },
  "macosSession": { "context": "terminal", "applications": [] }
}
```

```sh
aih repair node-npm-ca --target node --inputs-file repair-inputs.json --offline --no-log --json
aih repair node-npm-ca --target node --inputs-file repair-inputs.json --offline --apply --no-log --json
aih verify-macos-session --management-id node-npm-trust --no-log --json
aih managed list --scope user --json
aih managed remove node-npm-trust --scope user --mode vibe --no-log --json
aih managed remove node-npm-trust --scope user --mode vibe --apply --no-log --json
```

Start a new login shell after application so it reads the managed `.zprofile`
block. `--no-log` disables routine history; ownership, recovery and session
custody remain necessary for safe operation. Offline checks stay skipped and
unverified. The observation command checks recorded configuration and reports
drift. It does not start a shell, launch an app or repair files. Exit 1 means
incomplete or an unavailable prerequisite, 2 invalid input/review, and 130
cancellation.

Session custody is keyed by management ID in
`~/.aih/core/macos-session-custody.json`. An unfinished transaction blocks new
mutation of the recorded members with `session-recovery-required`. Unrelated
files remain usable. Prepare the same management family and affected targets
again with explicit current sources and any exact replacement resolutions,
review the pending-intent binding, then authorize that fresh review. Original
before/after evidence stays protected until reconciliation completes. Foreign file changes
block session removal. Restoring the exact reviewed bytes allows a fresh removal
review. The runtime never silently clears foreign GUI environment keys or
restarts applications.

Schemas include other existing trust families, but their versioned file route
remains unavailable where the installed integration is absent. OS/native trust
admission is independent of this supplied-file path. Desktop and both-context
requests return `app-session-unsupported`: the bundled desktop profile list is
empty. The public Harness session helpers render intent or observe the host.
GUI registration, environment mutation and login replay require protected
custody and a distinct native login identity and are not exposed by the public
runtime entry or activated through Core in this candidate.

The macOS 26 arm64 CI workflow installs a packed consumer and exercises real
terminal configuration, a fresh login shell against a temporary private CA,
negative checks before repair and after removal, custody, drift and cancellation.
Its fixture CA is never installed in the system keychain. The same installed
consumer driver runs in a standard-user x64 VM as development evidence. Neither
headless CI nor VM evidence admits Finder/Dock profiles. Full desktop acceptance
requires real-Mac login, exact application/backend/build evidence and native
checks after manual relaunch.

Older consumers that do not recognize request 1.1 reject its schema. Their
ability to enforce session custody guards depends on their installed code; a
new guard does not exist automatically in an older binary. The current runtime
guards session-owned members against requests without session semantics.
