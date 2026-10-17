/**
 * Machine-local path shapes shared by the reporting data modules.
 *
 * Internal to the package: not a public export. The snapshot projection masks
 * home paths with `maskHomePaths`; claim-set validation refuses any string for
 * which `localPathKind` names a form. `localPathKind` also refuses any string
 * `maskHomePaths` would change, so every home path the projection masks is
 * refused in a portable claim set by construction. Pure string
 * functions: no host, environment or filesystem access.
 */

// Shared fragments. A Windows drive root such as `C:\` or `c:/`, and the
// directories that hold per-user homes.
const DRIVE_ROOT = String.raw`[A-Za-z]:[\\/]`;
const WINDOWS_HOME_ROOTS = String.raw`(?:Users|Documents and Settings)`;
const UNIX_HOME_ROOTS = String.raw`(?:home|Users)`;

// Snapshot masking: a home directory up to its first separator. A Windows
// account name may contain spaces, so it ends at a separator or delimiter.
const WINDOWS_HOME = new RegExp(String.raw`${DRIVE_ROOT}${WINDOWS_HOME_ROOTS}[\\/](?:[^\\/:\r\n\t"'<>;|?*]+(?=[\\/]|$|["';\r\n\t|?*<>]|:(?![\\/]))|[^\s\\/:"'<>;|?*]+)`, 'gi');
const UNIX_HOME = new RegExp(String.raw`\/${UNIX_HOME_ROOTS}\/[^/\s"'<>;]+`, 'g');

/** Replace every home-directory prefix in `text` with `replacement`. */
export function maskHomePaths(text, replacement) {
  return text.replace(WINDOWS_HOME, replacement).replace(UNIX_HOME, replacement);
}

// Detection. A path must begin a token: at the start of the string or after
// whitespace, a quote, an opening bracket, `>`, `|`, `-` or a `=`, `,`, `;` or
// `:` separator, so `and/or`, `@scope/name` and `src/app.ts` are never paths.
const TOKEN_START = String.raw`(?<=^|[\s"'\x60(\[{<>|=,;:-])`;
const SEGMENT = String.raw`[^\s/\\"'<>|]+`;
// Well-known absolute roots. An absolute token that starts with one is a path.
const POSIX_ROOTS = new Set([
  'home', 'Users', 'root', 'tmp', 'var', 'etc', 'opt', 'usr', 'srv', 'mnt', 'media', 'private', 'Volumes',
  'Library', 'Applications', 'System', 'Network', 'run', 'proc', 'sys', 'dev', 'bin', 'sbin', 'lib', 'lib64',
  'boot', 'nix', 'snap', 'cygdrive', 'workspace', 'workspaces',
]);
// One absolute token: a `/` starting a token, up to the next delimiter.
const ABSOLUTE_TOKEN = new RegExp(String.raw`${TOKEN_START}\/([^\s\\"'<>|()\[\]{},;\x60]*)`, 'g');
const FILE_NAME = /[^.]\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const DOT_ENTRY = /^\.[A-Za-z]/;

// A file URL needs `file:/`; `file:` in prose (`Config file: x`) is not a URL.
const FILE_URL = /(?<![A-Za-z0-9+.-])file:\//i;
// A non-file URL is a remote address, not a local path; its body is skipped.
const REMOTE_URL = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*/g;

/** Ordered so the most specific form is reported. */
const LOCAL_PATH_FORMS = Object.freeze([
  ['unc', new RegExp(String.raw`(?<![\\\w])\\\\${SEGMENT}\\`)],
  ['home-relative', new RegExp(String.raw`${TOKEN_START}~(?:[A-Za-z_][\w.-]*)?[\\/]`)],
  ['windows-drive', new RegExp(String.raw`(?<![A-Za-z0-9+.-])${DRIVE_ROOT}`)],
]);

/**
 * Whether `text` holds an absolute POSIX path. JSON Pointers and routes such as
 * `/claims/0/subject` or `/api/v1/users` are not paths: a token is a path only
 * when it starts at a well-known root (`/etc/hosts`, `/tmp`) or has a file-name
 * or dot-entry shape (`/data/app/config.json`, `/x/.ssh`).
 */
function hasPosixAbsolute(text) {
  for (const match of text.matchAll(ABSOLUTE_TOKEN)) {
    const segments = match[1].replace(/[.:!?]+$/, '').split('/');
    // `//host/share` is a protocol-relative URL or forward-slash UNC; neither is detected.
    if (segments[0] === '' && segments.length > 1) continue;
    if (POSIX_ROOTS.has(segments[0])) return true;
    if (segments.some((segment) => DOT_ENTRY.test(segment))) return true;
    if (segments.length > 1 && FILE_NAME.test(segments[segments.length - 1])) return true;
  }
  return false;
}

/**
 * The form of the first machine-local path in `text`, or null when it has none:
 * `file-url`, `unc`, `home-relative`, `windows-drive`, `posix-absolute`, or
 * `home-directory` for any other string the snapshot projection would mask, so
 * every string a snapshot masks as a home path is refused by construction.
 * Repository-relative paths, JSON Pointers and non-file URLs are not local.
 */
export function localPathKind(text) {
  if (FILE_URL.test(text)) return 'file-url';
  // Any file: URL has already returned, so every remaining URL is remote.
  const remote = text.replace(REMOTE_URL, ' ');
  for (const [kind, pattern] of LOCAL_PATH_FORMS) if (pattern.test(remote)) return kind;
  if (hasPosixAbsolute(remote)) return 'posix-absolute';
  if (maskHomePaths(text, '') !== text) return 'home-directory';
  return null;
}
