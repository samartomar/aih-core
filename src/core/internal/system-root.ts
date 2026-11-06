// Windows system programs are started by absolute path under the Windows folder that the kernel's `\SystemRoot` link
// names, never through the inherited `%SystemRoot%` or a bare program name searched on `PATH`.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

let windows: string | undefined;
/** The Windows folder, from `\\?\GLOBALROOT\SystemRoot`. Throws when it can't be resolved (as off Windows). */
export function windowsDirectory(): string {
  windows ??= realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot');
  return windows;
}
/** An absolute path under `<Windows>\System32`. */
export const system32 = (...parts: string[]): string => join(windowsDirectory(), 'System32', ...parts);
/** Windows PowerShell 5.1, by absolute path. */
export const windowsPowerShell = (): string => system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
