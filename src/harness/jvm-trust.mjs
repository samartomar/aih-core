import { createHash, X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { jvmRepair } from './jvm-trust-definitions.mjs';
import { composeExistingTrust, validateSuppliedCa } from './ca.mjs';

const literal = value => ({ literal: value });
const input = name => ({ input: name });
const cwd = { root: 'userHome', segments: [] };

// Conventional public container password for CA-only truststores (donor semantics):
// the store distributes public certificates; the password is an integrity gate, not a secret.
const STORE_PASSWORD = 'changeit';
const GRADLE_ENDPOINT = 'https://services.gradle.org/versions/current';
const MAVEN_ENDPOINT = 'https://repo.maven.apache.org/maven2/';

/**
 * Read-only JKS trusted-certificate parser shared by baseline admission and the
 * fixed materialization script (embedded there by source). Dependencies are
 * injected so the same source runs inside the recipe's `node -e` process.
 * Throws Error with a stable reason code on any structural or content problem.
 */
function jksStoreFingerprints(bytes, crypto) {
  const fail = reason => { throw new Error(reason); };
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('jks-bytes');
  if (bytes.length < 12 + 20 || bytes.length > 4 * 1024 * 1024) fail('jks-length');
  if (bytes.readUInt32BE(0) !== 0xfeedfeed) fail('jks-magic');
  if (bytes.readUInt32BE(4) !== 2) fail('jks-version');
  const count = bytes.readUInt32BE(8);
  if (count < 1 || count > 2048) fail('jks-count');
  let offset = 12;
  const fingerprints = [];
  for (let index = 0; index < count; index++) {
    if (offset + 4 > bytes.length - 20) fail('jks-truncated');
    const tag = bytes.readUInt32BE(offset); offset += 4;
    if (tag !== 2) fail(tag === 1 ? 'jks-private-key' : 'jks-entry-tag');
    const string = () => {
      if (offset + 2 > bytes.length - 20) fail('jks-truncated');
      const length = bytes.readUInt16BE(offset); offset += 2;
      if (offset + length > bytes.length - 20) fail('jks-truncated');
      const value = bytes.subarray(offset, offset + length); offset += length;
      return value;
    };
    string(); // alias: opaque modified UTF-8, never interpreted
    if (offset + 8 > bytes.length - 20) fail('jks-truncated');
    offset += 8; // timestamp
    const type = string().toString('latin1');
    if (type !== 'X.509') fail('jks-cert-type');
    if (offset + 4 > bytes.length - 20) fail('jks-truncated');
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (length < 1 || length > 262144 || offset + length > bytes.length - 20) fail('jks-cert-length');
    const der = Buffer.from(bytes.subarray(offset, offset + length)); offset += length;
    let cert;
    try { cert = new crypto.X509Certificate(der); } catch { fail('jks-cert-invalid'); }
    if (!cert.raw.equals(der)) fail('jks-cert-invalid');
    if (!cert.ca) fail('jks-not-ca');
    fingerprints.push(crypto.createHash('sha256').update(cert.raw).digest('hex'));
  }
  if (offset !== bytes.length - 20) fail('jks-trailing');
  // JKS integrity: SHA-1 of the UTF-16BE password, the fixed salt and the store body.
  // The literal keeps this source self-contained when embedded in the materialize script.
  const storePassword = 'changeit';
  const password = Buffer.alloc(storePassword.length * 2);
  for (let i = 0; i < storePassword.length; i++) password.writeUInt16BE(storePassword.charCodeAt(i), i * 2);
  const integrity = crypto.createHash('sha1').update(password).update('Mighty Aphrodite', 'latin1')
    .update(bytes.subarray(0, bytes.length - 20)).digest();
  if (!integrity.equals(bytes.subarray(bytes.length - 20))) fail('jks-integrity');
  return fingerprints;
}

/** Reviewed baseline admission: complete JKS parse, CA-only entries, public container password. */
function validateBaselineStore(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1)
    return { valid: false, reason: 'baseline-store-invalid', message: 'The selected baseline truststore is missing or empty.' };
  try {
    return { valid: true, fingerprints: jksStoreFingerprints(Buffer.from(bytes), { createHash, X509Certificate }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'jks-bytes';
    return ['jks-length', 'jks-magic', 'jks-version'].includes(reason) ?
      { valid: false, reason: 'baseline-store-unsupported',
        message: 'The selected baseline truststore is not a JKS store. Select the JDK cacerts file in JKS format.' } :
      { valid: false, reason: 'baseline-store-invalid',
        message: 'The selected baseline truststore is not a readable CA-only JKS store with the conventional public container password.' };
  }
}

const digestScript = "const f=require('node:fs'),c=require('node:crypto');process.exit(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')===process.argv[2]?0:1)";
const baselineDigestScript = "const f=require('node:fs'),c=require('node:crypto');" +
  "const t=f.readFileSync(process.argv[1],'utf8').replace(/[\\r\\n]+$/,'');" +
  "if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t))process.exit(1);" +
  "const b=Buffer.from(t,'base64');process.exit(b.toString('base64')===t&&c.createHash('sha256').update(b).digest('hex')===process.argv[2]?0:1)";

// Publish the reviewed truststore at its content-addressed path without ever replacing
// unknown bytes: build in a same-directory work store, validate-or-fail any pre-existing
// output, then link without overwrite. Any failure leaves earlier effects untouched.
const materializeScript =
  "const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os'),p=require('node:path'),c=require('node:crypto');" +
  `const jksStoreFingerprints=${jksStoreFingerprints.toString()};` +
  "const main=()=>{" +
  "const [jksPath,bundlePath,baselineFile,keytool,baselineSha,bundleSha]=process.argv.slice(1);" +
  "if(!jksPath||!bundlePath||!baselineFile||!keytool)throw 0;" +
  "for(const value of [jksPath,bundlePath,baselineFile,keytool])if(!p.isAbsolute(value)||/[\\0\\r\\n]/.test(value))throw 0;" +
  "if(!/^[a-f0-9]{64}$/.test(baselineSha||'')||!/^[a-f0-9]{64}$/.test(bundleSha||''))throw 0;" +
  "if(p.dirname(jksPath)!==p.dirname(bundlePath)||p.basename(jksPath)!=='trust-'+baselineSha+'-'+bundleSha+'.jks')throw 0;" +
  "const sha256=b=>c.createHash('sha256').update(b).digest('hex');" +
  "const readBounded=(path,max)=>{const st=fs.lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw 0;return fs.readFileSync(path)};" +
  "const b64=readBounded(baselineFile,2097152).toString('utf8').replace(/[\\r\\n]+$/,'');" +
  "if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64))throw 0;" +
  "const baseline=Buffer.from(b64,'base64');if(baseline.toString('base64')!==b64||sha256(baseline)!==baselineSha)throw 0;" +
  "const pemBytes=readBounded(bundlePath,16777216);if(sha256(pemBytes)!==bundleSha)throw 0;" +
  "const text=new TextDecoder('utf-8',{fatal:true}).decode(pemBytes);" +
  "const blocks=[];let offset=0;" +
  "while(offset<text.length){" +
  "while(offset<text.length&&/[ \\t\\r\\n]/.test(text[offset]))offset++;" +
  "if(offset===text.length)break;" +
  "if(!text.startsWith('-----BEGIN CERTIFICATE-----',offset))throw 0;" +
  "const start=offset;offset+=27;" +
  "const end=text.indexOf('-----END CERTIFICATE-----',offset);if(end<0)throw 0;" +
  "const encoded=text.slice(offset,end).replace(/[ \\t\\r\\n]/g,'');offset=end+25;" +
  "if(!encoded||encoded.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw 0;" +
  "const der=Buffer.from(encoded,'base64');if(der.toString('base64')!==encoded)throw 0;" +
  "blocks.push({fingerprint:sha256(der),text:text.slice(start,offset)});" +
  "}" +
  "if(!blocks.length||blocks.length>1024)throw 0;" +
  "const baselineFps=jksStoreFingerprints(baseline,{createHash:c.createHash,X509Certificate:c.X509Certificate});" +
  "const baselineSet=new Set(baselineFps);" +
  "const seen=new Set();const imports=[];" +
  "for(const block of blocks){if(seen.has(block.fingerprint))continue;seen.add(block.fingerprint);" +
  "if(!baselineSet.has(block.fingerprint))imports.push(block)}" +
  "const expected=JSON.stringify([...baselineFps,...imports.map(item=>item.fingerprint)].sort());" +
  "const validateParent=()=>{const st=fs.lstatSync(p.dirname(jksPath));if(!st.isDirectory()||st.isSymbolicLink())throw 0};" +
  "const validateStore=(path)=>{const st=fs.lstatSync(path);" +
  "if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4194304)throw 0;" +
  "const found=jksStoreFingerprints(fs.readFileSync(path),{createHash:c.createHash,X509Certificate:c.X509Certificate});" +
  "if(JSON.stringify([...found].sort())!==expected)throw 0};" +
  "validateParent();" +
  "let stat;try{stat=fs.lstatSync(jksPath)}catch(error){if(error.code!=='ENOENT')throw 0}" +
  "if(stat){validateStore(jksPath);return 0}" +
  "const work=jksPath+'.work-'+process.pid;" +
  "fs.writeFileSync(work,baseline,{flag:'wx'});" +
  "let tmp;" +
  "try{" +
  "tmp=fs.mkdtempSync(p.join(os.tmpdir(),'aih-jvm-'));" +
  "const env={...process.env};for(const key of ['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS'])delete env[key];" +
  "imports.forEach((item,index)=>{const file=p.join(tmp,'cert-'+index+'.pem');fs.writeFileSync(file,item.text);" +
  "const r=cp.spawnSync(keytool,['-importcert','-noprompt','-storetype','JKS','-storepass','changeit'," +
  "'-alias','aihq-ca-'+item.fingerprint.slice(0,16),'-file',file,'-keystore',work]," +
  "{shell:false,windowsHide:true,timeout:30000,maxBuffer:65536,env});" +
  "if(r.error||r.status!==0)throw 0});" +
  // Never publish an unvalidated store: the completed work bytes must be exactly the
  // reviewed baseline+managed multiset before the exclusive no-overwrite link.
  "validateStore(work);" +
  "validateParent();" +
  "try{fs.linkSync(work,jksPath)}catch(error){validateStore(jksPath)}" +
  "return 0" +
  "}finally{" +
  "if(tmp)try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}" +
  "try{fs.unlinkSync(work)}catch{}" +
  "}" +
  "};" +
  "let code=1;try{code=main()}catch{}process.exit(code)";

// Confirm every reviewed supplied CA fingerprint is a trusted entry of the published store.
const jksContentScript =
  "const fs=require('node:fs'),cp=require('node:child_process'),c=require('node:crypto');" +
  "const [jksPath,keytool,csv]=process.argv.slice(1);" +
  "if(!jksPath||!keytool||!/^[a-f0-9]{64}(,[a-f0-9]{64})*$/.test(csv||''))process.exit(1);" +
  "const st=fs.lstatSync(jksPath);if(!st.isFile()||st.isSymbolicLink()||st.size>4194304)process.exit(1);" +
  "const env={...process.env};for(const key of ['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS'])delete env[key];" +
  "const r=cp.spawnSync(keytool,['-list','-v','-keystore',jksPath,'-storepass','changeit','-storetype','JKS']," +
  "{shell:false,windowsHide:true,timeout:45000,maxBuffer:1048576,env});" +
  "if(r.error||r.status!==0)process.exit(1);" +
  "const found=new Set();for(const m of String(r.stdout).matchAll(/SHA256:\\s*([0-9A-Fa-f:]+)/g))found.add(m[1].replaceAll(':','').toLowerCase());" +
  "process.exit(csv.split(',').every(f=>found.has(f))?0:1)";

const gradleBuildFixture = `import javax.net.ssl.TrustManagerFactory
import java.security.KeyStore
import java.security.MessageDigest
tasks.register('aihTrustCheck') {
  doLast {
    def store = System.getProperty('javax.net.ssl.trustStore')
    def want = System.getenv('AIH_EXPECTED_STORE')
    if (store == null || store.replace('\\\\', '/') != want.replace('\\\\', '/')) throw new GradleException('aih: repaired settings did not select the reviewed truststore')
    def tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    tmf.init((KeyStore) null)
    def trusted = tmf.getTrustManagers().collectMany { tm ->
      tm.getAcceptedIssuers().collect { cert -> MessageDigest.getInstance('SHA-256').digest(cert.getEncoded()).encodeHex().toString() }
    }.toSet()
    def wanted = System.getenv('AIH_EXPECTED_FINGERPRINTS').split(',') as Set
    if (!trusted.containsAll(wanted)) throw new GradleException('aih: selected CA identities are not trusted')
    def conn = new URL(System.getenv('AIH_ENDPOINT')).openConnection()
    conn.setConnectTimeout(15000)
    conn.setReadTimeout(15000)
    conn.setInstanceFollowRedirects(false)
    conn.setRequestProperty('Connection', 'close')
    int code = conn.getResponseCode()
    if (code < 100 || code > 599) throw new GradleException('aih: endpoint check failed')
  }
}
`;
const mavenJavaFixture = `package aih;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
public class TrustCheck {
  public static void main(String[] args) throws Exception {
    String store = System.getProperty("javax.net.ssl.trustStore");
    String want = System.getenv("AIH_EXPECTED_STORE");
    if (store == null || !store.replace('\\\\', '/').equals(want.replace('\\\\', '/'))) System.exit(4);
    TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    tmf.init((KeyStore) null);
    Set<String> trusted = new HashSet<>();
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    for (var tm : tmf.getTrustManagers()) {
      for (X509Certificate cert : ((X509TrustManager) tm).getAcceptedIssuers()) {
        byte[] hash = md.digest(cert.getEncoded());
        StringBuilder hex = new StringBuilder();
        for (byte b : hash) hex.append(String.format("%02x", b & 0xff));
        trusted.add(hex.toString());
      }
    }
    for (String wanted : System.getenv("AIH_EXPECTED_FINGERPRINTS").split(",")) {
      if (!trusted.contains(wanted)) System.exit(2);
    }
    HttpURLConnection conn = (HttpURLConnection) new URL(System.getenv("AIH_ENDPOINT")).openConnection();
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(15000);
    conn.setInstanceFollowRedirects(false);
    conn.setRequestProperty("Connection", "close");
    int code = conn.getResponseCode();
    if (code < 100 || code > 599) System.exit(3);
  }
}
`;
const mavenPomFixture = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>aih</groupId>
  <artifactId>aih-trust-check</artifactId>
  <version>1</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.release>11</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <build><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <version>3.13.0</version>
  </plugin></plugins></build>
</project>
`;

// Shared manager-check prelude: validate bindings, verify the repaired configuration
// still selects the reviewed store, guard inherited trust-overriding options uniformly,
// then launch the pinned manager (never plain java with injected trust, never caller
// content) against a fixed temporary fixture. Windows launches the captured vendor
// .cmd/.bat through one fixed cmd wrapper; POSIX launches the vendor shell script via sh.
const managerCheckPrelude =
  "const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os'),p=require('node:path');" +
  "const fail=()=>process.exit(1);" +
  "const readConfig=path=>{const st=fs.lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>1048576)fail();" +
  "return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(path))};" +
  "const guardEnvironment=()=>{" +
  "for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','JAVA_OPTS','GRADLE_OPTS','MAVEN_OPTS'])" +
  "if(/trustStore/i.test(process.env[key]||''))fail()};" +
  "const launch=(exe,args,env,timeoutMs)=>{" +
  "if(process.platform==='win32'){" +
  "if(!/\\.(cmd|bat)$/i.test(exe)||/[\"%*!^&|<>\\r\\n]/.test(exe)||args.some(arg=>/[\\s\"%!^&|<>]/.test(arg)))fail();" +
  "return cp.spawnSync(process.env.ComSpec||'C:\\\\Windows\\\\System32\\\\cmd.exe'," +
  "['/d','/v:off','/s','/c','\"\"'+exe+'\" '+args.join(' ')+'\"']," +
  "{env,windowsHide:true,windowsVerbatimArguments:true,timeout:timeoutMs,maxBuffer:65536})" +
  "}" +
  "return cp.spawnSync('sh',[exe,...args],{env,timeout:timeoutMs,maxBuffer:65536})" +
  "};" +
  "const managerEnv=javaExe=>{const env={...process.env};" +
  "env.JAVA_HOME=p.dirname(p.dirname(fs.realpathSync(javaExe)));return env};";

const gradleBehaviorScript = managerCheckPrelude +
  "const [configPath,jksPath,gradleExe,javaExe]=process.argv.slice(1);" +
  "if(!configPath||!jksPath||!gradleExe||!javaExe)fail();" +
  "for(const value of [configPath,jksPath,gradleExe,javaExe])if(!p.isAbsolute(value)||/[\\0\\r\\n]/.test(value))fail();" +
  "const expected=process.env.AIH_EXPECTED_FINGERPRINTS||'';" +
  "if(!/^[a-f0-9]{64}(,[a-f0-9]{64})*$/.test(expected)||!/^https:\\/\\//.test(process.env.AIH_ENDPOINT||'')||" +
  "process.env.AIH_EXPECTED_STORE!==jksPath)fail();" +
  "guardEnvironment();" +
  "const text=readConfig(configPath);" +
  "const rows=text.split(/\\r?\\n/);" +
  "const store=rows.filter(row=>/^systemProp\\.javax\\.net\\.ssl\\.trustStore=/.test(row));" +
  "const pass=rows.filter(row=>/^systemProp\\.javax\\.net\\.ssl\\.trustStorePassword=/.test(row));" +
  "const other=rows.filter(row=>/trustStore/i.test(row)&&!/^\\s*[!#]/.test(row)&&" +
  "!/^systemProp\\.javax\\.net\\.ssl\\.trustStore(?:Password)?=/.test(row));" +
  "if(store.length!==1||store[0]!=='systemProp.javax.net.ssl.trustStore='+jksPath.replaceAll('\\\\','/'))fail();" +
  "if(pass.length!==1||pass[0]!=='systemProp.javax.net.ssl.trustStorePassword=changeit')fail();" +
  "if(other.length)fail();" +
  // Select the reviewed configuration location explicitly: Windows Java resolves user.home
  // from the OS account profile, not from inherited HOME/USERPROFILE.
  "let dir,code=1;" +
  "try{" +
  "dir=fs.mkdtempSync(p.join(os.tmpdir(),'aih-gradle-'));" +
  "fs.writeFileSync(p.join(dir,'settings.gradle'),\"rootProject.name='aih-trust-check'\\n\");" +
  `fs.writeFileSync(p.join(dir,'build.gradle'),${JSON.stringify(gradleBuildFixture)});` +
  "const result=launch(gradleExe,['--no-daemon','--console=plain','-q'," +
  "'--gradle-user-home',p.dirname(configPath),'-p',dir,'aihTrustCheck'],managerEnv(javaExe),200000);" +
  "code=result&&!result.error&&result.status===0?0:1" +
  "}catch{code=1}finally{if(dir)try{fs.rmSync(dir,{recursive:true,force:true})}catch{}}" +
  "process.exit(code)";

const mavenBehaviorScript = managerCheckPrelude +
  "const [configPath,jksPath,mavenExe,javaExe]=process.argv.slice(1);" +
  "if(!configPath||!jksPath||!mavenExe||!javaExe)fail();" +
  "for(const value of [configPath,jksPath,mavenExe,javaExe])if(!p.isAbsolute(value)||/[\\0\\r\\n]/.test(value))fail();" +
  "const expected=process.env.AIH_EXPECTED_FINGERPRINTS||'';" +
  "if(!/^[a-f0-9]{64}(,[a-f0-9]{64})*$/.test(expected)||!/^https:\\/\\//.test(process.env.AIH_ENDPOINT||'')||" +
  "process.env.AIH_EXPECTED_STORE!==jksPath)fail();" +
  "if(process.env.MAVEN_SKIP_RC)fail();" +
  "guardEnvironment();" +
  "const win=process.platform==='win32';" +
  "const begin=win?'REM BEGIN AIHQ MAVEN CA':'# BEGIN AIHQ MAVEN CA';" +
  "const end=win?'REM END AIHQ MAVEN CA':'# END AIHQ MAVEN CA';" +
  "const text=readConfig(configPath);" +
  "const rows=text.split(/\\r?\\n/);" +
  "const starts=rows.flatMap((row,i)=>row===begin?[i]:[]);" +
  "const ends=rows.flatMap((row,i)=>row===end?[i]:[]);" +
  "if(starts.length!==1||ends.length!==1||ends[0]<starts[0])fail();" +
  "const block=rows.slice(starts[0]+1,ends[0]);" +
  "const outside=[...rows.slice(0,starts[0]),...rows.slice(ends[0]+1)];" +
  "if(outside.some(row=>/trustStore/i.test(row)))fail();" +
  "const opts=block.filter(row=>/trustStore/i.test(row));" +
  "if(opts.length!==1)fail();" +
  "const want='-Djavax.net.ssl.trustStore='+jksPath+' -Djavax.net.ssl.trustStorePassword=changeit';" +
  "if(!opts[0].includes(want))fail();" +
  "let dir,code=1;" +
  "try{" +
  "dir=fs.mkdtempSync(p.join(os.tmpdir(),'aih-maven-'));" +
  "fs.mkdirSync(p.join(dir,'src','main','java','aih'),{recursive:true});" +
  `fs.writeFileSync(p.join(dir,'pom.xml'),${JSON.stringify(mavenPomFixture)});` +
  `fs.writeFileSync(p.join(dir,'src','main','java','aih','TrustCheck.java'),${JSON.stringify(mavenJavaFixture)});` +
  "const settings=p.join(dir,'settings.xml');" +
  "fs.writeFileSync(settings,'<settings xmlns=\"http://maven.apache.org/SETTINGS/1.0.0\"/>');" +
  "const repo=p.join(dir,'repo');" +
  "const result=launch(mavenExe,['-q','-B','-s',settings,'-gs',settings,'-f',p.join(dir,'pom.xml'),'-Dmaven.repo.local='+repo,'compile'," +
  "'org.codehaus.mojo:exec-maven-plugin:3.5.0:java','-Dexec.mainClass=aih.TrustCheck','-Dexec.cleanupDaemonThreads=false']," +
  "managerEnv(javaExe),480000);" +
  "code=result&&!result.error&&result.status===0?0:1" +
  "}catch{code=1}finally{if(dir)try{fs.rmSync(dir,{recursive:true,force:true})}catch{}}" +
  "process.exit(code)";

const nodeInvocation = (script, args = []) => ({ executable: { name: process.execPath },
  args: [literal('-e'), literal(script), ...args], cwd, env: {}, timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
const namedCheck = (id, purpose, name, args) => ({ id, purpose, kind: 'process.exit',
  executable: { name }, args: args.map(literal), cwd, env: {}, timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });

export function jvmRecipe(variant) {
  const declared = variant.network !== 'off';
  const inputs = {
    bundle: { type: 'string', required: true, sensitive: true, maxLength: 16 * 1024 * 1024 },
    baselineStoreBase64: { type: 'string', required: true, sensitive: true, maxLength: 1_500_000 },
    bundlePath: { type: 'string', required: true, maxLength: 4096 },
    bundleSha256: { type: 'string', required: true, maxLength: 64 },
    baselineStoreSha256: { type: 'string', required: true, maxLength: 64 },
    baselineFilePath: { type: 'string', required: true, maxLength: 4096 },
    jksPath: { type: 'string', required: true, maxLength: 4096 },
    fingerprintCsv: { type: 'string', required: true, maxLength: 16640 },
    keytoolExecutable: { type: 'string', required: true, maxLength: 4096 }
  };
  if (declared) {
    inputs.javaExecutable = { type: 'string', required: true, maxLength: 4096 };
    if (variant.targets.includes('gradle')) inputs.gradleExecutable = { type: 'string', required: true, maxLength: 4096 };
    if (variant.targets.includes('maven')) inputs.mavenExecutable = { type: 'string', required: true, maxLength: 4096 };
  }
  const operations = [
    { id: 'material', purpose: 'Write composed trust preserving all existing managed certificates', kind: 'file.write',
      scope: 'user', target: { root: 'userState', segments: [literal('trust.pem')] }, content: input('bundle'),
      mode: 0o600, requires: [], checks: ['material-digest'] },
    { id: 'baseline-material', purpose: 'Write the reviewed baseline JDK truststore copy for materialization',
      kind: 'file.write', scope: 'user', target: { root: 'userState', segments: [literal('baseline.store.b64')] },
      content: input('baselineStoreBase64'), mode: 0o600, requires: [], checks: ['baseline-digest'] },
    { id: 'keytool-ready', purpose: 'Verify the selected existing keytool runs before any truststore work',
      kind: 'process.run', scope: 'user', executable: { name: 'keytool' }, args: [literal('-help')], cwd, env: {},
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0],
      effects: ['Read-only keytool help process'], requires: [], checks: ['keytool-available'] },
    { id: 'jks-materialize', purpose: 'Publish the reviewed JVM truststore at its content-addressed path from bound inputs',
      kind: 'process.run', scope: 'user', ...nodeInvocation(materializeScript,
        [input('jksPath'), input('bundlePath'), input('baselineFilePath'), input('keytoolExecutable'),
          input('baselineStoreSha256'), input('bundleSha256')]),
      timeoutMs: 300000, maxOutputBytes: 65536,
      effects: ['Publish the reviewed JVM truststore at its content-addressed managed path without replacing unknown existing bytes',
        'Temporary keytool workspace under the OS temp directory, removed on completion'],
      requires: ['material', 'baseline-material', 'keytool-ready'], checks: ['jks-content'] }
  ];
  const checks = [
    { id: 'material-digest', purpose: 'Check managed CA material bytes', kind: 'process.exit',
      ...nodeInvocation(digestScript, [input('bundlePath'), input('bundleSha256')]) },
    { id: 'baseline-digest', purpose: 'Check persisted baseline truststore copy matches the reviewed bytes',
      kind: 'process.exit', ...nodeInvocation(baselineDigestScript, [input('baselineFilePath'), input('baselineStoreSha256')]) },
    namedCheck('keytool-available', 'Require the selected existing keytool executable', 'keytool', ['-help']),
    { id: 'jks-content', purpose: 'Check every supplied CA fingerprint is trusted by the published store', kind: 'process.exit',
      ...nodeInvocation(jksContentScript, [input('jksPath'), input('keytoolExecutable'), input('fingerprintCsv')]),
      timeoutMs: 60000, maxOutputBytes: 16384 }
  ];
  for (const file of variant.configFiles) {
    if (file.operationId !== 'gradle-config' && file.operationId !== 'maven-config') continue;
    const id = file.operationId.split('-')[0];
    inputs[`${id}Config`] = { type: 'string', required: true, sensitive: true, maxLength: 2 * 1024 * 1024 };
    inputs[`${id}ConfigPath`] = { type: 'string', required: true, maxLength: 4096 };
    const behavior = `${id}-behavior`;
    operations.push({ id: file.operationId, purpose: `Set ${id === 'gradle' ?
      'Gradle JVM truststore properties' : 'Maven JVM truststore options'} using the reviewed store; preserve neighboring configuration privately`,
      kind: 'file.write', scope: 'user', target: structuredClone(file.target), content: input(`${id}Config`),
      requires: ['jks-materialize'], checks: declared ? [behavior] : [] });
    if (!declared) continue;
    const gradle = id === 'gradle';
    checks.push({ id: behavior, purpose: `Check the real ${id} manager consumes the repaired truststore, trusts the selected CA identities and reaches its declared endpoint`,
      kind: 'process.exit',
      ...nodeInvocation(gradle ? gradleBehaviorScript : mavenBehaviorScript,
        [input(`${id}ConfigPath`), input('jksPath'), input(`${id}Executable`), input('javaExecutable')]),
      env: { AIH_EXPECTED_FINGERPRINTS: input('fingerprintCsv'), AIH_EXPECTED_STORE: input('jksPath'),
        AIH_ENDPOINT: literal(gradle ? GRADLE_ENDPOINT : MAVEN_ENDPOINT) },
      timeoutMs: gradle ? 240000 : 540000, maxOutputBytes: 16384 });
  }
  return { schema: 'urn:aihq:core:recipe:1.0.0', id: 'jvm-ca', description: jvmRepair.description,
    inputs, materials: [], targets: ['user'], prerequisites: [], operations, checks };
}

const invalid = (reason, message, code = 'INPUT_INVALID') => ({ status: code === 'STATE_CONFLICT' || code === 'PREREQUISITE_UNAVAILABLE' ? 'blocked' : 'invalid', diagnostics: [{ code, reason, message }] });

function variantFor(request) {
  return jvmRepair.variants.find(item => item.recipeRef === request?.variantRef &&
    item.os === process.platform && item.architectures.includes(process.arch));
}

const GRADLE_KEYS = ['systemProp.javax.net.ssl.trustStore', 'systemProp.javax.net.ssl.trustStorePassword'];
/** Duplicate managed keys or non-`=` separators must never become an apparently verified rewrite. */
function gradleConfigAmbiguous(text) {
  const seen = new Set();
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim() || /^\s*[!#]/.test(row)) continue;
    for (const key of GRADLE_KEYS) {
      const escaped = key.replaceAll('.', '\\.');
      if (new RegExp(`^\\s*${escaped}=`).test(row)) {
        if (seen.has(key)) return true;
        seen.add(key);
      } else if (new RegExp(`^\\s*${escaped}(?:\\s|=|:)`).test(row)) return true;
    }
  }
  return false;
}

// Extracted from the donor gradleProperties upsert. Preserve EOL style and all
// neighboring lines; Java properties parsing treats backslash as escape.
function gradlePropertiesConfig(existing, jksPath) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const src = existing.replace(/[\r\n]+$/, '').replaceAll('\r\n', '\n');
  const rows = src ? src.split('\n') : [];
  const values = [['systemProp.javax.net.ssl.trustStore', jksPath.replaceAll('\\', '/')],
    ['systemProp.javax.net.ssl.trustStorePassword', STORE_PASSWORD]];
  const done = new Set();
  const out = rows.map(row => {
    for (const [key, value] of values) {
      if (new RegExp(`^\\s*${key.replaceAll('.', '\\.')}=`).test(row)) {
        done.add(key);
        return `${key}=${value}`;
      }
    }
    return row;
  });
  for (const [key, value] of values) if (!done.has(key)) out.push(`${key}=${value}`);
  return out.join(eol) + eol;
}

function mavenMarkers(os) {
  return os === 'win32' ? ['REM BEGIN AIHQ MAVEN CA', 'REM END AIHQ MAVEN CA'] : ['# BEGIN AIHQ MAVEN CA', '# END AIHQ MAVEN CA'];
}
/** Stacked/mismatched managed blocks or foreign trust options must never become an apparently verified rewrite. */
function mavenRcAmbiguous(text, os) {
  const [begin, end] = mavenMarkers(os);
  const rows = text.split(/\r?\n/);
  const starts = rows.flatMap((row, i) => row === begin ? [i] : []);
  const ends = rows.flatMap((row, i) => row === end ? [i] : []);
  if (starts.length !== ends.length || starts.length > 1 || starts.length === 1 && ends[0] < starts[0]) return true;
  const outside = starts.length ? [...rows.slice(0, starts[0]), ...rows.slice(ends[0] + 1)] : rows;
  return outside.some(row => /trustStore/i.test(row));
}

// Extracted from the donor mavenRc managed block. Preserve EOL style and every
// line outside the block; Windows uses mavenrc_pre.cmd batch syntax, POSIX a shell block.
function mavenRcConfig(existing, jksPath, os) {
  const [begin, end] = mavenMarkers(os);
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const src = existing.replace(/[\r\n]+$/, '').replaceAll('\r\n', '\n');
  let rows = src ? src.split('\n') : [];
  const starts = rows.flatMap((row, i) => row === begin ? [i] : []);
  const ends = rows.flatMap((row, i) => row === end ? [i] : []);
  if (starts.length === 1 && ends.length === 1 && ends[0] >= starts[0])
    rows = [...rows.slice(0, starts[0]), ...rows.slice(ends[0] + 1)];
  while (rows.length && rows.at(-1) === '') rows.pop();
  const opts = `-Djavax.net.ssl.trustStore=${jksPath} -Djavax.net.ssl.trustStorePassword=${STORE_PASSWORD}`;
  const block = os === 'win32' ?
    [begin, `set "MAVEN_OPTS=%MAVEN_OPTS% ${opts}"`, end] :
    [begin, `MAVEN_OPTS="\${MAVEN_OPTS:-} ${opts}"`, 'export MAVEN_OPTS', end];
  return [...rows, ...block].join(eol) + eol;
}

/** Maven options are whitespace-split by vendor launchers; batch/shell metacharacters are unsafe. */
function managedPathIssue(variant, jksPath) {
  if (/[^\x20-\x7E]/.test(jksPath)) return 'The managed truststore path must be printable ASCII text.';
  if (variant.targets.includes('maven')) {
    if (/\s/.test(jksPath)) return 'Maven launchers split options on whitespace; the managed truststore path must not contain spaces.';
    if (variant.os === 'win32' ? /[%!"^&|<>]/.test(jksPath) : /["$`\\]/.test(jksPath))
      return 'The managed truststore path is unsafe for Maven launcher scripts.';
  }
  return undefined;
}

export function renderJvmRepair(request) {
  const variant = variantFor(request);
  if (!variant || typeof request.bundlePath !== 'string' || !isAbsolute(request.bundlePath) ||
      /[\p{Cc}\p{Cf}]/u.test(request.bundlePath) || !/^[a-f0-9]{64}$/.test(request.bundleSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(request.baselineStoreSha256 ?? '') ||
      !Array.isArray(request.fingerprints) || !request.fingerprints.length ||
      request.fingerprints.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)))
    return invalid('repair-bindings', 'Invalid JVM trust bindings.');
  const jksPath = join(dirname(request.bundlePath), `trust-${request.baselineStoreSha256}-${request.bundleSha256}.jks`);
  const pathIssue = managedPathIssue(variant, jksPath);
  if (pathIssue) return invalid('managed-path-unsupported', pathIssue);
  if (typeof request.baselineStoreBase64 !== 'string' || request.baselineStoreBase64.length > 1_500_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.baselineStoreBase64) ||
      createHash('sha256').update(Buffer.from(request.baselineStoreBase64, 'base64')).digest('hex') !== request.baselineStoreSha256)
    return invalid('repair-bindings', 'Invalid baseline truststore binding.');
  const stateDir = dirname(request.bundlePath);
  const bindings = { bundlePath: request.bundlePath, bundleSha256: request.bundleSha256,
    baselineStoreSha256: request.baselineStoreSha256, baselineFilePath: join(stateDir, 'baseline.store.b64'),
    jksPath, fingerprintCsv: request.fingerprints.join(',') };
  const privateBindings = { baselineStoreBase64: request.baselineStoreBase64 };
  for (const { pathInput } of variant.executableBindings) {
    const path = request.executablePaths?.[pathInput] ?? '';
    if (typeof path !== 'string' || path && (!isAbsolute(path) || /[\p{Cc}\p{Cf}]/u.test(path)))
      return invalid('executable-binding', 'The selected executable path is invalid.');
    bindings[pathInput] = path;
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
    if (file.operationId === 'gradle-config') {
      if (gradleConfigAmbiguous(text)) return invalid('config-ambiguous', 'The selected Gradle user configuration has ambiguous trust entries.');
      privateBindings.gradleConfig = gradlePropertiesConfig(text, jksPath);
      bindings.gradleConfigPath = join(homedir(), '.gradle', 'gradle.properties');
    } else if (file.operationId === 'maven-config') {
      if (mavenRcAmbiguous(text, variant.os)) return invalid('config-ambiguous', 'The selected Maven user configuration has conflicting trust entries.');
      privateBindings.mavenConfig = mavenRcConfig(text, jksPath, variant.os);
      bindings.mavenConfigPath = join(homedir(), variant.os === 'win32' ? 'mavenrc_pre.cmd' : '.mavenrc');
    } else if (/trustStore/i.test(text))
      return invalid('config-ambiguous', 'A later Windows Maven rc file sets JVM trust options and would override the repaired settings.');
  }
  return { status: 'completed', bindings, privateBindings };
}
export function prepareJvmRepair(request) {
  const variant = variantFor(request);
  if (!variant || !Array.isArray(request.targets) || variant.targets.length !== request.targets.length ||
      !variant.targets.every(id => request.targets.includes(id)) ||
      (!request.validateOnly && variant.network !== (request.offline ? 'off' : 'declared')) ||
      !(request.files?.caFile instanceof Uint8Array) || !(request.files?.baselineStore instanceof Uint8Array))
    return invalid('repair-input', 'Unsupported JVM repair input.');
  const accepted = validateSuppliedCa(request.files.caFile);
  if (!accepted.valid) return { status: 'invalid', assessedBlocks: accepted.assessedBlocks,
    ...(accepted.assessmentLimit ? { assessmentLimit: accepted.assessmentLimit } : {}), diagnostics: accepted.diagnostics };
  const baseline = validateBaselineStore(request.files.baselineStore);
  if (!baseline.valid) return invalid(baseline.reason, baseline.message);
  const facts = { fingerprints: accepted.certificates.map(item => item.fingerprint), evaluatedAt: accepted.evaluatedAt,
    count: accepted.certificates.length, duplicates: accepted.duplicates };
  if (request.validateOnly) return { status: 'completed', ...facts };
  const home = homedir();
  if (variant.targets.includes('gradle') && process.env.GRADLE_USER_HOME &&
      resolveEnv(process.env.GRADLE_USER_HOME) !== resolveEnv(join(home, '.gradle')))
    return invalid('user-config-location-unsupported', 'Gradle redirects its user home. Use the canonical user location before preparing this repair.', 'PREREQUISITE_UNAVAILABLE');
  if (variant.targets.includes('maven') && process.env.MAVEN_SKIP_RC)
    return invalid('trust-bypass-environment', 'Maven is configured to skip user rc files; the repaired settings would never be consumed.', 'PREREQUISITE_UNAVAILABLE');
  // Manager launchers and JVMs honor inherited option variables; any trustStore there can silently
  // redirect trust away from the reviewed store, so prepare and the actual checks guard them uniformly.
  for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'GRADLE_OPTS', 'MAVEN_OPTS'])
    if (/trustStore/i.test(process.env[key] ?? ''))
      return invalid('trust-override-environment', 'An inherited JVM or manager option overrides the selected truststore. Remove that override before preparing.', 'PREREQUISITE_UNAVAILABLE');
  // The derived store carries baseline entries from the reviewed JDK copy plus all managed certificates.
  const bundle = composeExistingTrust(request.existing, accepted.material, { includeNodeDefaults: false });
  if (bundle === undefined) return invalid('existing-trust-uncomposable', 'Existing managed trust cannot be safely composed.', 'STATE_CONFLICT');
  if (Buffer.byteLength(bundle) > 16 * 1024 * 1024) return invalid('managed-material-limit', 'Managed trust would exceed its bound.', 'STATE_CONFLICT');
  const baselineBytes = Buffer.from(request.files.baselineStore);
  const rendered = renderJvmRepair({ ...request, fingerprints: facts.fingerprints, bundlePath: request.managedPath,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    baselineStoreSha256: createHash('sha256').update(baselineBytes).digest('hex'),
    baselineStoreBase64: baselineBytes.toString('base64') });
  return rendered.status === 'completed' ? { ...rendered, ...facts, bundle } : rendered;
}
function resolveEnv(value) {
  const resolved = resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
