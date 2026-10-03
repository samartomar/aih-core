// Portable support presentation over existing public results. Importing or
// calling these functions performs no host access, process execution,
// network, writes or state lookup.
import type { Diagnostic } from './types.js';

export type SupportPlatform = 'win32' | 'darwin' | 'linux' | 'unknown';
export interface SupportRepairContext { id: string; targets: string[] }
export type SupportInput =
  | { kind: 'inspect'; result: unknown }
  | { kind: 'prepare'; result: unknown; repair?: SupportRepairContext }
  | { kind: 'run'; result: unknown; repair?: SupportRepairContext };
export interface SupportOptions { platform: SupportPlatform }
export interface GuidanceRepairInput { name: string; type: string; description: string }
export interface GuidanceRepair { id: string; targets: string[]; requiredInputs: GuidanceRepairInput[] }
export interface GuidanceItem {
  id: string;
  target: string;
  reason: string;
  audience: 'developer' | 'administrator';
  summary: string;
  steps: string[];
  evidenceIds: string[];
  repairs: GuidanceRepair[];
}
export interface GuidanceResult { status: 'complete' | 'invalid'; items: GuidanceItem[]; diagnostics: Diagnostic[] }
export interface SupportMarkdownResult { status: 'rendered' | 'invalid'; markdown?: string; diagnostics: Diagnostic[] }

const invalid = (): Diagnostic => ({ code: 'INPUT_INVALID', reason: 'support-input', message: 'Use a supported public result.' });

/** Skeleton: replaced by the shipped adapter and rules. */
export function getGuidance(input: SupportInput, options: SupportOptions): GuidanceResult {
  void input; void options;
  return { status: 'invalid', items: [], diagnostics: [invalid()] };
}

/** Skeleton: replaced by the allowlisted renderer. */
export function renderSupportMarkdown(input: SupportInput, options: SupportOptions): SupportMarkdownResult {
  void input; void options;
  return { status: 'invalid', diagnostics: [invalid()] };
}
