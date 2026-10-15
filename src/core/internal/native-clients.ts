// Portable native client list shared by Node-side input handling and portable organization checks.
export const nativeClients = ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed'] as const;
export type NativeClientId = typeof nativeClients[number];
