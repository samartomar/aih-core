// Portable data checks only. Cryptographic trust decisions belong to the host.
export function snapshotTrustData(input) {
  let nodes = 0, characters = 0;
  const ancestors = new Set();
  const copy = (value, depth) => {
    if (++nodes > 65536 || depth > 64) throw new Error('trust-limit');
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > 1048576) throw new Error('trust-limit');
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('trust-shape');
    const array = Array.isArray(value);
    if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('trust-shape');
    if (array && value.length > 65536) throw new Error('trust-limit');
    ancestors.add(value);
    const result = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 65536 || array && keys.length !== value.length + 1) throw new Error('trust-shape');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor) ||
          array && !/^(?:0|[1-9][0-9]*)$/.test(key)) throw new Error('trust-shape');
      characters += key.length;
      if (characters > 1048576) throw new Error('trust-limit');
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  };
  const snapshot = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 1048576) throw new Error('trust-limit');
  return snapshot;
}

export function boundedBase64(value, maxBytes, exactBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('trust-base64');
  const binary = atob(value);
  if (binary.length > maxBytes || exactBytes !== undefined && binary.length !== exactBytes || btoa(binary) !== value)
    throw new Error('trust-base64');
  return binary;
}
