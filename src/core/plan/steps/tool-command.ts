// `tool-command` (Catalog 9, contract 8.1, 12, D57): one settings command of an AI setup, run with the setup's acquired
// executable after approval, then its readback; a readback that differs fails the step. The executable comes from the
// user root inside the AI setup's folder; when the qualification lists it, its sha256 is the one Apply runs. A step's
// `restore: { argv }` names `<prior>` once: Apply runs the readback first and keeps its output as the prior value, and the
// receipt's undo is the restore with that value, read back as it (C30, C54). Without a restore Core can't undo it.
import { hexOf } from './acquire.js';
import { acquiredByCore, refusal, target } from './common.js';
import { bindCommand, isArgv, launchable, readbackOf, shapeProblem } from './program.js';
import type { Json } from '../../types.js';
import type { StepHandler } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
type Fields = Record<string, Json>;
const object = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);

/** The placeholder a `restore` argv takes, once and as a whole argument, for the value read before the command. */
export const PRIOR = '<prior>';
/** A step's `restore: { argv }`: `<prior>` exactly once, as a whole argument and never inside another. */
function restoreOf(value: unknown): { argv: string[] } | undefined {
  if (!object(value) || Object.keys(value).join() !== 'argv' || !isArgv(value.argv)) return undefined;
  const argv = value.argv as string[];
  return argv.filter(arg => arg === PRIOR).length === 1 && argv.every(arg => arg === PRIOR || !arg.includes(PRIOR)) ? { argv: [...argv] } : undefined;
}

export const toolCommand: StepHandler = {
  op: 'tool-command',
  prepare(step, context) {
    const { index, request } = context;
    const shape = (field: string, message: string) => shapeProblem(index, field, 'tool-command', message);
    const { aiSetup } = step;
    if (typeof aiSetup !== 'string' || !ID.test(aiSetup)) return shape('aiSetup', 'A tool-command names its `aiSetup` id.');
    if (!isArgv(step.argv)) return shape('argv', 'A tool-command names its exact `argv`.');
    const readback = readbackOf(step.readback);
    if (!readback) return shape('readback', 'A tool-command names its `readback: { argv, expected }`.');
    const restore = step.restore === undefined ? undefined : restoreOf(step.restore);
    if (step.restore !== undefined && !restore) return shape('restore', 'A tool-command\'s `restore` is `{ argv }` naming `<prior>` once, as a whole argument.');
    if (step.approval !== undefined && step.approval !== 'required') return shape('approval', 'A tool-command runs only after approval.');
    if (!object(step.executable) || step.executable.root !== 'user') return shape('executable', 'A tool-command names its acquired `executable: { root: "user", path }`.');
    const placed = target(step.executable as never, index); if (!('root' in placed)) return placed;
    if (!placed.path.startsWith('.aihq/ai-setup/'))
      return refusal('path-escape', `Step ${index} runs \`${placed.path}\`, which is not inside an AI setup folder.`, index);
    // The qualification the command was qualified with; the acquire step for the same AI setup gives its folder. A
    // command from a recipe's replacement settings carries none (Catalog): no qualification ran it, so the acquire step
    // for its AI setup, and that step's qualification of the artifact, give the folder and the program's sha256.
    const qualified = step.qualification !== undefined;
    const sha = qualified ? hexOf(step.qualification) : undefined;
    if (qualified && !sha) return shape('qualification', 'A tool-command names its qualification by sha256, or none for a recipe\'s own settings.');
    const acquire = request.plan.plan.find(other => other.op === 'acquire' && other.aiSetup === aiSetup && (!qualified || hexOf(other.qualification) === sha));
    const named = sha ?? (acquire ? hexOf(acquire.qualification) : undefined);
    const qualification = named ? context.qualification(named) : undefined;
    if (qualified && !qualification) return refusal('qualification-missing', `Step ${index} names qualification \`sha256:${sha}\`, which was not supplied.`, index);
    if (qualification && (!object(qualification.subject) || qualification.subject.aiSetup !== aiSetup))
      return refusal('qualification-mismatch', `Step ${index}'s AI setup differs from qualification \`sha256:${named}\`.`, index);
    // Without an acquire step of this plan, the program must be in a folder Core acquired: never one a plan supplied.
    if (!acquire && !acquiredByCore(placed.path))
      return { problem: { path: `/plan/plan/${index}/executable`, reason: 'root-path-unplaced',
        message: `Step ${index} runs \`~/${placed.path}\`, which no acquire step of this plan places and no AI setup Core acquired holds; replan for a qualified AI setup.` } };
    let sha256: string | null = null;
    if (acquire && typeof acquire.into === 'string') {
      const into = acquire.into.replace(/\/$/, '') + '/';
      if (!placed.path.startsWith(into)) return refusal('path-escape', `Step ${index} runs \`${placed.path}\`, outside its AI setup's folder \`${into}\`.`, index);
      const members = qualification && object(qualification.observed) && Array.isArray(qualification.observed.members) ? qualification.observed.members : [];
      const member = members.find(entry => object(entry) && entry.path === placed.path.slice(into.length));
      sha256 = object(member) ? hexOf(member.sha256) ?? null : null;
    }
    if (!launchable(placed.path)) return refusal('program-unavailable', `Step ${index} runs \`${placed.path}\`, which this host cannot run.`, index);
    const bound = bindCommand(step.argv as string[], step.inputs, context, []);
    if (!('argv' in bound)) return bound;
    const command = `${placed.path} ${bound.shown.join(' ')}`;
    const check = `checks that \`${readback.argv.join(' ')}\` reads \`${readback.expected}\``;
    return { lowered: { kind: 'program', op: 'tool-command', managementIds: [aiSetup], root: 'user', argv: bound.argv, shown: bound.shown,
      env: bound.env, shownEnv: bound.shownEnv, executable: { from: 'acquired', path: placed.path, sha256 }, cwd: '', readback, undo: null, managed: true,
      ...(restore ? { restore } : {}),
      cantRemove: restore ? `Removal runs \`${restore.argv.join(' ')}\` with \`${PRIOR}\` as the value \`${readback.argv.join(' ')}\` showed before the ` +
        'command, then checks that the readback shows it again; nothing else is rolled back.' :
        `Core can't undo \`${bound.shown.join(' ')}\`: the step names no restore command.`,
      sentence: restore ? `Runs \`${readback.argv.join(' ')}\` and keeps what it shows as the prior value, then runs \`~/${command}\`, then ${check}` :
        `Runs \`~/${command}\`, then ${check}`,
      cantPromise: (qualified ? '' : 'No qualification ran this command: it is the recipe\'s own setting. ') +
        'Core can\'t show or promise what this command changes; it checks only the readback. ' +
        (sha256 ? 'The program is the qualified member of the acquired artifact.' : 'The program is not byte-qualified; Core runs the one in the AI setup folder.'),
      review: { item: aiSetup, ...(bound.bound ? { inputs: bound.bound.review } : {}) }, ...(bound.bound ? { bound: bound.bound } : {}) } };
  }
};
