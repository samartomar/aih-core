// The one published list of 0.1.0 refusal and conflict codes (C42). Append-only: each later contract slice adds its
// codes as new lines; nothing is reordered or renamed. `@aihq/core/contracts` publishes it as `refusalCodes`.

export interface RefusalCode {
  /** The result `status` that carries this code. */
  status: 'refused' | 'invalid' | 'blocked' | 'rejected';
  code: string;
  /** For a grouped code (`STATE_CONFLICT`, `REVIEW_STALE`), the reason that names the cause; otherwise absent. */
  reason?: string;
  /** The fix the result offers. */
  fix: string;
}

const entries: RefusalCode[] = [
  // Plan requests, own content (samartomar/aih-core#164).
  { status: 'refused', code: 'source-missing', fix: 'Pass the missing files, with their bytes.' },
  { status: 'refused', code: 'source-mismatch', fix: 'Re-read the source.' },
  { status: 'invalid', code: 'duplicate-file', fix: 'Pass each file once.' },
  { status: 'refused', code: 'tool-unknown', fix: 'A newer Core.' },
  { status: 'refused', code: 'step-unknown', fix: 'A newer Core.' },
  { status: 'refused', code: 'plan-unresolved', fix: 'Replan with `names`, `overrides` or `bundle`.' },
  { status: 'refused', code: 'catalog-required', fix: 'Pass the Catalog that made the plan.' },
  { status: 'refused', code: 'path-escape', fix: 'Replan; a plan path never leaves its root.' },
  { status: 'refused', code: 'state-path', fix: 'Choose a target outside Core\'s private state.' },
  { status: 'refused', code: 'limit-exceeded', fix: 'Split the request; the result names the limit.' },
  { status: 'refused', code: 'cancelled', fix: 'Prepare again.' },
  { status: 'refused', code: 'home-unavailable', fix: 'Run where the home folder is usable.' },
  { status: 'refused', code: 'client-attribution-missing', fix: 'Remove for every CLI, or replan with a Catalog that records `clis`.' },
  { status: 'blocked', code: 'STATE_CONFLICT', reason: 'existing-content', fix: 'Prepare again with a resolution: replace, adopt if identical, or skip.' },
  { status: 'blocked', code: 'STATE_CONFLICT', reason: 'managed-content-changed', fix: 'Your edit is kept; undo it yourself to take Core\'s version.' },
  { status: 'rejected', code: 'REVIEW_STALE', fix: 'Prepare again.' },
  // Authored changes (samartomar/aih-core#166).
  { status: 'refused', code: 'organization-required', fix: 'Prepare the change in Vibe mode; Enterprise admission of changes needs a newer Core.' },
  // Native plugin steps (samartomar/aih-core#168).
  { status: 'refused', code: 'profile-mismatch', fix: 'Pass the Catalog profile the plan was made with.' },
  { status: 'refused', code: 'plugin-command-unresolved', fix: 'Replan with a Catalog whose plugin step and profile give every value of an unattended, pinned install.' },
  { status: 'refused', code: 'program-unavailable', fix: 'Install the CLI the step runs, then prepare again.' },
  { status: 'invalid', code: 'item-removal-unavailable', fix: 'Remove the whole management id; only an item inside a plugin is named by item.' },
  // AI setup acquisition (samartomar/aih-core#169).
  { status: 'refused', code: 'qualification-missing', fix: "Pass the qualification documents that the plan's acquire steps name." },
  { status: 'refused', code: 'qualification-mismatch', fix: 'Replan with the qualification that matches the artifact.' },
  { status: 'refused', code: 'tls-untrusted', fix: 'Run the repair the result names, then Prepare again.' },
  { status: 'refused', code: 'cell-mismatch', fix: "Replan for this host's platform cell." },
  // Environment work: repair, certificate export and the macOS session (samartomar/aih-core#170).
  { status: 'refused', code: 'host-unsupported', fix: 'Run on a supported Node runtime and host.' },
  { status: 'refused', code: 'resolution-unknown', fix: 'Prepare again with resolutions taken from the conflicts of the review.' },
  // The aih CLI's own refusals (contract 22).
  { status: 'refused', code: 'usage', fix: 'Run the command with --help.' },
  { status: 'refused', code: 'request-unreadable', fix: 'Pass a strict JSON file within the request limit.' },
  { status: 'refused', code: 'approval-required', fix: 'Approve with --yes or answer yes interactively.' },
  // Renders and recipe proofs through the caller's Catalog (samartomar/aih-core#167).
  { status: 'refused', code: 'profile-mismatch', fix: 'Pass the Catalog and profiles the plan was made with.' },
  { status: 'invalid', code: 'render-failed', fix: 'Pass the Catalog that made the plan; its render did not return checked bytes.' },
  { status: 'invalid', code: 'recipe-proof', fix: 'Pass the recipe plugin’s exact `plugin.json` and `recipe.json` text.' },
  // Merges with reviewed conflict choices (samartomar/aih-core#165).
  { status: 'refused', code: 'file-too-large-for-client', fix: 'Shorten your file, or choose fewer always-on rules.' },
  // Local plugins and one-item switch-offs (samartomar/aih-core#173).
  { status: 'refused', code: 'switch-off-unsupported', fix: 'Remove the whole plugin; this CLI has no supported switch-off for one item.' },
  { status: 'invalid', code: 'switch-off-alone', fix: 'Prepare the switch-off as the only entry of its removal request.' },
];

export const refusalCodes: readonly Readonly<RefusalCode>[] = Object.freeze(entries.map(entry => Object.freeze({ ...entry })));
