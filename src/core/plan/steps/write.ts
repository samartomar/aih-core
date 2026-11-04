// `write` (Catalog 9, contract 8.1): one file from an item file or a source notice, checked by sha256.
// A `render` is carried out by the caller's Catalog (C51, `./render.ts`).
import { clis, owners, problem, refusal, target } from './common.js';
import { renderWrite } from './render.js';
import type { StepHandler } from './types.js';

export const write: StepHandler = {
  op: 'write',
  async prepare(step, context) {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index); if (!('root' in placed)) return placed;
    const served = clis(step, index); if (!('clis' in served)) return served;
    if (step.render !== undefined) {
      const done = await renderWrite(step, context, placed.path, owner.ids);
      if (!('rendered' in done)) return done;
      return { lowered: { kind: 'write', managementIds: owner.ids, root: placed.root, path: placed.path, bytes: done.rendered.bytes,
        executable: done.rendered.executable, sentence: `Writes \`${placed.path}\`, rendered by your Catalog (\`${done.rendered.name}\`)`,
        cantPromise: null, review: { ...owner.review, clis: served.clis }, profiles: done.rendered.profiles } };
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
