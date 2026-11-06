// A Core-side PROCESS FIXTURE standing in for a Python interpreter in acquisition tests. It is a copy of the Node
// executable named `python(.exe)`, loaded with `NODE_OPTIONS=--require <this file>`; in any process whose executable is
// not named like Python it does nothing. It answers Core's fixed helper commands (`probe`, `venv`, `install`, `readback`)
// the way the real helper would, driven by a `<executable>.fake.json` sidecar: `{ version, failWheels?, failInstall?, badReadback?,
// incompatible?, failBuild? }`. `compatible` calls a wheel installable unless its file name starts with an `incompatible`
// prefix; `install` makes each wheel's `console_scripts=` line into scripts in the environment and `readback <dist>
// <script>` checks the script is that distribution's; `buildenv` records the dependency wheels it was given; `build` writes `<name>-<version>-py3-none-any.whl` named
// after the sdist (`<name>-<version>.tar.gz`), unless `failBuild` (then a 60-line log on stderr, echoing the sidecar's `token`).
// It proves Core's branch logic only; it is not a real interpreter, pip or wheel install.
'use strict';
const { basename, dirname, join } = require('node:path');
const fs = require('node:fs');

if (/^python/i.test(basename(process.execPath))) {
  const sidecar = `${process.execPath}.fake.json`;
  const facts = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  const [command, ...args] = process.argv.slice(2);
  const out = value => process.stdout.write(JSON.stringify(value) + '\n');
  const windows = process.platform === 'win32';
  if (command === 'probe') out({ version: facts.version, executable: process.execPath });
  else if (command === 'venv') {
    const bin = join(args[0], windows ? 'Scripts' : 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const target = join(bin, windows ? 'python.exe' : 'python');
    try { fs.linkSync(process.execPath, target); } catch { fs.copyFileSync(process.execPath, target); }
    fs.copyFileSync(sidecar, `${target}.fake.json`);
    fs.writeFileSync(join(args[0], 'pyvenv.cfg'), `home = ${dirname(process.execPath)}\nversion = ${facts.version}\n`);
    out({ ok: true });
  } else if (command === 'install') {
    // pip's own wording: the refused wheel by file name, or (`failInstall`) an error that names none.
    const refused = args.find(wheel => (facts.failWheels ?? []).some(name => basename(wheel).startsWith(name)));
    if (refused) { process.stderr.write(`Processing ./wheels/other\nERROR: ${basename(refused)} is not a supported wheel on this platform.\n`); process.exit(1); }
    if (facts.failInstall) { process.stderr.write('ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device\n'); process.exit(1); }
    const site = {}; const scripts = {};
    for (const wheel of args) {
      if (!fs.existsSync(wheel)) process.exit(1);
      const [name, version] = basename(wheel).split('-'); site[name] = version;
      // The console scripts the wheel provides, made in the environment's scripts folder as pip would.
      const listed = /^console_scripts=(.*)$/m.exec(fs.readFileSync(wheel, 'utf8'))?.[1];
      for (const script of listed ? listed.split(',') : []) {
        fs.writeFileSync(join(dirname(process.execPath), windows ? `${script}.exe` : script),
          windows ? `fixture launcher ${script}\n` : `#!/bin/sh\necho ${script} ${version}\n`, { mode: 0o755 });
        scripts[script] = name;
      }
    }
    fs.writeFileSync(join(dirname(dirname(process.execPath)), 'fake-site.json'), JSON.stringify(site));
    fs.writeFileSync(join(dirname(dirname(process.execPath)), 'fake-scripts.json'), JSON.stringify(scripts));
    out({ ok: true });
  } else if (command === 'compatible') {
    out({ compatible: args.map(wheel => !(facts.incompatible ?? []).some(prefix => basename(wheel).startsWith(prefix))) });
  } else if (command === 'buildenv') {
    for (const wheel of args) if (!fs.existsSync(wheel)) process.exit(1);
    fs.writeFileSync(join(dirname(dirname(process.execPath)), 'fake-buildenv.json'), JSON.stringify(args.map(wheel => basename(wheel))));
  } else if (command === 'build') {
    if (facts.failBuild || !fs.existsSync(args[0])) {
      // A long build log; a secret-named host variable's value appears in it, as a real build might print it.
      for (let line = 0; line < 60; line++) process.stderr.write(`fixture: compiling unit ${line}\n`);
      if (facts.token) process.stderr.write(`fixture: token ${facts.token}\n`);
      process.stderr.write('fixture: build failed\n'); process.exit(1);
    }
    // The environment a build ran with, for tests that check what reaches it (the sidecar's `buildRecord` names the file;
    // a build receives no host variable such a test could use).
    if (facts.buildRecord) fs.writeFileSync(facts.buildRecord, JSON.stringify(Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^(HOME|USERPROFILE|APPDATA|TMP|TEMP|TMPDIR|CC|CXX|LDSHARED|CFLAGS|CPPFLAGS|LDFLAGS|SETUPTOOLS_.*|DISTUTILS_.*|CL|_CL_|INCLUDE|LIB|RUSTFLAGS|CARGO_.*|PIP_.*|HTTPS?_PROXY|ALL_PROXY|MAKEFLAGS|PYTHON.*)$/i.test(key)))));
    const [, name, version] = /^(.+)-([^-]+)\.tar\.gz$/.exec(basename(args[0]));
    const file = `${name}-${version}-py3-none-any.whl`;
    fs.mkdirSync(args[1], { recursive: true });
    fs.writeFileSync(join(args[1], file), `fixture built wheel ${name} ${version} from ${basename(args[0])}\n`);
    out({ wheels: [file] });
  } else if (command === 'readback') {
    const site = JSON.parse(fs.readFileSync(join(dirname(dirname(process.execPath)), 'fake-site.json'), 'utf8'));
    if (!site[args[0]]) process.exit(1);
    // With a script name: it must be one of that distribution's console scripts (pip's entry points).
    if (args[1] !== undefined && JSON.parse(fs.readFileSync(join(dirname(dirname(process.execPath)), 'fake-scripts.json'), 'utf8'))[args[1]] !== args[0]) process.exit(1);
    out({ version: facts.badReadback ? '0.0.0' : site[args[0]] });
  } else process.exit(2);
  process.exit(0);
}
