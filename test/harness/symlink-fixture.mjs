// Windows lets only Developer Mode or an elevated process create symbolic links, though it reads them like any other
// platform. Where creating one is refused, the check that needs a link is reported as not run, and the rest of the test
// still runs; elsewhere, or for any other error, the failure stands.
import { symlinkSync } from 'node:fs';

/** Create a symbolic link; false (with a test diagnostic) only where Windows refuses this account the privilege. */
export function symlinked(target, link, t, type) {
  try { symlinkSync(target, link, type); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('This Windows account cannot create symbolic links (Developer Mode or elevation is needed), so the link refusal is not exercised here.');
    return false;
  }
}
