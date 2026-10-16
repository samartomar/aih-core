import tls from 'node:tls';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as asn1js from 'asn1js';
import { BasicConstraints, Certificate, CryptoEngine, Extension, GeneralName, GeneralNames,
  AttributeTypeAndValue } from 'pkijs';

const crypto = new CryptoEngine({ name: 'fixture', crypto: webcrypto, subtle: webcrypto.subtle });
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export async function createRegistryCertificates() {
  const generate = () => webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const caKeys = await generate(); const leafKeys = await generate();
  // A distinct CA name per call, so an unrelated CA is never matched as the issuer by name.
  const issuer = `Registry fixture CA ${randomUUID()}`;
  const name = value => new AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value }) });
  const certificate = async (keys, serial, subject) => {
    const cert = new Certificate(); cert.version = 2;
    cert.serialNumber = new asn1js.Integer({ value: serial });
    cert.issuer.typesAndValues.push(name(issuer));
    cert.subject.typesAndValues.push(name(subject));
    cert.notBefore.value = new Date(Date.now() - 60_000);
    cert.notAfter.value = new Date(Date.now() + 24 * 60 * 60_000);
    await cert.subjectPublicKeyInfo.importKey(keys.publicKey, crypto);
    return cert;
  };
  const ca = await certificate(caKeys, 1, issuer);
  const constraints = new BasicConstraints({ cA: true });
  ca.extensions = [new Extension({ extnID: '2.5.29.19', critical: true,
    extnValue: constraints.toSchema().toBER(false) }),
  new Extension({ extnID: '2.5.29.15', critical: true,
    extnValue: new asn1js.BitString({ valueHex: new Uint8Array([0x06]).buffer, unusedBits: 1 }).toBER(false) })];
  await ca.sign(caKeys.privateKey, 'SHA-256', crypto);
  const leaf = await certificate(leafKeys, 2, 'registry.npmjs.org');
  leaf.extensions = [new Extension({ extnID: '2.5.29.17', extnValue:
    new GeneralNames({ names: [new GeneralName({ type: 2, value: 'registry.npmjs.org' })] }).toSchema().toBER(false) })];
  await leaf.sign(caKeys.privateKey, 'SHA-256', crypto);
  return { caPem: pem('CERTIFICATE', ca.toSchema().toBER(false)),
    leafPem: pem('CERTIFICATE', leaf.toSchema().toBER(false)),
    keyPem: pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey)) };
}

export async function startRegistry({ leafPem, keyPem }) {
  const sockets = new Set();
  const server = tls.createServer({ cert: leafPem, key: keyPem }, socket => socket.end());
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: server.address().port, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    for (const socket of sockets) socket.destroy();
  }) };
}

export function redirectRegistry(port) {
  const connect = tls.connect;
  tls.connect = function (options, ...args) {
    return connect.call(this, options?.host === 'registry.npmjs.org' ?
      { ...options, host: '127.0.0.1', port } : options, ...args);
  };
  return () => { tls.connect = connect; };
}

export function fakeNpmPath(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    process.platform === 'win32' ? '@echo off\r\necho 10.0.0\r\nexit /b 0\r\n' :
      '#!/bin/sh\nprintf "10.0.0\\n"\nexit 0\n', { mode: 0o755 });
  return dir;
}
