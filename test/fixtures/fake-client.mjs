// A controlled FAKE AI client executable for plugin-step tests. It is never a real client and proves no native
// compatibility: it only records the exact argv Core ran and keeps a list of "installed" plugins in a state folder.
//
// Install it with `installFakeClient(bin, name)`. On Windows the client is a copy of the Node executable named
// `<name>.exe`, and this module runs as its `--import` preload (pass `fakeClientEnv(...)`, which sets NODE_OPTIONS);
// elsewhere it is a small shell script that runs this module. The preload does nothing inside a process whose
// executable is called `node`.
//
// Behaviour, per client name, recorded in `<FAKE_CLIENT_STATE>/<name>.json`:
//   … marketplace add <m> …          records the marketplace; an absolute folder must already hold a marketplace file
//                                    (`.claude-plugin/marketplace.json` or `.github/plugin/marketplace.json`), whose
//                                    text is recorded in `marketplaceFiles` (else exit 1, as a client that finds none)
//   … plugin install|add <spec> …    records the plugin spec (`<plugin>@<marketplace>`)
//   … plugin uninstall|remove <p>    forgets every spec whose plugin is <p>, or the spec <p> itself (`<plugin>@<marketplace>`)
//   … plugin list                    prints each recorded spec on its own line
// `FAKE_CLIENT_MODE` (comma-separated) changes that: `install-noop`, `uninstall-noop` (exit 0, change nothing),
// `install-fail`, `uninstall-fail`, `list-fail` (exit 1), `install-hang` (never exits: for interruption tests).
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);

export function installFakeClient(bin, name) {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') copyFileSync(process.execPath, join(bin, `${name}.exe`));
  else {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${self}" --fake-client ${name} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
}
/**
 * Windows only: the fake client as a `<name>.cmd` command shim, the way npm installs a CLI (`claude.cmd`), which runs this
 * module with the running Node. Returns the shim's path.
 */
export function installFakeCommandShim(bin, name) {
  mkdirSync(bin, { recursive: true });
  const path = join(bin, `${name}.cmd`);
  writeFileSync(path, `@echo off\r\n"${process.execPath}" "${self}" --fake-client ${name} %*\r\n`);
  return path;
}
/** The environment a process needs so that the fake clients in `bin` run, with state kept under `state`. */
export function fakeClientEnv(bin, state, mode = '') {
  mkdirSync(state, { recursive: true });
  const sep = process.platform === 'win32' ? ';' : ':';
  return { PATH: `${bin}${sep}${join(process.execPath, '..')}`, FAKE_CLIENT_STATE: state, FAKE_CLIENT_MODE: mode,
    ...(process.platform === 'win32' ? { NODE_OPTIONS: `--import=${pathToFileURL(self).href}` } : {}) };
}
/** What one fake client recorded. */
export function fakeClientState(state, name) {
  const file = join(state, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { calls: [], marketplaces: [], plugins: [] };
}

function run(name, args) {
  const dir = process.env.FAKE_CLIENT_STATE;
  if (!dir) { process.stderr.write('FAKE_CLIENT_STATE is not set\n'); process.exit(2); }
  const modes = new Set((process.env.FAKE_CLIENT_MODE ?? '').split(',').filter(Boolean));
  const file = join(dir, `${name}.json`);
  const state = fakeClientState(dir, name);
  state.calls.push(args);
  const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
  save();
  const [first, second, third] = args;
  if (first !== 'plugin') { process.stderr.write('unknown command\n'); process.exit(64); }
  if (second === 'marketplace' && third === 'add') {
    const at = args[3];
    if (isAbsolute(at)) {
      const found = ['.claude-plugin', '.github/plugin'].map(folder => join(at, folder, 'marketplace.json')).find(existsSync);
      if (!found) { process.stderr.write(`no marketplace file in ${at}\n`); process.exit(1); }
      state.marketplaceFiles = { ...(state.marketplaceFiles ?? {}), [at]: readFileSync(found, 'utf8') };
    }
    state.marketplaces.push(at); save(); process.exit(0);
  }
  if (second === 'install' || second === 'add') {
    if (modes.has('install-hang')) { appendFileSync(join(dir, `${name}.started`), 'x'); return new Promise(() => setInterval(() => {}, 1000)); }
    if (modes.has('install-fail')) process.exit(1);
    if (!modes.has('install-noop')) { state.plugins = [...new Set([...state.plugins, args[2]])]; save(); }
    process.exit(0);
  }
  if (second === 'uninstall' || second === 'remove') {
    if (modes.has('uninstall-fail')) process.exit(1);
    if (!modes.has('uninstall-noop')) { state.plugins = state.plugins.filter(spec => spec !== args[2] && spec.split('@')[0] !== args[2]); save(); }
    process.exit(0);
  }
  if (second === 'list') {
    if (modes.has('list-fail')) process.exit(1);
    process.stdout.write(state.plugins.map(spec => spec + '\n').join(''));
    process.exit(0);
  }
  process.stderr.write('unknown plugin command\n'); process.exit(64);
}

if (process.argv[2] === '--fake-client' && process.argv[1] === self) await run(process.argv[3], process.argv.slice(4));
else {
  const name = basename(process.execPath).toLowerCase().replace(/\.exe$/, '');
  // As a preload inside the copied Node executable, Node has resolved the first argument against the working folder.
  if (name !== 'node' && process.argv.length > 1) await run(name, [basename(process.argv[1]), ...process.argv.slice(2)]);
}
