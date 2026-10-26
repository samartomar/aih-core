import assert from 'node:assert/strict';
import { verificationKeys, verificationPublishers } from '@aihq/core/harness';
import { getTrustSnapshot, getVerificationTrust, createTufTrustClient, getCurrentTrustStatus, getCatalogIndexTrust } from '@aihq/core/harness/runtime';
const snapshot = getTrustSnapshot();
assert.deepEqual(snapshot.verificationKeys, verificationKeys);
assert.deepEqual(snapshot.verificationPublishers, verificationPublishers);
assert.deepEqual(snapshot.scanEvidencePolicies, []);
assert.equal((await getVerificationTrust()).publishers.length, verificationPublishers.length);


import { readFileSync } from 'node:fs';
import { authenticateEvidence } from '@aihq/core';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
const pair = generateKeyPairSync('ed25519');
const keyid = 'fixture-tuf-key';
const signed = data => Buffer.from(JSON.stringify({signed:data,signatures:[{keyid,sig:sign(null,Buffer.from(canonical(data)),pair.privateKey).toString('hex')}]}));
const expires = '2099-01-01T00:00:00Z';
const root = signed({_type:'root',spec_version:'1.0.31',version:1,expires,consistent_snapshot:false,
  keys:{[keyid]:{keytype:'ed25519',scheme:'ed25519',keyval:{public:pair.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex')}}},
  roles:Object.fromEntries(['root','timestamp','snapshot','targets'].map(k => [k,{keyids:[keyid],threshold:1}]))});
const org = generateKeyPairSync('ed25519');
const spki = org.publicKey.export({format:'der',type:'spki'});
const record = {keyId:'ed25519:'+sha(spki),algorithm:'Ed25519',publicKeySpkiBase64:spki.toString('base64'),identity:'local-fixture-org',purposes:['scan-report']};
let files = {};
function publish(version, body, metadata = {}, snapshotMetadata = {}) {
  const target = Buffer.from(JSON.stringify(body));
  const targets = signed({_type:'targets',spec_version:'1.0.31',version,expires,...metadata,targets:{'trust.json':{length:target.length,hashes:{sha256:sha(target)}}}});
  const snapshot = signed({_type:'snapshot',spec_version:'1.0.31',version,expires,...snapshotMetadata,meta:{'targets.json':{version,length:targets.length,hashes:{sha256:sha(targets)}}}});
  const timestamp = signed({_type:'timestamp',spec_version:'1.0.31',version,expires,meta:{'snapshot.json':{version,length:snapshot.length,hashes:{sha256:sha(snapshot)}}}});
  files = {'/metadata/timestamp.json':timestamp,'/metadata/snapshot.json':snapshot,'/metadata/targets.json':targets,'/targets/trust.json':target};
}
const publisherTrust = JSON.parse(readFileSync(join(process.argv[2],'test-dsse-0.0.1.trust.json')));
const artifactBytes = new Uint8Array(readFileSync(join(process.argv[2],'test-dsse-0.0.1.artifact.json')));
const expectedScanId = JSON.parse(new TextDecoder().decode(artifactBytes)).scanId;
const policy = {schema:'urn:aihq:scan:evidence-policy:1.0.0',id:'local',version:'1',requiredDetectors:[],severityProfile:{id:'local',sha256:'a'.repeat(64)},suppressions:[]};
const body = {schema:'urn:aihq:harness:trust-update:1.0.0', verificationKeys:[record],verificationPublishers:publisherTrust.publishers,scanEvidencePolicies:[policy],revocations:[],catalogTufRootBase64:root.toString('base64'),authority:{frameworks:['attacker']},metadataBaseUrl:'https://attacker.invalid/'};
publish(1,body);
let requests = 0;
const server = createServer((req,res) => { requests++; const value=files[req.url];res.writeHead(value?200:404);res.end(value); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
try {
  const base='http://127.0.0.1:'+server.address().port;
  const client = createTufTrustClient({root,metadataBaseUrl:base+'/metadata/',targetBaseUrl:base+'/targets/',targetPath:'trust.json',cacheDir:join(process.argv[2],'cache')});
  assert.equal(requests,0);
  const updated = await client.update();
  assert.equal(updated.verificationKeys[0].identity, 'local-fixture-org');
  assert.equal((await getVerificationTrust(updated)).keys[0].keyId, record.keyId);
  assert.deepEqual(getTrustSnapshot().verificationKeys, []);
  assert.equal(getCurrentTrustStatus(updated, {keyId:record.keyId}), 'current');
  publish(2,{...body, verificationKeys:[], revocations:[{kind:'key',id:record.keyId}]});
  const revoked = await client.update();
  assert.equal(getCurrentTrustStatus(revoked,{keyId:record.keyId}), 'revoked');
  assert.equal(getCurrentTrustStatus(updated,{keyId:record.keyId}), 'current');
  assert.deepEqual(await getVerificationTrust(revoked),await getVerificationTrust(updated));
  assert.deepEqual(getCatalogIndexTrust(updated).tufRoot,new Uint8Array(root));
  assert.deepEqual(JSON.parse(JSON.stringify(updated.scanEvidencePolicies[0])), policy);
  assert.equal(Object.hasOwn(updated,'authority'),false);
  assert.equal(Object.hasOwn(updated,'metadataBaseUrl'),false);
  const historical = await authenticateEvidence({bytes:artifactBytes,expectedScanId,trust:await getVerificationTrust(updated)});
  assert.equal(historical.status,'authenticated');
  publish(3,{...body,verificationKeys:[],verificationPublishers:[],revocations:[{kind:'publisher',id:publisherTrust.publishers[0].identity}]});
  const publisherRevoked = await client.update();
  assert.equal(getCurrentTrustStatus(publisherRevoked,{publisherIdentity:publisherTrust.publishers[0].identity}), 'revoked');
  assert.deepEqual(await authenticateEvidence({bytes:artifactBytes,expectedScanId,trust:await getVerificationTrust(publisherRevoked)}),historical);
  // Persistent cache retains rollback floors across client instances.
  const options={root,metadataBaseUrl:base+'/metadata/',targetBaseUrl:base+'/targets/',targetPath:'trust.json',cacheDir:join(process.argv[2],'cache')};
  publish(1,body);
  await assert.rejects(createTufTrustClient(options).update());
  // Signed metadata with an expired timestamp is refused.
  publish(4,body);
  const expired=JSON.parse(files['/metadata/timestamp.json']).signed;
  expired.expires='2000-01-01T00:00:00Z';
  files['/metadata/timestamp.json']=signed(expired);
  await assert.rejects(createTufTrustClient(options).update());
  // Metadata signature corruption is not a trusted update.
  publish(4,body);
  const badSignature=JSON.parse(files['/metadata/timestamp.json']);
  badSignature.signatures[0].sig='00'.repeat(64);
  files['/metadata/timestamp.json']=Buffer.from(JSON.stringify(badSignature));
  await assert.rejects(createTufTrustClient(options).update());
  // Exact target bytes must match the signed length/hash.
  publish(4,body);files['/targets/trust.json']=Buffer.from('{}');
  await assert.rejects(createTufTrustClient(options).update());
  // An unrelated root cannot replace independently selected authority.
  publish(5,body);
  const badRoot=JSON.parse(root);badRoot.signed.version=2;badRoot.signatures[0].sig='00'.repeat(64);
  files['/metadata/2.root.json']=Buffer.from(JSON.stringify(badRoot));
  await assert.rejects(createTufTrustClient(options).update());
  assert.throws(()=>createTufTrustClient({...options,root:Buffer.from('{}')}),/trust-source-mismatch/);
  delete files['/metadata/2.root.json'];
  // Advertised metadata lengths cannot override the client's absolute cap.
  publish(6,body,{}, {padding:'x'.repeat(1048576)});
  await assert.rejects(createTufTrustClient(options).update());
  publish(7,body,{padding:'x'.repeat(1048576)});
  await assert.rejects(createTufTrustClient(options).update());
  // Publisher identity may retain several historical policy/root records.
  const rotated = {...publisherTrust.publishers[0], policy:{...publisherTrust.publishers[0].policy,
    subjectAlternativeName:'https://test.invalid/workflows/rotated@refs/heads/test'}};
  publish(8,{...body,verificationPublishers:[rotated, publisherTrust.publishers[0],rotated]});
  const rotatedSnapshot = await createTufTrustClient(options).update();
  assert.equal(rotatedSnapshot.verificationPublishers.filter(p=>p.identity===rotated.identity).length,2);
  assert.deepEqual(await authenticateEvidence({bytes:artifactBytes,expectedScanId,trust:await getVerificationTrust(rotatedSnapshot)}),historical);
  // No background refresh is scheduled, even after failed updates.
  const before=requests;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(requests,before);
} finally { await new Promise(resolve=>server.close(resolve)); }
console.log(JSON.stringify({status:'passed'}));
