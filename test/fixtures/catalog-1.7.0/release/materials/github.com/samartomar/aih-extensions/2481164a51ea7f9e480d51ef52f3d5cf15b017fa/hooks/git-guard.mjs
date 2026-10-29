#!/usr/bin/env node
// PreToolUse guard for shell commands: deny destructive git commands, and
// commands that skip the repo's commit hooks; ask before a push to main, master
// or the remote's default branch.
// Speaks Claude Code's hook protocol, which Cursor (through its Claude import)
// and Kimi Code also read. --no-ask is for a CLI that ignores "ask" (Kimi): a
// push is refused there instead of going through unconfirmed. --any-shell is
// for a CLI that calls its shell tool Bash whatever it runs (Codex on Windows).
import fs from 'node:fs';
import { checkShell, shellsFor, joinArgv } from './lib/git-policy.mjs';
import { gitContext } from './lib/git-context.mjs';

const noAsk = process.argv.includes('--no-ask');
const out = (decision, reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `aih-extensions git-guard: ${reason}` } }));
  process.exit(0);
};

let input;
// Cursor on Windows pipes the payload through Windows PowerShell, which prefixes a BOM.
try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); } catch {
  out('deny', 'could not read its hook input, so it cannot check this command. Fix or disable the hook.');
}
const raw = input?.tool_input?.command ?? input?.command ?? '';
const command = Array.isArray(raw) ? joinArgv(raw) : String(raw);
const cwd = input?.cwd || input?.tool_input?.cwd || process.cwd();
const v = checkShell(command, { shells: shellsFor(process.argv.includes('--any-shell') ? '' : input?.tool_name), cwd, repo: gitContext() });
if (v?.decision === 'ask' && noAsk) out('deny', `${v.reason} This tool cannot pause to ask, so it is refused: ask the user to run it.`);
if (v) out(v.decision, v.reason);
process.exit(0);
