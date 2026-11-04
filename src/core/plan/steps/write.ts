// `write` (Catalog 9, contract 8.1): one file from an item file or a source notice, checked by sha256.
// A `render` needs the caller's Catalog (C51); carrying a render out is a later slice, so it is refused here.
import { clis, owners, problem, refusal, target } from './common.js';
import type { StepHandler } from './types.js';

export const write: StepHandler = {
  op: 'write',
  prepare(step, context) {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index); if (!('root' in placed)) return placed;
    const served = clis(step, index); if (!('clis' in served)) return served;
    if (step.render !== undefined) {
      if (context.controls.catalog === undefined)
        return refusal('catalog-required', `Step ${index} renders \`${placed.path}\` and needs the Catalog that made the plan.`, index);
      return refusal('step-unknown', `Step ${index} renders \`${placed.path}\`; this Core does not carry out render steps yet.`, index);
    }
    const from = step.from;
    if (!from || typeof from !== 'object' || Array.isArray(from) || typeof from.sourcePath !== 'string' ||
        (typeof from.item === 'string') === (typeof from.source === 'string'))
      return problem(index, 'from', 'from', 'A write step names `from` as an item file or a source notice.');
    const facts = typeof from.item === 'string' ? context.itemFile(from.item, from.sourcePath) : context.notice(from.source as string, from.sourcePath);
    if (!facts) return refusal('source-missing', `Step ${index} names \`${from.sourcePath}\`, which no supplied content document lists.`, index);
    const supplied = context.bytesFor(facts); if ('refusal' in supplied) return supplied;
    return { lowered: { kind: 'write', managementIds: owner.ids, root: placed.root, path: placed.path, bytes: supplied.bytes,
      executable: facts.executable, sentence: `Writes \`${placed.path}\``, cantPromise: null,
      review: { ...owner.review, clis: served.clis } } };
  }
};
