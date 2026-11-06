// One authored operation's key: its selection id and its operation id, `<selectionId>/<operationId>`. Plan
// preparation and the engine name operations this way in the order, merge and effect maps they share.

/** An authored operation's key, made only by `operationKey`. */
export type OperationKey = string & { readonly operationKey: unique symbol };

export function operationKey(selectionId: string, operationId: string): OperationKey {
  return `${selectionId}/${operationId}` as OperationKey;
}

/** The selection and operation ids of a key (a selection id never holds `/`). */
export function operationParts(key: OperationKey): { selectionId: string; operationId: string } {
  const at = key.indexOf('/');
  return { selectionId: key.slice(0, at), operationId: key.slice(at + 1) };
}
