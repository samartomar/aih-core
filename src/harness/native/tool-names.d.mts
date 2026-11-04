import type { NativeClientId, NativeValidationResult, NativeVerificationDefinition } from './contracts.mjs';
/** A tool registry id (contract 6). */
export type NativeToolId = string;
export type NativeClientDefinition = Omit<NativeVerificationDefinition, 'schema' | 'client'> & {
  schema: 'urn:aihq:core:native-verification-definition:0.1.0'; client: NativeToolId };
export const NATIVE_DEFINITION_010: 'urn:aihq:core:native-verification-definition:0.1.0';
export const NATIVE_TEST_IDENTITY_010: 'urn:aihq:core:native-test-identity:0.1.0';
export const nativeClientOfTool: Readonly<Record<string, NativeClientId>>;
export const toolOfNativeClient: Readonly<Record<string, NativeToolId>>;
export const nativeClientDefinitions: readonly Readonly<NativeClientDefinition>[];
export function validateNativeVerificationDefinition(value: unknown): NativeValidationResult;
export function validateNativeTestIdentity(value: unknown): NativeValidationResult;
