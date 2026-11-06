export interface SignerRecord {
  readonly identity: string; readonly issuer: string; readonly subject: string;
  readonly extensions?: Readonly<Record<string, string>>;
}
export interface SignerRecords { readonly schema: 'urn:aihq:core:signer-records:0.1.0'; readonly signers: readonly SignerRecord[] }
/** The default allowed Scan signers; an organization's `scanSigners` replaces or extends them. */
export declare const signerRecords: SignerRecords;
