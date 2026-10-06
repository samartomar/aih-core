// Fixed, bounded native observation for the admitted development host family.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const command = promisify(execFile);
export async function observeMacosSessionPlatform(signal) {
  const unavailable = { status: 'unavailable', reason: 'session-platform-unsupported' };
  if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) ||
      process.getuid() !== process.geteuid() || process.geteuid() <= 0) return unavailable;
  try {
    const observe = async option => (await command('/usr/bin/sw_vers', [option],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536, signal })).stdout.trim();
    const version = await observe('-productVersion'), build = await observe('-buildVersion');
    if (!/^26\.[0-9.]{1,16}$/.test(version) || !/^[A-Za-z0-9]{1,64}$/.test(build)) return unavailable;
    return { status: 'observed', platform: { os: 'darwin', release: `macOS ${version}`, build, architecture: process.arch } };
  } catch {
    return signal?.aborted ? { status: 'cancelled', reason: 'cancelled' } : unavailable;
  }
}
