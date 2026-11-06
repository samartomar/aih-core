export interface GuidanceLimit { readonly cli: string; readonly label: string; readonly file: string; readonly maxBytes: number }
export interface SwitchOffRoute { readonly cli: string; readonly file: readonly string[]; readonly table: readonly string[] }
export interface InspectTarget { readonly target: string; readonly tool: string; readonly binary?: string }
export declare const cliFacts: {
  readonly profiled: readonly string[];
  readonly junctionLinks: readonly string[];
  readonly guidanceLimits: readonly GuidanceLimit[];
  readonly switchOff: readonly SwitchOffRoute[];
  readonly inspectTargets: readonly InspectTarget[];
};
export declare function guidanceLimit(clis: readonly string[], file: string): GuidanceLimit | undefined;
export declare function switchOffRoute(cli: string): SwitchOffRoute | undefined;
export declare function inspectTargetOf(tool: string): string;
export declare function inspectToolOf(target: string, binary?: string): string | null;
