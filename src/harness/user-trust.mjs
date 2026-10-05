import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { userToolsRepair } from './user-trust-definitions.mjs';
import { composeExistingTrust, validateSuppliedCa } from './ca.mjs';

const literal = value => ({ literal: value });
const input = name => ({ input: name });
const cwd = { root: 'userHome', segments: [] };
const target = segments => ({ root: 'userHome', segments: segments.map(literal) });
const trim = text => text.replace(/[\r\n]+$/, '');

// Extracted from certs/ini.ts. Preserve EOL style and all neighboring lines.
function upsertIniKey(existing, key, value, { section, separator = '=', caseInsensitive = false } = {}) {
  const crlf = existing.includes('\r\n');
  const text = trim(existing.replaceAll('\r\n', '\n'));
  const rows = text ? text.split('\n') : [];
  const header = `[${section}]`;
  let begin = rows.findIndex(row => {
    const found = row.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/)?.[1];
    return caseInsensitive ? found?.toLowerCase() === section.toLowerCase() : found === section;
  });
  if (begin < 0) rows.push(header, `${key}${separator}${value}`);
  else {
    let end = begin + 1;
    while (end < rows.length && !/^\s*\[[^\]]+\]\s*(?:[#;].*)?$/.test(rows[end])) end++;
    const match = rows.findIndex((row, i) => {
      const found = row.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1];
      return i > begin && i < end && (caseInsensitive ? found?.toLowerCase() === key.toLowerCase() : found === key);
    });
    if (match < 0) rows.splice(begin + 1, 0, `${key}${separator}${value}`);
    else rows[match] = `${key}${separator}${value}`;
  }
  const output = `${rows.join('\n')}\n`;
  return crlf ? output.replaceAll('\n', '\r\n') : output;
}
function pipConfig(existing, path) {
  const output = upsertIniKey(existing, 'cert', path, { section: 'global', caseInsensitive: true });
  if (output.includes('use-feature')) return output;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  return trim(output) + eol + '# pip >= 24.2 on Python 3.10+ can instead verify via the OS store:' + eol +
    '#   use-feature = truststore' + eol;
}
function cargoConfig(existing, path) {
  return upsertIniKey(upsertIniKey(existing, 'cainfo', JSON.stringify(path.replaceAll('\\', '/')),
    { section: 'http', separator: ' = ' }), 'git-fetch-with-cli', 'true', { section: 'net', separator: ' = ' });
}
function gitConfig(existing, path) {
  // Git quoted values retain backslashes/quotes in Windows paths.
  return upsertIniKey(existing, 'sslCAInfo', JSON.stringify(path.replaceAll('\\', '/')),
    { section: 'http', separator: ' = ', caseInsensitive: true });
}
function condarcConfig(existing, path) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const rows = trim(existing.replaceAll('\r\n', '\n')).split('\n').filter((_, i, all) => all.length !== 1 || all[0]);
  let replaced = false;
  const out = rows.map(row => {
    if (/^ssl_verify\s*:/.test(row)) { replaced = true; return `ssl_verify: ${JSON.stringify(path)}`; }
    return row;
  });
  if (!replaced) out.push(`ssl_verify: ${JSON.stringify(path)}`);
  return out.join(eol) + eol;
}
const transforms = { 'pip-config': pipConfig, 'git-config': gitConfig, 'cargo-config': cargoConfig, 'conda-config': condarcConfig };
const invalid = (reason, message, code = 'INPUT_INVALID') => ({ status: code === 'STATE_CONFLICT' || code === 'PREREQUISITE_UNAVAILABLE' ? 'blocked' : 'invalid', diagnostics: [{ code, reason, message }] });

function variantFor(request) {
  return userToolsRepair.variants.find(item => item.recipeRef === request?.variantRef &&
    item.os === process.platform && item.architectures.includes(process.arch));
}
export function renderUserToolsRepair(request) {
  const variant = variantFor(request);
  if (!variant || typeof request.bundlePath !== 'string' || !isAbsolute(request.bundlePath) ||
      /[\p{Cc}\p{Cf}]/u.test(request.bundlePath) || !/^[a-f0-9]{64}$/.test(request.bundleSha256 ?? ''))
    return invalid('repair-bindings', 'Invalid user-tool trust bindings.');
  if (variant.targets.includes('python') && variant.os === 'win32' &&
      (request.bundlePath.includes('%') || request.bundlePath.length > 1024))
    return invalid('setx-value-unsupported', 'Windows user environment cannot hold this path.');
  const bindings = { bundlePath: request.bundlePath, bundleSha256: request.bundleSha256 };
  const privateBindings = {};
  for (const { pathInput } of variant.executableBindings) {
    const path = request.executablePaths?.[pathInput] ?? '';
    if (typeof path !== 'string' || path && (!isAbsolute(path) || /[\p{Cc}\p{Cf}]/u.test(path)))
      return invalid('executable-binding', 'The selected executable path is invalid.');
    bindings[pathInput] = path;
  }
  if (variant.targets.includes('python')) {
    if (!Array.isArray(request.fingerprints) || !request.fingerprints.length ||
        request.fingerprints.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)))
      return invalid('repair-bindings', 'Invalid Python CA identities.');
    bindings.fingerprintCsv = request.fingerprints.join(',');
    bindings.pythonAssignment = variant.os === 'win32' ?
      ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'].map(key => `$env:${key} = '${request.bundlePath.replaceAll("'", "''")}'`).join('\n') :
      ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'].map(key => `export ${key}='${request.bundlePath.replaceAll("'", "'\\''")}'`).join('\n');
  }
  const snapshots = request.configSnapshots ?? {};
  for (const file of variant.configFiles) {
    const bytes = snapshots[file.operationId] ?? new Uint8Array();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > file.maxBytes)
      return invalid('config-snapshot-limit', 'A user configuration snapshot exceeds its bound.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return invalid('config-encoding', 'User configuration must be complete UTF-8 text.'); }
    if (text.includes('\0')) return invalid('config-encoding', 'User configuration contains invalid text.');
    if (file.operationId === 'pip-config' && /^[ \t]*trusted-host[ \t]*[:=](?:[ \t]*\S|[ \t]*\r?\n[ \t]+\S)/im.test(text) ||
        file.operationId === 'git-config' && /^\s*sslverify\s*=\s*(?:false|no|off|0)\s*(?:[#;].*)?$/im.test(text) ||
        file.operationId === 'cargo-config' && /^\s*ssl-verify\s*=\s*false\s*(?:#.*)?$/im.test(text))
      return invalid('trust-bypass-config', 'Existing configuration disables TLS verification. Resolve that setting before preparing this CA repair.', 'PREREQUISITE_UNAVAILABLE');
    if (file.operationId === 'pip-config' && /^[ \t]*cert[ \t]*:/im.test(text))
      return invalid('config-ambiguous', 'Use an unambiguous equals-separated pip cert entry before preparing this CA repair.');
    // Duplicate managed keys or ambiguous syntax must never become an apparently verified rewrite.
    if (ambiguousConfig(file.operationId, text)) return invalid('config-ambiguous', 'The selected user configuration has ambiguous trust entries.');
    privateBindings[file.operationId.replace('-config', 'Config')] = transforms[file.operationId](text, request.bundlePath);
    bindings[file.operationId.replace('-config', 'ConfigPath')] = join(homedir(), ...file.target.segments.map(item => item.literal));
  }
  return { status: 'completed', bindings, privateBindings };
}
function ambiguousConfig(id, text) {
  if (id === 'conda-config') return text.split(/\r?\n/).filter(line => /^ssl_verify\s*:/.test(line)).length > 1 ||
    /^(?:---|\.\.\.)\s*$/m.test(text) || /^\s+ssl_verify\s*:/m.test(text);
  const wanted = id === 'pip-config' ? { global: ['cert'] } : id === 'git-config' ? { http: ['sslcainfo', 'sslverify', 'sslbackend'] } :
    { http: ['cainfo', 'ssl-verify'], net: ['git-fetch-with-cli'] };
  let section = ''; const seen = new Set();
  for (const row of text.split(/\r?\n/)) {
    const header = row.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (header) { section = header[1].toLowerCase(); continue; }
    const key = row.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1]?.toLowerCase();
    if (wanted[section]?.includes(key)) {
      const identity = `${section}/${key}`;
      if (seen.has(identity)) return true;
      seen.add(identity);
    }
  }
  return false;
}
/** Actual-client environment guards shared by the legacy supplied-file and shared-source file routes. */
function userToolsEnvironmentBlock(variant, managedPath) {
  const home = homedir();
  const pipLocation = join(home, ...(variant.os === 'win32' ? ['AppData', 'Roaming', 'pip', 'pip.ini'] : ['.config', 'pip', 'pip.conf']));
  const sameLocation = (a, b) => variant.os === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  const redirected = variant.targets.includes('pip') && variant.os === 'win32' && process.env.APPDATA &&
    resolve(process.env.APPDATA).toLowerCase() !== resolve(home, 'AppData', 'Roaming').toLowerCase() ||
    variant.targets.includes('pip') && variant.os !== 'win32' && process.env.XDG_CONFIG_HOME &&
      resolve(process.env.XDG_CONFIG_HOME) !== resolve(home, '.config') ||
    variant.targets.includes('pip') && process.env.PIP_CONFIG_FILE && !sameLocation(process.env.PIP_CONFIG_FILE, pipLocation) ||
    variant.targets.includes('pip') && variant.os === 'win32' && process.env.WIN_PD_OVERRIDE_APPDATA &&
      !sameLocation(process.env.WIN_PD_OVERRIDE_APPDATA, join(home, 'AppData', 'Roaming')) ||
    variant.targets.includes('cargo') && process.env.CARGO_HOME && resolve(process.env.CARGO_HOME) !== resolve(home, '.cargo') ||
    variant.targets.includes('conda') && process.env.CONDARC && resolve(process.env.CONDARC) !== resolve(home, '.condarc') ||
    variant.targets.includes('git') && process.env.GIT_CONFIG_GLOBAL && resolve(process.env.GIT_CONFIG_GLOBAL) !== resolve(home, '.gitconfig');
  if (redirected) return invalid('user-config-location-unsupported', 'A selected tool redirects its user configuration. Use its canonical user location before preparing this repair.', 'PREREQUISITE_UNAVAILABLE');
  if (variant.targets.includes('cargo') && process.env.CARGO_HTTP_SSL_VERIFY && process.env.CARGO_HTTP_SSL_VERIFY !== 'true')
    return invalid('trust-bypass-environment', 'Inherited Cargo TLS verification must be enabled before preparing this CA repair.', 'PREREQUISITE_UNAVAILABLE');
  if (variant.network !== 'off' && (
      variant.targets.includes('pip') && process.env.PIP_TRUSTED_HOST ||
      variant.targets.includes('git') && process.env.GIT_SSL_NO_VERIFY ||
      variant.targets.includes('conda') && process.env.CONDA_SSL_VERIFY &&
        process.env.CONDA_SSL_VERIFY !== managedPath))
    return invalid('trust-bypass-environment', 'An inherited tool environment bypasses or overrides the selected TLS verification. Remove that override before preparing.', 'PREREQUISITE_UNAVAILABLE');
  for (const [id, key] of [['pip', 'PIP_CERT'], ['git', 'GIT_SSL_CAINFO'], ['cargo', 'CARGO_HTTP_CAINFO'],
    ['conda', 'REQUESTS_CA_BUNDLE'], ['conda', 'CURL_CA_BUNDLE']])
    if (variant.targets.includes(id) && process.env[key] && process.env[key] !== managedPath)
      return invalid('trust-override-environment', 'An inherited CA environment value overrides the selected user configuration.', 'PREREQUISITE_UNAVAILABLE');
}
export function prepareUserToolsRepair(request) {
  const variant = variantFor(request);
  if (!variant || !Array.isArray(request.targets) || variant.targets.length !== request.targets.length ||
      !variant.targets.every(id => request.targets.includes(id)) ||
      (!request.validateOnly && variant.network !== (request.offline ? 'off' : 'declared')) ||
      !(request.files?.caFile instanceof Uint8Array)) return invalid('repair-input', 'Unsupported user-tool repair input.');
  const accepted = validateSuppliedCa(request.files.caFile);
  if (!accepted.valid) return { status: 'invalid', assessedBlocks: accepted.assessedBlocks,
    ...(accepted.assessmentLimit ? { assessmentLimit: accepted.assessmentLimit } : {}), diagnostics: accepted.diagnostics };
  const facts = { fingerprints: accepted.certificates.map(item => item.fingerprint), evaluatedAt: accepted.evaluatedAt,
    count: accepted.certificates.length, duplicates: accepted.duplicates };
  if (request.validateOnly) return { status: 'completed', ...facts };
  const environment = userToolsEnvironmentBlock(variant, request.managedPath);
  if (environment) return environment;
  // All selected managers can replace their normal CA bundle; preserve roots alongside supplied CAs.
  const bundle = composeExistingTrust(request.existing, accepted.material, { includeNodeDefaults: true });
  if (bundle === undefined) return invalid('existing-trust-uncomposable', 'Existing managed trust cannot be safely composed.', 'STATE_CONFLICT');
  if (Buffer.byteLength(bundle) > 16 * 1024 * 1024) return invalid('managed-material-limit', 'Managed trust would exceed its bound.', 'STATE_CONFLICT');
  const rendered = renderUserToolsRepair({ ...request, fingerprints: facts.fingerprints, bundlePath: request.managedPath,
    bundleSha256: createHash('sha256').update(bundle).digest('hex') });
  return rendered.status === 'completed' ? { ...rendered, ...facts, bundle } : rendered;
}

/**
 * Shared-source file route (repair definition 1.1): the caller passes the complete reviewed
 * source set by identity only — `bundleSha256` of the exact serialized PEM and the sorted
 * unique DER `fingerprints` of every admitted certificate. Prior managed output is never an
 * input and never read here; refresh rebuilds from revalidated sources in the caller.
 * Runs the same actual-client environment/config guards as the legacy supplied-file repair,
 * then renders the original user recipe bindings from the captured snapshots/executable paths.
 */
export function renderUserToolsTrustFileRepair(request) {
  const variant = variantFor(request);
  if (request?.id !== 'user-tools-ca' || !variant || !Array.isArray(request.targets) ||
      variant.targets.length !== request.targets.length || !variant.targets.every(id => request.targets.includes(id)) ||
      typeof request.offline !== 'boolean' || variant.network !== (request.offline ? 'off' : 'declared') ||
      typeof request.bundlePath !== 'string' || !isAbsolute(request.bundlePath) ||
      !/^[a-f0-9]{64}$/.test(request.bundleSha256 ?? '') ||
      !Array.isArray(request.fingerprints) || !request.fingerprints.length)
    return invalid('repair-input', 'Unsupported user-tool trust file input.');
  if (Object.hasOwn(request, 'caFile') || Object.hasOwn(request, 'files') ||
      Object.hasOwn(request, 'existing') || Object.hasOwn(request, 'validateOnly'))
    return invalid('repair-input', 'The shared file route binds the complete source set; supplied-file fields are not accepted.');
  const environment = userToolsEnvironmentBlock(variant, request.bundlePath);
  if (environment) return environment;
  const rendered = renderUserToolsRepair(request);
  if (rendered.status !== 'completed' || !variant.targets.includes('python')) return rendered;
  const recipe = userToolsRecipe(variant);
  // Shared discovery includes the complete aggregate, beyond the legacy single-file bound.
  recipe.inputs.fingerprintCsv.maxLength = 4096 * 65 - 1;
  return { ...rendered, recipe };
}


const nodeInvocation = (script, args = []) => ({ executable: { name: process.execPath },
  args: [literal('-e'), literal(script), ...args], cwd, env: {}, timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
const check = (id, purpose, name, args, env = {}, timeoutMs = 25000) => ({ id, purpose, kind: 'process.exit',
  executable: { name }, args: args.map(value => typeof value === 'string' ? literal(value) : value), cwd, env,
  timeoutMs, maxOutputBytes: 16384, acceptedExitCodes: [0] });
const digestScript = "const f=require('node:fs'),c=require('node:crypto');process.exit(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')===process.argv[2]?0:1)";
const envReadScript = key => `$v=[Environment]::GetEnvironmentVariable('${key}','User');` +
  "if($null -eq $v){[Console]::Out.Write('ABSENT')}else{[Console]::Out.Write('VALUE:'+ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))}";
const envCheckScript = key => "const c=require('node:child_process'),p=require('node:path');const r=c.spawnSync(p.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')," +
  JSON.stringify(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', envReadScript(key)]) +
  ",{encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});process.exit(r.status===0&&r.stdout==='VALUE:'+Buffer.from(process.argv[1]).toString('base64')?0:1)";
const envSetScript = key => "const c=require('node:child_process'),p=require('node:path');const r=c.spawnSync(p.join(process.env.SystemRoot||'C:\\\\Windows','System32','setx.exe')," +
  `[${JSON.stringify(key)},process.argv[1]],{shell:false,timeout:10000,maxBuffer:4096,windowsHide:true});process.exit(r.status===0?0:1)`;
const pythonTls = "import os,ssl,hashlib,sys,urllib.request\nassert os.environ['SSL_CERT_FILE']==os.environ['REQUESTS_CA_BUNDLE']\nctx=ssl.create_default_context()\nloaded={hashlib.sha256(c).hexdigest() for c in ctx.get_ca_certs(binary_form=True)}\nassert set(sys.argv[1].split(',')).issubset(loaded)\nwith urllib.request.urlopen('https://pypi.org/simple/pip/',context=ctx,timeout=15) as r: assert r.status==200";
// Invoke the actual tools after checking their effective trust, never replacing the CA with a verification-only override.
const toolCheckPrelude = "const c=require('node:child_process');const expected=process.argv[1],config=process.argv[2],file=process.argv[3];" +
  "if(!file||!require('node:path').isAbsolute(file))process.exit(1);" +
  "const deadline=Date.now()+24000;const env={...process.env};" +
  "const run=(file,args)=>{const left=deadline-Date.now();if(left<=0)process.exit(1);" +
  "return c.spawnSync(file,args,{env,shell:false,windowsHide:true,encoding:'utf8',timeout:Math.min(left,18000),maxBuffer:16384})};" +
  "const ok=r=>!r.error&&r.status===0;";
// pip prints string values using Python repr. Decode only that bounded string grammar;
// never execute text returned by a tool or assume precedence among repeated file entries.
function parsePipRepr(text) {
  const quote = text[0];
  if (!['"', "'"].includes(quote) || text.at(-1) !== quote) return undefined;
  let result = '';
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i];
    if (char === quote || char.charCodeAt(0) < 32) return undefined;
    if (char !== '\\') { result += char; continue; }
    if (++i >= text.length - 1) return undefined;
    const escape = text[i];
    const simple = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    if (Object.hasOwn(simple, escape)) { result += simple[escape]; continue; }
    const digits = { x: 2, u: 4, U: 8 }[escape];
    if (!digits) return undefined;
    const hex = text.slice(i + 1, i + 1 + digits);
    if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) return undefined;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) return undefined;
    result += String.fromCodePoint(code); i += digits;
  }
  return result;
}
function assessPipList(text, expected, parseRepr) {
  let selected = false; const seen = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const entry = line.match(/^([A-Za-z0-9_:.-]+)=(.*)$/);
    if (!entry) return false;
    const key = entry[1].toLowerCase();
    if (!/\.(?:cert|trusted-host|index-url|extra-index-url)$/.test(key)) continue;
    const value = parseRepr(entry[2]);
    if (value === undefined || seen.has(key) && seen.get(key) !== value) return false;
    seen.set(key, value);
    if (key.endsWith('.cert')) {
      if (value !== expected) return false;
      if (key === 'global.cert') selected = true;
    }
    if (key.endsWith('.trusted-host') && value.trim()) return false;
    if (key.endsWith('.index-url') || key.endsWith('.extra-index-url')) {
      try { if (value.trim().split(/\s+/).filter(Boolean).some(origin => new URL(origin).protocol !== 'https:')) return false; }
      catch { return false; }
    }
  }
  return selected;
}
const pipTls = toolCheckPrelude +
  "if(env.PIP_TRUSTED_HOST||env.PIP_CERT&&env.PIP_CERT!==expected)process.exit(1);" +
  "if(['PIP_USER','PIP_SITE','PIP_GLOBAL'].some(key=>env[key]&&!/^(0|false|no|off)$/i.test(env[key])))process.exit(1);" +
  `const parseRepr=${parsePipRepr.toString()},assess=${assessPipList.toString()};` +
  "const cfg=run(file,['config','list']);if(!ok(cfg)||!assess(cfg.stdout,expected,parseRepr))process.exit(1);" +
  "const r=run(file,['--disable-pip-version-check','--no-cache-dir','index','versions','pip','--retries','0','--timeout','15']);process.exit(ok(r)?0:1)";
const gitTls = toolCheckPrelude +
  "if(env.GIT_SSL_NO_VERIFY||env.GIT_SSL_CAINFO&&env.GIT_SSL_CAINFO!==expected)process.exit(1);" +
  "env.GIT_CONFIG_GLOBAL=config;const origin='https://github.com/git/git.git';" +
  "const cfg=run(file,['config','--get-urlmatch','http.sslCAInfo',origin]);" +
  "if(!ok(cfg)||cfg.stdout.trim().replaceAll('\\\\','/')!==expected.replaceAll('\\\\','/'))process.exit(1);" +
  "const verify=run(file,['config','--get-urlmatch','http.sslVerify',origin]);" +
  "if(verify.status!==1&&(!ok(verify)||/^(false|no|off|0)$/i.test(verify.stdout.trim())))process.exit(1);" +
  "const backend=run(file,['config','--get','http.sslBackend']);if(ok(backend)&&backend.stdout.trim().toLowerCase()==='schannel')process.exit(1);" +
  "const r=run(file,['ls-remote',origin,'HEAD']);process.exit(ok(r)?0:1)";
const cargoTls = toolCheckPrelude +
  "if(env.CARGO_HTTP_SSL_VERIFY&&env.CARGO_HTTP_SSL_VERIFY!=='true'||env.CARGO_HTTP_CAINFO&&env.CARGO_HTTP_CAINFO!==expected)process.exit(1);" +
  "const p=require('node:path'),f=require('node:fs');" +
  "if(env.CARGO_HOME&&p.resolve(env.CARGO_HOME)!==p.dirname(config))process.exit(1);" +
  "try{f.lstatSync(p.join(p.dirname(config),'config'));process.exit(1)}catch(error){if(error.code!=='ENOENT')process.exit(1)};" +
  "const r=run(file,['search','serde','--limit','1']);process.exit(ok(r)?0:1)";
// conda run's Windows wrapper refuses arguments with newlines. A fresh Python
// import also starts with an empty config search path; initialize the same
// effective context used by conda's CLI before testing its connection session.
const condaTls = ["import os", "from conda.base.context import context,reset_context", "reset_context()",
  "from conda.gateways.connection.session import CondaSession", "assert context.ssl_verify == os.environ['AIHQ_EXPECTED_CA']",
  "s=CondaSession()", "url='https://repo.anaconda.com/pkgs/main/noarch/repodata.json'",
  "assert s.merge_environment_settings(url,{},True,None,None)['verify'] == os.environ['AIHQ_EXPECTED_CA']",
  "r=s.get(url,timeout=15,stream=True)",
  "assert r.status_code==200", "r.close()"].join(';');

export function userToolsRecipe(variant) {
  const inputs = { bundle: { type: 'string', required: true, sensitive: true, maxLength: 16 * 1024 * 1024 },
    bundlePath: { type: 'string', required: true, maxLength: 4096 }, bundleSha256: { type: 'string', required: true, maxLength: 64 } };
  for (const { pathInput } of variant.executableBindings) inputs[pathInput] = { type: 'string', required: true, maxLength: 4096 };
  const operations = [{ id: 'material', purpose: 'Write composed trust preserving all existing managed certificates', kind: 'file.write',
    scope: 'user', target: { root: 'userState', segments: [literal('trust.pem')] }, content: input('bundle'), mode: 0o600,
    requires: [], checks: ['material-digest'] }];
  const checks = [{ id: 'material-digest', purpose: 'Check managed CA material bytes', kind: 'process.exit',
    ...nodeInvocation(digestScript, [input('bundlePath'), input('bundleSha256')]) }];
  const python = variant.os === 'win32' ? 'python' : 'python3';
  if (variant.targets.includes('python')) {
    inputs.pythonAssignment = { type: 'string', required: true, maxLength: 16384 };
    inputs.fingerprintCsv = { type: 'string', required: true, maxLength: 16640 };
    checks.push(check('python-installed', 'Require the selected existing Python executable', python, ['--version']));
    operations.push({ id: 'python-ready', purpose: 'Verify existing Python is runnable before changing its trust references',
      kind: 'process.run', scope: 'user', executable: { name: python }, args: [literal('--version')], cwd, env: {},
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0],
      effects: ['Read-only Python version process'], requires: [], checks: ['python-installed'] });
    const dependencies = ['material', 'python-ready'];
    if (variant.os === 'win32') for (const [suffix, key] of [['ssl', 'SSL_CERT_FILE'], ['requests', 'REQUESTS_CA_BUNDLE']]) {
      const id = `python-persist-${suffix}`;
      operations.push({ id, purpose: `Persist ${key} for future Windows user processes`, kind: 'process.run', scope: 'user',
        ...nodeInvocation(envSetScript(key), [input('bundlePath')]), effects: [`HKCU\\Environment\\${key}`],
        requires: ['material', 'python-ready'], checks: [`python-user-env-${suffix}`] });
      checks.push({ id: `python-user-env-${suffix}`, purpose: `Check fresh process reads persisted ${key}`, kind: 'process.exit',
        ...nodeInvocation(envCheckScript(key), [input('bundlePath')]) });
      dependencies.push(id);
    }
    operations.push({ id: 'python-config', purpose: 'Set Python SSL_CERT_FILE and Requests CA path for future user shell sessions',
      kind: 'text.block', scope: 'user', target: target(variant.os === 'win32' ?
        ['Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'] : [variant.os === 'darwin' ? '.zprofile' : '.profile']),
      blockId: 'python-ca', startMarker: '# BEGIN AIHQ PYTHON CA', endMarker: '# END AIHQ PYTHON CA', action: 'set',
      content: input('pythonAssignment'), requires: dependencies, checks: ['python-installed', ...(variant.network === 'off' ? [] : ['python-behavior'])] });
    if (variant.network !== 'off') checks.push(check('python-behavior', 'Check Python default TLS context reaches PyPI with selected trust',
      python, ['-c', pythonTls, input('fingerprintCsv')], { SSL_CERT_FILE: input('bundlePath'), REQUESTS_CA_BUNDLE: input('bundlePath') }));
  }
  for (const file of variant.configFiles) {
    const id = file.operationId.split('-')[0];
    inputs[`${id}Config`] = { type: 'string', required: true, sensitive: true, maxLength: 2 * 1024 * 1024 };
    inputs[`${id}ConfigPath`] = { type: 'string', required: true, maxLength: 4096 };
    checks.push(check(`${id}-installed`, `Require the selected existing ${id} executable`, id, ['--version']));
    const selectedChecks = [`${id}-installed`];
    if (id === 'cargo') {
      checks.push(check('cargo-git-installed', 'Cargo git-fetch-with-cli requires existing Git', 'git', ['--version']));
      selectedChecks.push('cargo-git-installed');
    }
    operations.push({ id: `${id}-ready`, purpose: `Verify existing ${id} prerequisites before changing its configuration`,
      kind: 'process.run', scope: 'user', executable: { name: id }, args: [literal('--version')], cwd, env: {},
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0], effects: [`Read-only ${id} version process`],
      requires: [], checks: [...selectedChecks] });
    if (variant.network !== 'off') selectedChecks.push(`${id}-behavior`);
    const keys = { pip: '[global] cert', git: '[http] sslCAInfo', cargo: '[http] cainfo and [net] git-fetch-with-cli=true', conda: 'ssl_verify' };
    operations.push({ id: file.operationId, purpose: `Set ${id} ${keys[id]} using the reviewed CA path; preserve neighboring configuration privately`,
      kind: 'file.write', scope: 'user', target: structuredClone(file.target), content: input(`${id}Config`),
      requires: ['material', `${id}-ready`], checks: selectedChecks });
    if (variant.network === 'off') continue;
    if (id === 'pip') checks.push({ id: 'pip-behavior', purpose: 'Check effective pip CA configuration and HTTPS package index query', kind: 'process.exit',
      ...nodeInvocation(pipTls, [input('bundlePath'), input('pipConfigPath'), input('pipExecutable')]), timeoutMs: 30000, maxOutputBytes: 16384 });
    if (id === 'git') checks.push({ id: 'git-behavior', purpose: 'Check effective Git CA, verification and HTTPS remote read', kind: 'process.exit',
      ...nodeInvocation(gitTls, [input('bundlePath'), input('gitConfigPath'), input('gitExecutable')]), timeoutMs: 30000, maxOutputBytes: 16384 });
    if (id === 'cargo') checks.push({ id: 'cargo-behavior', purpose: 'Check Cargo searches with inherited verified trust and no shadowing extensionless config', kind: 'process.exit',
      ...nodeInvocation(cargoTls, [input('bundlePath'), input('cargoConfigPath'), input('cargoExecutable')]), timeoutMs: 30000, maxOutputBytes: 16384 });
    if (id === 'conda') checks.push(check('conda-behavior', 'Check conda base connection session uses selected ssl_verify and reaches its repository',
      'conda', ['run', '--no-capture-output', '-n', 'base', 'python', '-c', condaTls],
      { CONDARC: input('condaConfigPath'), AIHQ_EXPECTED_CA: input('bundlePath') }, 30000));
  }
  return { schema: 'urn:aihq:core:recipe:1.0.0', id: 'user-tools-ca', description: userToolsRepair.description,
    inputs, materials: [], targets: ['user'], prerequisites: [], operations, checks };
}

export function userToolsObservationRequests(request) {
  if (process.platform !== 'win32' || !request.targets.includes('python')) return [];
  return [['ssl', 'SSL_CERT_FILE'], ['requests', 'REQUESTS_CA_BUNDLE']].map(([suffix, key]) => ({
    id: `python-user-env-${suffix}`, operationId: `python-persist-${suffix}`,
    executable: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', envReadScript(key)], timeoutMs: 10000, maxOutputBytes: 4096
  }));
}
export function assessUserToolsObservations(request) {
  return request.observations.map(item => {
    const suffix = item.id === 'python-user-env-ssl' ? 'ssl' : item.id === 'python-user-env-requests' ? 'requests' : undefined;
    if (!suffix) throw new Error('observation-unsupported');
    let current = null;
    if (item.output !== 'ABSENT') {
      const encoded = item.output.startsWith('VALUE:') ? item.output.slice(6) : '';
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('user-environment-invalid');
      current = Buffer.from(encoded, 'base64').toString('utf8');
      if ('VALUE:' + Buffer.from(current).toString('base64') !== item.output) throw new Error('user-environment-invalid');
    }
    return { id: item.id, operationId: `python-persist-${suffix}`, raw: item.output,
      expectedRaw: 'VALUE:' + Buffer.from(request.managedPath).toString('base64'),
      conflict: current !== null && current !== request.managedPath, observedValue: current,
      reason: current === null ? 'absent' : current === request.managedPath ? 'already-selected' : 'replace-reviewed' };
  });
}
