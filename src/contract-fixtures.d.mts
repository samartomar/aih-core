export declare function describeContract<T extends { id: string }>(contract: T): T & {
  readonly versions: readonly string[];
  readonly fixtures: readonly { readonly export: string; readonly expect: 'accept' | 'refuse'; readonly code?: string }[];
};
