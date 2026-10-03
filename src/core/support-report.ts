// Explicit host write of the portable support Markdown report. Only the
// portable renderer's Markdown is written, only to the exact caller-chosen
// path, and only on this explicit request.
import { renderSupportMarkdown, type SupportInput, type SupportPlatform } from './support.js';
import { writeExclusiveReportFile, type ReportFileResult } from './internal/report-file.js';

export interface WriteSupportReportOptions { platform: SupportPlatform; path: string; signal?: AbortSignal }
export type SupportReportResult = ReportFileResult;

const platforms: readonly string[] = ['win32', 'darwin', 'linux', 'unknown'];
const invalidOptions = (): SupportReportResult => ({
  status: 'invalid',
  diagnostics: [{ code: 'INPUT_INVALID', reason: 'invalid-options',
    message: 'Use exactly {platform, path, signal?} with a supported platform.' }]
});

export async function writeSupportReport(input: SupportInput, options: WriteSupportReportOptions): Promise<SupportReportResult> {
  const candidate: unknown = options;
  const plain = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(candidate));
  if (!plain) return invalidOptions();
  const keys = Object.keys(candidate);
  const { platform, path, signal } = candidate as WriteSupportReportOptions;
  if (keys.some(key => !['platform', 'path', 'signal'].includes(key)) ||
      typeof platform !== 'string' || !platforms.includes(platform) ||
      typeof path !== 'string' ||
      (signal !== undefined && !(signal instanceof AbortSignal))) return invalidOptions();
  if (signal?.aborted) return {
    status: 'cancelled',
    diagnostics: [{ code: 'CANCELLED', reason: 'cancelled', message: 'The report write was cancelled.' }]
  };
  const rendered = renderSupportMarkdown(input, { platform });
  if (rendered.status !== 'rendered' || rendered.markdown === undefined)
    return { status: 'invalid', diagnostics: rendered.diagnostics };
  return writeExclusiveReportFile(path, new TextEncoder().encode(rendered.markdown),
    signal === undefined ? {} : { signal });
}
