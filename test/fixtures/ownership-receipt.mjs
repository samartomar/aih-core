// Stored ownership receipts for tests that read or edit one directly. Ownership 1.7.0 stores a record without the
// data it derives from itself (see src/core/internal/ownership-storage.ts); every earlier version stores it as it is.
import { readFileSync, writeFileSync } from 'node:fs';
import { expandOwnership, storedOwnership } from '../../dist/core/internal/ownership-storage.js';

/** The record a stored receipt holds. */
export const recordOf = text => expandOwnership(JSON.parse(text));
export const readReceipt = path => recordOf(readFileSync(path, 'utf8'));
/** The stored text of a record: what Core writes for it. */
export const receiptText = record => JSON.stringify(storedOwnership(record));
export const writeReceipt = (path, record) => writeFileSync(path, receiptText(record));
