// `acquire` (Catalog 9, contract 4.1, 8.1): an AI setup's artifact downloaded into `~/.aihq/ai-setup/<name>/<version>/<cell>/`.
// Before any effect the step must agree with the supplied qualification document it names, byte for byte: the artifact,
// its members, the wheel closure, the fallback interpreter and the cell (D54, D86, D105). A missing document is
// `qualification-missing`; any disagreement is `qualification-mismatch`. The step is lowered into one Core-owned marker
// file in that folder, whose write runs the acquisition first (`../acquire/effect.ts`).
import { canonicalJson } from '../../internal/canonical.js';
import { limitValue } from '../limits.js';
import { parseRange } from '../acquire/range.js';
import { MANIFEST, type AcquireSpec, type ArchiveMember, type ClosureWheel, type Download } from '../acquire/types.js';
import { problem, refusal } from './common.js';
import type { Json } from '../../types.js';
import type { StepHandler } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;
export const QUALIFICATION = 'urn:aihq:catalog:qualification:0.1.0';
type Fields = Record<string, Json>;
const object = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);
/** A sha256 written as `sha256:<hex>` or bare hex, as hex; otherwise `undefined`. */
export const hexOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const hex = value.startsWith('sha256:') ? value.slice(7) : value;
  return HEX.test(hex) ? hex : undefined;
};
/** The platform cell this host is (Catalog D48). */
export const hostCell = (): string => `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left as Json) === canonicalJson(right as Json);

function download(value: unknown): Download | string {
  if (!object(value)) return 'shape';
  const sha256 = hexOf(value.sha256);
  if (!sha256) return 'sha256';
  if (typeof value.url !== 'string') return 'url';
  let url: URL;
  try { url = new URL(value.url); } catch { return 'url'; }
  if (url.protocol !== 'https:' || url.username || url.password) return 'url';
  const file = typeof value.file === 'string' ? value.file : decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
  if (!SEGMENT.test(file)) return 'file';
  if (value.bytes !== undefined && !(Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0)) return 'bytes';
  return { url: url.href, file, sha256, bytes: value.bytes === undefined ? null : value.bytes as number };
}
function members(value: unknown): ArchiveMember[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > limitValue('artifact-members')) return undefined;
  const out: ArchiveMember[] = [];
  for (const entry of value) {
    if (!object(entry) || typeof entry.path !== 'string' || !hexOf(entry.sha256) || typeof entry.executable !== 'boolean') return undefined;
    const segments = entry.path.split('/');
    if (entry.path.length > 1024 || segments.some(segment => !SEGMENT.test(segment))) return undefined;
    out.push({ path: entry.path, sha256: hexOf(entry.sha256)!, executable: entry.executable });
  }
  return new Set(out.map(entry => entry.path.toLowerCase())).size === out.length ? out : undefined;
}
/** Where a qualification's field and the step's agree: every field both name is equal. */
function agrees(observed: unknown, planned: Download, fields: string[]): boolean {
  if (!object(observed) || hexOf(observed.sha256) !== planned.sha256) return false;
  const values: Record<string, unknown> = { file: planned.file, bytes: planned.bytes };
  return fields.every(field => observed[field] === undefined || values[field] === null || observed[field] === values[field]);
}

export const acquire: StepHandler = {
  op: 'acquire',
  prepare(step, context) {
    const { index } = context;
    const shape = (field: string, message: string) => problem(index, field, 'acquire', message);
    if (typeof step.aiSetup !== 'string' || !ID.test(step.aiSetup)) return shape('aiSetup', 'An acquire step names its `aiSetup` id.');
    if (typeof step.version !== 'string' || !SEGMENT.test(step.version)) return shape('version', 'An acquire step names the exact `version`.');
    if (typeof step.cell !== 'string' || !SEGMENT.test(step.cell)) return shape('cell', 'An acquire step names its platform `cell`.');
    const into = typeof step.into === 'string' ? step.into.replace(/\/$/, '') : '';
    const parts = into.split('/');
    if (parts.length !== 5 || parts[0] !== '.aihq' || parts[1] !== 'ai-setup' || !SEGMENT.test(parts[2]!) || parts[3] !== step.version || parts[4] !== step.cell)
      return refusal('path-escape', `Step ${index} acquires into \`${String(step.into)}\`, not \`.aihq/ai-setup/<name>/${step.version}/${step.cell}/\`.`, index);
    const distribution = step.distribution;
    if (!object(distribution) || typeof distribution.kind !== 'string') return shape('distribution', 'An acquire step names its `distribution`.');
    if (distribution.kind !== 'pypi-wheel' && distribution.kind !== 'native-archive')
      return refusal('step-unknown', `Step ${index} acquires a \`${distribution.kind}\` distribution, which this Core does not carry out yet.`, index, { op: 'acquire' });
    const artifact = download(distribution);
    if (typeof artifact === 'string') return shape(`distribution/${artifact}`,
      'A distribution Core downloads names an https `url`, its `sha256` and a plain file name; a `file` alone names no place to download from.');
    const python = distribution.kind === 'pypi-wheel';
    // A Python tool's closure and interpreter choice (D105).
    let closure: ClosureWheel[] = []; let interpreter: AcquireSpec['interpreter'] = null;
    if (python) {
      const choice = step.interpreter;
      if (!object(choice) || choice.prefer !== 'installed' || typeof choice.range !== 'string' || !parseRange(choice.range))
        return shape('interpreter', 'A Python tool names `interpreter: { prefer: "installed", range, fallback }` with a readable range.');
      const fallback = download(choice.fallback);
      if (typeof fallback === 'string' || !object(choice.fallback) || typeof choice.fallback.version !== 'string')
        return shape('interpreter/fallback', 'The fallback interpreter names its `version`, https `url` and `sha256`.');
      interpreter = { range: choice.range, fallback: { ...fallback, version: choice.fallback.version } };
      if (!Array.isArray(step.closure) || step.closure.length > limitValue('closure-wheels')) return shape('closure', 'A Python tool names its wheel `closure`.');
      for (const entry of step.closure) {
        const wheel = download(entry);
        if (typeof wheel === 'string' || !object(entry) || typeof entry.name !== 'string' || typeof entry.version !== 'string' || !wheel.file.endsWith('.whl'))
          return shape('closure', 'Each closure wheel names `name`, `version`, an https `url` to a `.whl` and its `sha256`.');
        closure.push({ ...wheel, name: entry.name, version: entry.version });
      }
      if (!artifact.file.endsWith('.whl')) return shape('distribution/file', 'A `pypi-wheel` artifact is a `.whl` file.');
    }
    const bound = limitValue('artifact-bytes');
    for (const item of [artifact, ...closure, ...(interpreter ? [interpreter.fallback] : [])])
      if (item.bytes !== null && item.bytes > bound) return refusal('limit-exceeded', `Step ${index} names \`${item.file}\`, larger than one acquired artifact may be.`,
        index, { limit: 'artifact-bytes', value: bound });

    // The qualification the step names, then agreement field by field.
    const sha = hexOf(step.qualification);
    if (!sha) return shape('qualification', 'An acquire step names its qualification by sha256.');
    const document = context.qualification(sha);
    if (!document) return refusal('qualification-missing', `Step ${index} names qualification \`sha256:${sha}\`, which was not supplied.`, index);
    const mismatch = (what: string) => refusal('qualification-mismatch', `Step ${index}'s ${what} differs from qualification \`sha256:${sha}\`.`, index);
    const { subject, observed, result } = document as Fields;
    if (document.schema !== QUALIFICATION || !object(subject) || !object(observed) || !object(result)) return mismatch('qualification document');
    if (subject.aiSetup !== step.aiSetup || subject.version !== step.version) return mismatch('AI setup or version');
    if (subject.cell !== step.cell) return mismatch('cell');
    if (result.status !== 'qualified') return mismatch('qualified status');
    if (!agrees(observed.artifact, artifact, ['file', 'bytes'])) return mismatch('artifact');
    let listed: ArchiveMember[] = [];
    if (!python) {
      const found = members(observed.members);
      if (!found) return mismatch('members');
      if (distribution.members !== undefined && !sameJson(members(distribution.members) ?? null, found)) return mismatch('members');
      listed = found;
    } else {
      if (observed.members !== undefined && observed.members !== null && !(Array.isArray(observed.members) && observed.members.length === 0)) return mismatch('members');
      const qualified = observed.closure;
      if (!Array.isArray(qualified) || qualified.length !== closure.length ||
          !closure.every((wheel, at) => object(qualified[at]) && (qualified[at] as Fields).name === wheel.name &&
            (qualified[at] as Fields).version === wheel.version && agrees(qualified[at], wheel, ['file', 'bytes']))) return mismatch('closure');
      const fallback = observed.interpreter;
      if (!object(fallback) || fallback.version !== interpreter!.fallback.version || !agrees(fallback, interpreter!.fallback, ['file', 'bytes']))
        return mismatch('fallback interpreter');
    }
    // Agreement is settled; only then is the host's own cell compared, since a qualification for another cell is still that cell's.
    if (step.cell !== hostCell()) return refusal('cell-mismatch', `Step ${index} acquires for \`${step.cell}\`; this host is \`${hostCell()}\`.`, index);

    const spec: AcquireSpec = { step: index, aiSetup: step.aiSetup, version: step.version, cell: step.cell, qualification: sha, into,
      kind: python ? 'pypi-wheel' : 'native-archive', artifact, members: listed, closure, interpreter };
    const marker = Buffer.from(`Managed by AIH Core: ${step.aiSetup} ${step.version} ${step.cell}\nqualification sha256:${sha}\nartifact sha256:${artifact.sha256}\n`);
    return { lowered: { kind: 'write', managementIds: [step.aiSetup], root: 'user', path: `${into}/${MANIFEST}`, bytes: marker, executable: false,
      sentence: python ? `Downloads \`${artifact.file}\` into \`~/${into}/\` and installs it with its ${closure.length}-wheel closure in a dedicated environment` :
        `Downloads \`${artifact.file}\` and extracts its ${listed.length} qualified member${listed.length === 1 ? '' : 's'} into \`~/${into}/\``,
      cantPromise: python ? 'An installed interpreter is checked only by its version range and the tool\'s readback, never byte-qualified.' : null,
      review: { item: step.aiSetup }, acquire: spec } };
  }
};
