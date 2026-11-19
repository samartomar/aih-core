export interface ObserveClaudePluginsRequest { project: string; home: string }
export interface ObservedClaudePlugin {
  name: string; source: string; path: string; builtin: boolean; version?: string;
}
/** Complete control-protocol enumeration, not native tool/hook execution or verifyClient qualification. */
export interface ObserveClaudePluginsResult {
  status: 'observed' | 'unconfirmed'; plugins: ObservedClaudePlugin[]; reason?: string; checkedAt: string;
  scope: 'plugin-control-readback'; hooks: 'disabled'; mcp: 'disabled'; modelTurnRequested: false;
  client?: { path: string; sha256: string };
}
/** Uses only an explicit credential-free home and project, with their existing plugin registration/cache. */
export declare function observeClaudePlugins(request: ObserveClaudePluginsRequest): Promise<ObserveClaudePluginsResult>;
