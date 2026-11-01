import { Readable } from 'node:stream';
import JSZip from 'jszip';
export declare const MAX_PRINT_FILE_BYTES: number;
/** Read no more than the fixed print-artifact limit, even if the file grows. */
export declare function readBoundedPrintFile(filePath: string): Promise<Buffer>;
/** Entry names in archive order with their ZIP method, after the checks loadSafe3mfArchive makes (so a rewrite can keep order and compression). */
export declare function listSafe3mfEntries(bytes: Buffer): {
    name: string;
    stored: boolean;
}[];
/** Bounded native inflation prevents false size fields from making JSZip allocate
 * unbounded output. Populate JSZip only with the verified, uniquely named bytes. */
export declare function loadSafe3mfArchive(bytes: Buffer): Promise<JSZip>;
/**
 * One entry of a verified archive as a stream of inflated chunks, so a 40 MB+ plate G-code is never held whole. Every check of
 * loadSafe3mfArchive applies (the whole archive is validated first); inflation stops past the declared size, and the declared size
 * and CRC are checked at the end, where a mismatch errors the stream.
 */
export declare function streamSafe3mfEntry(bytes: Buffer, name: string): Readable;
/** streamSafe3mfEntry for a file on disk (the compressed archive is read, bounded; the entry is not inflated into one buffer). */
export declare function streamSafe3mfEntryFromFile(filePath: string, name: string): Promise<Readable>;
export declare function readSafe3mfArchive(filePath: string): Promise<{
    bytes: Buffer;
    zip: JSZip;
}>;
