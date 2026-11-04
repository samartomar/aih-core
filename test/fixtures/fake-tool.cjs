// A Core-side PROCESS FIXTURE for program steps (`tool-command`, `upstream-installer`, `upstream-setup`). It is never a
// real AI tool, installer or setup and proves no native behaviour: it records the argv, working folder and a digest of
// the secret `TOOL_TOKEN` it was given, and answers a tiny `config set|get|unset` vocabulary.
//
// On Windows each fake is a copy of the Node executable named `fake-tool.exe`, `fake-setup.exe` or `fake-installer.exe`,
// loaded with `NODE_OPTIONS=--require <this file>`; elsewhere it is a shell script that runs this file with
// `FAKE_TOOL_NAME`. In any other process it does nothing. State goes to `<FAKE_TOOL_STATE>/<name>.json`.
// `FAKE_TOOL_MODE` (comma-separated): `set-fail` (exit 1), `readback-wrong` (get prints `wrong`), `set-hang` (waits
// 30 s, then fails; writes `<name>.started`), `setup-fail`, `unset-noop` (exit 0, changes nothing).
'use strict';
const { basename, join } = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const executableName = basename(process.execPath).toLowerCase().replace(/\.exe$/, '');
const name = process.env.FAKE_TOOL_NAME && require.main === module ? process.env.FAKE_TOOL_NAME :
  /^fake-(tool|setup|installer)$/.test(executableName) ? executableName : undefined;

if (name) {
  const dir = process.env.FAKE_TOOL_STATE;
  if (!dir) { process.stderr.write('FAKE_TOOL_STATE is not set\n'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const modes = new Set((process.env.FAKE_TOOL_MODE ?? '').split(',').filter(Boolean));
  // On Windows Node resolved the first argument against the working folder; its base name is the argument.
  const raw = process.env.FAKE_TOOL_NAME ? process.argv.slice(2) : process.argv.slice(1);
  const args = raw.length ? [process.env.FAKE_TOOL_NAME ? raw[0] : basename(raw[0]), ...raw.slice(1)] : [];
  const file = join(dir, `${name}.json`);
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { calls: [], settings: {} };
  const token = process.env.TOOL_TOKEN;
  state.calls.push({ argv: args, cwd: process.cwd(), ...(token ? { tokenSha256: createHash('sha256').update(token).digest('hex') } : {}) });
  const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
  save();
  const hang = () => { fs.appendFileSync(join(dir, `${name}.started`), 'x'); const cell = new Int32Array(new SharedArrayBuffer(4));
    // Bounded, so a fake orphaned by a killed host (Windows keeps children alive) never outlives its test for long.
    for (let waited = 0; waited < 30; waited++) Atomics.wait(cell, 0, 0, 1000); process.exit(1); };
  if (name === 'fake-tool') {
    const [group, verb, key, value] = args;
    if (group !== 'config') process.exit(64);
    if (verb === 'set') {
      if (modes.has('set-hang')) hang();
      if (modes.has('set-fail')) process.exit(1);
      state.settings[key] = value; save(); process.exit(0);
    }
    if (verb === 'get') { process.stdout.write(`${modes.has('readback-wrong') ? 'wrong' : state.settings[key] ?? ''}\n`); process.exit(0); }
    if (verb === 'unset') { if (!modes.has('unset-noop')) { delete state.settings[key]; save(); } process.exit(0); }
    process.exit(64);
  }
  if (name === 'fake-setup') {
    if (modes.has('setup-fail')) process.exit(1);
    fs.writeFileSync(join(process.cwd(), 'built.txt'), 'built by the fake setup\n');
    fs.writeFileSync(join(process.env.HOME ?? process.env.USERPROFILE, '.fake-setup-outside'), 'written outside the clone\n');
    process.exit(0);
  }
  fs.writeFileSync(join(process.env.HOME ?? process.env.USERPROFILE, '.fake-installed'), args.join(' ') + '\n');
  process.exit(0);
}
