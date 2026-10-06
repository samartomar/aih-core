// Portable bundled macOS session admission profiles: data only, no host observation or Node imports.
// The admitted list starts empty until native evidence satisfies the admission contract;
// an empty list is honest absence of admission, never a generic app-support claim.
import { distribution } from '../distribution.mjs';

export const macosSessionProfilesSchema = 'urn:aihq:harness:macos-session-profiles:1.0.0';

export const macosSessionProfiles = Object.freeze({
  schema: macosSessionProfilesSchema,
  package: Object.freeze({ name: distribution.name, version: distribution.version }),
  profiles: Object.freeze([])
});
