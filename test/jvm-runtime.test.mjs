import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runtime from '@aihq/core/harness/runtime';

// Disposable process protocols: no selected JDK/manager artifact or native TLS claim.
test('JVM discovery keeps the selected launcher separate from Gradle daemon and toolchain', {skip:process.platform==='win32'}, async () => {
  const root=mkdtempSync(join(tmpdir(),'aih-jvm-runtime-'));
  try {
    const javaHome=join(root,'jdk'), daemonHome=join(root,'daemon');
    mkdirSync(join(javaHome,'bin'),{recursive:true});
    const java=join(javaHome,'bin','java'), gradle=join(root,'gradle');
    writeFileSync(java, `#!/bin/sh\nprintf '    java.home = ${javaHome}\n    java.runtime.version = 27.0.1+3\n    os.arch = amd64\n' >&2\n`, {mode:0o755});
    writeFileSync(gradle, `#!/bin/sh\nprintf 'Gradle 9.8.2\nLauncher JVM: 27.0.1 (Oracle Corporation)\nDaemon JVM: ${daemonHome} (from org.gradle.java.home)\n'\n`, {mode:0o755});
    assert.equal(typeof runtime.inspectJvmRuntime, 'function');
    const result=await runtime.inspectJvmRuntime({target:'gradle',javaExecutable:java,executable:gradle,project:root});
    assert.equal(result.decision,'blocked');
    assert.equal(result.reason,'daemon-jvm-differs');
    assert.equal(result.observation.launcher.javaHome,javaHome);
    assert.equal(result.observation.daemon.javaHome,daemonHome);
    assert.equal(result.observation.toolchain.state,'unconfirmed');
    assert.equal(result.observation.tls,'unconfirmed');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('JVM discovery refuses explicit options without launching or changing them', async () => {
  const key='JDK_JAVA_OPTIONS', previous=process.env[key];
  process.env[key]='-Djavax.net.ssl.trustStore=/application/store.p12';
  try {
    const result=await runtime.inspectJvmRuntime({target:'maven',javaExecutable:'/absent/java',executable:'/absent/mvn',project:tmpdir()});
    assert.equal(result.decision,'blocked');
    assert.ok(['explicit-jvm-options','windows-observer-unqualified','distribution-unqualified'].includes(result.reason));
    assert.equal(process.env[key],'-Djavax.net.ssl.trustStore=/application/store.p12');
    assert.equal(result.observation.launcher,undefined);
  } finally { if(previous===undefined)delete process.env[key];else process.env[key]=previous; }
});

test('JVM discovery bounds a stalled process and cancels before starting work', {skip:process.platform==='win32'}, async () => {
  const root=mkdtempSync(join(tmpdir(),'aih-jvm-stall-'));
  try {
    const java=join(root,'java'), marker=join(root,'started');
    writeFileSync(java,`#!/bin/sh\ntouch '${marker}'\nexec sleep 20\n`,{mode:0o755});
    const request={target:'maven',javaExecutable:java,executable:java,project:root};
    const cancelled=await runtime.inspectJvmRuntime(request,{signal:AbortSignal.abort()});
    assert.equal(cancelled.reason,'cancelled');
    assert.equal(existsSync(marker),false);
    const result=await runtime.inspectJvmRuntime(request,{budgetMs:200});
    assert.equal(result.decision,'blocked');
    assert.equal(result.reason,'deadline');
    assert.equal(result.observation.launcher,undefined);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('JVM discovery prefers jssecacerts and never calls a PKCS12 envelope a JKS baseline', {skip:process.platform==='win32'}, async () => {
  const root=mkdtempSync(join(tmpdir(),'aih-jvm-store-'));
  try {
    const javaHome=join(root,'jdk'), java=join(root,'java'), maven=join(root,'mvn');
    mkdirSync(join(javaHome,'lib','security'),{recursive:true});
    writeFileSync(join(javaHome,'lib','security','cacerts'),Buffer.from('feedfeed0000000200000000','hex'));
    writeFileSync(join(javaHome,'lib','security','jssecacerts'),Buffer.from('3012020103300d06092a864886f70d010701a000','hex'));
    writeFileSync(java, `#!/bin/sh\nprintf '    java.home = ${javaHome}\n    java.runtime.version = 27.0.1+3\n    os.arch = amd64\n' >&2\n`, {mode:0o755});
    writeFileSync(maven, `#!/bin/sh\nprintf 'Apache Maven 3.10.0\nJava version: 27.0.1, vendor: Oracle Corporation, runtime: ${javaHome}\n'\n`, {mode:0o755});
    const result=await runtime.inspectJvmRuntime({target:'maven',javaExecutable:java,executable:maven,project:root});
    assert.equal(result.decision,'unconfirmed');
    assert.equal(result.observation.store.path,join(javaHome,'lib','security','jssecacerts'));
    assert.equal(result.observation.store.format,'pkcs12-envelope');
    assert.equal(result.observation.store.admission,'unverified');
    assert.equal(result.observation.manager.version,'3.10.0');
    assert.equal(result.observation.tls,'unconfirmed');
  } finally {rmSync(root,{recursive:true,force:true});}
});
