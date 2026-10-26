// The shared entry-block marker contract for Project basics. Harness's renderer writes these
// exact marker lines around the shared guidance and the entry pointer it places in a tool's
// entry files; Core's custody recognizes the same markers to record typed `entry-block` and
// `entry-pointer` members, and to rescue a person's own lines on update. Both sides keep
// these two literals as one published contract, like the aih: marker syntax itself.
/** The shared guidance block: one per entry file, whoever wrote the guidance. */
export const SHARED_GUIDANCE = Object.freeze({
  startMarker: '<!-- BEGIN aih:shared -->',
  endMarker: '<!-- END aih:shared -->',
});
/** The entry pointer block: points the tool at the project's shared guidance folder. */
export const SHARED_POINTER = Object.freeze({
  startMarker: '<!-- BEGIN aih:shared:pointer -->',
  endMarker: '<!-- END aih:shared:pointer -->',
});
/** The blockId Harness gives the pointer operation; the guidance block keeps the item key. */
export const SHARED_POINTER_BLOCK_ID = 'aihq.entry-pointer';
/** The user-owned file an update moves a person's rescued lines into, inside the project folder. */
export const USER_NOTES_FILE = 'PROJECT.md';

/** Which shared block these exact markers name, or null for any other marker block. */
export function sharedBlockRole(startMarker: string, endMarker: string): 'guidance' | 'pointer' | null {
  if (startMarker === SHARED_GUIDANCE.startMarker && endMarker === SHARED_GUIDANCE.endMarker) return 'guidance';
  if (startMarker === SHARED_POINTER.startMarker && endMarker === SHARED_POINTER.endMarker) return 'pointer';
  return null;
}
/** The marker id recorded in custody, e.g. `aih:shared`; null for any other marker block. */
export function sharedBlockMarker(startMarker: string): string | null {
  const inner = /^<!-- BEGIN ([^>]+) -->$/.exec(startMarker);
  return inner && (inner[1] === 'aih:shared' || inner[1] === 'aih:shared:pointer') ? inner[1] : null;
}
/**
 * The person's own lines inside a live shared block: the lines of `liveBody` left after
 * removing one occurrence of each recorded line. Returns null when the live body is not a
 * superset of the recorded content (a line was deleted or modified), where rescue would not
 * be safe, or when there is nothing extra.
 */
export function personLinesInside(liveBody: string, recorded: string): string[] | null {
  // The recorded content ends with the newline that precedes the end marker, and the live body
  // is the lines between the markers: both carry one phantom trailing empty line, dropped here.
  const linesOf = (text: string): string[] => {
    const lines = text.split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const remaining = linesOf(liveBody);
  const recordedCounts = new Map<string, number>();
  for (const line of linesOf(recorded)) recordedCounts.set(line, (recordedCounts.get(line) ?? 0) + 1);
  for (const line of [...remaining]) {
    const count = recordedCounts.get(line);
    if (count) { recordedCounts.set(line, count - 1); remaining.splice(remaining.indexOf(line), 1); }
  }
  for (const count of recordedCounts.values()) if (count) return null;
  const extra = remaining.filter(line => line.trim() !== '');
  return extra.length ? extra : null;
}
/**
 * The normalized text between one exact unambiguous marker pair in `text`, or null when a
 * marker line is absent. The caller validates ambiguity first; CRLF and lone CR normalize
 * to LF so a body compares with the recorded content.
 */
export function extractBlockBody(text: string, startMarker: string, endMarker: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.indexOf(startMarker);
  if (start === -1) return null;
  const end = lines.indexOf(endMarker, start + 1);
  if (end === -1) return null;
  return lines.slice(start + 1, end).join('\n');
}
