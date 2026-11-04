// `link` (Catalog 9, contract 8.1): a user-scope folder link from a CLI's place to a shared version folder. How it lands
// on this host (junction, symlink or copy, C29) is decided here from the CLIs the step records.
import { clis, owners, problem, target } from './common.js';
import { linkTypeFor } from '../links.js';
import type { StepHandler } from './types.js';

export const link: StepHandler = {
  op: 'link',
  prepare(step, context) {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index); if (!('root' in placed)) return placed;
    const linked = target(step, index, 'to'); if (!('root' in linked)) return linked;
    if (placed.root !== 'user') return problem(index, 'root', 'link-scope', 'A link is placed only in user scope.');
    const fold = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
    if (fold(linked.path) === fold(placed.path) || fold(linked.path).startsWith(fold(placed.path) + '/') || fold(placed.path).startsWith(fold(linked.path) + '/'))
      return problem(index, 'to', 'link-overlap', 'A link and the folder it points to are separate places.');
    const served = clis(step, index); if (!('clis' in served)) return served;
    const linkType = linkTypeFor(served.clis);
    const how = linkType === 'copy' ? 'a copy of' : `a ${linkType} to`;
    return { lowered: { kind: 'link', managementIds: owner.ids, root: 'user', path: placed.path, to: linked.path, linkType,
      sentence: `Places \`${placed.path}\` as ${how} \`${linked.path}\``, cantPromise: null,
      review: { ...owner.review, clis: served.clis, to: linked.path, linkType } } };
  }
};
