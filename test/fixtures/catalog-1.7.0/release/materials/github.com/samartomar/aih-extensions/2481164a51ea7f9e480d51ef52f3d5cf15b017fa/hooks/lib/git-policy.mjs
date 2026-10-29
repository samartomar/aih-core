// Which git commands an agent may run on its own. Shared by every CLI's
// adapter (hooks/git-guard.mjs for command hooks, hooks/opencode-plugin.mjs).
import path from 'node:path';
import { gitCommands, hasFlag } from './shell.mjs';

const YOURSELF = 'Run it yourself in a terminal if you really mean it.';
const everyPath = (args) => args.some((a) => a === '.' || a === ':/' || a === '*' || a === ':(top)');
const PROTECTED = ['main', 'master'];
const PUSH_VALUE_OPTS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);

// `git push [options] [<remote> [<refspec>...]]`, split into its parts.
export function pushParts(args) {
  const pos = [];
  let remote, all = false, tags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--repo=')) { remote = a.slice(7); continue; }
    if (PUSH_VALUE_OPTS.has(a)) { if (a === '--repo') remote = args[i + 1]; i++; continue; }
    if (a === '--all' || a === '--branches') all = true;
    if (a === '--tags' || a === '--follow-tags') tags = true;
    if (!a.startsWith('-')) pos.push(a);
  }
  if (remote === undefined) remote = pos.shift();
  return { remote, refspecs: pos, all, tags };
}

// A push asks only when it lands on main, master or the remote's default
// branch, or when the target can't be worked out. `repo` answers questions
// about the repo (hooks/lib/git-context.mjs); without it every push asks.
function pushVerdict(args, shown, dir, repo, config) {
  if (!repo) return ['ask', `${shown} publishes commits to a remote.`];
  const { remote: named, refspecs, all, tags } = pushParts(args);
  if (all) return ['ask', `${shown} publishes every branch.`];
  if (tags) return ['ask', `${shown} publishes tags.`];
  if (refspecs.some((spec) => spec.includes('*'))) return ['ask', `${shown} publishes multiple matching refs.`];
  const current = repo.currentBranch(dir);
  const targets = (refspecs.length ? refspecs : ['HEAD']).map((spec) => {
    let dst = spec.slice(spec.lastIndexOf(':') + 1);
    if (dst === 'HEAD') return current ? { branch: current } : null;
    if (dst.startsWith('refs/tags/') || (!spec.includes(':') && repo.isTag(dir, dst))) return { tag: dst.replace(/^refs\/tags\//, '') };
    dst = dst.replace(/^refs\/heads\//, '');
    return dst.startsWith('refs/') ? null : { branch: dst };
  });
  if (targets.includes(null)) return ['ask', `${shown} publishes commits, and which branch it updates can't be worked out here.`];
  const tag = targets.find((t) => t.tag);
  if (tag) return ['ask', `${shown} publishes the tag ${tag.tag}.`];
  const remote = named ?? repo.pushRemote(dir, current);
  // A temporary approval covers one explicit branch on its actual push URL.
  // Bare pushes and command-local configuration keep the normal checks.
  const simpleOptions = args.filter((a) => a.startsWith('-'))
    .every((a) => ['-u', '--set-upstream', '--'].includes(a));
  const source = refspecs[0]?.split(':')[0];
  const tagSource = source?.startsWith('refs/tags/') || (source && repo.isTag(dir, source));
  const explicitBranch = /^[^:]+:refs\/heads\/.+$/.test(refspecs[0] ?? '');
  if (!config.length && simpleOptions && explicitBranch && !tagSource && named && refspecs.length === 1 && targets.length === 1
    && repo.protectedPushAllowed?.(dir, remote, targets[0].branch)) return null;
  const hit = targets.find((t) => PROTECTED.includes(t.branch));
  if (hit) return ['ask', `${shown} publishes commits to ${hit.branch}.`];
  const def = repo.defaultBranch(dir, remote);
  if (!def) return ['ask', `${shown} publishes commits, and the default branch of ${remote} can't be looked up.`];
  const onDefault = targets.find((t) => t.branch === def);
  return onDefault ? ['ask', `${shown} publishes commits to ${def}, the default branch of ${remote}.`] : null;
}

function verdict({ sub, args, config, cwd }, ctx) {
  const shown = `\`git ${sub} ${args.join(' ')}\``.replace(/ `$/, '`');
  if (config.some((kv) => /^core\.hookspath=/i.test(kv))) return ['deny', `${shown} overrides core.hooksPath, which skips the repo's commit hooks. ${YOURSELF}`];
  switch (sub) {
    case 'push':
      if (hasFlag(args, '--dry-run', 'n')) return null;
      if (hasFlag(args, '--force', 'f') || hasFlag(args, '--delete', 'd') || hasFlag(args, '--mirror') || hasFlag(args, '--prune')
        || args.some((a) => a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^[+:]/.test(a))) {
        return ['deny', `${shown} rewrites or deletes remote history. ${YOURSELF}`];
      }
      return pushVerdict(args, shown, path.resolve(ctx.cwd ?? process.cwd(), ...cwd), ctx.repo, config);
    case 'commit':
      return hasFlag(args, '--no-verify', 'n') ? ['deny', `${shown} skips the repo's commit hooks, including the commit gate. Fix what the hook reports instead.`] : null;
    case 'reset':
      return hasFlag(args, '--hard') || hasFlag(args, '--merge') ? ['deny', `${shown} throws away uncommitted work. Use \`git stash\` (recoverable) or \`git revert\`. ${YOURSELF}`] : null;
    case 'clean':
      return !hasFlag(args, '--dry-run', 'n') && hasFlag(args, '--force', 'f') ? ['deny', `${shown} deletes untracked files permanently. \`git clean -n\` lists them first. ${YOURSELF}`] : null;
    case 'branch':
      return hasFlag(args, '--force', 'f') || hasFlag(args, null, 'D') || hasFlag(args, null, 'M') || hasFlag(args, null, 'C')
        ? ['deny', `${shown} force-deletes, force-moves or overwrites a branch, which can orphan commits. Use \`git branch -d\`, or a new branch name. ${YOURSELF}`] : null;
    case 'checkout':
      return hasFlag(args, '--force', 'f') || hasFlag(args, null, 'B') || everyPath(args)
        ? ['deny', `${shown} discards local changes or resets a branch. ${YOURSELF}`] : null;
    case 'switch':
      return hasFlag(args, '--force', 'f') || hasFlag(args, '--discard-changes') || hasFlag(args, '--force-create', 'C')
        ? ['deny', `${shown} discards local changes or resets a branch. ${YOURSELF}`] : null;
    case 'restore':
      if (hasFlag(args, '--staged', 'S') && !hasFlag(args, '--worktree', 'W')) return null;
      return everyPath(args) ? ['deny', `${shown} discards local changes across the tree. ${YOURSELF}`] : null;
    case 'stash':
      if (args[0] === 'clear') return ['deny', `\`git stash clear\` drops every stash. ${YOURSELF}`];
      if (args[0] === 'drop') return ['ask', '`git stash drop` deletes a stash entry.'];
      return null;
    default:
      return null;
  }
}

// null (allow) or { decision: 'deny' | 'ask', reason }. A deny anywhere in the
// command wins over an ask. `cwd` and `repo` let a push to a feature branch
// through; without them every push asks.
export function checkCommand(command, { powershell = false, cwd, repo } = {}) {
  const text = String(command ?? '');
  // Fast path: no git and no base64-encoded PowerShell command anywhere.
  if (!/git/i.test(text) && !/\s-(e|ec|enc|encodedcommand)\s/i.test(text)) return null;
  let asked = null;
  for (const c of gitCommands(text, { powershell })) {
    const v = verdict(c, { cwd, repo });
    if (v?.[0] === 'deny') return { decision: 'deny', reason: v[1] };
    if (v?.[0] === 'ask') asked ??= { decision: 'ask', reason: v[1] };
  }
  return asked;
}

// For a tool whose shell is not known for sure (Cursor's `Shell` on Windows
// can be PowerShell or Git Bash), read the command both ways; the stricter wins.
export function checkShell(command, { shells = ['bash'], cwd, repo } = {}) {
  let result = null;
  for (const shell of shells) {
    const v = checkCommand(command, { powershell: shell === 'powershell', cwd, repo });
    if (v?.decision === 'deny') return v;
    result ??= v;
  }
  return result;
}

// Which shells a hook's tool name implies.
export function shellsFor(toolName, platform = process.platform) {
  if (toolName === 'PowerShell') return ['powershell'];
  if (toolName === 'Bash') return ['bash'];
  return platform === 'win32' ? ['bash', 'powershell'] : ['bash'];
}

// A command given as an argv array (["bash", "-lc", "git push -f"]), rejoined
// with bash quoting so the nested-shell unwrapping in shell.mjs still applies.
export function joinArgv(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');
}
