/**
 * Type declarations for the experimental renderer (`@aihq/core/report/render`).
 * The renderer reads a `ReportSnapshot` from the data module and returns HTML; it performs no
 * filesystem, network or acquisition work.
 */
import type { ReportSnapshot } from './data.mjs';

export interface RenderOptions {
  /** Page and heading title, 1 to 200 characters. Defaults to `AIH report`. */
  title?: string;
  /**
   * `report` (default) shows LIVE panels for supplied values and EMPTY panels for everything else.
   * `demo` shows the labelled V9 design sample and never renders the snapshot's values.
   */
  mode?: 'report' | 'demo';
}

/**
 * Render a self-contained offline HTML document. The snapshot is validated and re-projected by the
 * data module first; invalid input throws its `ReportInputError`, and invalid options throw `TypeError`.
 * Identical inputs produce identical bytes.
 */
export declare function renderReport(snapshot: ReportSnapshot, options?: RenderOptions): string;
