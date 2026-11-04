// `upstream-setup` (Catalog 9, contract 8.1, 12, C30): a framework's own setup program. Apply clones `repository` at the
// exact `commit` into `into` (with git, pinned at Prepare), checks the checkout is that commit, then runs the exact
// `command` inside the clone after approval. Core owns the clone, marked by one file, and removes it with the install;
// it can't see or remove what the command writes, and the review says so. The step is grouped under its framework (C48).
import { knownCli } from '../tools.js';
import { problem, refusal, target } from './common.js';
import { isArgv, launchable, shapeProblem } from './program.js';
import type { StepHandler } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
/** The file that marks a folder as Core's clone of an upstream setup. */
export const SETUP_MARKER = '.aih-setup';

export const upstreamSetup: StepHandler = {
  op: 'upstream-setup',
  prepare(step, context) {
    const { index } = context;
    const shape = (field: string, message: string) => shapeProblem(index, field, 'upstream-setup', message);
    const { cli, framework, repository, commit, command, needs } = step;
    if (typeof framework !== 'string' || !ID.test(framework)) return shape('framework', 'An upstream setup names its `framework`.');
    if (typeof cli !== 'string' || !ID.test(cli)) return shape('cli', 'An upstream setup names its `cli`.');
    if (typeof repository !== 'string' || repository.length > 512 || !/^https:\/\/[^\s/]+\/\S+$/.test(repository))
      return shape('repository', 'An upstream setup names an https `repository`.');
    if (typeof commit !== 'string' || !COMMIT.test(commit)) return shape('commit', 'An upstream setup names the exact `commit`.');
    if (!isArgv(command)) return shape('command', 'An upstream setup names its exact `command` argv.');
    if (!Array.isArray(needs) || needs.length > 64 || !needs.every(need => typeof need === 'string' && need.length > 0 && need.length <= 256))
      return shape('needs', 'An upstream setup lists what its command `needs`.');
    if (step.approval !== undefined && step.approval !== 'required') return shape('approval', 'An upstream setup runs only after approval.');
    if (!knownCli(cli)) return refusal('tool-unknown', `Step ${index} names CLI \`${cli}\`, which has no registry tool.`, index, { tool: cli });
    const into = typeof step.into === 'string' ? step.into.replace(/\/$/, '') : '';
    const placed = target({ ...step, into } as never, index, 'into'); if (!('root' in placed)) return placed;
    if (placed.root === 'project' && typeof context.request.target.project !== 'string')
      return problem(index, 'root', 'project', 'A project setup needs the request to name its project.');
    // The command runs a program inside the clone (`./setup`) or one found on PATH; nothing through a shell.
    const program = command[0] as string;
    const inClone = program.startsWith('./');
    const relative = inClone ? program.slice(2) : '';
    if (inClone ? relative.length === 0 || relative.split('/').some(part => part === '' || part === '.' || part === '..') || relative.includes('\\') :
        /[\\/]/.test(program)) return shape('command', 'The command runs `./<file>` inside the clone or a program found on PATH.');
    if (inClone && !launchable(relative))
      return refusal('program-unavailable', `Step ${index} runs the clone's \`${program}\`, which this host cannot run without a shell.`, index);
    const shown = (command as string[]).join(' ');
    const marker = Buffer.from(`Managed by AIH Core: upstream setup of ${framework}\nrepository ${repository}\ncommit ${commit}\n`);
    return { lowered: { kind: 'program', op: 'upstream-setup', managementIds: [framework], root: placed.root, argv: [...command as string[]],
      shown: [...command as string[]], env: {}, shownEnv: {}, executable: inClone ? { from: 'clone', path: relative } : { from: 'path', name: program },
      cwd: placed.path, clone: { repository, commit, into: placed.path, marker }, needs: [...needs as string[]], managed: true,
      cantRemove: `Core removes only its clone \`${placed.path}\`; it can't remove what \`${shown}\` wrote elsewhere.`,
      sentence: `Clones \`${repository}\` at \`${commit}\` into \`${placed.root === 'user' ? '~/' : ''}${placed.path}\`, then runs \`${shown}\` there` +
        (needs.length ? `; it needs ${(needs as string[]).map(need => `\`${need}\``).join(', ')}` : ''),
      cantPromise: 'Core checks only the clone. It can\'t show or promise what the setup command writes, and can\'t remove it.',
      review: { framework, clis: [cli] } } };
  }
};
