import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeExclusiveReportFile } from '../dist/core/internal/report-file.js';
import { inspect, writeSupportReport } from '../dist/core/index.js';
import { renderSupportMarkdown } from '../dist/core/support.js';

const SENTINEL = 'SENTINEL-c0ffee-secret';
const bytes = text => new TextEncoder().encode(text);
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}
const platform = ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown';

// The FileHandle class is not a named export; take the prototype from a real handle.
const probeRoot = mkdtempSync(join(tmpdir(), 'aih-report-probe-'));
const probeHandle = await open(join(probeRoot, 'probe'), 'w');
const FileHandleProto = Object.getPrototypeOf(probeHandle);
await probeHandle.close();
rmSync(probeRoot, { recursive: true, force: true });

test('report file is created exclusively with the exact bytes and restrictive POSIX permissions', async () => {
  const { root, close } = fixture('aih-report-file-');
  const target = join(root, 'report.md');
  try {
    const result = await writeExclusiveReportFile(target, bytes('# Report\n'));
    assert.equal(result.status, 'written', JSON.stringify(result));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.path, join(realpathSync.native(root), 'report.md'));
    assert.equal(readFileSync(target, 'utf8'), '# Report\n');
    if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600);
    const again = await writeExclusiveReportFile(target, bytes('replacement\n'));
    assert.equal(again.status, 'exists');
    assert.equal(again.diagnostics[0].reason, 'exists');
    assert.equal(readFileSync(target, 'utf8'), '# Report\n');
  } finally { close(); }
});

test('report file refuses invalid paths without creating anything', async () => {
  const { root, close } = fixture('aih-report-path-');
  try {
    for (const [path, reason] of [
      ['relative-report.md', 'invalid-path'],
      [join(root, 'report.txt'), 'invalid-path'],
      [`${join(root, 'report.md')}\0`, 'invalid-path'],
      [join(root, 're\nport.md'), 'invalid-path'],
      [join(root, 'missing', 'report.md'), 'parent-missing']
    ]) {
      const result = await writeExclusiveReportFile(path, bytes('x'));
      assert.equal(result.status, 'invalid', `${path}: ${JSON.stringify(result)}`);
      assert.equal(result.diagnostics[0].reason, reason, path);
    }
    assert.equal(existsSync(join(root, 'missing')), false, 'no incidental directories');
    assert.deepEqual(readdirSync(root), []);
    const file = join(root, 'plain.md'); writeFileSync(file, 'x');
    const underFile = await writeExclusiveReportFile(join(file, 'report.md'), bytes('x'));
    assert.equal(underFile.status, 'invalid');
    assert.equal(underFile.diagnostics[0].reason, 'parent-not-directory');
    assert.equal(readFileSync(file, 'utf8'), 'x');
  } finally { close(); }
});

test('report file refuses a directory at the destination', async () => {
  const { root, close } = fixture('aih-report-dir-');
  try {
    mkdirSync(join(root, 'taken.md'));
    const result = await writeExclusiveReportFile(join(root, 'taken.md'), bytes('x'));
    assert.equal(result.status, 'invalid');
    assert.equal(result.diagnostics[0].reason, 'unsafe-destination');
    assert.ok(lstatSync(join(root, 'taken.md')).isDirectory());
  } finally { close(); }
});

test('report file refuses a symlink destination and a linked parent directory', async t => {
  const { root, close } = fixture('aih-report-link-');
  const realFile = join(root, 'real.md'); writeFileSync(realFile, 'original\n');
  const realDir = join(root, 'real-dir'); mkdirSync(realDir);
  const linkFile = join(root, 'link.md'), linkDir = join(root, 'link-dir');
  // Directory junctions need no privilege on Windows, so a refused file symlink skips only its own case.
  const refusal = create => { try { create(); return undefined; } catch (error) { return error.code ?? error.message; } };
  const fileRefused = refusal(() => symlinkSync(realFile, linkFile));
  const dirRefused = refusal(() => symlinkSync(realDir, linkDir, 'junction'));
  try {
    if (fileRefused) t.diagnostic(`file symlink case skipped: the OS refused creation (${fileRefused})`);
    else {
      const atLink = await writeExclusiveReportFile(linkFile, bytes('x'));
      assert.equal(atLink.status, 'invalid');
      assert.equal(atLink.diagnostics[0].reason, 'unsafe-destination');
      assert.equal(readFileSync(realFile, 'utf8'), 'original\n');
    }
    if (dirRefused) t.diagnostic(`linked parent case skipped: the OS refused creation (${dirRefused})`);
    else {
      const throughLink = await writeExclusiveReportFile(join(linkDir, 'report.md'), bytes('x'));
      assert.equal(throughLink.status, 'invalid');
      assert.equal(throughLink.diagnostics[0].reason, 'unsafe-parent');
      assert.deepEqual(readdirSync(realDir), []);
    }
    if (fileRefused && dirRefused) t.skip('the OS refused both link kinds');
  } finally { close(); }
});

test('a pre-aborted signal cancels before anything is created', async () => {
  const { root, close } = fixture('aih-report-preabort-');
  const target = join(root, 'report.md');
  const controller = new AbortController(); controller.abort();
  try {
    const result = await writeExclusiveReportFile(target, bytes('x'), { signal: controller.signal });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.diagnostics[0].reason, 'cancelled');
    assert.equal(existsSync(target), false);
  } finally { close(); }
});

test('mid-write cancellation removes only the created file', async () => {
  const { root, close } = fixture('aih-report-midcancel-');
  const target = join(root, 'report.md');
  const controller = new AbortController();
  const original = FileHandleProto.write;
  FileHandleProto.write = async function (...args) {
    const written = await original.apply(this, args);
    controller.abort();
    return written;
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('x'.repeat(200_000)), { signal: controller.signal });
    assert.equal(result.status, 'cancelled', JSON.stringify(result));
    assert.equal(existsSync(target), false);
  } finally { FileHandleProto.write = original; close(); }
});

test('a write failure removes only the created file', async () => {
  const { root, close } = fixture('aih-report-writefail-');
  const target = join(root, 'report.md');
  const original = FileHandleProto.write;
  FileHandleProto.write = async () => { throw new Error('simulated write failure'); };
  try {
    const result = await writeExclusiveReportFile(target, bytes('x'.repeat(200_000)));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'failed');
    assert.equal(existsSync(target), false);
  } finally { FileHandleProto.write = original; close(); }
});

test('a changed identity before cleanup retains the file with an explicit diagnostic', async () => {
  const { root, close } = fixture('aih-report-retained-');
  const target = join(root, 'report.md');
  const original = FileHandleProto.write;
  FileHandleProto.write = async function (...args) {
    const written = await original.apply(this, args);
    await this.close();
    unlinkSync(target);
    writeFileSync(target, 'replacement-bytes\n');
    throw new Error('simulated write failure');
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('x'.repeat(200_000)));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'partial-report-retained');
    assert.equal(result.diagnostics[0].path, join(realpathSync.native(root), 'report.md'));
    assert.equal(readFileSync(target, 'utf8'), 'replacement-bytes\n');
  } finally { FileHandleProto.write = original; close(); }
});

// Reuse is filesystem-dependent after the last descriptor closes. Project only
// the replacement's inode identity so the real writer takes that branch on every OS.
function simulateReusedIdentity(target) {
  const originalStat = FileHandleProto.stat;
  const originalLstat = fs.lstatSync;
  let identity;
  let replaced = false;
  FileHandleProto.stat = async function (...args) {
    const stats = await originalStat.apply(this, args);
    identity ??= { dev: stats.dev, ino: stats.ino };
    return stats;
  };
  fs.lstatSync = function (path, ...args) {
    const stats = originalLstat.call(this, path, ...args);
    if (replaced && path === target && args[0]?.bigint === true) {
      return Object.assign(stats, identity);
    }
    return stats;
  };
  syncBuiltinESMExports();
  return {
    replace() { unlinkSync(target); writeFileSync(target, 'replacement-bytes\n'); replaced = true; },
    restore() { FileHandleProto.stat = originalStat; fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
  };
}

test('cleanup retains a replacement even if the closed file identity is reused', async () => {
  const { root, close } = fixture('aih-report-reused-cleanup-');
  const target = join(root, 'report.md');
  const reuse = simulateReusedIdentity(target);
  const original = FileHandleProto.write;
  FileHandleProto.write = async function (...args) {
    await original.apply(this, args);
    await this.close();
    reuse.replace();
    throw new Error('simulated write failure after identity reuse');
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('report\n'));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'partial-report-retained');
    assert.equal(result.diagnostics[0].path, join(realpathSync.native(root), 'report.md'));
    assert.equal(readFileSync(target, 'utf8'), 'replacement-bytes\n');
  } finally { FileHandleProto.write = original; reuse.restore(); close(); }
});

test('completion refuses a replacement made while closing even if its inode identity matches', async () => {
  const { root, close } = fixture('aih-report-reused-completion-');
  const target = join(root, 'report.md');
  const reuse = simulateReusedIdentity(target);
  const captureStat = FileHandleProto.stat;
  let replaced = false;
  FileHandleProto.stat = async function (...args) {
    const stats = await captureStat.apply(this, args);
    // close is an own method on FileHandle, so intercept this actual instance.
    const originalClose = this.close;
    this.close = async (...closeArgs) => {
      const result = await originalClose.apply(this, closeArgs);
      if (!replaced) { reuse.replace(); replaced = true; }
      return result;
    };
    return stats;
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('complete report\n'));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'partial-report-retained');
    assert.equal(result.diagnostics[0].path, join(realpathSync.native(root), 'report.md'));
    assert.equal(readFileSync(target, 'utf8'), 'replacement-bytes\n');
    assert.equal(replaced, true, 'the replacement must occur inside the awaited close');
  } finally { reuse.restore(); close(); }
});

test('a close failure removes only the created file and releases its descriptors', async () => {
  const { root, close } = fixture('aih-report-closefail-');
  const target = join(root, 'report.md');
  const original = FileHandleProto.stat;
  let handle;
  let closeCalls = 0;
  FileHandleProto.stat = async function (...args) {
    const stats = await original.apply(this, args);
    handle = this;
    const originalClose = this.close;
    this.close = async (...closeArgs) => {
      if (++closeCalls === 1) throw new Error('simulated close failure');
      return originalClose.apply(this, closeArgs);
    };
    return stats;
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('report\n'));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'failed');
    assert.equal(existsSync(target), false);
    assert.equal(closeCalls, 2, 'the writer must retry releasing the failed handle');
    assert.equal(handle.fd, -1);
  } finally { FileHandleProto.stat = original; close(); }
});

test('a completion descriptor release error returns the retained path instead of rejecting', async () => {
  const { root, close } = fixture('aih-report-pin-closefail-');
  const target = join(root, 'report.md');
  const original = fs.closeSync;
  let releaseAttempted = false;
  fs.closeSync = function (...args) {
    original.apply(this, args);
    releaseAttempted = true;
    throw new Error('simulated uncertain descriptor release');
  };
  syncBuiltinESMExports();
  try {
    const result = await writeExclusiveReportFile(target, bytes('complete report\n'));
    assert.equal(releaseAttempted, true);
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'partial-report-retained');
    assert.equal(result.diagnostics[0].path, join(realpathSync.native(root), 'report.md'));
    assert.equal(readFileSync(target, 'utf8'), 'complete report\n');
  } finally { fs.closeSync = original; syncBuiltinESMExports(); close(); }
});

test('writeSupportReport rejects malformed options before rendering or writing', async () => {
  const { root, close } = fixture('aih-support-options-');
  const target = join(root, 'report.md');
  const input = { kind: 'inspect', result: null };
  try {
    for (const options of [
      { platform, path: target, extra: true },
      { platform: 'plan9', path: target },
      { path: target },
      { platform, path: target, signal: {} },
      null,
      'options'
    ]) {
      const result = await writeSupportReport(input, options);
      assert.equal(result.status, 'invalid', JSON.stringify(options));
      assert.equal(result.diagnostics[0].reason, 'invalid-options', JSON.stringify(options));
      assert.equal(existsSync(target), false);
    }
  } finally { close(); }
});

test('writeSupportReport honors a pre-aborted signal before rendering', async () => {
  const { root, close } = fixture('aih-support-preabort-');
  const target = join(root, 'report.md');
  const controller = new AbortController(); controller.abort();
  try {
    const result = await writeSupportReport({ kind: 'inspect', result: null },
      { platform, path: target, signal: controller.signal });
    assert.equal(result.status, 'cancelled');
    assert.equal(existsSync(target), false);
  } finally { close(); }
});

test('writeSupportReport passes render diagnostics through without writing', async () => {
  const { root, close } = fixture('aih-support-invalid-');
  const target = join(root, 'report.md');
  try {
    const input = { kind: 'inspect', result: null };
    const rendered = renderSupportMarkdown(input, { platform });
    assert.equal(rendered.status, 'invalid');
    const result = await writeSupportReport(input, { platform, path: target });
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.diagnostics, rendered.diagnostics);
    assert.equal(existsSync(target), false);
  } finally { close(); }
});

test('a written support report equals the rendered Markdown and never contains freeform sentinel data', async () => {
  const { root, close } = fixture('aih-support-written-');
  const target = join(root, 'report.md');
  try {
    const inspection = JSON.parse(JSON.stringify(await inspect({ targets: ['node'], network: 'off' })));
    inspection.diagnostics.push({ code: 'TEST', reason: 'sentinel-fixture',
      message: `freeform ${SENTINEL}`, path: join(root, SENTINEL), guidance: `https://user:${SENTINEL}@example.invalid/` });
    for (const check of inspection.checks) check.detail = `${SENTINEL} ${check.detail}`;
    const input = { kind: 'inspect', result: inspection };
    const rendered = renderSupportMarkdown(input, { platform });
    assert.equal(rendered.status, 'rendered', JSON.stringify(rendered.diagnostics));
    const result = await writeSupportReport(input, { platform, path: target });
    assert.equal(result.status, 'written', JSON.stringify(result));
    const text = readFileSync(result.path, 'utf8');
    assert.equal(text, rendered.markdown);
    assert.equal(text.includes(SENTINEL), false, 'the allowlisted report must omit freeform detail/message/path fields');
    if (process.platform !== 'win32') assert.equal(statSync(result.path).mode & 0o777, 0o600);
  } finally { close(); }
});

test('a created file that cannot be attributed for cleanup is always reported with its path', async () => {
  const { root, close } = fixture('aih-report-unattributed-');
  const target = join(root, 'report.md');
  const original = FileHandleProto.stat;
  // A descriptor that does not look like the created regular file blocks success,
  // and its identity cannot match the path, so cleanup must retain and report it.
  FileHandleProto.stat = async function () { return { dev: 1n, ino: 1n, isFile: () => false }; };
  try {
    const result = await writeExclusiveReportFile(target, bytes('report\n'));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'partial-report-retained');
    assert.equal(result.diagnostics[0].path, join(realpathSync.native(root), 'report.md'));
    assert.equal(existsSync(target), true);
  } finally { FileHandleProto.stat = original; close(); }
});

test('a parent directory replaced after creation reports the retained file', async t => {
  const { root, close } = fixture('aih-report-parent-swap-');
  const parent = join(root, 'out'); mkdirSync(parent);
  const target = join(parent, 'report.md');
  const original = FileHandleProto.stat;
  let refused = false;
  FileHandleProto.stat = async function (...args) {
    const stats = await original.apply(this, args);
    try { renameSync(parent, join(root, 'moved')); mkdirSync(parent); } catch { refused = true; }
    return stats;
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('report\n'));
    if (refused) { t.skip('this platform refuses renaming a directory that holds an open file'); return; }
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.diagnostics[0].reason, 'partial-report-retained');
    assert.equal(existsSync(join(root, 'moved', 'report.md')), true);
    assert.equal(existsSync(target), false);
  } finally { FileHandleProto.stat = original; close(); }
});

test('alternate data streams and reserved device names are refused as report paths', async () => {
  const { root, close } = fixture('aih-report-segment-');
  writeFileSync(join(root, 'file.txt'), 'original\n');
  try {
    const names = ['file.txt:stream.md', ...(process.platform === 'win32' ? ['CON.md', 'report.md '] : [])];
    for (const name of names) {
      const result = await writeExclusiveReportFile(join(root, name), bytes('report\n'));
      assert.equal(result.status, 'invalid', name);
      assert.equal(result.diagnostics[0].reason, 'invalid-path', name);
    }
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'original\n');
    assert.deepEqual(readdirSync(root), ['file.txt']);
  } finally { close(); }
});

test('cancellation after the complete file is closed still returns written', async () => {
  const { root, close } = fixture('aih-report-late-abort-');
  const target = join(root, 'report.md');
  const controller = new AbortController();
  const original = FileHandleProto.stat;
  FileHandleProto.stat = async function (...args) {
    const stats = await original.apply(this, args);
    const originalClose = this.close;
    this.close = async (...closeArgs) => {
      const closed = await originalClose.apply(this, closeArgs);
      controller.abort();
      return closed;
    };
    return stats;
  };
  try {
    const result = await writeExclusiveReportFile(target, bytes('complete report\n'), { signal: controller.signal });
    assert.equal(result.status, 'written', JSON.stringify(result));
    assert.equal(controller.signal.aborted, true, 'cancellation must arrive during close');
    assert.equal(readFileSync(target, 'utf8'), 'complete report\n');
  } finally { FileHandleProto.stat = original; close(); }
});
