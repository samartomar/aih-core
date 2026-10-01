# Public consumer migration

This example joins independently installed Core, Catalog and Scan packages
through public exports. It is source-only demonstration and acceptance tooling,
not an additional runtime package or an application framework.

The Core starting revision is `8d12ea6779fbc36885f3aabb972a5f0bb2c85812`.
Catalog inputs are retained artifacts from
`0e08206314c6a57ce58c827d5144948fbcb087a2` and
`5d3f10e3dc82ce7a52d3cd458ddd292938cfcd99`; Scan's selected producer artifact is
from `fc7560a87e6047ecfd58631d99469977349dff01`. These are development artifact
identities, not registry release claims. The gate records the SHA-256 and length
of each actual input instead of treating its package version as byte identity.

## Existing delivery records

The contributing migrations remain with their owning products:

- [Catalog release reader, dependency mapping and material handoff](https://github.com/samartomar/aih-catalog/issues/46#issuecomment-5927675880).
- [Catalog shared context and explicit client content](https://github.com/samartomar/aih-catalog/blob/5d3f10e3dc82ce7a52d3cd458ddd292938cfcd99/docs/CONTEXT-CONTENT.md).
- [Scan immutable assessment and authentication migration](https://github.com/samartomar/aih-scan/blob/fc7560a87e6047ecfd58631d99469977349dff01/docs/immutable-assessment-migration.md).

Those records describe the inspected legacy source, retained assertions and
delivery-specific validation. The example uses their delivered contracts; it
does not transplant their producer engines or introduce legacy imports.

## Additional migration in this change

| Inspected behavior | Decision and current owner | Regression boundary |
| --- | --- | --- |
| Core `test/package.test.mjs` at the starting revision | Retain its existing isolated install, repair, helper-byte stale refusal, deliberate new Core version and original reinstall. Extend the same test with installed declaration and schema checks. | One Core artifact, no separate Harness, real temporary-target effects and public exports. |
| Harness `contracts.mjs` and `contracts.d.mts` at the starting revision | Adapt the old support literal and string IDs to package-support records. Keep package identity and trust metadata inert. The sole Core caller now checks the record's ID and produced role. | Public schema/declaration tests and installed-consumer TypeScript compilation; no helper-binding algorithm changes. |
| Existing `repairIndex`, user-tool/JVM repair definitions and `diagnose` results | Retain their existing data and result shapes. Add the owning repair and diagnostic schemas; select the diagnostic schema externally. | Every shipped repair definition and real completed, invalid and cancelled diagnoses validate. Invalid metadata and unknown execution fields reject. |
| Catalog public reader/configuration APIs and `tools/verify-core-consumer.mjs` | Adapt the public authoring handoff into the example. Preserve explicitly supplied values, omitted defaults and returned selection dependencies. Drop item-specific Core knowledge. | Export/reopen through `parsePolicy`, explicit required choices, actual public Prepare/Apply and compatible new content in a second artifact. |
| Scan public contracts, `readReport`, `readArtifact` and `prepareArtifact` | Reuse the reader and producer validation without copying internal imports. Add a full structured report view and deliberately unsigned synthetic display fixtures. | Findings, unavailable reasons, all outcomes, exclusions/gaps, annex references, fresh/reused origin, malformed input and unsupported IDs remain observable. |
| Core's serializable review and opaque `PreparedHandle` | Put live handles in the example's Node host. Expose a session ID and review, with explicit digest-bound approval. Do not turn saved JSON into executable work. | Missing approval, wrong digest, replay/lost session and fresh Prepare/Apply are tested through public APIs. |
| Existing actual production Scan artifact and bundled independent publisher trust | Reuse exactly the retained signed artifact for offline authentication; no new signing, upload or fixture-supplied trust. | The packed consumer checks authentic evidence separately from complete report display and execution approval. Synthetic display reports make no authenticity claim. |

The selected Catalog comparison adds content while preserving supported formats.
It does not claim that two different bytes at one development version are two
published releases. New Scan report bytes likewise require no scanner software
release. Ordinary source changes remain under Unreleased until maintainers
prepare a uniquely versioned distribution.

Run `npm run verify:public-consumer` as documented in the root README. Inspect
the retained `acceptance.json` and logs for what a particular run actually
checked. Native environment repair remains covered by the owning package and
platform checks; this one consumer seam does not expand into a UI/client matrix.
