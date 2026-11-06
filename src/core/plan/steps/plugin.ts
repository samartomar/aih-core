// `plugin` (Catalog 9, contract 8.1, 12): the CLI's own plugin install at the pin, after approval of the exact commands.
// The commands, the removal commands and the presence check come from the supplied tool profile's `plugins` argv
// templates, filled only from the step's own fields; a placeholder the step does not fill is refused, never guessed.
// Every step naming a `framework` is one indivisible plugin install grouped under that framework id (C68).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../../internal/canonical.js';
import { codeUnitCompare } from '../../internal/canonical.js';
import { knownCli } from '../tools.js';
import { problem, refusal, target } from './common.js';
import type { Json } from '../../types.js';
import type { StepHandler } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
// Catalog's one address grammar for repositories and marketplaces: an https URL on a named host (no credentials, query,
// fragment or whitespace; a repository path of plain segments), or a marketplace's `owner/repo` short form. Nothing an
// installer could read as an option, a local path, a remote helper or credentials.
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const isRepository = (value: string): boolean => {
  const match = value.length <= 2048 ? /^https:\/\/([^/]+)\/(.+)$/.exec(value) : null;
  if (!match || !HOST.test(match[1]!)) return false;
  const segments = match[2]!.split('/');
  return segments.length <= 16 && segments.every(part => SEGMENT.test(part));
};
const isMarketplace = (value: string): boolean => {
  if (value.length <= 256 && value.split('/').length === 2 && value.split('/').every(part => SEGMENT.test(part))) return true;
  const match = value.length <= 2048 && !/[\s"%]/.test(value) ? /^https:\/\/([^/?#@]+)(\/[^?#@]*)?$/.exec(value) : null;
  return !!match && HOST.test(match[1]!);
};
const PLACEHOLDER = /<([a-z-]+)>/g;
type Argv = string[];
const isArgv = (value: unknown): value is Argv => Array.isArray(value) && value.length > 0 && value.length <= 64 &&
  value.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !arg.includes('\0'));
const isArgvList = (value: unknown): value is Argv[] => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(isArgv);
const plain = (value: unknown): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);
const under = (sourcePath: string, folder: string): boolean => folder === '/' || folder === '' || sourcePath.startsWith(folder.replace(/\/$/, '') + '/');

export const plugin: StepHandler = {
  op: 'plugin',
  prepare(step, context) {
    const { index, request } = context;
    const { cli, framework, plugin: name, repository, commit, scanKey } = step;
    if (typeof framework !== 'string' || !ID.test(framework) || typeof cli !== 'string' || !ID.test(cli) ||
        // Nothing a CLI would read as an option, or a command processor would read inside quotes.
        typeof name !== 'string' || name.length === 0 || name.length > 256 || /[<>\s"%\u0000-\u001f\u007f]/.test(name) || name.startsWith('-') ||
        typeof repository !== 'string' || repository.length > 512 || !isRepository(repository) ||
        typeof commit !== 'string' || !COMMIT.test(commit) || typeof scanKey !== 'string' || scanKey.length === 0 ||
        step.marketplaceName !== undefined && (typeof step.marketplaceName !== 'string' || !ID.test(step.marketplaceName)))
      return problem(index, '', 'plugin', 'A plugin step names its `cli`, `framework`, `plugin`, `repository`, exact `commit` and `scanKey`.');
    // Catalog marks a step whose install can still land on another commit `pin: "unverified"`; nothing else is its shape.
    if (step.pin !== undefined && step.pin !== 'unverified')
      return problem(index, 'pin', 'pin', 'A plugin step\'s `pin` is absent or `"unverified"`.');
    const unverifiedPin = step.pin === 'unverified';
    if (!knownCli(cli)) return refusal('tool-unknown', `Step ${index} names CLI \`${cli}\`, which has no registry tool.`, index, { tool: cli });
    // The marketplace is an https URL or `owner/repo`, or a marketplace the plan writes itself, resolved to its absolute folder.
    let marketplace: string | undefined;
    if (typeof step.marketplace === 'string') {
      if (!isMarketplace(step.marketplace)) return problem(index, 'marketplace', 'marketplace', 'A marketplace is an https URL, `owner/repo` or `{ root, path }`.');
      marketplace = step.marketplace;
    } else if (plain(step.marketplace)) {
      const placed = target(step.marketplace as never, index); if (!('root' in placed)) return placed;
      const base = placed.root === 'user' ? homedir() : request.target.project;
      if (typeof base !== 'string') return problem(index, 'marketplace', 'project', 'A project marketplace needs the request to name its project.');
      marketplace = join(base, ...placed.path.split('/'));
    } else if (step.marketplace !== undefined) return problem(index, 'marketplace', 'marketplace', 'A marketplace is an https URL, `owner/repo` or `{ root, path }`.');

    const profile = request.profiles.find(entry => entry.id === cli);
    if (!profile) return refusal('profile-mismatch', `Step ${index} installs a plugin for \`${cli}\`, but no \`${cli}\` profile was supplied.`, index, { tool: cli });
    const route = plain(profile.plugins) ? profile.plugins : undefined;
    const verify = route?.verify;
    const declared = verify === 'none' ? 'none' : plain(verify) && isArgv(verify.argv) && typeof verify.expect === 'string' &&
      verify.expect.length > 0 && verify.expect.length <= 4096 && Object.keys(verify).length === 2 ? { argv: verify.argv as Argv, expect: verify.expect } : undefined;
    if (!route || route.pin !== 'holds' || !isArgvList(route.install) || route.remove !== undefined && !isArgvList(route.remove) || !declared ||
        Array.isArray(route.scopes) && !route.scopes.includes(request.scope))
      return refusal('plugin-command-unresolved', `The \`${cli}\` profile gives no unattended, pinned plugin install at ${request.scope} scope for step ${index}.`, index);
    // Catalog copies the profile's check into the step; a different one means another profile made the plan.
    if (step.verify !== undefined && canonicalJson(step.verify) !== canonicalJson(declared as Json))
      return refusal('profile-mismatch', `Step ${index}'s presence check differs from the supplied \`${cli}\` profile's.`, index, { tool: cli });

    const values: Record<string, string | undefined> = { plugin: name, marketplace, 'marketplace-name': step.marketplaceName as string | undefined,
      repository, commit, scope: request.scope };
    let unfilled: string | undefined;
    const fill = (text: string): string => text.replace(PLACEHOLDER, (whole, key: string) => {
      const value = Object.hasOwn(values, key) ? values[key] : undefined;
      if (value === undefined) { unfilled ??= key; return whole; }
      return value;
    });
    const commands = (route.install as Argv[]).map(argv => argv.map(fill));
    const undo = route.remove === undefined ? null : (route.remove as Argv[]).map(argv => argv.map(fill));
    const presenceCheck = declared === 'none' ? 'none' as const : { argv: declared.argv.map(fill), expect: fill(declared.expect) };
    if (unfilled !== undefined)
      return refusal('plugin-command-unresolved', `The \`${cli}\` profile's plugin command needs \`<${unfilled}>\`, which step ${index} does not give.`, index);

    // The items the plugin's recorded folder holds, from the framework's content document (Catalog `plugins`).
    const contains = new Set<string>();
    // Each contained skill's name: what a CLI that can switch one skill off keys it by (C45).
    const skills: Record<string, string> = {};
    for (const content of request.contents as unknown as { framework?: { id?: string }; plugins?: { sourceId: string; path: string; scanKey: string }[];
        items?: { id: string; kind?: unknown; name?: unknown; files: { sourceId: string; sourcePath: string }[] }[] }[]) {
      if (content.framework?.id !== framework) continue;
      for (const folder of content.plugins ?? []) if (folder.scanKey === scanKey)
        for (const item of content.items ?? []) if (item.files.length && item.files.every(file => file.sourceId === folder.sourceId && under(file.sourcePath, folder.path)))
        { contains.add(item.id); if (item.kind === 'skill' && typeof item.name === 'string' && SKILL.test(item.name)) skills[item.id] = item.name; }
    }
    const install = commands.at(-1)!.join(' ');
    const before = commands.slice(0, -1).map(argv => `\`${argv.join(' ')}\``).join(', then ');
    return { lowered: { kind: 'plugin', managementIds: [framework], root: request.scope, cli, plugin: name, commit, framework,
      contains: [...contains].sort(codeUnitCompare), ...(Object.keys(skills).length ? { skills } : {}), commands, undo, presenceCheck,
      sentence: `Runs \`${install}\`${before ? ` after ${before}` : ''}`,
      cantPromise: (unverifiedPin ? `The plan marks this pin unverified: the CLI may install another commit than ${commit}, and nothing checks the installed one. ` : '') +
        'Core can\'t show or promise what this command changes: it is the CLI\'s own program. ' +
        (presenceCheck === 'none' ? 'The profile gives no presence check, so the plugin stays unverified. ' : 'Core checks only that the plugin is listed. ') +
        (undo ? `Removal runs \`${undo.map(argv => argv.join(' ')).join('`, then `')}\`; nothing else is rolled back.` : 'Core has no removal command for this plugin.'),
      review: { framework, clis: [cli], ...(unverifiedPin ? { pin: 'unverified' as const } : {}) } } };
  }
};
