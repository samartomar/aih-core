// What git-policy needs to know about the repo a push runs in: the current
// branch, the remote a bare `git push` uses, and the remote's default branch.
// Each lookup returns null when it can't tell, and the policy then asks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(dir, args, timeout = 3000) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch { return null; }
}

// Memoised per call site: one hook run may read the command as bash and as
// PowerShell, and the default-branch lookup can go over the network.
export function gitContext({ approvalsFile = path.join(process.env.AIH_EXTENSIONS_HOME || path.join(os.homedir(), '.aih-extensions'), 'push-approvals.json') } = {}) {
  const seen = new Map();
  const memo = (name, fn) => (...a) => {
    const key = `${name}\0${a.join('\0')}`;
    if (!seen.has(key)) seen.set(key, fn(...a));
    return seen.get(key);
  };
  return Object.fromEntries(Object.entries({
    ...lookups,
    protectedPushAllowed: (dir, remote, branch) => approvedPush(approvalsFile, dir, remote, branch),
  }).map(([k, fn]) => [k, memo(k, fn)]));
}

function approvedPush(file, dir, remote, branch) {
  if (!branch || git(dir, ['check-ref-format', `refs/heads/${branch}`]) === null) return false;
  if (git(dir, ['config', '--bool', '--get', 'push.followTags']) === 'true'
    || git(dir, ['config', '--bool', '--get', `remote.${remote}.mirror`]) === 'true'
    || git(dir, ['config', '--get-all', `remote.${remote}.push`])) return false;
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (config?.version !== 1 || !Array.isArray(config.protectedPushes)) return false;
  const urls = git(dir, ['remote', 'get-url', '--push', '--all', '--', remote]);
  if (!urls) return false;
  // Git expands pushInsteadOf and pushurl here. Every destination must be approved.
  return urls.split(/\r?\n/).every((url) => config.protectedPushes.some((entry) =>
    entry?.url === url && Array.isArray(entry.branches) && entry.branches.includes(branch)));
}

const lookups = {
  currentBranch: (dir) => git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) || null,
  pushRemote: (dir, branch) => (branch && git(dir, ['config', `branch.${branch}.pushRemote`]))
    || git(dir, ['config', 'remote.pushDefault'])
    || (branch && git(dir, ['config', `branch.${branch}.remote`]))
    || 'origin',
  // The local record of the remote's HEAD when there is one (set by clone),
  // otherwise ask the remote itself (GitHub's default branch setting).
  defaultBranch(dir, remote) {
    const local = git(dir, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]);
    if (local) return local.slice(local.indexOf('/') + 1);
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(git(dir, ['ls-remote', '--symref', remote, 'HEAD'], 6000) ?? '');
    return m ? m[1] : null;
  },
  isTag: (dir, name) => git(dir, ['show-ref', '--verify', '--quiet', `refs/tags/${name}`]) !== null,
};
