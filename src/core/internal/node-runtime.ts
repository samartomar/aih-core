/** Runtime policy for Node host execution; portable imports have no host requirement. */
export function nodeRuntimeSupported(): boolean {
  const [major, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
  return major === 26 && (minor > 12 || minor === 12 && patch >= 1);
}
