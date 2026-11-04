export type ToolSurface = 'cli' | 'ide';
export interface RegistryTool {
  readonly id: string; readonly label: string; readonly surface: ToolSurface;
  readonly binaries: readonly string[]; readonly aliases: readonly string[];
}
export interface ToolRegistry { readonly schema: 'urn:aihq:core:tool-registry:0.1.0'; readonly tools: readonly RegistryTool[] }
export interface RegistryProblem { path: string; reason: string; message: string }
export type ToolSelection =
  | { status: 'ok'; tool: RegistryTool; via: 'id' | 'alias' }
  | { status: 'refused'; code: 'tool-unknown'; reason: string };
export type ToolList = { status: 'ok'; tools: readonly RegistryTool[] } | { status: 'invalid'; problems: RegistryProblem[] };
export type ToolRegistryResult = { status: 'ok' } | { status: 'invalid'; problems: RegistryProblem[] } |
  { status: 'unsupported-version'; encountered: string; supported: string[] };
export declare const toolRegistry: ToolRegistry;
export declare function listTools(options?: { surface?: ToolSurface }): ToolList;
export declare function findTool(name: unknown): { tool: RegistryTool; via: 'id' | 'alias' } | undefined;
export declare function selectTool(name: unknown): ToolSelection;
export declare function validateToolRegistry(value: unknown): ToolRegistryResult;
