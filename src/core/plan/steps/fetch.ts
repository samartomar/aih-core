// `fetch` (Catalog 9, contract 8.1): a `fetch: "upstream"` file the caller read with Catalog's `fetchSource` and
// supplied in `files`. Core never fetches; missing bytes are `source-missing`, other bytes `source-mismatch`.
import { clis, owners, problem, refusal, target } from './common.js';
import type { StepHandler } from './types.js';

const SHA = /^[a-f0-9]{64}$/;
export const fetch: StepHandler = {
  op: 'fetch',
  prepare(step, context) {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index); if (!('root' in placed)) return placed;
    const served = clis(step, index); if (!('clis' in served)) return served;
    if (typeof step.source !== 'string' || typeof step.sourcePath !== 'string' || typeof step.sha256 !== 'string' || !SHA.test(step.sha256))
      return problem(index, '', 'fetch', 'A fetch step names `source`, `sourcePath` and `sha256`.');
    const listed = owner.ids.map(item => context.itemFile(item, step.sourcePath as string)).find(Boolean);
    if (listed && listed.sha256 !== step.sha256)
      return refusal('source-mismatch', `Step ${index}'s sha256 differs from the content document's for \`${step.sourcePath}\`.`, index);
    const supplied = context.bytesFor({ sourceId: step.source, sourcePath: step.sourcePath, sha256: step.sha256, executable: listed?.executable ?? false });
    if ('refusal' in supplied) return supplied;
    return { lowered: { kind: 'write', managementIds: owner.ids, root: placed.root, path: placed.path, bytes: supplied.bytes,
      executable: listed?.executable ?? false, sentence: `Writes \`${placed.path}\` from the fetched upstream file`, cantPromise: null,
      review: { ...owner.review, clis: served.clis } } };
  }
};
