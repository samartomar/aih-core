// Portable Harness data: the default allowed Scan signer (contract 6, 13, C35). Importing it performs no host work.
// It is AIHQ's Scan report publishing workflow, matched by issuer, certificate subject and the Fulcio extensions Scan
// documents for it. An organization's `scanSigners` replaces or extends it (contract 11); changing it is a Core release.
const PUBLISHER = 'https://github.com/samartomar/aih-scan/.github/workflows/scan-report-publisher.yml@refs/heads/main';

export const signerRecords = Object.freeze({
  schema: 'urn:aihq:core:signer-records:0.1.0',
  signers: Object.freeze([Object.freeze({
    identity: 'aihq-scan-production',
    issuer: 'https://token.actions.githubusercontent.com',
    subject: PUBLISHER,
    extensions: Object.freeze({
      '1.3.6.1.4.1.57264.1.9': PUBLISHER,
      '1.3.6.1.4.1.57264.1.11': 'github-hosted',
      '1.3.6.1.4.1.57264.1.12': 'https://github.com/samartomar/aih-scan',
      '1.3.6.1.4.1.57264.1.14': 'refs/heads/main',
      '1.3.6.1.4.1.57264.1.15': '1336836161',
      '1.3.6.1.4.1.57264.1.16': 'https://github.com/samartomar',
      '1.3.6.1.4.1.57264.1.17': '9993940',
      '1.3.6.1.4.1.57264.1.18': PUBLISHER,
      '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch',
      '1.3.6.1.4.1.57264.1.22': 'public'
    })
  })])
});
