/**
 * Machine-local path shapes shared by the reporting data modules.
 *
 * Internal to the package: not a public export. The snapshot projection masks
 * home paths with `maskHomePaths`; claim-set validation refuses any string for
 * which `localPathKind` names a form. Both are built from the same drive and
 * home-root fragments below, so the absolute home paths the projection masks
 * are always among the paths a portable claim set refuses. Pure string
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
// whitespace, a quote, an opening bracket or a `=`, `,`, `;` or `:` separator,
// so `and/or`, `@scope/name` and `src/app.ts` are never paths.
const TOKEN_START = String.raw`(?<=^|[\s"'\x60(\[{<=,;:])`;
const SEGMENT = String.raw`[^\s/\\"'<>|]+`;
// Well-known single-segment absolute roots, so `/tmp` alone is a path but a
// lone `/word` in prose is not.
const POSIX_ROOTS = String.raw`(?:home|Users|root|tmp|var|etc|opt|usr|srv|mnt|media|private|Volumes|run|proc|dev|bin|sbin|lib|workspace|workspaces)`;

const FILE_URL = /(?<![A-Za-z0-9+.-])file:/i;
// A non-file URL is a remote address, not a local path; its body is skipped.
const REMOTE_URL = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*/g;

/** Ordered so the most specific form is reported. */
const LOCAL_PATH_FORMS = Object.freeze([
  ['unc', new RegExp(String.raw`(?<![\\\w])\\\\${SEGMENT}\\`)],
  ['home-relative', new RegExp(String.raw`${TOKEN_START}~(?:[A-Za-z_][\w.-]*)?[\\/]`)],
  ['windows-drive', new RegExp(String.raw`(?<![A-Za-z0-9+.-])${DRIVE_ROOT}`)],
  ['posix-absolute', new RegExp(String.raw`${TOKEN_START}\/(?:${SEGMENT}\/|${POSIX_ROOTS}(?![^\s/\\"'<>|]))`)],
]);

/**
 * The form of the first machine-local path in `text`, or null when it has none:
 * `file-url`, `unc`, `home-relative`, `windows-drive` or `posix-absolute`.
 * Repository-relative paths and non-file URLs are not local.
 */
export function localPathKind(text) {
  if (FILE_URL.test(text)) return 'file-url';
  // Any file: URL has already returned, so every remaining URL is remote.
  const remote = text.replace(REMOTE_URL, ' ');
  for (const [kind, pattern] of LOCAL_PATH_FORMS) if (pattern.test(remote)) return kind;
  return null;
}
