# Evidence conformance vectors

`test-dsse-0.0.1.*` and `test-dsse-0.0.2.*` retain the artifact and independent
trust produced by the Scan test encoder `tests/artifact/synthetic-keyless.ts`
at Scan commit `fc7560a87e6047ecfd58631d99469977349dff01`.

Each artifact carries a supported partial report with a refused unknown
detector, a nonempty annex, ordinary JSON statement ordering, and a certificate
whose real validity period has ended. The encoder creates actual signatures,
CT witnesses, Rekor proofs and a private ephemeral CA/log universe. Its
`TEST-ONLY` roots and publisher identities are used only by tests and are never
shipped as Harness trust.

The `0.0.1` vector witnesses signing time with a verified Rekor inclusion promise
and also has an inclusion proof. The `0.0.2` vector has an inclusion proof and a
verified RFC3161 timestamp bound to the DSSE signature; the proof alone cannot
establish signing time. Neither fixture proves production signing authority.

`test/evidence-fixtures.mjs` independently generates an ephemeral organization
Ed25519 signature over an opaque future report for the public Core tests. No
private fixture keys or signing functions are part of the shipped Core module.

`production.scan.json` is the exact authenticated artifact from the protected
[Scan publisher run 36880316350](https://github.com/samartomar/aih-scan/actions/runs/36880316350).
Its SHA-256 is `ce2e1b862eaf763b2b0d593a84c26ad3a0c1a39661af1d5629f00484e5029b0c`;
it contains a 3,508-byte report and a 246-byte native annex. Its leaf certificate
expired at `2026-10-01T15:07:44Z`. The test uses independently maintained Harness
roots and exact issuer/SAN/OID policy, with network and subprocess guards, and
retains wrong-policy/root/time/proof and changed-byte refusals. The artifact
itself never supplies its trust. No signing run occurs during tests.
