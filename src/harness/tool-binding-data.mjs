// Portable Harness data shared by the tool registry and the binding table. No host observation.
import bindingData from './tool-bindings.json' with { type: 'json' };

const deepFreeze = value => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
// Seeded with the 23 October 2026 Windows canary observations. Every change here ships in a new Core version.
export const toolBindings = deepFreeze(bindingData);
// Isolation that keeps the user's own configuration out of the observation. Inside-profile redirection never counts.
export const qualifyingIsolation = Object.freeze(['os-account', 'sandbox', 'env-redirect-outside-profile']);
/** Tools with at least one cell observed under qualifying isolation, in table order. */
export const observedToolIds = Object.freeze(toolBindings
  .filter(binding => Object.values(binding.layouts).some(layout =>
    layout.observations.some(item => qualifyingIsolation.includes(item.isolation))))
  .map(binding => binding.tool));
