// Additional export-only classification. Existing trust discovery/detection stays unchanged.
import { platform, arch, release } from 'node:os';
import { spawnSync } from 'node:child_process';
import { detectTrustPlatform } from './trust-os.mjs';

export const exactExportRelease = 'Windows 11 26H2 build 26340.9767';
export function classifyCertificateExportPlatform(legacy, facts) {
  if (legacy.release !== null || legacy.os !== 'win32' || legacy.architecture !== 'x64') return legacy;
  if (!facts || facts.nodeRelease !== '10.0.26340' || facts.cimVersion !== '10.0.26340' ||
      facts.currentBuild !== '26340' || facts.ubr !== 9767 || facts.displayVersion !== '26H2' ||
      facts.architecture !== 'AMD64' || facts.caption !== 'Microsoft Windows 11 Pro Insider Preview') return legacy;
  return { ...legacy, release: exactExportRelease, projection: 'windows-effective-server-auth-v1' };
}
export function detectCertificateExportPlatform() {
  const legacy = detectTrustPlatform();
  if (legacy.release !== null || platform() !== 'win32' || arch() !== 'x64' || release() !== '10.0.26340') return legacy;
  try {
    // This additional cell is scoped to the reviewed C:\Windows host. Environment variables
    // must not redirect either the OS observer or its autoloaded modules to user-owned code.
    const env = { SystemRoot: 'C:/Windows', WINDIR: 'C:/Windows',
      PSModulePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules',
      PATH: 'C:/Windows/System32;C:/Windows;C:/Windows/System32/WindowsPowerShell/v1.0' };
    const result = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $o=CimCmdlets\\Get-CimInstance Win32_OperatingSystem; $c=@(CimCmdlets\\Get-CimInstance Win32_Processor); $a=if($c.Count -gt 0 -and @($c|Where-Object Architecture -ne 9).Count -eq 0){'AMD64'}else{'unsupported'}; $v=Microsoft.PowerShell.Management\\Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; [ordered]@{cimVersion=$o.Version;currentBuild=[string]$v.CurrentBuild;ubr=[int]$v.UBR;displayVersion=[string]$v.DisplayVersion;architecture=$a;caption=$o.Caption}|Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress"],
      { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, env });
    if (result.status !== 0 || result.error) return legacy;
    return classifyCertificateExportPlatform(legacy, { ...JSON.parse(result.stdout.replace(/^\uFEFF/, '')), nodeRelease: release() });
  } catch { return legacy; }
}
