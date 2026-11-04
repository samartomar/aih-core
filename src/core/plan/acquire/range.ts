// Interpreter version ranges as Catalog's `runtime.python` writes them (PEP 440 specifiers, the subset upstreams use):
// comma-separated `>=`, `>`, `<=`, `<`, `==` (optionally `.*`), `!=` and `~=` clauses over numeric release segments.
// A range Core cannot read is never guessed: `parseRange` returns `undefined` and the step is refused before effects.

type Clause = { op: '>=' | '>' | '<=' | '<' | '==' | '!=' | '~='; release: number[]; wildcard: boolean };
const CLAUSE = /^(>=|<=|==|!=|~=|>|<)\s*([0-9]+(?:\.[0-9]+){0,3})(\.\*)?$/;

export function parseRange(range: string): Clause[] | undefined {
  if (typeof range !== 'string' || range.length === 0 || range.length > 256) return undefined;
  const clauses: Clause[] = [];
  for (const part of range.split(',')) {
    const match = CLAUSE.exec(part.trim());
    if (!match) return undefined;
    const wildcard = match[3] !== undefined;
    if (wildcard && match[1] !== '==' && match[1] !== '!=') return undefined;
    if (match[1] === '~=' && match[2]!.split('.').length < 2) return undefined;
    clauses.push({ op: match[1] as Clause['op'], release: match[2]!.split('.').map(Number), wildcard });
  }
  return clauses;
}
/** A released version `X.Y.Z` (no pre-release or local part), or `undefined`. */
export function parseVersion(version: string): number[] | undefined {
  return typeof version === 'string' && /^[0-9]+(\.[0-9]+){0,3}$/.test(version) ? version.split('.').map(Number) : undefined;
}
function compare(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}
const prefix = (version: number[], release: number[]): boolean => release.every((part, index) => (version[index] ?? 0) === part);

export function inRange(version: string, range: string): boolean {
  const parsed = parseVersion(version); const clauses = parseRange(range);
  if (!parsed || !clauses) return false;
  return clauses.every(({ op, release, wildcard }) => {
    const order = compare(parsed, release);
    switch (op) {
      case '>=': return order >= 0;
      case '>': return order > 0;
      case '<=': return order <= 0;
      case '<': return order < 0;
      case '==': return wildcard ? prefix(parsed, release) : order === 0;
      case '!=': return wildcard ? !prefix(parsed, release) : order !== 0;
      case '~=': return order >= 0 && prefix(parsed, release.slice(0, -1));
    }
  });
}
