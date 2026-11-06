import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { argumentsRunnable, resolveExecutable, resolveProgram, runApprovedProcess } from '../dist/core/internal/approved-process.js';

const windows = process.platform === 'win32';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an in-place executable edit invalidates the captured byte identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-executable-pin-'));
  try {
    const path = join(root, 'helper.exe');
    writeFileSync(path, 'MZ00');
    chmodSync(path, 0o700);
    const executable = resolveExecutable(path);
    assert.ok(executable);
    writeFileSync(path, 'MZ11');
    const result = await runApprovedProcess({ executable, args: [], cwd: root, env: {},
      timeoutMs: 1000, maxOutputBytes: 1024, acceptedExitCodes: [0] });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'executable-changed');
    assert.equal(result.effectsUncertain, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * An npm-style command shim (`claude.cmd`): it runs `node` by name when no `node.exe` sits beside it, then its JS entry.
 * A process FIXTURE: the entry records its argv; nothing here is a real client.
 */
function npmShimFolder(root) {
  const bin = join(root, 'npm'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'node_modules', 'fixture-cli', 'cli.js'); mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `require('fs').writeFileSync(${JSON.stringify(join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))\n`);
  writeFileSync(join(bin, 'fixture-cli.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n' +
    'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fixture-cli\\cli.js" %*\r\n');
  return { bin, entry };
}

test('an npm command shim runs its pinned JS entry with the pinned node, never a program found in the working folder', { skip: !windows }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-npm-shim-'));
  const saved = { PATH: process.env.PATH, NoDefaultCurrentDirectoryInExePath: process.env.NoDefaultCurrentDirectoryInExePath };
  try {
    const { bin, entry } = npmShimFolder(root);
    const project = join(root, 'project'); mkdirSync(project);
    const sentinel = join(root, 'PLANTED');
    writeFileSync(join(project, 'node.cmd'), `@echo planted> "${sentinel}"\r\n`);
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    process.env.PATH = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(delimiter);
    const program = resolveProgram('fixture-cli');
    assert.ok(program, 'the shim is found on PATH');
    assert.equal(program.launcher?.script.path, entry, 'the shim\'s JS entry is pinned');
    assert.equal(program.launcher?.node.path.toLowerCase(), process.execPath.toLowerCase(), 'the node it starts is pinned');
    assert.match(program.launcher.script.sha256, /^[a-f0-9]{64}$/);
    // Arguments a command processor would read (`%`, `"`) reach the entry exactly: nothing goes through cmd.exe.
    const args = ['plugin', 'install', '100%', 'say "hi"'];
    assert.equal(argumentsRunnable(program, args), true);
    const result = await runApprovedProcess({ executable: program, args, cwd: project, env: {}, timeoutMs: 20_000, maxOutputBytes: 1_000_000, acceptedExitCodes: [0] });
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')), args);
    assert.equal(existsSync(sentinel), false, 'the planted program in the working folder never ran');
    // A changed entry is a changed program.
    writeFileSync(entry, 'process.exit(0)\n');
    const changed = await runApprovedProcess({ executable: program, args: [], cwd: project, env: {}, timeoutMs: 20_000, maxOutputBytes: 1_000_000, acceptedExitCodes: [0] });
    assert.deepEqual([changed.status, changed.reason], ['unavailable', 'executable-changed']);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a command shim that names a program by name does not find it in the working folder', { skip: !windows }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-cmd-shim-'));
  const saved = { NoDefaultCurrentDirectoryInExePath: process.env.NoDefaultCurrentDirectoryInExePath };
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const project = join(root, 'project'); mkdirSync(project);
    const sentinel = join(root, 'PLANTED');
    // A shim with no JS entry still runs through cmd.exe; a bare `helper` must never resolve to the project's copy.
    writeFileSync(join(bin, 'other.cmd'), '@helper\r\n@exit /b 0\r\n');
    writeFileSync(join(project, 'helper.cmd'), `@echo planted> "${sentinel}"\r\n`);
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const program = resolveProgram(join(bin, 'other.cmd'));
    assert.ok(program); assert.equal(program.launcher, undefined);
    await runApprovedProcess({ executable: program, args: [], cwd: project, env: {}, timeoutMs: 20_000, maxOutputBytes: 1_000_000, acceptedExitCodes: [0, 1, 9009] });
    assert.equal(existsSync(sentinel), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a cancelled program is stopped with everything it started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-kill-tree-'));
  try {
    const late = join(root, 'LATE');
    const child = join(root, 'child.js');
    writeFileSync(child, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'x'), 3000);\n`);
    // On Windows a command shim (run by cmd.exe) starts the late writer; elsewhere a Node parent does.
    const parent = join(root, windows ? 'parent.cmd' : 'parent.js');
    writeFileSync(parent, windows ? `@"${process.execPath}" "${child}"\r\n` :
      `require('child_process').spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' });\nsetTimeout(() => {}, 10000);\n`);
    const executable = windows ? resolveProgram(parent) : resolveExecutable(process.execPath);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const result = await runApprovedProcess({ executable, args: windows ? [] : [parent], cwd: root, env: {}, timeoutMs: 60_000, maxOutputBytes: 1_000_000,
      acceptedExitCodes: [0], signal: controller.signal });
    assert.equal(result.status, 'cancelled');
    await sleep(4000);
    assert.equal(existsSync(late), false, 'the grandchild did not outlive the cancel');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
