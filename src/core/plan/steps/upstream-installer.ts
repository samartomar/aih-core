// `upstream-installer` (Catalog 9, contract 8.1, 12, C30, D53): the AI setup's own installer, chosen instead of a managed
// setup. Core runs its exact argv after approval of that command and its pinned executable, and clones nothing. It is
// `managed: false`: Core can't see, check or remove what it writes, and the review and removal say so. A project-scope
// plan keeps its receipt in that project; removing it there releases only that receipt.
import { refusal } from './common.js';
import { isArgv, launchable, shapeProblem } from './program.js';
import type { StepHandler } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const upstreamInstaller: StepHandler = {
  op: 'upstream-installer',
  prepare(step, context) {
    const { index, request } = context;
    const shape = (field: string, message: string) => shapeProblem(index, field, 'upstream-installer', message);
    const { aiSetup, argv } = step;
    if (typeof aiSetup !== 'string' || !ID.test(aiSetup)) return shape('aiSetup', 'An upstream installer names its `aiSetup` id.');
    if (!isArgv(argv)) return shape('argv', 'An upstream installer names its exact `argv`.');
    if (step.managed !== false) return shape('managed', 'An upstream installer is `managed: false`.');
    if (step.approval !== undefined && step.approval !== 'required') return shape('approval', 'An upstream installer runs only after approval.');
    const name = argv[0] as string;
    // Only a program found on PATH is pinned and run; a path or a shell line is never guessed at.
    if (/[\\/]/.test(name) || !launchable(name) && /\.[A-Za-z0-9]+$/.test(name))
      return refusal('program-unavailable', `Step ${index} runs \`${name}\`, which this host cannot run as a pinned program.`, index);
    const command = (argv as string[]).join(' ');
    // The run belongs to the scope of the plan that ran it: its receipt is kept, and the program runs, there. Catalog's
    // step names no root, so a `root` field on it is never read.
    const root = request.scope === 'project' ? 'project' : 'user';
    return { lowered: { kind: 'program', op: 'upstream-installer', managementIds: [aiSetup], root, argv: [...argv as string[]],
      shown: [...argv as string[]], env: {}, shownEnv: {}, executable: { from: 'path', name }, cwd: '', managed: false,
      cantRemove: `Core can't remove what \`${command}\` installs: it is not managed by Core. Remove it with the tool's own uninstaller.`,
      sentence: `Runs \`${command}\``,
      cantPromise: 'Core can\'t show, check or remove what this installer changes: it is the upstream\'s own program (`managed: false`).',
      review: { item: aiSetup } } };
  }
};
