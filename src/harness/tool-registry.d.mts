export type ToolSurface = 'cli' | 'ide';
export interface RegistryTool {
  readonly id: string; readonly label: string; readonly surface: ToolSurface;
  readonly binaries: readonly string[]; readonly aliases: readonly string[];
}
export interface ToolRegistry { readonly schema: 'urn:aihq:harness:tool-registry:1.0.0'; readonly tools: readonly RegistryTool[] }
export type ToolSelection =
  | { status: 'selected'; tool: RegistryTool }
  | { status: 'refused'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'tool-not-observed'; tool: RegistryTool }
  | { status: 'refused'; code: 'INPUT_INVALID'; reason: 'unknown-tool' };
export declare const toolRegistry: ToolRegistry;
export declare function listTools(options?: { includeUnobserved?: boolean }): readonly RegistryTool[];
export declare function selectTool(id: string): ToolSelection;
export declare function validateToolRegistry(value: unknown): {
  valid: boolean; diagnostics: { code: string; reason: string; path: string; message: string; encountered?: string; supported?: string[] }[];
};
