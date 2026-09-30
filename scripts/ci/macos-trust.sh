#!/usr/bin/env bash
set -euo pipefail

case_dir="$(mktemp -d "$RUNNER_TEMP/aih-native-macos.XXXXXX")"
server_pid=""
stop_server() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
  fi
}
trap stop_server EXIT

printf 'OS: %s %s\n' "$(sw_vers -productName)" "$(sw_vers -productVersion)"
printf 'OS build: %s\n' "$(sw_vers -buildVersion)"
printf 'Architecture: %s\n' "$(uname -m)"
printf 'Runtime: %s; npm %s\n' "$(node --version)" "$(npm --version)"
id
test "$(uname -m)" = arm64
case "$(sw_vers -productVersion)" in 26.*) ;; *) exit 1 ;; esac
case "$(node --version)" in v24.*) ;; *) exit 1 ;; esac
test "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0

mkdir -p "$case_dir/packs" "$case_dir/consumer" "$case_dir/tls" "$case_dir/home"
(
  cd "$GITHUB_WORKSPACE"
  npm ci --ignore-scripts
  npm run typecheck
  npm run build
  npm test
  npm pack --ignore-scripts --pack-destination "$case_dir/packs"
)
printf '{"name":"aih-native-macos","private":true,"type":"module"}\n' > "$case_dir/consumer/package.json"
(
  cd "$case_dir/consumer"
  npm install --ignore-scripts --no-audit --no-fund --package-lock=false "$case_dir"/packs/*.tgz
)
# Actual product operations target only this disposable account-home fixture.
export HOME="$case_dir/home"
export USERPROFILE="$case_dir/home"

cat > "$case_dir/tls/ca.cnf" <<'EOF'
[req]
distinguished_name=dn
x509_extensions=v3_ca
prompt=no
[dn]
CN=AIH Native Acceptance Temporary Root
[v3_ca]
basicConstraints=critical,CA:true
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EOF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$case_dir/tls/ca.key" \
  -out "$case_dir/tls/ca.crt" -days 1 -config "$case_dir/tls/ca.cnf" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$case_dir/tls/server.key" \
  -out "$case_dir/tls/server.csr" -subj '/CN=localhost' >/dev/null 2>&1
cat > "$case_dir/tls/server.ext" <<'EOF'
subjectAltName=DNS:localhost
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$case_dir/tls/server.csr" -CA "$case_dir/tls/ca.crt" \
  -CAkey "$case_dir/tls/ca.key" -CAcreateserial -out "$case_dir/tls/server.crt" \
  -days 1 -extfile "$case_dir/tls/server.ext" >/dev/null 2>&1

cat > "$case_dir/consumer/server.mjs" <<'NODE'
import https from 'node:https';
import { readFileSync } from 'node:fs';
const root = process.argv[2];
https.createServer({
  key: readFileSync(root + '/server.key'),
  cert: readFileSync(root + '/server.crt')
}, (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
}).listen(8443);
NODE
node "$case_dir/consumer/server.mjs" "$case_dir/tls" &
server_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --disable --silent --show-error --head --cacert "$case_dir/tls/ca.crt" \
      --noproxy '*' https://localhost:8443/ >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --disable --silent --show-error --head --cacert "$case_dir/tls/ca.crt" \
  --noproxy '*' https://localhost:8443/ >/dev/null

cat > "$case_dir/consumer/probe.mjs" <<'NODE'
import tls from 'node:tls';
const socket = tls.connect({
  host: 'localhost', port: 8443, servername: 'localhost', rejectUnauthorized: true
}, () => {
  console.log(socket.authorized ? 'pass' : 'not-authorized');
  socket.end();
});
socket.on('error', error => {
  console.log(error.code);
  process.exitCode = 1;
});
NODE
if node "$case_dir/consumer/probe.mjs"; then
  echo 'Default Node unexpectedly trusted the private CA before OS import'
  exit 1
fi
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain "$case_dir/tls/ca.crt"
os_code="$(curl --disable --silent --show-error --head --output /dev/null \
  --write-out '%{http_code}' --noproxy '*' https://localhost:8443/)"
printf 'OS HTTPS status: %s\n' "$os_code"
test "$os_code" = 200
if node "$case_dir/consumer/probe.mjs"; then
  echo 'Default Node unexpectedly trusted the private CA after OS import'
  exit 1
fi
NODE_USE_SYSTEM_CA=1 node "$case_dir/consumer/probe.mjs"

export npm_config_registry=https://localhost:8443/
cat > "$case_dir/consumer/repair.mjs" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '@aihq/core';
import Ajv2020 from 'ajv/dist/2020.js';
import preparedSchema from '@aihq/core/schemas/prepared-work/1.0.0.json' with { type: 'json' };
import resultSchema from '@aihq/core/schemas/run-result/1.0.0.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: true });
const validPrepared = ajv.compile(preparedSchema);
const validResult = ajv.compile(resultSchema);
const authorize = review => ({ approved: true, origin: 'automation', reviewDigest: review.review.reviewDigest });
const exactReplacement = (name, operationId) => {
  const path = join(homedir(), name);
  return existsSync(path) ? [{ selectionId: 'trust', operationId, choice: 'replace',
    observedSha256: createHash('sha256').update(readFileSync(path)).digest('hex') }] : [];
};
const system = await prepare({
  useCase: 'repair',
  repairs: [{ id: 'node-os-trust', targets: ['node'], inputs: { originId: 'npm-registry' } }],
  resolutions: exactReplacement('.zprofile', 'node-config')
}, { logging: 'off' });
assert.equal(system.status, 'ready', JSON.stringify(system.diagnostics));
assert.equal(system.review.inputs.candidateKind, 'system-ca');
assert.equal(validPrepared(system.review), true, JSON.stringify(validPrepared.errors));
console.log('System CA review:', JSON.stringify({
  candidateKind: system.review.inputs.candidateKind,
  observations: system.review.observations
}));
const applied = await apply(system.prepared, authorize(system), { logging: 'off' });
assert.equal(validResult(applied), true, JSON.stringify(validResult.errors));
assert.equal(applied.completion, 'complete', JSON.stringify(applied));
assert.equal(applied.checks.find(check => check.id === 'trust/node-tls')?.status, 'passed');
assert.match(readFileSync(join(homedir(), '.zprofile'), 'utf8'), /NODE_USE_SYSTEM_CA/);
console.log('System CA result:', JSON.stringify({
  completion: applied.completion, operations: applied.operations, checks: applied.checks
}));

const supplied = await prepare({
  useCase: 'repair',
  repairs: [{ id: 'node-npm-ca', targets: ['npm'], inputs: { caFile: process.argv[2] } }],
  resolutions: exactReplacement('.npmrc', 'npm-config')
}, { logging: 'off' });
assert.equal(supplied.status, 'ready', JSON.stringify(supplied.diagnostics));
assert.equal(validPrepared(supplied.review), true, JSON.stringify(validPrepared.errors));
const npmResult = await apply(supplied.prepared, authorize(supplied), { logging: 'off' });
assert.equal(validResult(npmResult), true, JSON.stringify(validResult.errors));
assert.equal(npmResult.completion, 'complete', JSON.stringify(npmResult));
assert.equal(npmResult.checks.find(check => check.id === 'trust/npm-behavior')?.status, 'passed');
console.log('Supplied npm result:', JSON.stringify({
  completion: npmResult.completion, operations: npmResult.operations, checks: npmResult.checks
}));
NODE
node "$case_dir/consumer/repair.mjs" "$case_dir/tls/ca.crt"
