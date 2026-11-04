// TEST FIXTURE for @aihq/core tests: @aihq/scan/read bundled from samartomar/aih-scan 0386bc0c7f1fc936c54a2ae3bac9c743389fd400 (Apache-2.0).
// Its Sigstore trusted root is a private TEST-ONLY universe, never production trust. Not a published Scan artifact.


// src/contracts/formats.ts
var formats = Object.freeze({
  request: "aih-scan-request/1",
  source: "aih-scan-source/1",
  summary: "aih-scan-summary/1",
  withdrawn: "aih-scan-withdrawn/1",
  routing: "aih-scan-routing/1",
  scoring: "aih-risk/1",
  codes: "aih-codes/1",
  limits: "aih-scan-limits/1"
});
var FORMAT_PATTERN = /^([a-z][a-z0-9-]*)\/(\d+)$/;
function formatProblem(value, expected, label) {
  if (value === expected) return void 0;
  const family = FORMAT_PATTERN.exec(expected)?.[1];
  if (typeof value === "string") {
    const match = FORMAT_PATTERN.exec(value);
    if (match !== null && match[1] === family)
      return Object.freeze({
        status: "unsupported-version",
        reason: "unsupported-version",
        detail: `${label} format ${value} is not supported; expected ${expected}`
      });
  }
  return Object.freeze({
    status: "invalid",
    reason: "format",
    detail: `${label} format must be ${expected}`
  });
}

// src/contracts/codes.ts
var scanCodes = Object.freeze([
  "trust.prompt-injection",
  "trust.hidden-unicode",
  "trust.visible-unicode",
  "trust.malicious-code",
  "trust.external-egress",
  "trust.auto-exec-hook",
  "trust.permission-risk",
  "trust.plaintext-secret",
  "trust.mcp-hardcoded-secret",
  "trust.mcp-tool-poisoning",
  "trust.typosquat",
  "trust.dependency-confusion",
  "trust.unpinned-dependency",
  "trust.unmapped-rule"
]);
var advisoryCodes = Object.freeze(["trust.known-vulnerability"]);
var toolRuleCodes = Object.freeze({
  "aih-trust-lint": Object.freeze({
    "trust.prompt-injection": "trust.prompt-injection",
    "trust.hidden-unicode": "trust.hidden-unicode",
    "trust.visible-unicode": "trust.visible-unicode",
    "trust.malicious-code": "trust.malicious-code",
    "trust.external-egress": "trust.external-egress",
    "trust.auto-exec-hook": "trust.auto-exec-hook",
    "trust.permission-risk": "trust.permission-risk",
    "secrets.plaintext-detected": "trust.plaintext-secret",
    "mcp.hardcoded-secret": "trust.mcp-hardcoded-secret",
    "mcp.tool-poisoning": "trust.mcp-tool-poisoning",
    "trust.typosquat": "trust.typosquat",
    "trust.dependency-confusion": "trust.dependency-confusion",
    "trust.unpinned-dependency": "trust.unpinned-dependency"
  }),
  /**
   * SkillSpector 2.13.2 rule ids. SC4 (known vulnerable dependency) is not a scan finding:
   * known vulnerabilities come only from `checkAdvisories`. Rules without a clear code
   * (for example SC5, OH2, OH3, TR1-TR3, AE1, AE7) stay `trust.unmapped-rule`.
   */
  skillspector: Object.freeze({
    AR1: "trust.prompt-injection",
    AR2: "trust.prompt-injection",
    AR3: "trust.prompt-injection",
    AS1: "trust.malicious-code",
    AS2: "trust.malicious-code",
    AS3: "trust.malicious-code",
    AST1: "trust.malicious-code",
    AST2: "trust.malicious-code",
    AST3: "trust.malicious-code",
    AST4: "trust.malicious-code",
    AST5: "trust.malicious-code",
    AST6: "trust.malicious-code",
    AST7: "trust.malicious-code",
    AST8: "trust.malicious-code",
    AST9: "trust.malicious-code",
    AST10: "trust.malicious-code",
    BH1: "trust.auto-exec-hook",
    BH2: "trust.external-egress",
    BH3: "trust.permission-risk",
    BH4: "trust.auto-exec-hook",
    DS1: "trust.malicious-code",
    DS2: "trust.malicious-code",
    DS3: "trust.malicious-code",
    DS4: "trust.malicious-code",
    E1: "trust.external-egress",
    E2: "trust.malicious-code",
    E3: "trust.malicious-code",
    E4: "trust.external-egress",
    E5: "trust.external-egress",
    EA1: "trust.permission-risk",
    EA2: "trust.permission-risk",
    EA3: "trust.permission-risk",
    EA4: "trust.permission-risk",
    EA5: "trust.permission-risk",
    LP1: "trust.permission-risk",
    LP2: "trust.permission-risk",
    LP3: "trust.permission-risk",
    LP4: "trust.permission-risk",
    MP1: "trust.prompt-injection",
    MP2: "trust.prompt-injection",
    MP3: "trust.prompt-injection",
    OH1: "trust.malicious-code",
    P1: "trust.prompt-injection",
    P2: "trust.prompt-injection",
    P3: "trust.external-egress",
    P4: "trust.prompt-injection",
    P5: "trust.prompt-injection",
    P6: "trust.prompt-injection",
    P7: "trust.prompt-injection",
    P8: "trust.external-egress",
    P9: "trust.prompt-injection",
    PE1: "trust.permission-risk",
    PE2: "trust.permission-risk",
    PE3: "trust.malicious-code",
    PE4: "trust.permission-risk",
    PE5: "trust.permission-risk",
    RA1: "trust.malicious-code",
    RA2: "trust.malicious-code",
    RP1: "trust.unpinned-dependency",
    RP2: "trust.permission-risk",
    RP3: "trust.unpinned-dependency",
    SC1: "trust.unpinned-dependency",
    SC2: "trust.malicious-code",
    SC3: "trust.malicious-code",
    SC6: "trust.typosquat",
    SC7: "trust.permission-risk",
    SC8: "trust.malicious-code",
    SC9: "trust.malicious-code",
    SC10: "trust.dependency-confusion",
    SSRF1: "trust.external-egress",
    SSRF2: "trust.external-egress",
    SSRF3: "trust.external-egress",
    TM1: "trust.malicious-code",
    TM2: "trust.malicious-code",
    TM3: "trust.permission-risk",
    TM4: "trust.permission-risk",
    TP1: "trust.mcp-tool-poisoning",
    TP2: "trust.mcp-tool-poisoning",
    TP3: "trust.mcp-tool-poisoning",
    TP4: "trust.mcp-tool-poisoning",
    TT1: "trust.malicious-code",
    TT2: "trust.malicious-code",
    TT3: "trust.external-egress",
    TT4: "trust.external-egress",
    TT5: "trust.malicious-code",
    TT6: "trust.malicious-code",
    YR1: "trust.malicious-code",
    YR2: "trust.malicious-code",
    YR3: "trust.malicious-code",
    YR4: "trust.malicious-code"
  })
});
var toolCategoryCodes = Object.freeze({
  cisco: Object.freeze({
    autonomy_abuse: "trust.permission-risk",
    command_injection: "trust.malicious-code",
    data_exfiltration: "trust.external-egress",
    hardcoded_secrets: "trust.plaintext-secret",
    malware: "trust.malicious-code",
    obfuscation: "trust.malicious-code",
    prompt_injection: "trust.prompt-injection",
    supply_chain_attack: "trust.malicious-code",
    tool_chaining_abuse: "trust.malicious-code",
    unauthorized_tool_use: "trust.permission-risk",
    unicode_steganography: "trust.hidden-unicode"
  })
});
var codes = Object.freeze({
  format: formats.codes,
  scan: scanCodes,
  advisory: advisoryCodes,
  unmapped: "trust.unmapped-rule",
  tools: toolRuleCodes,
  categories: toolCategoryCodes
});
function isScanCode(value) {
  return typeof value === "string" && scanCodes.includes(value);
}

// src/contracts/limits.ts
var MiB = 1024 * 1024;
var limits = Object.freeze({
  format: formats.limits,
  input: Object.freeze({
    /** Total bytes of every regular file in one source or one request. */
    sourceBytes: 500 * MiB,
    /** Regular files in one source or one request. */
    files: 5e4,
    /** Bytes of one file. */
    fileBytes: 50 * MiB,
    /** Code points of one relative path. */
    pathLength: 1024,
    /** Folders above one file. */
    depth: 64,
    /** Items in one request or found in one source. */
    items: 2e4
  }),
  tool: Object.freeze({
    /** One tool on one item; over it the tool is `not-run` with reason `timeout`. */
    timeoutMs: 10 * 60 * 1e3
  }),
  output: Object.freeze({
    /** Code points kept of one finding's text (`readFindings`); longer text is cut. */
    findingText: 500,
    /** Code points of one finding path; longer paths cannot match a scanned file. */
    findingPath: 1024,
    /** Code points kept of a rule id or tool name. */
    ruleId: 256,
    /** Findings read from one SARIF document; more is refused. */
    findingsPerSarif: 1e5,
    /** Bytes of one summary document accepted by `readSummary`. */
    summaryBytes: 128 * MiB,
    /** Bytes of one SARIF document accepted by `readFindings`. */
    sarifBytes: 256 * MiB,
    /** Bytes of one Sigstore bundle or trusted root accepted by `verifySummary`. */
    bundleBytes: 8 * MiB,
    /** Code points of a tool or summary reason. */
    reason: 500,
    /** Code points of a request label echoed in a scan result. */
    label: 256
  })
});

// src/contracts/npm.ts
var SEGMENT = "[a-z0-9][a-z0-9._~-]*";
var NPM_SCOPE_PATTERN = new RegExp(`^@${SEGMENT}$`);
var NPM_NAME_PATTERN = new RegExp(`^(?:@${SEGMENT}/)?${SEGMENT}$`);

// src/contracts/text.ts
var UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
var LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function isWellFormedText(value) {
  LONE_SURROGATE.lastIndex = 0;
  const bad = LONE_SURROGATE.test(value);
  LONE_SURROGATE.lastIndex = 0;
  return !bad;
}
function hasUnsafeCharacters(value) {
  UNSAFE.lastIndex = 0;
  const found = UNSAFE.test(value);
  UNSAFE.lastIndex = 0;
  return found;
}
function sanitizeText(value, maxCodePoints) {
  const wellFormed = value.replace(LONE_SURROGATE, "\uFFFD");
  const visible = wellFormed.replace(UNSAFE, "");
  const points = [...visible];
  return points.length > maxCodePoints ? points.slice(0, maxCodePoints).join("") : visible;
}
function codePointLength(value) {
  return [...value].length;
}
var PATH_UNSAFE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
function pathProblem(path, maxLength, maxDepth) {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string";
  if (!isWellFormedText(path)) return "path is not valid text";
  if (PATH_UNSAFE.test(path)) return "path contains control or bidirectional characters";
  if (codePointLength(path) > maxLength) return "path-length";
  if (path.includes("\\")) return "path must use forward slashes";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "path must be relative";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return "path must not be a URL";
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."))
    return "path must not contain empty, . or .. segments";
  if (segments.length - 1 > maxDepth) return "depth";
  return void 0;
}
var SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]+:/;
function displayPathProblem(path, maxLength, maxDepth) {
  const problem2 = pathProblem(path, maxLength, maxDepth);
  if (problem2 !== void 0) return problem2;
  if (SCHEME_PREFIX.test(path)) return "path must not be a URL";
  return hasUnsafeCharacters(path) ? "path contains format or separator characters" : void 0;
}
function isBytes(value) {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

// src/shared/bounded-response.ts
async function readBoundedText(response, maximum) {
  const reader = response.body?.getReader?.();
  if (reader === void 0) return void 0;
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) && !ArrayBuffer.isView(value)) return void 0;
      total += value.byteLength;
      if (total > maximum) return void 0;
      chunks.push(value);
    }
  } catch {
    return void 0;
  } finally {
    await Promise.resolve(reader.cancel()).catch(() => {
    });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return void 0;
  }
}

// src/shared/values.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function webCryptoSubtle() {
  const value = globalThis.crypto?.subtle;
  if (value === void 0) throw new TypeError("WebCrypto is unavailable");
  return value;
}

// src/read/check-advisories.ts
var osvEndpoint = "https://api.osv.dev";
var ECOSYSTEMS = Object.freeze({ npm: "npm", pypi: "PyPI" });
var BATCH = 1e3;
var MAX_PAGES = 16;
var REQUEST_TIMEOUT_MS = 6e4;
var MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
var ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var NPM_EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var PEP440_EXACT = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?$/i;
var invalid = (detail) => Object.freeze({ status: "invalid", reason: "schema", detail });
function exactVersion(ecosystem, version) {
  if (version === null) return void 0;
  if (ecosystem === "npm") return NPM_EXACT.test(version) ? version : void 0;
  const pinned = /^===?\s*(\S+)$/.exec(version.trim());
  const candidate = pinned === null ? version.trim() : pinned[1];
  return PEP440_EXACT.test(candidate) ? candidate : void 0;
}
function isInternal(dependency, scopes) {
  if (dependency.ecosystem !== "npm") return false;
  const name = dependency.name.toLowerCase();
  return scopes.some((scope) => name.startsWith(`${scope}/`));
}
function validDependencies(value) {
  if (!Array.isArray(value)) return invalid("dependencies must be an array");
  for (const [index, entry] of value.entries()) {
    const at = `dependencies[${index}]`;
    if (typeof entry !== "object" || entry === null) return invalid(`${at} must be an object`);
    const { ecosystem, name, version, file } = entry;
    if (ecosystem !== "npm" && ecosystem !== "pypi")
      return invalid(`${at}.ecosystem must be npm or pypi`);
    if (typeof name !== "string" || name.length === 0 || name.length > 214)
      return invalid(`${at}.name must be a package name`);
    if (version !== null && typeof version !== "string")
      return invalid(`${at}.version must be a string or null`);
    if (file !== void 0 && typeof file !== "string")
      return invalid(`${at}.file must be a string`);
  }
  return value;
}
var Unreachable = class extends Error {
};
var Cancelled = class extends Error {
};
var isObject = isRecord;
async function request(fetcher, url, init, signal) {
  if (signal?.aborted) throw new Cancelled();
  const controller = typeof AbortController === "function" ? new AbortController() : void 0;
  const abort = () => controller?.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = controller !== void 0 && typeof setTimeout === "function" ? setTimeout(abort, REQUEST_TIMEOUT_MS) : void 0;
  try {
    const response = await fetcher(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...controller !== void 0 ? { signal: controller.signal } : signal !== void 0 ? { signal } : {}
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {
      });
      throw new Unreachable();
    }
    const text2 = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (text2 === void 0) throw new Unreachable();
    return JSON.parse(text2);
  } catch (error) {
    if (signal?.aborted) throw new Cancelled();
    throw error instanceof Unreachable ? error : new Unreachable();
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
async function queryIds(queries, base, fetcher, signal) {
  const ids = queries.map(() => []);
  for (let start = 0; start < queries.length; start += BATCH) {
    let pending = queries.slice(start, start + BATCH).map((query, offset) => ({
      index: start + offset,
      query,
      token: void 0
    }));
    for (let page = 0; pending.length > 0; page += 1) {
      if (page >= MAX_PAGES) throw new Unreachable();
      const body = JSON.stringify({
        queries: pending.map(({ query, token }) => ({
          package: { name: query.name, ecosystem: ECOSYSTEMS[query.ecosystem] },
          version: query.version,
          ...token === void 0 ? {} : { page_token: token }
        }))
      });
      const answer = await request(
        fetcher,
        `${base}/v1/querybatch`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
        signal
      );
      if (!isObject(answer) || !Array.isArray(answer.results)) throw new Unreachable();
      const results = answer.results;
      if (results.length !== pending.length) throw new Unreachable();
      const next = [];
      for (const [position, entry] of pending.entries()) {
        const result = results[position];
        if (!isObject(result)) throw new Unreachable();
        const vulns = result.vulns ?? [];
        if (!Array.isArray(vulns)) throw new Unreachable();
        for (const vuln of vulns) {
          if (!isObject(vuln) || typeof vuln.id !== "string" || !ADVISORY_ID.test(vuln.id))
            throw new Unreachable();
          const list = ids[entry.index];
          if (!list.includes(vuln.id)) list.push(vuln.id);
        }
        const token = result.next_page_token;
        if (typeof token === "string" && token.length > 0) next.push({ ...entry, token });
        else if (token !== void 0 && token !== null && token !== "") throw new Unreachable();
      }
      pending = next;
    }
  }
  return ids;
}
function compareNumeric(left, right) {
  const numeric = /^\d+(?:\.\d+)*$/;
  if (!numeric.test(left) || !numeric.test(right)) return void 0;
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
function fixedIn(record, query) {
  const fixes = /* @__PURE__ */ new Set();
  const affected = Array.isArray(record.affected) ? record.affected : [];
  for (const entry of affected) {
    if (!isObject(entry) || !isObject(entry.package)) continue;
    const pkg = entry.package;
    if (pkg.ecosystem !== ECOSYSTEMS[query.ecosystem]) continue;
    const same = query.ecosystem === "npm" ? pkg.name === query.name : typeof pkg.name === "string" && normalPypi(pkg.name) === normalPypi(query.name);
    if (!same || !Array.isArray(entry.ranges)) continue;
    for (const range of entry.ranges) {
      if (!isObject(range) || !Array.isArray(range.events)) continue;
      for (const event of range.events)
        if (isObject(event) && typeof event.fixed === "string" && event.fixed.length > 0)
          fixes.add(event.fixed);
    }
  }
  const all = [...fixes];
  if (all.length === 1) return all[0];
  if (all.length === 0) return void 0;
  const above = all.filter((fix) => compareNumeric(fix, query.version) === 1);
  if (above.length === 0 || all.some((fix) => compareNumeric(fix, query.version) === void 0))
    return void 0;
  return above.sort((a, b) => compareNumeric(a, b))[0];
}
var normalPypi = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
function advisoryOf(record, id, query) {
  if (!isObject(record) || record.id !== id) throw new Unreachable();
  if (typeof record.withdrawn === "string" && record.withdrawn.length > 0) return null;
  const specific = isObject(record.database_specific) ? record.database_specific : {};
  const severity = typeof specific.severity === "string" ? specific.severity : void 0;
  const text2 = typeof record.summary === "string" && record.summary.trim().length > 0 ? record.summary : typeof record.details === "string" && record.details.trim().length > 0 ? record.details : void 0;
  const fix = fixedIn(record, query);
  return Object.freeze({
    id,
    ...severity === void 0 ? {} : { severity: sanitizeText(severity, 32) },
    ...text2 === void 0 ? {} : { summary: sanitizeText(text2.trim(), limits.output.findingText) },
    ...fix === void 0 ? {} : { fixedIn: sanitizeText(fix, 128) }
  });
}
var checkedAtOf = (date) => `${date.toISOString().slice(0, 19)}Z`;
async function checkAdvisories(dependencies, options = {}) {
  const valid = validDependencies(dependencies);
  if ("status" in valid) return valid;
  const scopes = options.internalScopes ?? [];
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string" || !NPM_SCOPE_PATTERN.test(scope)))
    return invalid("internalScopes must be npm scopes such as @acme");
  let base = osvEndpoint;
  if (options.endpoint !== void 0) {
    let url;
    try {
      url = new URL(options.endpoint);
    } catch {
      return invalid("endpoint must be an http(s) URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
      return invalid("endpoint must be an http(s) URL without credentials, query or fragment");
    base = url.href.replace(/\/+$/, "");
  }
  const fetcher = options.fetch ?? (typeof fetch === "function" ? (url, init) => fetch(url, init) : void 0);
  const checkedAt = checkedAtOf((options.now ?? (() => /* @__PURE__ */ new Date()))());
  const echo = (dependency) => Object.freeze({
    ecosystem: dependency.ecosystem,
    name: dependency.name,
    version: dependency.version,
    ...dependency.file === void 0 ? {} : { file: dependency.file }
  });
  const queries = [];
  const keyOf = (query) => `${query.ecosystem}\0${query.name}\0${query.version}`;
  const queryIndex = /* @__PURE__ */ new Map();
  const plan = valid.map((dependency) => {
    if (isInternal(dependency, scopes)) return { reason: "internal scope" };
    const version = exactVersion(dependency.ecosystem, dependency.version);
    if (version === void 0) return { reason: "no exact version" };
    const query = { ecosystem: dependency.ecosystem, name: dependency.name, version };
    const key = keyOf(query);
    if (!queryIndex.has(key)) {
      queryIndex.set(key, queries.length);
      queries.push(query);
    }
    return { query: queryIndex.get(key) };
  });
  let found;
  if (queries.length > 0) {
    try {
      if (fetcher === void 0) throw new Unreachable();
      const ids = await queryIds(queries, base, fetcher, options.signal);
      const records = /* @__PURE__ */ new Map();
      for (const id of [...new Set(ids.flat())]) {
        records.set(
          id,
          await request(
            fetcher,
            `${base}/v1/vulns/${encodeURIComponent(id)}`,
            { method: "GET" },
            options.signal
          )
        );
      }
      found = queries.map(
        (query, index) => ids[index].map((id) => advisoryOf(records.get(id), id, query)).filter((advisory) => advisory !== null)
      );
    } catch (error) {
      if (error instanceof Cancelled)
        return Object.freeze({
          status: "refused",
          reason: "cancelled",
          detail: "the advisory check was cancelled"
        });
      found = void 0;
    }
  }
  const results = valid.map((dependency, index) => {
    const step = plan[index];
    if ("reason" in step)
      return Object.freeze({ ...echo(dependency), state: "not-checked", reason: step.reason });
    const advisories = found?.[step.query];
    if (advisories === void 0)
      return Object.freeze({
        ...echo(dependency),
        state: "not-checked",
        reason: "advisory service unreachable"
      });
    if (advisories.length === 0) return Object.freeze({ ...echo(dependency), state: "none-known" });
    return Object.freeze({
      ...echo(dependency),
      state: "vulnerable",
      code: advisoryCodes[0],
      advisories: Object.freeze([...advisories])
    });
  });
  return Object.freeze({ status: "ok", checkedAt, results: Object.freeze(results) });
}

// src/contracts/git-tree.ts
var SCAN_KEY_PATTERN = /^git-(sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
var encoder = new TextEncoder();
function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function hex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
async function digest(algorithm, bytes) {
  return new Uint8Array(
    await webCryptoSubtle().digest(algorithm, bytes)
  );
}
async function sha256Hex(bytes) {
  return hex(await digest("SHA-256", bytes));
}
async function gitObject(algorithm, type, body) {
  const header = encoder.encode(`${type} ${body.length}\0`);
  return digest(algorithm === "sha1" ? "SHA-1" : "SHA-256", concat([header, body]));
}
var newDirectory = () => ({ files: /* @__PURE__ */ new Map(), folders: /* @__PURE__ */ new Map() });
function compareBytes(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
async function treeHash(algorithm, directory) {
  const entries = [];
  for (const [name, file] of directory.files) {
    const id = await gitObject(algorithm, "blob", file.bytes);
    entries.push({
      sortKey: encoder.encode(name),
      record: concat([encoder.encode(`${file.mode} ${name}\0`), id])
    });
  }
  for (const [name, folder] of directory.folders) {
    const id = await treeHash(algorithm, folder);
    entries.push({
      sortKey: encoder.encode(`${name}/`),
      record: concat([encoder.encode(`40000 ${name}\0`), id])
    });
  }
  entries.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  return gitObject(algorithm, "tree", concat(entries.map((entry) => entry.record)));
}
async function treeKeyOf(files, algorithm = "sha1") {
  const root = newDirectory();
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop();
    let directory = root;
    for (const part of parts) {
      let next = directory.folders.get(part);
      if (next === void 0) {
        next = newDirectory();
        directory.folders.set(part, next);
      }
      directory = next;
    }
    directory.files.set(name, { mode: file.mode, bytes: file.bytes });
  }
  return `git-${algorithm}:${hex(await treeHash(algorithm, root))}`;
}
var invalid2 = (reason, detail) => Object.freeze({ status: "invalid", reason, detail });
var refused = (reason, detail) => Object.freeze({ status: "refused", reason, detail });
function checkTreeFiles(files) {
  if (!Array.isArray(files))
    return invalid2("files", "files must be an array of { path, mode, bytes }");
  if (files.length > limits.input.files)
    return refused("files", `more than ${limits.input.files} files`);
  const seen = /* @__PURE__ */ new Set();
  let total = 0;
  const out = [];
  for (const [index, entry] of files.entries()) {
    if (typeof entry !== "object" || entry === null)
      return invalid2("files", `files[${index}] must be an object`);
    const { path, mode, bytes } = entry;
    const problem2 = pathProblem(path, limits.input.pathLength, limits.input.depth);
    if (problem2 !== void 0)
      return problem2 === "path-length" || problem2 === "depth" ? refused(problem2, `files[${index}] exceeds the ${problem2} limit`) : refused("unsafe-path", `files[${index}]: ${problem2}`);
    if (mode !== "100644" && mode !== "100755")
      return invalid2("mode", `files[${index}].mode must be 100644 or 100755`);
    if (!isBytes(bytes)) return invalid2("bytes", `files[${index}].bytes must be a Uint8Array`);
    if (bytes.length > limits.input.fileBytes)
      return refused("file-size", `files[${index}] exceeds the file size limit`);
    total += bytes.length;
    if (total > limits.input.sourceBytes)
      return refused("source-size", "files exceed the source size limit");
    if (seen.has(path)) return invalid2("files", `files[${index}] repeats a path`);
    seen.add(path);
    out.push({ path, mode, bytes });
  }
  for (const path of seen) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1)
      if (seen.has(segments.slice(0, depth).join("/")))
        return invalid2("files", "a path is both a file and a folder");
  }
  return out;
}
function hasWebCrypto() {
  try {
    webCryptoSubtle();
    return true;
  } catch {
    return false;
  }
}
function algorithmOfKey(key) {
  if (!SCAN_KEY_PATTERN.test(key)) return void 0;
  return key.startsWith("git-sha1:") ? "sha1" : "sha256";
}

// src/contracts/git-url.ts
var GIT_REPOSITORY_URL_PATTERN = "^https://[^/@?#\\s\\u0000-\\u001f\\u007f]+(?:/[^?#\\s\\u0000-\\u001f\\u007f]*)?$";
var shape = new RegExp(GIT_REPOSITORY_URL_PATTERN);

// src/contracts/risk.ts
var POINTS = Object.freeze({
  CRITICAL: 50,
  HIGH: 25,
  MEDIUM: 10,
  LOW: 5,
  INFO: 0
});
var LEVEL_SEVERITY = Object.freeze({
  error: "HIGH",
  warning: "MEDIUM",
  note: "LOW",
  none: "INFO"
});
var scoring = Object.freeze({
  format: formats.scoring,
  points: POINTS,
  /** Step 1: SARIF `level` is used only when the tool gave no severity; an absent level is SARIF's default `warning`. */
  levelSeverity: LEVEL_SEVERITY,
  /** Step 4: weights of the 1st, 2nd, 3rd findings of one tool rule; later ones weigh nothing. */
  weights: Object.freeze([1, 0.5, 0.25]),
  codeMultiplier: 1.3,
  missingConfidence: 1,
  cap: 100,
  thresholds: Object.freeze([
    Object.freeze({ label: "SAFE", min: 0, max: 20 }),
    Object.freeze({ label: "CAUTION", min: 21, max: 50 }),
    Object.freeze({ label: "DO NOT INSTALL", min: 51, max: 100 })
  ]),
  order: Object.freeze(["SAFE", "CAUTION", "DO NOT INSTALL"]),
  /** Codes never scored (advisories are a separate call). */
  excludedCodes: Object.freeze(["trust.known-vulnerability"])
});
function severityOf(finding) {
  return finding.severity ?? LEVEL_SEVERITY[finding.level ?? "warning"];
}
function riskLabelForScore(score) {
  if (score <= 20) return "SAFE";
  if (score <= 50) return "CAUTION";
  return "DO NOT INSTALL";
}
function storedLabel(input) {
  if (!input.routable) return "NOT ASSESSED";
  const derived = riskLabelForScore(input.score);
  return input.coverage === "partial" && derived === "SAFE" ? "CAUTION" : derived;
}

// src/contracts/routing.ts
var CODE_EXTENSIONS = Object.freeze([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "ps1",
  "cmd",
  "bat",
  "rs",
  "go",
  "rb",
  "lua"
]);
var TEXT_EXTENSIONS = Object.freeze(["md", "txt", "mdc", "json", "toml"]);
var CONFIG_NAMES = Object.freeze(["hooks.json", ".mcp.json", "mcp.json", "plugin.json"]);
var SERVER_MAP_KEYS = Object.freeze(["mcpServers", "servers", "mcp", "mcp_servers"]);
var routing = Object.freeze({
  format: formats.routing,
  order: Object.freeze(["config", "dependencies", "code", "text"]),
  parts: Object.freeze({
    config: Object.freeze({
      names: CONFIG_NAMES,
      content: "a JSON or TOML (.toml) hook entry (an event with a command) or MCP entry (command and args, or url), at the top level or under mcpServers, servers, mcp or mcp_servers; the named files may use JSONC comments and trailing commas",
      tools: Object.freeze(["aih-trust-lint", "skillspector"])
    }),
    dependencies: Object.freeze({
      names: Object.freeze(["package.json", "requirements*.txt"]),
      content: "npx/uvx commands in MCP config entries are extracted as dependencies",
      tools: Object.freeze(["aih-trust-lint"])
    }),
    code: Object.freeze({
      extensions: CODE_EXTENSIONS,
      content: "a first line starting with #!",
      tools: Object.freeze(["skillspector", "aih-trust-lint"])
    }),
    text: Object.freeze({
      extensions: TEXT_EXTENSIONS,
      tools: Object.freeze(["skillspector", "aih-trust-lint"])
    })
  }),
  /** Inline commands inside a config entry also go to the code checks; their findings have part `code`. */
  inlineCommandPart: "code",
  /** Always runs, on every text file for secrets. */
  baseline: "aih-trust-lint",
  /** Optional second opinion; never routed for coverage. */
  optional: Object.freeze(["cisco"]),
  /** Item layouts recognised on the `source` route. */
  layouts: Object.freeze([
    Object.freeze({ kind: "skill", rule: "a folder holding SKILL.md: the whole folder" }),
    Object.freeze({
      kind: "agent",
      rule: "a .md file, or a .json/.toml agent definition, under a folder named agents"
    }),
    Object.freeze({ kind: "command", rule: "a .md file under a folder named commands" }),
    Object.freeze({
      kind: "rule",
      rule: "a file under a folder named rules at any depth, .cursor/rules/*.mdc, or .kiro/steering/*.md"
    }),
    Object.freeze({
      kind: "hook",
      rule: "a hooks.json in a folder named hooks: that whole folder; elsewhere the hooks.json file alone"
    }),
    Object.freeze({
      kind: "mcp",
      rule: "a .mcp.json or mcp.json file, whole; or an npm, npm-file or remote source"
    })
  ]),
  ownership: "the outermost skill folder owns everything inside it, then a hooks folder, then single files"
});
var kinds = Object.freeze(["skill", "agent", "command", "rule", "hook", "mcp"]);
var optionalTools = Object.freeze(["skillspector", "aih-trust-lint", "cisco"]);
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// src/contracts/validate.ts
var Invalid = class extends Error {
  constructor(result) {
    super(result.detail ?? result.reason);
    this.result = result;
  }
  result;
};
var invalid3 = (detail, reason = "schema") => {
  throw new Invalid(Object.freeze({ status: "invalid", reason, detail }));
};
var refuse = (reason, detail) => {
  throw new Invalid(Object.freeze({ status: "refused", reason, detail }));
};
function object(value, at) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid3(`${at} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
    invalid3(`${at} must be a plain object`);
  return value;
}
function keys(value, at, required, optional = []) {
  for (const key of required) if (!Object.hasOwn(value, key)) invalid3(`${at}.${key} is required`);
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      invalid3(`${at} has an unknown field ${JSON.stringify(key).slice(0, 80)}`);
}
function text(value, at, max, min = 1) {
  if (typeof value !== "string") return invalid3(`${at} must be a string`);
  if (!isWellFormedText(value)) invalid3(`${at} is not valid text`);
  if (hasUnsafeCharacters(value))
    invalid3(`${at} contains control, bidirectional or zero-width characters`);
  const length = codePointLength(value);
  if (length < min || length > max) invalid3(`${at} must be ${min}-${max} characters`);
  return value;
}
function oneOf(value, at, allowed) {
  if (typeof value !== "string" || !allowed.includes(value))
    invalid3(`${at} must be one of ${allowed.join(", ")}`);
  return value;
}
function integer(value, at, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid3(`${at} must be an integer from ${min} to ${max}`);
  return value;
}
function array(value, at, max, min = 0) {
  if (!Array.isArray(value)) return invalid3(`${at} must be an array`);
  if (value.length < min || value.length > max) invalid3(`${at} must have ${min}-${max} entries`);
  return value;
}
function unique(values, at) {
  if (new Set(values).size !== values.length) invalid3(`${at} must not repeat entries`);
}
var TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
function timestamp(value, at) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
    invalid3(`${at} must be a UTC RFC 3339 timestamp`);
  return value;
}
function scanKey(value, at) {
  if (typeof value !== "string" || !SCAN_KEY_PATTERN.test(value))
    invalid3(`${at} must be a git-sha1: or git-sha256: scan key`);
  return value;
}
function sha256(value, at) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    invalid3(`${at} must be a lowercase sha256`);
  return value;
}
function contentPath(value, at) {
  if (typeof value !== "string") return invalid3(`${at} must be a string`);
  const problem2 = pathProblem(value, limits.input.pathLength, limits.input.depth);
  if (problem2 !== void 0) refuse("unsafe-path", `${at}: ${problem2}`);
  return value;
}
function run(body) {
  try {
    return body();
  } catch (error) {
    if (error instanceof Invalid) return error.result;
    return Object.freeze({
      status: "invalid",
      reason: "schema",
      detail: "input could not be validated"
    });
  }
}
var PARTS = ["config", "dependencies", "code", "text", "none"];
var LABELS = ["SAFE", "CAUTION", "DO NOT INSTALL", "NOT ASSESSED"];
var COUNT_KEYS = ["critical", "high", "medium", "low", "info"];
function summaryTool(value, at) {
  const tool = object(value, at);
  keys(tool, at, ["tool", "version", "mode", "result", "counts"], ["ai", "reason", "suppressed"]);
  const result = {
    tool: text(tool.tool, `${at}.tool`, limits.output.ruleId),
    version: text(tool.version, `${at}.version`, 128),
    mode: oneOf(tool.mode, `${at}.mode`, ["static", "ai"]),
    result: oneOf(tool.result, `${at}.result`, [
      "pass",
      "warn",
      "fail",
      "not-run",
      "not-applicable"
    ]),
    counts: {}
  };
  const counts = object(tool.counts, `${at}.counts`);
  keys(counts, `${at}.counts`, [], COUNT_KEYS);
  for (const key of COUNT_KEYS)
    if (counts[key] !== void 0)
      result.counts[key] = integer(counts[key], `${at}.counts.${key}`, 1);
  result.counts = Object.freeze(result.counts);
  if (tool.ai !== void 0) {
    const ai = object(tool.ai, `${at}.ai`);
    keys(ai, `${at}.ai`, ["via", "provider", "model"]);
    result.ai = Object.freeze({
      via: oneOf(ai.via, `${at}.ai.via`, ["cli", "local", "provider"]),
      provider: text(ai.provider, `${at}.ai.provider`, 128),
      model: text(ai.model, `${at}.ai.model`, 256)
    });
  }
  if (tool.reason !== void 0)
    result.reason = text(tool.reason, `${at}.reason`, limits.output.reason);
  if (result.result === "not-run" !== (result.reason !== void 0))
    invalid3(`${at}.reason is required exactly when the tool did not run`);
  if (tool.suppressed !== void 0)
    result.suppressed = Object.freeze(
      array(tool.suppressed, `${at}.suppressed`, 1e4).map((entry, index) => {
        const suppressed = object(entry, `${at}.suppressed[${index}]`);
        keys(suppressed, `${at}.suppressed[${index}]`, ["count", "reason"]);
        return Object.freeze({
          count: integer(suppressed.count, `${at}.suppressed[${index}].count`, 1),
          reason: text(
            suppressed.reason,
            `${at}.suppressed[${index}].reason`,
            limits.output.reason
          )
        });
      })
    );
  return Object.freeze(result);
}
function summary(value) {
  const document = object(value, "summary");
  const problem2 = formatProblem(document.format, formats.summary, "summary");
  if (problem2 !== void 0) throw new Invalid(problem2);
  keys(
    document,
    "summary",
    [
      "format",
      "scanKey",
      "revision",
      "origin",
      "scannedAt",
      "scanner",
      "routing",
      "scoring",
      "score",
      "label",
      "coverage",
      "files",
      "tools",
      "notAnalysed",
      "sarif",
      "dependencies"
    ],
    ["reason"]
  );
  for (const [field2, expected] of [
    ["routing", formats.routing],
    ["scoring", formats.scoring]
  ]) {
    const versionProblem = formatProblem(document[field2], expected, `summary.${field2}`);
    if (versionProblem !== void 0) throw new Invalid(versionProblem);
  }
  const files = array(document.files, "summary.files", limits.input.files).map((entry, index) => {
    const at = `summary.files[${index}]`;
    const file = object(entry, at);
    keys(file, at, ["path", "mode", "part", "sha256"]);
    return Object.freeze({
      path: contentPath(file.path, `${at}.path`),
      mode: oneOf(file.mode, `${at}.mode`, ["100644", "100755"]),
      part: oneOf(file.part, `${at}.part`, PARTS),
      sha256: sha256(file.sha256, `${at}.sha256`)
    });
  });
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) invalid3("summary.files must not repeat a path");
  for (const path of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1)
      if (paths.has(segments.slice(0, depth).join("/")))
        invalid3("summary.files has a path that is both a file and a folder");
  }
  const notAnalysed = array(document.notAnalysed, "summary.notAnalysed", limits.input.files).map(
    (entry, index) => {
      const at = `summary.notAnalysed[${index}]`;
      const record = object(entry, at);
      keys(record, at, ["path", "secretsChecked"]);
      if (typeof record.secretsChecked !== "boolean")
        invalid3(`${at}.secretsChecked must be a boolean`);
      return Object.freeze({
        path: contentPath(record.path, `${at}.path`),
        secretsChecked: record.secretsChecked
      });
    }
  );
  const unrouted = new Set(files.filter((file) => file.part === "none").map((file) => file.path));
  if (notAnalysed.length !== unrouted.size || notAnalysed.some((entry) => !unrouted.has(entry.path)))
    invalid3("summary.notAnalysed must list exactly the files with part none");
  const tools = array(document.tools, "summary.tools", 64).map(
    (entry, index) => summaryTool(entry, `summary.tools[${index}]`)
  );
  unique(
    tools.map((tool) => tool.tool),
    "summary.tools[].tool"
  );
  const sarif = array(document.sarif, "summary.sarif", 64).map((entry, index) => {
    const at = `summary.sarif[${index}]`;
    const record = object(entry, at);
    keys(record, at, ["path", "sha256"]);
    return Object.freeze({
      path: contentPath(record.path, `${at}.path`),
      sha256: sha256(record.sha256, `${at}.sha256`)
    });
  });
  const dependencies = array(
    document.dependencies,
    "summary.dependencies",
    limits.input.files * 16
  ).map((entry, index) => {
    const at = `summary.dependencies[${index}]`;
    const record = object(entry, at);
    keys(record, at, ["ecosystem", "name", "version", "file"]);
    return Object.freeze({
      ecosystem: oneOf(record.ecosystem, `${at}.ecosystem`, ["npm", "pypi"]),
      name: text(record.name, `${at}.name`, 256),
      version: record.version === null ? null : text(record.version, `${at}.version`, 256),
      file: contentPath(record.file, `${at}.file`)
    });
  });
  for (const dependency of dependencies)
    if (!paths.has(dependency.file))
      invalid3("summary.dependencies must name a file of the summary");
  const score = integer(document.score, "summary.score", 0, 100);
  const coverage = oneOf(document.coverage, "summary.coverage", ["complete", "partial"]);
  const label = oneOf(document.label, "summary.label", LABELS);
  const reason = document.reason === void 0 ? void 0 : text(document.reason, "summary.reason", limits.output.reason);
  const result = {
    format: formats.summary,
    scanKey: scanKey(document.scanKey, "summary.scanKey"),
    revision: integer(document.revision, "summary.revision", 1),
    origin: oneOf(document.origin, "summary.origin", ["published", "local"]),
    scannedAt: timestamp(document.scannedAt, "summary.scannedAt"),
    scanner: text(document.scanner, "summary.scanner", 128),
    routing: formats.routing,
    scoring: formats.scoring,
    score,
    label,
    coverage,
    ...reason === void 0 ? {} : { reason },
    files: Object.freeze(files),
    tools: Object.freeze(tools),
    notAnalysed: Object.freeze(notAnalysed),
    sarif: Object.freeze(sarif),
    dependencies: Object.freeze(dependencies)
  };
  if (coverage === "partial" !== (result.reason !== void 0))
    invalid3("summary.reason is required exactly when coverage is partial");
  const routable = files.some((file) => file.part !== "none");
  if (storedLabel({ score, coverage, routable }) !== label)
    invalid3("summary.label does not follow from score, coverage and routable content", "label");
  return Object.freeze(result);
}
function validateSummary(value) {
  return run(() => Object.freeze({ status: "ok", summary: summary(value) }));
}
function validateWithdrawn(value) {
  return run(() => {
    const document = object(value, "withdrawn");
    const problem2 = formatProblem(document.format, formats.withdrawn, "withdrawn");
    if (problem2 !== void 0) throw new Invalid(problem2);
    keys(document, "withdrawn", ["format", "scanKey", "throughRevision", "at", "reason"]);
    return Object.freeze({
      status: "ok",
      withdrawn: Object.freeze({
        format: formats.withdrawn,
        scanKey: scanKey(document.scanKey, "withdrawn.scanKey"),
        throughRevision: integer(document.throughRevision, "withdrawn.throughRevision", 1),
        at: timestamp(document.at, "withdrawn.at"),
        reason: text(document.reason, "withdrawn.reason", limits.output.reason)
      })
    });
  });
}

// fixture-root:root
var sigstoreTrustedRootText = '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1","tlogs":[{"baseUrl":"https://rekor.test.invalid","hashAlgorithm":"SHA2_256","publicKey":{"rawBytes":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHn7eJzJ3qz8ZD7Dr6K6Gb1HtXUbd28/iXPr/J2T4WhzvuJBKZGJJbs5Sq1LgBrzeTEv4/hVDxmLN/Ym017b7aQ==","keyDetails":"PKIX_ECDSA_P256_SHA_256","validFor":{"start":"2020-01-01T00:00:00Z","end":"2030-01-01T00:00:00Z"}},"logId":{"keyId":"3DGFish/PqceCJCcXy4o8ZubnfqDwWetjZvcD+lhIi8="}},{"baseUrl":"https://rekor-v2.test.invalid","hashAlgorithm":"SHA2_256","publicKey":{"rawBytes":"MCowBQYDK2VwAyEA1H7Y5xDHpv1rTMciXpirZ+HBYidCzpJTLddhCBZoF7I=","keyDetails":"PKIX_ED25519","validFor":{"start":"2020-01-01T00:00:00Z","end":"2030-01-01T00:00:00Z"}},"logId":{"keyId":"WlgWO2mkoBV9v9erxSPU47Ua6Dj2YHgKPccB3F6uuKA="}}],"certificateAuthorities":[{"subject":{"commonName":"TEST ONLY fulcio"},"uri":"https://fulcio.test.invalid","certChain":{"certificates":[{"rawBytes":"MIIBmjCCASCgAwIBAgIBAjAKBggqhkjOPQQDAzAgMR4wHAYDVQQDDBVURVNUIE9OTFkgZnVsY2lvIHJvb3QwHhcNMjAwMTAxMDAwMDAwWhcNMzAwMTAxMDAwMDAwWjAoMSYwJAYDVQQDDB1URVNUIE9OTFkgZnVsY2lvIGludGVybWVkaWF0ZTB2MBAGByqGSM49AgEGBSuBBAAiA2IABGEoxZqpZbVQ+hkhUnplHHZvljml8KIme6BtjI05A5KIZPJuQM5yHp/v/68UkiYXnV5kcw2W01/0l2aiRfHJlJo83SQojrdFvDeN84UVewi/dn7SEU//iA+2lnc0wOpaX6MmMCQwEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIxALXh2ptfmk2Xl1FGfvMk7YdUdSAqSzPVvf9gjRy6S14/CBUPUAqsirCV6n8SN3xnuAIwGEEfREquR1LtHK4BdJG8YAl8azjWZez3O5Ovuz/yor7BbC0GP9HOKcSzFRgtMI+J"},{"rawBytes":"MIIBkjCCARigAwIBAgIBATAKBggqhkjOPQQDAzAgMR4wHAYDVQQDDBVURVNUIE9OTFkgZnVsY2lvIHJvb3QwHhcNMjAwMTAxMDAwMDAwWhcNMzAwMTAxMDAwMDAwWjAgMR4wHAYDVQQDDBVURVNUIE9OTFkgZnVsY2lvIHJvb3QwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARmaJfh5d1XsKi6XVJKxX6k1TFQuj+GKRuC065SUi/NMWQWGi9ilq0iJUVzGlumTmHg8zTTOUFQASuLNNEkjaP6TfneE0WF9U+aLK91JYUmht8E0ikXGTI/6EiAKf589q+jJjAkMBIGA1UdEwEB/wQIMAYBAf8CAQEwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMECb1nTwWHvIEwbbgz37NNqhwxBFeejuQBPoP6cXhZKitvo5dXLqZWz1964BIdjZ9gIxAPRNl1HdgIfYWW1BbzIi37dH+XddhqLz9ab1YagULBPE15Q0jriZnAIdkFEV0cES2Q=="}]},"validFor":{"start":"2020-01-01T00:00:00Z","end":"2030-01-01T00:00:00Z"}}],"ctlogs":[{"baseUrl":"https://ct.test.invalid","hashAlgorithm":"SHA2_256","publicKey":{"rawBytes":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWoyWUt2daggtSRsKyaZZ5PiTTg6z5gNq/kPZs5htahKxy8/lnvd9Hbny5HP3y4A3gfyIJIpIZ5+Mz1/i0lRKcg==","keyDetails":"PKIX_ECDSA_P256_SHA_256","validFor":{"start":"2020-01-01T00:00:00Z","end":"2030-01-01T00:00:00Z"}},"logId":{"keyId":"1kjzrw3vGFmUWT3YftlowTwYWCSErPQhHhDBGAtgy/4="}}],"timestampAuthorities":[{"subject":{"commonName":"TEST ONLY timestamp"},"uri":"https://tsa.test.invalid","certChain":{"certificates":[{"rawBytes":"MIIBqjCCAS+gAwIBAgIBBzAKBggqhkjOPQQDAzAjMSEwHwYDVQQDDBhURVNUIE9OTFkgdGltZXN0YW1wIHJvb3QwHhcNMjAwMTAxMDAwMDAwWhcNMzAwMTAxMDAwMDAwWjAlMSMwIQYDVQQDDBpURVNUIE9OTFkgdGltZXN0YW1wIHNpZ25lcjB2MBAGByqGSM49AgEGBSuBBAAiA2IABDO/XQmy8QPQY0GAbFMK55EBWYsgWkdmd9ouTcj5xu6yatRT6Xl05lbvMIpbAEPHir3rRuUaSaQcJCF8LJcWvYsg8wC/2km7F5LheRvJHRynN3U2R8M4cxcWto8wW01a2qM1MDMwCQYDVR0TBAIwADAOBgNVHQ8BAf8EBAMCB4AwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwgwCgYIKoZIzj0EAwMDaQAwZgIxAJdCYDnLXb57lhOFwjNrtyb5ceZhNOzAJ05rR4Bdl2wpQKUdD1CMdwsF0DPx0CaIpAIxAOarBXBTxczW0s0EIwikUsiyBj0HQDVR+le3oYOLUkTDJMtYIQDced9cfb99MY4/dQ=="},{"rawBytes":"MIIBmTCCAR6gAwIBAgIBATAKBggqhkjOPQQDAzAjMSEwHwYDVQQDDBhURVNUIE9OTFkgdGltZXN0YW1wIHJvb3QwHhcNMjAwMTAxMDAwMDAwWhcNMzAwMTAxMDAwMDAwWjAjMSEwHwYDVQQDDBhURVNUIE9OTFkgdGltZXN0YW1wIHJvb3QwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATzjfoFqsuuzuEt1V7wfZSPSbzA7kfrxdotQnlIJpzR5gpn7DdUtccjEsxjE+SVeCIv9wA3QIaktRE/gaOqH/OWB2IZDimxm8sycroO5dWAmJTIow3cIQ2hyXcBTZHeJaijJjAkMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2kAMGYCMQDx4F9zFnZnaaLp7nlu134vtFFfTs9fYu3YKDXzZBm/XbexQOxb1MwFVA0p8wuKck8CMQCwnAd1LcDotUCOgKjfFhLuFrFw4UtE3ws7j9iEaFt44jD8csZV3rM/EiwjGogvpo0="}]},"validFor":{"start":"2020-01-01T00:00:00Z","end":"2030-01-01T00:00:00Z"}}]}';

// src/contracts/verification.ts
var PUBLISHER_URI = "https://github.com/samartomar/aih-scan/.github/workflows/scan-report-publisher.yml@refs/heads/main";
var defaultSigners = Object.freeze([
  Object.freeze({
    identity: "aihq-scan-production",
    issuer: "https://token.actions.githubusercontent.com",
    subject: PUBLISHER_URI,
    extensions: Object.freeze({
      "1.3.6.1.4.1.57264.1.9": PUBLISHER_URI,
      "1.3.6.1.4.1.57264.1.11": "github-hosted",
      "1.3.6.1.4.1.57264.1.12": "https://github.com/samartomar/aih-scan",
      "1.3.6.1.4.1.57264.1.14": "refs/heads/main",
      "1.3.6.1.4.1.57264.1.15": "1336836161",
      "1.3.6.1.4.1.57264.1.16": "https://github.com/samartomar",
      "1.3.6.1.4.1.57264.1.17": "9993940",
      "1.3.6.1.4.1.57264.1.18": PUBLISHER_URI,
      "1.3.6.1.4.1.57264.1.20": "workflow_dispatch",
      "1.3.6.1.4.1.57264.1.22": "public"
    })
  })
]);
var verification = Object.freeze({
  profile: "aih-sigstore-keyless/1",
  bundle: Object.freeze({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: "certificate",
    content: "messageSignature",
    messageDigest: "SHA2_256",
    signingKey: "ECDSA P-256 with SHA-256 (DER signature) over the exact supplied bytes",
    refused: Object.freeze([
      "dsseEnvelope",
      "publicKey",
      "x509CertificateChain",
      "other bundle media types"
    ])
  }),
  encodings: Object.freeze({
    bundle: "Sigstore bundle protobuf JSON (base64 bytes, decimal int64 strings)",
    trustedRoot: Object.freeze([
      "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
      "application/vnd.dev.sigstore.trustedroot.v0.2+json"
    ]),
    certificates: "X.509 v3 DER",
    tlogBodies: Object.freeze(["hashedrekord 0.0.1 (Rekor v1)", "hashedrekord 0.0.2 (Rekor v2)"]),
    timestamps: "RFC 3161 TimeStampResp with CMS SignedData/TSTInfo"
  }),
  algorithms: Object.freeze({
    signingCertificate: "ECDSA P-256 / SHA-256",
    certificateChains: "ECDSA P-256 or P-384 with SHA-256, SHA-384 or SHA-512 (as the certificate names)",
    certificateTransparency: "ECDSA P-256 / SHA-256 SCTs (RFC 6962), log id = SHA-256 of the key",
    transparencyLogs: Object.freeze([
      "PKIX_ECDSA_P256_SHA_256 (signed entry timestamp and checkpoint)",
      "PKIX_ED25519 (checkpoint)"
    ]),
    merkleTree: "RFC 6962 SHA-256 inclusion proofs",
    timestampAuthorities: "ECDSA P-256 or P-384 with SHA-256, SHA-384 or SHA-512; imprint SHA-256/384/512",
    unsupported: "refused with reason unsupported-algorithm"
  }),
  rules: Object.freeze([
    "fresh SHA-256 of the supplied bytes equals the bundle's message digest and the signature verifies",
    "the signing certificate chains to a selected Fulcio CA valid at every authenticated signing time",
    "at least one embedded SCT verifies under a selected CT log",
    "every transparency-log entry binds the digest, certificate and signature and has a verified inclusion proof and signed checkpoint",
    "at least one authenticated signing time (Rekor signed entry timestamp or RFC 3161) within the certificate's validity",
    "certificates and proofs inside a bundle are evidence, never trust anchors; no network access"
  ]),
  trustSnapshot: Object.freeze({
    description: "Sigstore public-good instance trusted root",
    source: "https://tuf-repo-cdn.sigstore.dev",
    obtainedThrough: "authenticated TUF update from the embedded bootstrap root (sigstore-python 4.5.1, python-tuf 7.0.1)",
    target: "trusted_root.json",
    rootVersion: 16,
    targetsVersion: 14,
    snapshotVersion: 166,
    timestampVersion: 823,
    fetchedAt: "2026-11-01",
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    length: 6787,
    sha256: "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66",
    note: "authenticates evidence under this material only; no live revocation, freshness or withdrawal discovery"
  })
});

// src/shared/strict-json.ts
var object2 = (value) => typeof value === "object" && value !== null;
var own = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === void 0 || !("value" in descriptor))
    throw new TypeError("canonical JSON requires own data properties");
  return descriptor.value;
};
function assertWellFormedNfcV1(value, label, requireNfc = true) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343))
        throw new TypeError(`${label} contains malformed Unicode`);
      index += 1;
    } else if (unit >= 56320 && unit <= 57343)
      throw new TypeError(`${label} contains malformed Unicode`);
  }
  if (requireNfc && value.normalize("NFC") !== value)
    throw new TypeError(`${label} must already be NFC`);
}
function assertStrictJsonValueV1(value, label, requireNfc = true, active = /* @__PURE__ */ new WeakSet()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertWellFormedNfcV1(value, label, requireNfc);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new TypeError(`${label} numbers must be finite and not negative zero`);
    return value;
  }
  if (!object2(value)) throw new TypeError(`${label} does not support ${typeof value}`);
  if (active.has(value)) throw new TypeError(`${label} must not contain a cycle`);
  active.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError(`${label} must not contain symbol properties`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      throw new TypeError(`${label} has an unsupported array shape`);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === void 0 || !("value" in descriptor))
        throw new TypeError(`${label} arrays must not contain holes/accessors`);
      assertStrictJsonValueV1(descriptor.value, `${label}[${String(index)}]`, requireNfc, active);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${label} has an unsupported object prototype`);
    for (const key of Object.keys(value)) {
      assertWellFormedNfcV1(key, `${label} key`, requireNfc);
      assertStrictJsonValueV1(own(value, key), `${label}.${key}`, requireNfc, active);
    }
  }
  active.delete(value);
  return value;
}
var STRICT_JSON_MAX_DEPTH_V1 = 512;
var UTF8_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeStrictUtf8V1(bytes, label) {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw new TypeError(`${label} is not well-formed UTF-8`);
  }
}
var STRICT_JSON_MAX_NUMBER_CHARACTERS_V1 = 1100;
var StrictJsonBoundErrorV1 = class extends TypeError {
  bound;
  limit;
  constructor(message, bound, limit) {
    super(message);
    this.name = "StrictJsonBoundErrorV1";
    this.bound = bound;
    this.limit = limit;
  }
};
var isDigitCode = (code) => code >= 48 && code <= 57;
function scanDecimalV1(text2, start, limit, over) {
  let at = start;
  const step = () => {
    at += 1;
    if (at - start > limit) over();
  };
  const digits = () => {
    while (isDigitCode(text2.charCodeAt(at))) step();
  };
  const negative = text2.charCodeAt(at) === 45;
  if (negative) step();
  const wholeStart = at;
  const first = text2.charCodeAt(at);
  if (first === 48) step();
  else if (isDigitCode(first)) digits();
  else return void 0;
  const whole = text2.slice(wholeStart, at);
  let fraction = "";
  if (text2.charCodeAt(at) === 46 && isDigitCode(text2.charCodeAt(at + 1))) {
    step();
    const fractionStart = at;
    digits();
    fraction = text2.slice(fractionStart, at);
  }
  let scale = "";
  const marker = text2.charCodeAt(at);
  if (marker === 101 || marker === 69) {
    const sign = text2.charCodeAt(at + 1);
    const signed = sign === 43 || sign === 45;
    if (isDigitCode(text2.charCodeAt(at + (signed ? 2 : 1)))) {
      step();
      const scaleStart = at;
      if (signed) step();
      digits();
      scale = text2.slice(scaleStart, at);
    }
  }
  return { end: at, negative, whole, fraction, scale };
}
var StrictJsonNumberErrorV1 = class extends TypeError {
  lexeme;
  loss;
  constructor(message, lexeme, loss) {
    super(message);
    this.name = "StrictJsonNumberErrorV1";
    this.lexeme = lexeme;
    this.loss = loss;
  }
};
function exactDecimalOfParts({ negative, whole, fraction, scale }) {
  const all = `${whole}${fraction}`;
  let first = 0;
  while (first < all.length && all.charCodeAt(first) === 48) first += 1;
  let last = all.length;
  while (last > first && all.charCodeAt(last - 1) === 48) last -= 1;
  const digits = all.slice(first, last);
  const exponent = digits === "" ? 0 : Number.parseInt(scale || "0", 10) - fraction.length + (all.length - last);
  return { negative, digits, exponent };
}
function exactDecimal(text2) {
  const malformed2 = () => {
    throw new TypeError(`not a decimal number: ${text2}`);
  };
  const parts = scanDecimalV1(text2, 0, Number.POSITIVE_INFINITY, malformed2);
  if (parts === void 0 || parts.end !== text2.length) return malformed2();
  return exactDecimalOfParts(parts);
}
var sameDecimal = (left, right) => left.negative === right.negative && left.digits === right.digits && left.exponent === right.exponent;
function exactDecimalOfFraction(value) {
  const view2 = new DataView(new ArrayBuffer(8));
  view2.setFloat64(0, value);
  const bits = view2.getBigUint64(0);
  const biased = Number(bits >> 52n & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = biased === 0 ? fraction : fraction | 1n << 52n;
  const shift = 1075 - (biased === 0 ? 1 : biased);
  const decimal = exactDecimal((mantissa * 5n ** BigInt(shift)).toString());
  return { negative: value < 0, digits: decimal.digits, exponent: decimal.exponent - shift };
}
function numberLossV1(parts, value) {
  if (parts.fraction === "" && parts.scale === "" && parts.whole.length <= 15)
    return parts.negative && parts.whole === "0" ? "negative-zero" : void 0;
  const decimal = exactDecimalOfParts(parts);
  if (decimal.digits === "") return decimal.negative ? "negative-zero" : void 0;
  if (!Number.isFinite(value)) return "overflow";
  if (value === 0) return "underflow";
  if (decimal.exponent >= 0) {
    if (Number.isSafeInteger(value)) return void 0;
    if (!Number.isInteger(value)) return "rounded";
    const magnitude = BigInt(decimal.digits) * 10n ** BigInt(decimal.exponent);
    return BigInt(value) === (decimal.negative ? -magnitude : magnitude) ? void 0 : "rounded";
  }
  if (Number.isInteger(value)) return "rounded";
  if (sameDecimal(decimal, exactDecimal(String(value)))) return void 0;
  return sameDecimal(decimal, exactDecimalOfFraction(value)) ? void 0 : "rounded";
}
var NUMBER_LOSS_V1 = {
  overflow: "a number beyond the double range",
  underflow: "a non-zero number that underflows to zero",
  rounded: "a number no double holds exactly",
  "negative-zero": "negative zero"
};
var ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
};
function parseStrictJsonV1(text2, label, options = {}) {
  const requireNfc = options.requireNfc ?? true;
  assertWellFormedNfcV1(text2, `${label} JSON text`, requireNfc);
  let at = 0;
  const invalid7 = (reason) => {
    throw new TypeError(`invalid JSON ${label}: ${reason} at offset ${String(at)}`);
  };
  const space = () => {
    for (let code = text2.charCodeAt(at); ; code = text2.charCodeAt(at)) {
      if (code === 32 || code === 9 || code === 10 || code === 13) at += 1;
      else return;
    }
  };
  const string = () => {
    at += 1;
    let value2 = "";
    let start = at;
    for (; ; ) {
      if (at >= text2.length) return invalid7("an unterminated string");
      const code = text2.charCodeAt(at);
      if (code === 34) {
        value2 += text2.slice(start, at);
        at += 1;
        return value2;
      }
      if (code < 32) return invalid7("a control character in a string");
      if (code !== 92) {
        at += 1;
        continue;
      }
      value2 += text2.slice(start, at);
      const escaped = text2[at + 1] ?? "";
      if (escaped === "u") {
        const hex2 = text2.slice(at + 2, at + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex2)) return invalid7("an invalid \\u escape");
        value2 += String.fromCharCode(Number.parseInt(hex2, 16));
        at += 6;
      } else {
        const decoded = ESCAPES[escaped];
        if (decoded === void 0) return invalid7("an invalid escape");
        value2 += decoded;
        at += 2;
      }
      start = at;
    }
  };
  const number = () => {
    const parts = scanDecimalV1(text2, at, STRICT_JSON_MAX_NUMBER_CHARACTERS_V1, () => {
      throw new StrictJsonBoundErrorV1(
        `invalid JSON ${label}: a number longer than ${String(STRICT_JSON_MAX_NUMBER_CHARACTERS_V1)} characters at offset ${String(at)}`,
        "number-characters",
        STRICT_JSON_MAX_NUMBER_CHARACTERS_V1
      );
    });
    if (parts === void 0) return invalid7("an unexpected character");
    const lexeme = text2.slice(at, parts.end);
    const value2 = Number(lexeme);
    const loss = numberLossV1(parts, value2);
    if (loss !== void 0) {
      const shown = lexeme.length > 64 ? `${lexeme.slice(0, 64)}\u2026` : lexeme;
      throw new StrictJsonNumberErrorV1(
        `invalid JSON ${label}: ${NUMBER_LOSS_V1[loss]} (${shown}) at offset ${String(at)}`,
        lexeme,
        loss
      );
    }
    at += lexeme.length;
    return value2;
  };
  const literal = (word, value2) => {
    if (text2.startsWith(word, at)) {
      at += word.length;
      return value2;
    }
    return invalid7("an unexpected character");
  };
  const value = (depth) => {
    space();
    const code = text2.charCodeAt(at);
    if (code === 123 || code === 91) {
      if (depth >= STRICT_JSON_MAX_DEPTH_V1) return invalid7("nesting beyond the bound");
      return code === 123 ? objectValue(depth + 1) : arrayValue(depth + 1);
    }
    if (code === 34) return string();
    if (code === 116) return literal("true", true);
    if (code === 102) return literal("false", false);
    if (code === 110) return literal("null", null);
    if (Number.isNaN(code)) return invalid7("an unexpected end of text");
    return number();
  };
  const objectValue = (depth) => {
    at += 1;
    const result = {};
    const keys2 = /* @__PURE__ */ new Set();
    space();
    if (text2.charCodeAt(at) === 125) {
      at += 1;
      return result;
    }
    for (; ; ) {
      space();
      if (text2.charCodeAt(at) !== 34) return invalid7("an object key that is not a string");
      const key = string();
      if (keys2.has(key)) throw new TypeError(`${label} has a duplicate JSON object key: ${key}`);
      keys2.add(key);
      space();
      if (text2.charCodeAt(at) !== 58) return invalid7("a missing ':'");
      at += 1;
      Object.defineProperty(result, key, {
        value: value(depth),
        writable: true,
        enumerable: true,
        configurable: true
      });
      space();
      const next = text2.charCodeAt(at);
      at += 1;
      if (next === 125) return result;
      if (next !== 44) {
        at -= 1;
        return invalid7("a missing ',' or '}'");
      }
    }
  };
  const arrayValue = (depth) => {
    at += 1;
    const result = [];
    space();
    if (text2.charCodeAt(at) === 93) {
      at += 1;
      return result;
    }
    for (; ; ) {
      result.push(value(depth));
      space();
      const next = text2.charCodeAt(at);
      at += 1;
      if (next === 93) return result;
      if (next !== 44) {
        at -= 1;
        return invalid7("a missing ',' or ']'");
      }
    }
  };
  const parsed = value(0);
  space();
  if (at !== text2.length) invalid7("data after the JSON value");
  return assertStrictJsonValueV1(parsed, label, requireNfc);
}

// src/read/read-summary.ts
var invalid4 = (reason, detail) => Object.freeze({ status: "invalid", reason, detail });
function parseJsonBytes(bytes, label, maxBytes) {
  if (!isBytes(bytes))
    return {
      ok: false,
      problem: invalid4("bytes", `${label} must be supplied as bytes (Uint8Array)`)
    };
  if (bytes.length > maxBytes)
    return {
      ok: false,
      problem: Object.freeze({
        status: "refused",
        reason: "limit",
        detail: `${label} exceeds ${maxBytes} bytes`
      })
    };
  try {
    const text2 = decodeStrictUtf8V1(bytes, label);
    return {
      ok: true,
      value: parseStrictJsonV1(text2.startsWith("\uFEFF") ? text2.slice(1) : text2, label, {
        requireNfc: false
      })
    };
  } catch {
    return { ok: false, problem: invalid4("json", `${label} is not strict UTF-8 JSON`) };
  }
}
function readSummary(bytes) {
  const parsed = parseJsonBytes(bytes, "summary", limits.output.summaryBytes);
  if (!parsed.ok) return parsed.problem;
  return validateSummary(parsed.value);
}

// src/read/sigstore/bytes.ts
var EvidenceError = class extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
  reason;
};
var fail = (detail) => {
  throw new EvidenceError("invalid-signature", detail);
};
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));
var URL_SAFE = /* @__PURE__ */ new Map([
  ["-", 62],
  ["_", 63]
]);
function base64Decode(value, maxBytes = 16 * 1024 * 1024) {
  if (typeof value !== "string") return void 0;
  let text2 = value;
  while (text2.endsWith("=")) text2 = text2.slice(0, -1);
  if (value.length - text2.length > 2 || text2.length % 4 === 1) return void 0;
  if (text2.length * 3 / 4 > maxBytes) return void 0;
  const out = new Uint8Array(Math.floor(text2.length * 3 / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const character of text2) {
    const sextet = DECODE.get(character) ?? URL_SAFE.get(character);
    if (sextet === void 0) return void 0;
    buffer = buffer << 6 | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = buffer >> bits & 255;
    }
  }
  if ((buffer & (1 << bits) - 1) !== 0) return void 0;
  return out;
}
function base64Encode(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = a << 16 | (b ?? 0) << 8 | (c ?? 0);
    out += ALPHABET[triple >> 18 & 63];
    out += ALPHABET[triple >> 12 & 63];
    out += b === void 0 ? "=" : ALPHABET[triple >> 6 & 63];
    out += c === void 0 ? "=" : ALPHABET[triple & 63];
  }
  return out;
}
function hexOf(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
function hexDecode(value) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value))
    return void 0;
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1)
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}
function concat2(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left[index] ^ right[index];
  return difference === 0;
}
var encoder2 = new TextEncoder();
var utf8 = (value) => encoder2.encode(value);
var strictDecoder = new TextDecoder("utf-8", { fatal: true });
function utf8Text(bytes) {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return void 0;
  }
}
function pemCertificate(text2) {
  const match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END CERTIFICATE-----\r?\n?$/.exec(
    text2
  );
  if (match === null) return void 0;
  return base64Decode(match[1].replace(/\r?\n/g, ""));
}
function uintOf(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  return value;
}

// src/read/sigstore/bundle.ts
var BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
var BUNDLE_FAMILY = /^application\/vnd\.dev\.sigstore\.bundle(?:\+json;version=\d+\.\d+|\.v\d+\.\d+\+json)$/;
var BundleProblem = class extends Error {
  constructor(status, reason, detail) {
    super(detail);
    this.status = status;
    this.reason = reason;
  }
  status;
  reason;
};
var invalid5 = (detail) => {
  throw new BundleProblem("invalid", "bundle", detail);
};
var unsupportedProfile = (detail) => {
  throw new BundleProblem("refused", "unsupported-profile", detail);
};
var MAX_ENTRIES = 8;
var MAX_HASHES = 64;
var objectOf = (value, label) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : invalid5(`${label} must be an object`);
var bytesOf = (value, label, max = 1024 * 1024) => base64Decode(value, max) ?? invalid5(`${label} must be base64`);
function int64(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value)) return BigInt(value);
  return invalid5(`${label} must be a non-negative integer`);
}
function arrayOf(value, label, max) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > max)
    return invalid5(`${label} must be an array of at most ${max}`);
  return value;
}
function entryOf(value, index) {
  const label = `tlogEntries[${index}]`;
  const entry = objectOf(value, label);
  const kindVersion = objectOf(entry.kindVersion, `${label}.kindVersion`);
  if (typeof kindVersion.kind !== "string" || typeof kindVersion.version !== "string")
    invalid5(`${label}.kindVersion`);
  const promise = entry.inclusionPromise === void 0 ? void 0 : objectOf(entry.inclusionPromise, `${label}.inclusionPromise`);
  let proof;
  if (entry.inclusionProof !== void 0) {
    const raw = objectOf(entry.inclusionProof, `${label}.inclusionProof`);
    const checkpoint = objectOf(raw.checkpoint, `${label}.inclusionProof.checkpoint`).envelope;
    if (typeof checkpoint !== "string" || checkpoint.length > 64 * 1024)
      invalid5(`${label} checkpoint`);
    proof = Object.freeze({
      logIndex: int64(raw.logIndex, `${label}.inclusionProof.logIndex`),
      treeSize: int64(raw.treeSize, `${label}.inclusionProof.treeSize`),
      rootHash: bytesOf(raw.rootHash, `${label}.inclusionProof.rootHash`),
      hashes: Object.freeze(
        arrayOf(raw.hashes, `${label}.inclusionProof.hashes`, MAX_HASHES).map(
          (hash, position) => bytesOf(hash, `${label}.inclusionProof.hashes[${position}]`)
        )
      ),
      checkpoint
    });
  }
  return Object.freeze({
    logIndex: int64(entry.logIndex, `${label}.logIndex`),
    logId: bytesOf(objectOf(entry.logId, `${label}.logId`).keyId, `${label}.logId.keyId`),
    kind: kindVersion.kind,
    version: kindVersion.version,
    integratedTime: entry.integratedTime === void 0 ? void 0 : int64(entry.integratedTime, `${label}.integratedTime`),
    signedEntryTimestamp: promise === void 0 ? void 0 : bytesOf(promise.signedEntryTimestamp, `${label}.signedEntryTimestamp`),
    body: bytesOf(entry.canonicalizedBody, `${label}.canonicalizedBody`, 4 * 1024 * 1024),
    proof
  });
}
function parseBundle(value) {
  let document = value;
  if (value instanceof Uint8Array || ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const bytes = value;
    if (bytes.length > limits.output.bundleBytes) invalid5("the bundle is too large");
    const text2 = utf8Text(bytes);
    if (text2 === void 0) return invalid5("the bundle is not UTF-8 JSON");
    try {
      document = JSON.parse(text2);
    } catch {
      return invalid5("the bundle is not JSON");
    }
  }
  const bundle = objectOf(document, "bundle");
  if (bundle.mediaType !== BUNDLE_MEDIA_TYPE) {
    if (typeof bundle.mediaType === "string" && BUNDLE_FAMILY.test(bundle.mediaType))
      throw new BundleProblem(
        "unsupported-version",
        "unsupported-version",
        `bundle media type ${bundle.mediaType} is not supported; expected ${BUNDLE_MEDIA_TYPE}`
      );
    invalid5("bundle.mediaType is not a Sigstore bundle media type");
  }
  const material = objectOf(bundle.verificationMaterial, "bundle.verificationMaterial");
  if (bundle.dsseEnvelope !== void 0)
    unsupportedProfile("DSSE attestations are not accepted by aih-sigstore-keyless/1");
  if (material.publicKey !== void 0)
    unsupportedProfile("bare public-key signatures are not accepted by aih-sigstore-keyless/1");
  if (material.x509CertificateChain !== void 0 || material.certificate === void 0)
    unsupportedProfile("aih-sigstore-keyless/1 requires a single X.509 signing certificate");
  if (bundle.messageSignature === void 0)
    unsupportedProfile("aih-sigstore-keyless/1 requires a messageSignature");
  const signature = objectOf(bundle.messageSignature, "bundle.messageSignature");
  const messageDigest = objectOf(signature.messageDigest, "bundle.messageSignature.messageDigest");
  if (messageDigest.algorithm !== "SHA2_256")
    throw new BundleProblem(
      "refused",
      "unsupported-algorithm",
      "aih-sigstore-keyless/1 requires a SHA2_256 message digest"
    );
  const timestamps = material.timestampVerificationData ? arrayOf(
    objectOf(material.timestampVerificationData, "timestampVerificationData").rfc3161Timestamps,
    "rfc3161Timestamps",
    MAX_ENTRIES
  ).map(
    (entry, index) => bytesOf(
      objectOf(entry, "rfc3161 timestamp").signedTimestamp,
      `rfc3161Timestamps[${index}]`
    )
  ) : [];
  return Object.freeze({
    certificate: bytesOf(
      objectOf(material.certificate, "certificate").rawBytes,
      "certificate.rawBytes"
    ),
    digest: bytesOf(messageDigest.digest, "messageDigest.digest"),
    signature: bytesOf(signature.signature, "messageSignature.signature"),
    tlogEntries: Object.freeze(
      arrayOf(material.tlogEntries, "tlogEntries", MAX_ENTRIES).map(entryOf)
    ),
    timestamps: Object.freeze(timestamps)
  });
}

// src/read/sigstore/der.ts
var TAG = Object.freeze({
  boolean: 1,
  integer: 2,
  bitString: 3,
  octetString: 4,
  null: 5,
  oid: 6,
  utf8String: 12,
  printableString: 19,
  ia5String: 22,
  utcTime: 23,
  generalizedTime: 24,
  sequence: 48,
  set: 49
});
var MAX_DEPTH = 32;
function parseAt(bytes, offset, depth) {
  if (depth > MAX_DEPTH) fail("ASN.1 nesting is too deep");
  if (offset + 2 > bytes.length) fail("truncated ASN.1");
  const tag = bytes[offset];
  if ((tag & 31) === 31) fail("high ASN.1 tag numbers are not supported");
  let length = bytes[offset + 1];
  let cursor = offset + 2;
  if (length & 128) {
    const count = length & 127;
    if (count === 0 || count > 4) fail("unsupported ASN.1 length");
    if (cursor + count > bytes.length) fail("truncated ASN.1 length");
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + bytes[cursor + index];
    if (length < 128 || count > 1 && bytes[cursor] === 0) fail("non-minimal ASN.1 length");
    cursor += count;
  }
  const end = cursor + length;
  if (end > bytes.length) fail("truncated ASN.1 value");
  const value = bytes.subarray(cursor, end);
  const children = [];
  if (tag & 32) {
    let inner = 0;
    while (inner < value.length) {
      const child = parseAt(value, inner, depth + 1);
      children.push(child.node);
      inner = child.end;
    }
  }
  return {
    node: Object.freeze({ tag, raw: bytes.subarray(offset, end), value, children }),
    end
  };
}
function parseDer(bytes) {
  const { node, end } = parseAt(bytes, 0, 0);
  if (end !== bytes.length) fail("trailing bytes after ASN.1");
  return node;
}
function expectTag(node, tag, label) {
  if (node === void 0 || node.tag !== tag) return fail(`malformed ${label}`);
  return node;
}
function oidOf(node) {
  const value = expectTag(node, TAG.oid, "object identifier").value;
  if (value.length === 0) fail("empty object identifier");
  const first = value[0];
  const arcs = [
    first < 80 ? Math.floor(first / 40) : 2,
    first < 80 ? first % 40 : first - 80
  ];
  let current = 0;
  for (let index = 1; index < value.length; index += 1) {
    const byte = value[index];
    current = current * 128 + (byte & 127);
    if (current > Number.MAX_SAFE_INTEGER) fail("object identifier arc is too large");
    if ((byte & 128) === 0) {
      arcs.push(current);
      current = 0;
    }
  }
  if (value[value.length - 1] & 128) fail("truncated object identifier");
  return arcs.join(".");
}
function integerBytes(node) {
  const value = expectTag(node, TAG.integer, "integer").value;
  if (value.length === 0) fail("empty integer");
  return value[0] === 0 && value.length > 1 ? value.subarray(1) : value;
}
function smallInteger(node) {
  const value = integerBytes(node);
  if (value.length > 6) fail("integer is too large");
  let out = 0;
  for (const byte of value) out = out * 256 + byte;
  return out;
}
function bitStringBytes(node) {
  const value = expectTag(node, TAG.bitString, "bit string").value;
  if (value.length === 0 || value[0] !== 0) fail("bit string has unused bits");
  return value.subarray(1);
}
var TIME = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/;
function timeOf(node) {
  if (node === void 0 || node.tag !== TAG.utcTime && node.tag !== TAG.generalizedTime)
    return fail("malformed time");
  const text2 = String.fromCharCode(...node.value);
  const match = TIME.exec(text2);
  if (match === null) return fail("malformed time");
  const [, y, mo, d, h, mi, s, fraction] = match;
  let year = Number(y);
  if (node.tag === TAG.utcTime) {
    if (y.length !== 2 || fraction !== void 0) fail("malformed UTCTime");
    year += year >= 50 ? 1900 : 2e3;
  } else if (y.length !== 4) fail("malformed GeneralizedTime");
  const millis = fraction === void 0 ? 0 : Math.floor(Number(`0.${fraction}`) * 1e3);
  const time = Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis);
  const check = new Date(time);
  if (check.getUTCDate() !== Number(d) || check.getUTCMonth() !== Number(mo) - 1)
    fail("invalid date");
  return time;
}
function encode(tag, ...content) {
  const value = concat2(...content);
  const length = value.length;
  let header;
  if (length < 128) header = [tag, length];
  else if (length < 256) header = [tag, 129, length];
  else if (length < 65536) header = [tag, 130, length >> 8, length & 255];
  else header = [tag, 131, length >> 16, length >> 8 & 255, length & 255];
  return concat2(Uint8Array.from(header), value);
}

// src/read/sigstore/crypto.ts
var OID = Object.freeze({
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ed25519: "1.3.101.112",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4"
});
var unsupported = (detail) => {
  throw new EvidenceError("unsupported-algorithm", detail);
};
var subtle = webCryptoSubtle;
var view = (bytes) => bytes;
async function digest2(name, bytes) {
  return new Uint8Array(await subtle().digest(name, view(bytes)));
}
var sha2562 = (bytes) => digest2("SHA-256", bytes);
function hashOfOid(oid) {
  if (oid === OID.sha256) return "SHA-256";
  if (oid === OID.sha384) return "SHA-384";
  if (oid === OID.sha512) return "SHA-512";
  return void 0;
}
var ecPublicKeyOid = OID.ecPublicKey;
function ecdsaHashOfOid(oid) {
  if (oid === OID.ecdsaSha256) return "SHA-256";
  if (oid === OID.ecdsaSha384) return "SHA-384";
  if (oid === OID.ecdsaSha512) return "SHA-512";
  return void 0;
}
function publicKeyOf(spki) {
  const root = expectTag(parseDer(spki), TAG.sequence, "public key");
  const algorithm = expectTag(root.children[0], TAG.sequence, "public key algorithm");
  const algorithmOid = oidOf(algorithm.children[0]);
  bitStringBytes(root.children[1]);
  if (algorithmOid === OID.ed25519) return Object.freeze({ kind: "ed25519", spki });
  if (algorithmOid !== OID.ecPublicKey) return unsupported(`public key algorithm ${algorithmOid}`);
  const curve = oidOf(algorithm.children[1]);
  if (curve === OID.p256) return Object.freeze({ kind: "ecdsa-p256", spki });
  if (curve === OID.p384) return Object.freeze({ kind: "ecdsa-p384", spki });
  return unsupported(`elliptic curve ${curve}`);
}
function rawEcdsaSignature(der, size) {
  const node = expectTag(parseDer(der), TAG.sequence, "ECDSA signature");
  if (node.children.length !== 2) fail("malformed ECDSA signature");
  const out = new Uint8Array(size * 2);
  for (const [index, child] of node.children.entries()) {
    const value = integerBytes(child);
    if (value.length > size) fail("malformed ECDSA signature");
    out.set(value, index * size + (size - value.length));
  }
  return out;
}
async function verifySignature(key, hash, signature, data) {
  if (key.kind === "ed25519") {
    if (hash !== void 0) unsupported("Ed25519 takes no separate hash");
    if (signature.length !== 64) return false;
    const imported2 = await subtle().importKey("spki", view(key.spki), { name: "Ed25519" }, false, [
      "verify"
    ]);
    return subtle().verify({ name: "Ed25519" }, imported2, view(signature), view(data));
  }
  if (hash === void 0) unsupported(`ECDSA ${key.kind} needs a hash`);
  const size = key.kind === "ecdsa-p256" ? 32 : 48;
  let raw;
  try {
    raw = rawEcdsaSignature(signature, size);
  } catch {
    return false;
  }
  const imported = await subtle().importKey(
    "spki",
    view(key.spki),
    { name: "ECDSA", namedCurve: key.kind === "ecdsa-p256" ? "P-256" : "P-384" },
    false,
    ["verify"]
  );
  return subtle().verify(
    { name: "ECDSA", hash },
    imported,
    view(raw),
    view(data)
  );
}

// src/read/sigstore/x509.ts
var EXTENSION = Object.freeze({
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  sct: "1.3.6.1.4.1.11129.2.4.2",
  fulcioIssuerV1: "1.3.6.1.4.1.57264.1.1",
  fulcioIssuerV2: "1.3.6.1.4.1.57264.1.8"
});
var EKU = Object.freeze({
  codeSigning: "1.3.6.1.5.5.7.3.3",
  timeStamping: "1.3.6.1.5.5.7.3.8"
});
function parseCertificate(raw) {
  const root = expectTag(parseDer(raw), TAG.sequence, "certificate");
  if (root.children.length !== 3) fail("malformed certificate");
  const tbs = expectTag(root.children[0], TAG.sequence, "TBS certificate");
  const algorithm = expectTag(root.children[1], TAG.sequence, "certificate signature algorithm");
  const signatureOid = oidOf(algorithm.children[0]);
  const signatureHash = ecdsaHashOfOid(signatureOid);
  if (signatureHash === void 0)
    throw new EvidenceError(
      "unsupported-algorithm",
      `certificate signature algorithm ${signatureOid}`
    );
  const signature = bitStringBytes(root.children[2]);
  const fields = [...tbs.children];
  let index = 0;
  if (fields[0]?.tag === 160) {
    if (smallInteger(fields[0].children[0]) !== 2) fail("only X.509 v3 certificates are supported");
    index += 1;
  } else fail("only X.509 v3 certificates are supported");
  const serial = integerBytes(fields[index++]);
  const innerAlgorithm = expectTag(fields[index++], TAG.sequence, "TBS signature algorithm");
  if (!equalBytes(innerAlgorithm.raw, algorithm.raw))
    fail("certificate signature algorithms differ");
  const issuer = expectTag(fields[index++], TAG.sequence, "issuer").raw;
  const validity = expectTag(fields[index++], TAG.sequence, "validity");
  const subject = expectTag(fields[index++], TAG.sequence, "subject").raw;
  const spki = expectTag(fields[index++], TAG.sequence, "subject public key").raw;
  const extensions = [];
  for (; index < fields.length; index += 1) {
    const field2 = fields[index];
    if (field2.tag === 129 || field2.tag === 130) continue;
    if (field2.tag !== 163) fail("malformed TBS certificate");
    const list = expectTag(field2.children[0], TAG.sequence, "extensions");
    for (const entry of list.children) {
      const parts = expectTag(entry, TAG.sequence, "extension").children;
      const oid = oidOf(parts[0]);
      const critical = parts.length === 3;
      if (critical && (parts[1]?.tag !== TAG.boolean || parts[1].value[0] !== 255))
        fail("malformed extension");
      const value = expectTag(parts[parts.length - 1], TAG.octetString, "extension value").value;
      if (extensions.some((existing) => existing.oid === oid))
        fail("duplicate certificate extension");
      extensions.push(Object.freeze({ oid, critical, value, node: entry }));
    }
  }
  const key = publicKeyOf(spki);
  return Object.freeze({
    raw,
    tbs,
    serial,
    issuer,
    subject,
    notBefore: timeOf(validity.children[0]),
    notAfter: timeOf(validity.children[1]),
    key,
    spki,
    signatureHash,
    signature,
    extensions: Object.freeze(extensions)
  });
}
var extensionOf = (certificate, oid) => certificate.extensions.find((extension) => extension.oid === oid);
function isCa(certificate) {
  const extension = extensionOf(certificate, EXTENSION.basicConstraints);
  if (extension === void 0) return { ca: false };
  const node = expectTag(parseDer(extension.value), TAG.sequence, "basic constraints");
  const [first, second] = node.children;
  const ca = first?.tag === TAG.boolean && first.value[0] === 255;
  const lengthNode = first?.tag === TAG.integer ? first : second;
  return lengthNode === void 0 ? { ca } : { ca, pathLength: smallInteger(lengthNode) };
}
function keyUsage(certificate) {
  const extension = extensionOf(certificate, EXTENSION.keyUsage);
  if (extension === void 0) return void 0;
  const node = expectTag(parseDer(extension.value), TAG.bitString, "key usage");
  let bits = 0;
  for (let index = 1; index < node.value.length && index < 3; index += 1) {
    const byte = node.value[index];
    for (let bit = 0; bit < 8; bit += 1)
      if (byte & 128 >> bit) bits |= 1 << (index - 1) * 8 + bit;
  }
  return bits;
}
var KEY_USAGE = Object.freeze({ digitalSignature: 1, keyCertSign: 1 << 5 });
function extendedKeyUsages(certificate) {
  const extension = extensionOf(certificate, EXTENSION.extKeyUsage);
  if (extension === void 0) return [];
  return expectTag(parseDer(extension.value), TAG.sequence, "extended key usage").children.map(
    oidOf
  );
}
function subjectAlternativeName(certificate) {
  const extension = extensionOf(certificate, EXTENSION.subjectAltName);
  if (extension === void 0) return void 0;
  const names = expectTag(
    parseDer(extension.value),
    TAG.sequence,
    "subject alternative name"
  ).children;
  const values = names.filter((name) => name.tag === 134 || name.tag === 129).map((name) => utf8Text(name.value));
  if (values.length !== 1 || values[0] === void 0) return void 0;
  return values[0];
}
function fulcioText(certificate, oid) {
  const extension = extensionOf(certificate, oid);
  if (extension === void 0) return void 0;
  try {
    const node = parseDer(extension.value);
    if (node.tag === TAG.utf8String) return utf8Text(node.value);
  } catch {
  }
  return utf8Text(extension.value);
}
function oidIssuer(certificate) {
  if (extensionOf(certificate, EXTENSION.fulcioIssuerV2) !== void 0) {
    const node = parseDer(extensionOf(certificate, EXTENSION.fulcioIssuerV2).value);
    return node.tag === TAG.utf8String ? utf8Text(node.value) : void 0;
  }
  const v1 = extensionOf(certificate, EXTENSION.fulcioIssuerV1);
  return v1 === void 0 ? void 0 : utf8Text(v1.value);
}
async function issuedBy(certificate, issuer) {
  if (!equalBytes(certificate.issuer, issuer.subject)) return false;
  return verifySignature(
    issuer.key,
    certificate.signatureHash,
    certificate.signature,
    certificate.tbs.raw
  );
}
function precertificateTbs(certificate) {
  const parts = [];
  for (const field2 of certificate.tbs.children) {
    if (field2.tag !== 163) {
      parts.push(field2.raw);
      continue;
    }
    const list = field2.children[0];
    const kept = list.children.filter((entry) => oidOf(entry.children[0]) !== EXTENSION.sct);
    parts.push(encode(163, encode(TAG.sequence, ...kept.map((entry) => entry.raw))));
  }
  return encode(TAG.sequence, ...parts);
}

// src/read/sigstore/trust.ts
var TRUSTED_ROOT_MEDIA_TYPES = Object.freeze([
  "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
  "application/vnd.dev.sigstore.trustedroot.v0.2+json"
]);
var TrustProblem = class extends Error {
  constructor(status, reason, detail) {
    super(detail);
    this.status = status;
    this.reason = reason;
  }
  status;
  reason;
};
var malformed = (detail) => {
  throw new TrustProblem("invalid", "trusted-root", detail);
};
var MAX_ENTRIES2 = 64;
var MAX_CHAIN = 8;
var RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
var objectOf2 = (value, label) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : malformed(`${label} must be an object`);
function arrayOf2(value, label) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) return malformed(`${label} must be an array`);
  if (value.length > MAX_ENTRIES2) return malformed(`${label} has too many entries`);
  return value;
}
function timeOf2(value, label) {
  if (typeof value !== "string" || !RFC3339.test(value))
    return malformed(`${label} must be an RFC 3339 time`);
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : malformed(`${label} must be an RFC 3339 time`);
}
function validForOf(value, label) {
  if (value === void 0) return Object.freeze({ start: 0, end: Number.POSITIVE_INFINITY });
  const range = objectOf2(value, label);
  const start = range.start === void 0 ? 0 : timeOf2(range.start, `${label}.start`);
  const end = range.end === void 0 ? Number.POSITIVE_INFINITY : timeOf2(range.end, `${label}.end`);
  if (end < start) malformed(`${label} ends before it starts`);
  return Object.freeze({ start, end });
}
function bytesOf2(value, label) {
  return base64Decode(value, 1024 * 1024) ?? malformed(`${label} must be base64`);
}
var SUPPORTED_LOG_KEYS = /* @__PURE__ */ new Set(["PKIX_ECDSA_P256_SHA_256", "PKIX_ED25519"]);
function logKeys(value, label) {
  const out = [];
  for (const [index, entry] of arrayOf2(value, label).entries()) {
    const log = objectOf2(entry, `${label}[${index}]`);
    const publicKey = objectOf2(log.publicKey, `${label}[${index}].publicKey`);
    const logId = bytesOf2(
      objectOf2(log.logId, `${label}[${index}].logId`).keyId,
      `${label}[${index}].logId.keyId`
    );
    if (logId.length !== 32) malformed(`${label}[${index}].logId.keyId must be 32 bytes`);
    const baseUrl = typeof log.baseUrl === "string" ? log.baseUrl : malformed(`${label}[${index}].baseUrl`);
    const validFor = validForOf(publicKey.validFor, `${label}[${index}].publicKey.validFor`);
    if (typeof publicKey.keyDetails !== "string")
      malformed(`${label}[${index}].publicKey.keyDetails`);
    const raw = bytesOf2(publicKey.rawBytes, `${label}[${index}].publicKey.rawBytes`);
    if (!SUPPORTED_LOG_KEYS.has(publicKey.keyDetails)) continue;
    let key;
    try {
      key = publicKeyOf(raw);
    } catch (error) {
      if (error instanceof EvidenceError && error.reason === "unsupported-algorithm") continue;
      return malformed(`${label}[${index}].publicKey.rawBytes is not a public key`);
    }
    const expected = publicKey.keyDetails === "PKIX_ED25519" ? "ed25519" : "ecdsa-p256";
    if (key.kind !== expected)
      malformed(`${label}[${index}].publicKey does not match its keyDetails`);
    out.push(Object.freeze({ baseUrl, logId, key, validFor }));
  }
  return out;
}
function authorities(value, label) {
  const out = [];
  for (const [index, entry] of arrayOf2(value, label).entries()) {
    const authority = objectOf2(entry, `${label}[${index}]`);
    const chain = arrayOf2(
      objectOf2(authority.certChain, `${label}[${index}].certChain`).certificates,
      "certificates"
    );
    if (chain.length === 0 || chain.length > MAX_CHAIN)
      malformed(`${label}[${index}] needs 1-${MAX_CHAIN} certificates`);
    const validFor = validForOf(authority.validFor, `${label}[${index}].validFor`);
    const certificates = [];
    let usable = true;
    for (const [position, certificate] of chain.entries()) {
      const raw = bytesOf2(
        objectOf2(certificate, "certificate").rawBytes,
        `${label}[${index}] certificate ${position}`
      );
      try {
        certificates.push(parseCertificate(raw));
      } catch (error) {
        if (error instanceof EvidenceError && error.reason === "unsupported-algorithm") {
          usable = false;
          continue;
        }
        return malformed(`${label}[${index}] certificate ${position} is not a certificate`);
      }
    }
    if (usable) out.push(Object.freeze({ certificates: Object.freeze(certificates), validFor }));
  }
  return out;
}
function parseTrustedRoot(value) {
  const root = objectOf2(value, "trustedRoot");
  if (typeof root.mediaType !== "string" || !TRUSTED_ROOT_MEDIA_TYPES.includes(root.mediaType))
    malformed("trustedRoot.mediaType is not a supported Sigstore trusted-root media type");
  const material = Object.freeze({
    certificateAuthorities: Object.freeze(
      authorities(root.certificateAuthorities, "certificateAuthorities")
    ),
    tlogs: Object.freeze(logKeys(root.tlogs, "tlogs")),
    ctlogs: Object.freeze(logKeys(root.ctlogs, "ctlogs")),
    timestampAuthorities: Object.freeze(
      authorities(root.timestampAuthorities, "timestampAuthorities")
    )
  });
  if (material.certificateAuthorities.length === 0 || material.tlogs.length === 0 || material.ctlogs.length === 0)
    throw new TrustProblem(
      "refused",
      "trust-data-unavailable",
      "the selected trust material has no usable certificate authority, transparency log or certificate-transparency log"
    );
  return material;
}
var covers = (range, time) => range.start <= time && time <= range.end;

// src/read/sigstore/evidence.ts
var validAt = (certificate, time) => certificate.notBefore <= time && time <= certificate.notAfter;
async function verifyChain(leaf, authorities2, time) {
  for (const authority of authorities2) {
    if (!covers(authority.validFor, time)) continue;
    const path = await chainWithin(leaf, authority.certificates);
    if (path === void 0) continue;
    if (!path.every((certificate) => validAt(certificate, time))) continue;
    return path;
  }
  return fail(
    "the certificate does not chain to selected trust material valid at the signing time"
  );
}
async function chainWithin(leaf, trusted) {
  const path = [leaf];
  let current = leaf;
  for (let depth = 0; depth <= trusted.length; depth += 1) {
    const selfSigned = equalBytes(current.subject, current.issuer);
    if (selfSigned && current !== leaf) {
      if (!await issuedBy(current, current)) return void 0;
      return checkPath(path) ? path : void 0;
    }
    let next;
    for (const candidate of trusted)
      if (candidate !== current && !equalBytes(candidate.raw, current.raw) && await issuedBy(current, candidate)) {
        next = candidate;
        break;
      }
    if (next === void 0) return void 0;
    path.push(next);
    current = next;
  }
  return void 0;
}
function checkPath(path) {
  for (let index = 1; index < path.length; index += 1) {
    const certificate = path[index];
    const constraints = isCa(certificate);
    if (!constraints.ca) return false;
    const usage = keyUsage(certificate);
    if (usage !== void 0 && (usage & KEY_USAGE.keyCertSign) === 0) return false;
    if (constraints.pathLength !== void 0 && constraints.pathLength < index - 1) return false;
  }
  return true;
}
function readScts(leaf) {
  const extension = extensionOf(leaf, EXTENSION.sct);
  if (extension === void 0) return [];
  const list = expectTag(parseDer(extension.value), TAG.octetString, "SCT list").value;
  const u16 = (offset2) => list[offset2] << 8 | list[offset2 + 1];
  if (list.length < 2 || u16(0) !== list.length - 2) fail("malformed SCT list");
  const out = [];
  let offset = 2;
  while (offset < list.length) {
    if (offset + 2 > list.length) fail("malformed SCT list");
    const length = u16(offset);
    const end = offset + 2 + length;
    if (end > list.length || length < 47) fail("malformed SCT");
    const sct = list.subarray(offset + 2, end);
    const extensionsLength = sct[41] << 8 | sct[42];
    const after = 43 + extensionsLength;
    if (after + 4 > sct.length) fail("malformed SCT");
    const signatureLength = sct[after + 2] << 8 | sct[after + 3];
    if (after + 4 + signatureLength !== sct.length) fail("malformed SCT");
    const hashCode = sct[after];
    out.push({
      version: sct[0],
      logId: sct.subarray(1, 33),
      timestamp: sct.subarray(33, 41),
      extensions: sct.subarray(43, after),
      hash: hashCode === 4 ? "SHA-256" : hashCode === 5 ? "SHA-384" : hashCode === 6 ? "SHA-512" : void 0,
      signatureAlgorithm: sct[after + 1],
      signature: sct.subarray(after + 4)
    });
    offset = end;
  }
  return out;
}
async function verifyScts(leaf, issuer, ctlogs) {
  const scts = readScts(leaf);
  if (scts.length === 0) return 0;
  const tbs = precertificateTbs(leaf);
  const length = Uint8Array.of(
    tbs.length >> 16 & 255,
    tbs.length >> 8 & 255,
    tbs.length & 255
  );
  const preCert = concat2(await sha2562(issuer.spki), length, tbs);
  let verified = 0;
  for (const sct of scts) {
    const time = Number(uintOf(sct.timestamp));
    const logs = ctlogs.filter(
      (log) => equalBytes(log.logId, sct.logId) && covers(log.validFor, time)
    );
    if (logs.length === 0) continue;
    if (sct.version !== 0 || sct.signatureAlgorithm !== 3 || sct.hash === void 0)
      throw new EvidenceError("unsupported-algorithm", "unsupported SCT version or algorithm");
    const extensionsLength = Uint8Array.of(
      sct.extensions.length >> 8,
      sct.extensions.length & 255
    );
    const signed = concat2(
      Uint8Array.of(sct.version, 0),
      sct.timestamp,
      Uint8Array.of(0, 1),
      preCert,
      extensionsLength,
      sct.extensions
    );
    let ok = false;
    for (const log of logs)
      if (await verifySignature(log.key, sct.hash, sct.signature, signed)) ok = true;
    if (!ok) fail("an SCT from a selected log does not verify");
    verified += 1;
  }
  return verified;
}
var hashLeaf = (body) => sha2562(concat2(Uint8Array.of(0), body));
var hashChildren = (left, right) => sha2562(concat2(Uint8Array.of(1), left, right));
var bitLength = (value) => value === 0n ? 0 : value.toString(2).length;
var onesCount = (value) => [...value.toString(2)].filter((bit) => bit === "1").length;
async function merkleRoot(body, index, size, hashes) {
  if (index < 0n || index >= size) return fail("inclusion proof index is outside the tree");
  const inner = bitLength(index ^ size - 1n);
  const border = onesCount(index >> BigInt(inner));
  if (hashes.length !== inner + border)
    return fail("inclusion proof has the wrong number of hashes");
  let node = await hashLeaf(body);
  for (const [position, hash] of hashes.entries()) {
    if (hash.length !== 32) fail("inclusion proof hash is not 32 bytes");
    if (position < inner)
      node = index >> BigInt(position) & 1n ? await hashChildren(hash, node) : await hashChildren(node, hash);
    else node = await hashChildren(hash, node);
  }
  return node;
}
async function verifyCheckpoint(envelope, log) {
  const split = envelope.indexOf("\n\n");
  if (split < 0) return fail("checkpoint has no signature separator");
  const note = envelope.slice(0, split + 1);
  const lines = note.slice(0, -1).split("\n");
  if (lines.length < 3) return fail("checkpoint has too few lines");
  if (!/^(0|[1-9]\d{0,18})$/.test(lines[1])) return fail("checkpoint size is malformed");
  const root = base64Decode(lines[2]);
  if (root === void 0 || root.length !== 32) return fail("checkpoint root is malformed");
  const signatures = envelope.slice(split + 2);
  const pattern = /^— (\S+) (\S+)\n/gmu;
  let host;
  try {
    host = new URL(log.baseUrl).host;
  } catch {
    host = log.baseUrl;
  }
  let verified = false;
  for (const match of signatures.matchAll(pattern)) {
    const name = match[1];
    const bytes = base64Decode(match[2]);
    if (bytes === void 0 || bytes.length < 5) continue;
    if (!equalBytes(bytes.subarray(0, 4), log.logId.subarray(0, 4))) continue;
    if (name !== host && !log.baseUrl.includes(name)) continue;
    const hash = log.key.kind === "ed25519" ? void 0 : "SHA-256";
    if (await verifySignature(log.key, hash, bytes.subarray(4), utf8(note))) verified = true;
  }
  if (!verified) return fail("checkpoint signature does not verify with the selected log key");
  return { origin: lines[0], size: BigInt(lines[1]), root };
}
function jsonOf(bytes) {
  const text2 = utf8Text(bytes);
  if (text2 === void 0) return fail("log entry body is not UTF-8");
  let value;
  try {
    value = JSON.parse(text2);
  } catch {
    return fail("log entry body is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail("log entry body is not an object");
  return value;
}
var field = (value, ...path) => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return void 0;
    current = current[key];
  }
  return current;
};
function verifyBody(entry, bundleDigest, certificate, signature) {
  const body = jsonOf(entry.body);
  if (entry.kind !== "hashedrekord")
    fail(`log entry kind ${entry.kind} does not bind a message signature`);
  if (body.kind !== entry.kind || body.apiVersion !== entry.version)
    fail("log entry kind/version mismatch");
  const same = (value, expected) => value !== void 0 && equalBytes(value, expected);
  if (entry.version === "0.0.1") {
    if (field(body, "spec", "data", "hash", "algorithm") !== "sha256")
      fail("log entry digest algorithm");
    if (!same(hexDecode(field(body, "spec", "data", "hash", "value")), bundleDigest))
      fail("log entry digest differs");
    if (!same(base64Decode(field(body, "spec", "signature", "content")), signature))
      fail("log entry signature differs");
    const key = base64Decode(field(body, "spec", "signature", "publicKey", "content"));
    const pem = key === void 0 ? void 0 : utf8Text(key);
    const der = pem === void 0 ? void 0 : pemCertificate(pem);
    if (!same(der, certificate)) fail("log entry certificate differs");
    return;
  }
  if (entry.version === "0.0.2") {
    const spec = field(body, "spec", "hashedRekordV002");
    if (field(spec, "data", "algorithm") !== "SHA2_256") fail("log entry digest algorithm");
    if (!same(base64Decode(field(spec, "data", "digest")), bundleDigest))
      fail("log entry digest differs");
    if (!same(base64Decode(field(spec, "signature", "content")), signature))
      fail("log entry signature differs");
    const details = field(spec, "signature", "verifier", "keyDetails");
    if (details !== void 0 && details !== "PKIX_ECDSA_P256_SHA_256")
      fail("log entry key details differ");
    if (!same(
      base64Decode(field(spec, "signature", "verifier", "x509Certificate", "rawBytes")),
      certificate
    ))
      fail("log entry certificate differs");
    return;
  }
  fail(`hashedrekord version ${entry.version} is not supported`);
}
async function verifyInclusion(entry, tlogs) {
  const candidates = tlogs.filter((log) => equalBytes(log.logId, entry.logId));
  if (candidates.length === 0) return fail("the log entry is not from a selected transparency log");
  if (entry.proof === void 0) return fail("the log entry has no inclusion proof");
  const proof = entry.proof;
  for (const log of candidates) {
    try {
      const checkpoint = await verifyCheckpoint(proof.checkpoint, log);
      if (checkpoint.size !== proof.treeSize || !equalBytes(checkpoint.root, proof.rootHash))
        fail("checkpoint does not match the inclusion proof");
      const root = await merkleRoot(entry.body, proof.logIndex, proof.treeSize, proof.hashes);
      if (!equalBytes(root, proof.rootHash))
        fail("inclusion proof does not reproduce the root hash");
      let integratedTime;
      if (entry.signedEntryTimestamp !== void 0) {
        if (entry.integratedTime === void 0)
          fail("signed entry timestamp without integrated time");
        const time = entry.integratedTime;
        if (time > 253402300799n) fail("integrated time is out of range");
        if (entry.logIndex > BigInt(Number.MAX_SAFE_INTEGER)) fail("log index is out of range");
        const payload = `{"body":${JSON.stringify(base64Encode(entry.body))},"integratedTime":${time},"logID":${JSON.stringify(hexOf(entry.logId))},"logIndex":${entry.logIndex}}`;
        const hash = log.key.kind === "ed25519" ? void 0 : "SHA-256";
        if (!await verifySignature(log.key, hash, entry.signedEntryTimestamp, utf8(payload)))
          fail("signed entry timestamp does not verify");
        integratedTime = Number(time) * 1e3;
        if (!covers(log.validFor, integratedTime)) fail("log key not valid at the integrated time");
      }
      return { log, integratedTime };
    } catch (error) {
      if (candidates.length === 1 || !(error instanceof EvidenceError) || error.reason !== "invalid-signature")
        throw error;
    }
  }
  return fail("the log entry does not verify with a selected log key");
}
var OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
var OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
var OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
var OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
async function verifyTimestamp(token, data, authorities2) {
  const response = expectTag(parseDer(token), TAG.sequence, "timestamp response");
  const status = smallInteger(
    expectTag(response.children[0], TAG.sequence, "PKIStatusInfo").children[0]
  );
  if (status !== 0 && status !== 1) fail("timestamp was not granted");
  const contentInfo = expectTag(response.children[1], TAG.sequence, "timestamp token");
  if (oidOf(contentInfo.children[0]) !== OID_SIGNED_DATA) fail("timestamp token is not SignedData");
  const signedData = expectTag(
    expectTag(contentInfo.children[1], 160, "SignedData").children[0],
    TAG.sequence,
    "SignedData"
  );
  const parts = signedData.children;
  const encapsulated = expectTag(parts[2], TAG.sequence, "encapsulated content");
  if (oidOf(encapsulated.children[0]) !== OID_TST_INFO) fail("timestamp content is not TSTInfo");
  const tstInfoBytes = expectTag(
    expectTag(encapsulated.children[1], 160, "TSTInfo").children[0],
    TAG.octetString,
    "TSTInfo"
  ).value;
  const signerInfos = expectTag(parts[parts.length - 1], TAG.set, "signer infos");
  if (signerInfos.children.length !== 1) fail("timestamp must have exactly one signer");
  const signerInfo = expectTag(signerInfos.children[0], TAG.sequence, "signer info").children;
  const sid = expectTag(signerInfo[1], TAG.sequence, "signer identifier");
  const sidIssuer = expectTag(sid.children[0], TAG.sequence, "signer issuer").raw;
  const sidSerial = integerBytes(sid.children[1]);
  const digestOid = oidOf(expectTag(signerInfo[2], TAG.sequence, "digest algorithm").children[0]);
  const signerHash = hashOfOid(digestOid);
  if (signerHash === void 0)
    throw new EvidenceError("unsupported-algorithm", `timestamp digest ${digestOid}`);
  const signedAttributes = expectTag(signerInfo[3], 160, "signed attributes");
  const signatureOid = oidOf(
    expectTag(signerInfo[4], TAG.sequence, "signature algorithm").children[0]
  );
  const signatureHash = signatureOid === ecPublicKeyOid ? signerHash : ecdsaHashOfOid(signatureOid);
  if (signatureHash === void 0)
    throw new EvidenceError(
      "unsupported-algorithm",
      `timestamp signature algorithm ${signatureOid}`
    );
  const signatureValue = expectTag(signerInfo[5], TAG.octetString, "signature").value;
  const attribute = (oid) => signedAttributes.children.find((entry) => oidOf(entry.children[0]) === oid)?.children[1]?.children[0];
  if (oidOf(attribute(OID_CONTENT_TYPE)) !== OID_TST_INFO) fail("timestamp content-type attribute");
  const messageDigest = expectTag(
    attribute(OID_MESSAGE_DIGEST),
    TAG.octetString,
    "message digest"
  ).value;
  if (!equalBytes(messageDigest, await digest2(signerHash, tstInfoBytes)))
    fail("timestamp message digest differs");
  const tstInfo = expectTag(parseDer(tstInfoBytes), TAG.sequence, "TSTInfo").children;
  const imprint = expectTag(tstInfo[2], TAG.sequence, "message imprint");
  const imprintOid = oidOf(
    expectTag(imprint.children[0], TAG.sequence, "imprint algorithm").children[0]
  );
  const imprintHash = hashOfOid(imprintOid);
  if (imprintHash === void 0)
    throw new EvidenceError("unsupported-algorithm", `timestamp imprint ${imprintOid}`);
  const imprintValue = expectTag(imprint.children[1], TAG.octetString, "imprint").value;
  if (!equalBytes(imprintValue, await digest2(imprintHash, data)))
    fail("timestamp does not cover this signature");
  const genTime = timeOf(expectTag(tstInfo[4], TAG.generalizedTime, "genTime"));
  const signed = new Uint8Array(signedAttributes.raw);
  signed[0] = TAG.set;
  for (const authority of authorities2) {
    const [signer, ...rest] = authority.certificates;
    if (signer === void 0 || !equalBytes(signer.serial, sidSerial) || !equalBytes(signer.issuer, sidIssuer))
      continue;
    if (!covers(authority.validFor, genTime)) continue;
    if (!extendedKeyUsages(signer).includes(EKU.timeStamping)) continue;
    const path = rest.length === 0 ? void 0 : await chainWithin(signer, rest);
    if (path === void 0 || !path.every((certificate) => validAt(certificate, genTime))) continue;
    if (await verifySignature(signer.key, signatureHash, signatureValue, signed)) return genTime;
  }
  return fail("timestamp is not signed by selected timestamp-authority material");
}
async function verifyKeyless(bytes, bundle, trust) {
  const leaf = parseCertificate(bundle.certificate);
  if (leaf.key.kind !== "ecdsa-p256")
    throw new EvidenceError("unsupported-algorithm", "the signing key must be ECDSA P-256");
  const actual = await sha2562(bytes);
  if (!equalBytes(actual, bundle.digest))
    fail("the signed digest does not match the supplied bytes");
  if (!await verifySignature(leaf.key, "SHA-256", bundle.signature, bytes))
    fail("the signature does not verify over the supplied bytes");
  if (bundle.tlogEntries.length === 0) fail("the bundle has no transparency-log entry");
  const times = [];
  const logs = [];
  for (const entry of bundle.tlogEntries) {
    verifyBody(entry, bundle.digest, bundle.certificate, bundle.signature);
    const { log, integratedTime } = await verifyInclusion(entry, trust.tlogs);
    logs.push(log);
    if (integratedTime !== void 0) times.push(integratedTime);
  }
  for (const token of bundle.timestamps)
    times.push(await verifyTimestamp(token, bundle.signature, trust.timestampAuthorities));
  if (times.length === 0) fail("no authenticated signing time");
  for (const log of logs)
    if (!times.every((time) => covers(log.validFor, time)))
      fail("the log key is not valid at the signing time");
  let issuer;
  for (const time of times) {
    if (!validAt(leaf, time))
      fail("the signing time is outside the signing certificate's validity");
    const path = await verifyChain(leaf, trust.certificateAuthorities, time);
    issuer = path[1];
  }
  if (issuer === void 0) return fail("the signing certificate has no issuer");
  if (await verifyScts(leaf, issuer, trust.ctlogs) < 1)
    fail("no valid certificate-transparency SCT");
  if (!extendedKeyUsages(leaf).includes(EKU.codeSigning))
    fail("the signing certificate lacks code signing usage");
  const usage = keyUsage(leaf);
  if (usage !== void 0 && (usage & KEY_USAGE.digitalSignature) === 0)
    fail("the signing certificate lacks digital signature usage");
  const oidcIssuer = oidIssuer(leaf);
  const subject = subjectAlternativeName(leaf);
  if (oidcIssuer === void 0 || subject === void 0)
    fail("the signing certificate has no Fulcio identity");
  return Object.freeze({
    issuer: oidcIssuer,
    subject,
    certificate: leaf,
    signedAt: Object.freeze([...times])
  });
}

// src/read/verify-summary.ts
var notVerified = (problem2) => Object.freeze({
  ...problem2,
  verified: false,
  withdrawn: false,
  signer: null,
  summary: null
});
var problem = (status, reason, detail) => Object.freeze({ status, reason, detail });
var shipped;
function selectTrust(options) {
  try {
    if (options.trustedRoot === void 0) {
      shipped ??= parseTrustedRoot(JSON.parse(sigstoreTrustedRootText));
      return shipped;
    }
    if (options.trustedRoot === null)
      return problem("refused", "trust-data-unavailable", "no trust material was selected");
    let value = options.trustedRoot;
    if (isBytes(value)) {
      const parsed = parseJsonBytes(value, "trustedRoot", limits.output.bundleBytes);
      if (!parsed.ok)
        return problem("invalid", "trusted-root", "trustedRoot is not strict UTF-8 JSON");
      value = parsed.value;
    }
    return parseTrustedRoot(value);
  } catch (error) {
    if (error instanceof TrustProblem) return problem(error.status, error.reason, error.message);
    return problem(
      "refused",
      "trust-data-unavailable",
      "the selected trust material could not be read"
    );
  }
}
function checkSigners(value) {
  if (value === void 0) return defaultSigners;
  const bad = problem(
    "invalid",
    "allowedSigners",
    "allowedSigners must be an array of { identity, issuer, subject, extensions? }"
  );
  if (!Array.isArray(value) || value.length > 256) return bad;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return bad;
    const { identity, issuer, subject, extensions } = entry;
    if (typeof identity !== "string" || typeof issuer !== "string" || typeof subject !== "string")
      return bad;
    if (issuer.length === 0 || subject.length === 0) return bad;
    if (extensions !== void 0) {
      if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions))
        return bad;
      for (const [oid, text2] of Object.entries(extensions))
        if (!/^\d+(\.\d+)+$/.test(oid) || typeof text2 !== "string") return bad;
    }
  }
  return value;
}
var matches = (signer, allowed) => signer.issuer === allowed.issuer && signer.subject === allowed.subject && Object.entries(allowed.extensions ?? {}).every(
  ([oid, text2]) => fulcioText(signer.certificate, oid) === text2
);
async function authenticate(bytes, bundleInput, trust) {
  let bundle;
  try {
    bundle = parseBundle(bundleInput);
  } catch (error) {
    if (error instanceof BundleProblem)
      return { ok: false, problem: problem(error.status, error.reason, error.message) };
    return { ok: false, problem: problem("invalid", "bundle", "the bundle could not be read") };
  }
  try {
    return { ok: true, signer: await verifyKeyless(bytes, bundle, trust) };
  } catch (error) {
    if (error instanceof EvidenceError)
      return { ok: false, problem: problem("refused", error.reason, error.message) };
    return {
      ok: false,
      problem: problem(
        "refused",
        "invalid-signature",
        "the signature, certificate or proof material does not verify"
      )
    };
  }
}
var listOf = (value) => value === void 0 ? [] : Array.isArray(value) ? value : [value];
async function withdrawalOutcome(bytes, bundle, summary2, signer, trust, allowed) {
  const parsed = parseJsonBytes(bytes, "withdrawn", 1024 * 1024);
  if (!parsed.ok)
    return Object.freeze({ status: parsed.problem.status, reason: parsed.problem.reason });
  const checked = validateWithdrawn(parsed.value);
  if (checked.status !== "ok")
    return Object.freeze({ status: checked.status, reason: checked.reason });
  const withdrawal = checked.withdrawn;
  const verified = await authenticate(bytes, bundle, trust);
  if (!verified.ok)
    return Object.freeze({ status: verified.problem.status, reason: verified.problem.reason });
  const through = withdrawal.throughRevision;
  if (withdrawal.scanKey !== summary2.scanKey)
    return Object.freeze({
      status: "not-applicable",
      reason: "other-key",
      throughRevision: through
    });
  const sameSigner = verified.signer.issuer === signer.issuer && verified.signer.subject === signer.subject && allowed.every((entry) => !matches(signer, entry) || matches(verified.signer, entry));
  if (!sameSigner)
    return Object.freeze({
      status: "not-applicable",
      reason: "other-signer",
      throughRevision: through
    });
  if (summary2.revision > through)
    return Object.freeze({
      status: "not-applicable",
      reason: "later-revision",
      throughRevision: through
    });
  return Object.freeze({ status: "applies", throughRevision: through });
}
async function verifySummary(bytes, bundle, allowedSigners, options = {}) {
  const result = await verify(bytes, bundle, allowedSigners, options);
  issued.add(result);
  return result;
}
var issued = /* @__PURE__ */ new WeakSet();
function isVerifySummaryResult(value) {
  return typeof value === "object" && value !== null && issued.has(value);
}
async function verify(bytes, bundle, allowedSigners, options) {
  try {
    const read = readSummary(bytes);
    if (read.status !== "ok") return notVerified(read);
    const allowed = checkSigners(allowedSigners);
    if ("status" in allowed) return notVerified(allowed);
    const trust = selectTrust(options ?? {});
    if ("status" in trust) return notVerified(trust);
    const verified = await authenticate(bytes, bundle, trust);
    if (!verified.ok) return notVerified(verified.problem);
    const withdrawnList = listOf(options?.withdrawn);
    const bundleList = listOf(
      options?.withdrawnBundle
    );
    if (withdrawnList.length !== bundleList.length || withdrawnList.length > 64)
      return notVerified(
        problem(
          "invalid",
          "withdrawn",
          "each withdrawal needs its bundle at the same position (at most 64)"
        )
      );
    const withdrawals = [];
    for (const [index, entry] of withdrawnList.entries())
      withdrawals.push(
        await withdrawalOutcome(
          entry,
          bundleList[index],
          read.summary,
          verified.signer,
          trust,
          allowed
        )
      );
    const withdrawn = withdrawals.some((outcome) => outcome.status === "applies");
    const listed = allowed.find((entry) => matches(verified.signer, entry));
    return Object.freeze({
      status: "ok",
      verified: true,
      withdrawn,
      signer: Object.freeze({
        identity: listed?.identity ?? verified.signer.subject,
        trusted: listed !== void 0 && !withdrawn,
        issuer: verified.signer.issuer,
        subject: verified.signer.subject
      }),
      summary: read.summary,
      signedAt: Object.freeze(verified.signer.signedAt.map((time) => new Date(time).toISOString())),
      withdrawals: Object.freeze(withdrawals)
    });
  } catch {
    return notVerified(
      problem("refused", "invalid-signature", "the evidence could not be verified")
    );
  }
}

// src/read/match-scan.ts
var invalid6 = (reason, detail) => Object.freeze({ status: "invalid", reason, detail });
var refused2 = (reason, detail) => Object.freeze({ status: "refused", reason, detail });
function resolveSummary(input) {
  if (typeof input !== "object" || input === null)
    return invalid6("summary", "expected a summary or a verifySummary result");
  const value = input;
  if (Object.hasOwn(value, "format")) {
    const checked = validateSummary(value);
    return checked.status === "ok" ? { summary: checked.summary, signer: null } : checked;
  }
  if (Object.hasOwn(value, "status") && Object.hasOwn(value, "summary")) {
    if (value.status !== "ok" || value.summary === null || value.summary === void 0)
      return refused2("not-verified", "the verifySummary result did not verify");
    const checked = validateSummary(value.summary);
    if (checked.status !== "ok") return checked;
    const signer = isVerifySummaryResult(value) ? value.signer : null;
    const ok = signer === null || signer === void 0 || typeof signer === "object" && typeof signer.identity === "string" && typeof signer.trusted === "boolean";
    if (!ok) return invalid6("signer", "the verifySummary result has a malformed signer");
    return {
      summary: checked.summary,
      signer: signer === null || signer === void 0 ? null : Object.freeze({ identity: signer.identity, trusted: signer.trusted })
    };
  }
  return invalid6("summary", "expected a summary or a verifySummary result");
}
async function matchScan(summaryOrVerified, files) {
  const resolved = resolveSummary(summaryOrVerified);
  if ("status" in resolved) return resolved;
  const checked = checkTreeFiles(files);
  if (!Array.isArray(checked)) return checked;
  const { summary: summary2, signer } = resolved;
  const algorithm = algorithmOfKey(summary2.scanKey);
  if (algorithm === void 0) return invalid6("scanKey", "unsupported scan key algorithm");
  if (!hasWebCrypto()) return refused2("crypto-unavailable", "WebCrypto is unavailable");
  try {
    return await compare(summary2, signer, checked, algorithm);
  } catch {
    return refused2("digest-failed", "the scan key could not be computed");
  }
}
async function compare(summary2, signer, checked, algorithm) {
  const scanKey2 = await treeKeyOf(checked, algorithm);
  const listed = new Map(summary2.files.map((file) => [file.path, file]));
  const supplied = new Set(checked.map((file) => file.path));
  const missing = summary2.files.map((file) => file.path).filter((path) => !supplied.has(path));
  const extra = [];
  const changed = [];
  const modeChanged = [];
  for (const file of checked) {
    const expected = listed.get(file.path);
    if (expected === void 0) {
      extra.push(file.path);
      continue;
    }
    if (await sha256Hex(file.bytes) !== expected.sha256) changed.push(file.path);
    if (file.mode !== expected.mode) modeChanged.push(file.path);
  }
  const sort = (list) => Object.freeze(list.sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
  const differences = Object.freeze({
    missing: sort(missing),
    extra: sort(extra),
    changed: sort(changed),
    modeChanged: sort(modeChanged)
  });
  const differs = missing.length + extra.length + changed.length + modeChanged.length > 0;
  if (scanKey2 === summary2.scanKey && differs)
    return refused2(
      "collision-or-tampering",
      "the content reproduces the scan key but not the summary's file list; the summary or content was tampered with"
    );
  return Object.freeze({
    status: "ok",
    matches: scanKey2 === summary2.scanKey && !differs,
    coverage: summary2.coverage,
    signer,
    scanKey: scanKey2,
    differences
  });
}

// src/read/read-findings.ts
var FINDINGS_MISMATCH_MESSAGE = "Findings don't match this scan";
var MISMATCH = Object.freeze({
  status: "refused",
  reason: "findings-mismatch",
  message: FINDINGS_MISMATCH_MESSAGE
});
var Mismatch = class extends Error {
};
var Bad = class extends Error {
};
var isObject2 = isRecord;
function need(condition, error = Bad) {
  if (!condition) throw new error();
}
var SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
var LEVELS = ["error", "warning", "note", "none"];
var PARTS2 = ["config", "dependencies", "code", "text", "none"];
function locationOf(result) {
  const locations = result.locations;
  need(Array.isArray(locations) && locations.length >= 1);
  const physical = locations[0];
  need(isObject2(physical) && isObject2(physical.physicalLocation));
  const location = physical.physicalLocation;
  need(
    isObject2(location.artifactLocation) && typeof location.artifactLocation.uri === "string"
  );
  const uri = location.artifactLocation.uri;
  const region = location.region;
  const line = isObject2(region) && region.startLine !== void 0 ? region.startLine : 1;
  need(typeof line === "number" && Number.isSafeInteger(line) && line >= 1);
  return { uri, line };
}
async function readFindings(summary2, sarifBytes, scanKey2) {
  if (!isObject2(summary2) || !Array.isArray(summary2.sarif) || !Array.isArray(summary2.files))
    return Object.freeze({
      status: "invalid",
      reason: "summary",
      detail: "summary must be a readSummary result's summary"
    });
  if (!isBytes(sarifBytes))
    return Object.freeze({
      status: "invalid",
      reason: "bytes",
      detail: "SARIF must be supplied as bytes (Uint8Array)"
    });
  if (typeof scanKey2 !== "string" || scanKey2 !== summary2.scanKey) return MISMATCH;
  if (sarifBytes.length > limits.output.sarifBytes)
    return Object.freeze({
      status: "refused",
      reason: "limit",
      detail: `SARIF exceeds ${limits.output.sarifBytes} bytes`
    });
  const digest3 = await sha256Hex(sarifBytes);
  if (!summary2.sarif.some((entry) => entry.sha256 === digest3)) return MISMATCH;
  const parsed = parseJsonBytes(sarifBytes, "SARIF", limits.output.sarifBytes);
  if (!parsed.ok) return parsed.problem;
  const document = parsed.value;
  if (!isObject2(document))
    return Object.freeze({ status: "invalid", reason: "sarif", detail: "SARIF must be an object" });
  if (document.version !== "2.1.0")
    return Object.freeze({
      status: "unsupported-version",
      reason: "unsupported-version",
      detail: "only SARIF 2.1.0 is supported"
    });
  const files = new Map(summary2.files.map((file) => [file.path, file]));
  try {
    const findings = [];
    need(Array.isArray(document.runs));
    for (const run2 of document.runs) {
      need(isObject2(run2) && isObject2(run2.tool) && isObject2(run2.tool.driver));
      const driver = run2.tool.driver;
      need(typeof driver.name === "string" && driver.name.length > 0);
      const tool = sanitizeText(driver.name, limits.output.ruleId);
      const artifacts = run2.artifacts;
      if (artifacts !== void 0) {
        need(Array.isArray(artifacts));
        for (const artifact of artifacts) {
          need(isObject2(artifact) && isObject2(artifact.location));
          const uri = artifact.location.uri;
          need(typeof uri === "string");
          const file = files.get(uri);
          need(file !== void 0, Mismatch);
          const hashes = artifact.hashes;
          if (isObject2(hashes) && hashes["sha-256"] !== void 0)
            need(hashes["sha-256"] === file?.sha256, Mismatch);
        }
      }
      const results = run2.results;
      need(Array.isArray(results));
      for (const result of results) {
        need(findings.length < limits.output.findingsPerSarif);
        need(isObject2(result));
        const entry = result;
        const { uri, line } = locationOf(entry);
        need(
          displayPathProblem(uri, limits.output.findingPath, limits.input.depth) === void 0,
          Mismatch
        );
        const file = files.get(uri);
        need(file !== void 0, Mismatch);
        const properties = entry.properties;
        need(isObject2(properties));
        const props = properties;
        need(props.scanKey === scanKey2, Mismatch);
        need(isScanCode(props.code));
        need(
          typeof props.part === "string" && PARTS2.includes(props.part)
        );
        const severity = props.severity;
        need(
          severity === void 0 || SEVERITIES.includes(severity)
        );
        const level = entry.level;
        need(level === void 0 || LEVELS.includes(level));
        const confidence = props.confidence;
        need(
          confidence === void 0 || typeof confidence === "number" && confidence >= 0 && confidence <= 1
        );
        need(typeof entry.ruleId === "string");
        need(isObject2(entry.message) && typeof entry.message.text === "string");
        const fingerprints = isObject2(entry.partialFingerprints) ? entry.partialFingerprints : {};
        const fingerprint = Object.values(fingerprints).find((value) => typeof value === "string");
        findings.push(
          Object.freeze({
            severity: severityOf({
              severity,
              level
            }),
            code: props.code,
            tool,
            ruleId: sanitizeText(entry.ruleId, limits.output.ruleId),
            part: props.part,
            fingerprint: typeof fingerprint === "string" ? sanitizeText(fingerprint, limits.output.ruleId) : null,
            confidence: typeof confidence === "number" ? confidence : null,
            fileSha256: file.sha256,
            text: sanitizeText(entry.message.text, limits.output.findingText),
            path: uri,
            line
          })
        );
      }
    }
    return Object.freeze({ status: "ok", findings: Object.freeze(findings) });
  } catch (error) {
    if (error instanceof Mismatch) return MISMATCH;
    return Object.freeze({
      status: "invalid",
      reason: "sarif",
      detail: "SARIF does not follow the scan finding shape"
    });
  }
}
export {
  FINDINGS_MISMATCH_MESSAGE,
  checkAdvisories,
  matchScan,
  readFindings,
  readSummary,
  verifySummary
};
