export declare function sha256(value: string | Uint8Array): string;
export interface Snapshot {
    files: Record<string, string>;
    hash: string;
}
export declare function inside(root: string, file: string): string;
export declare function assertRegularPath(root: string, file: string, allowMissing?: boolean, allowDirectory?: boolean): Promise<void>;
/** Canonicalize a possibly missing path via its nearest existing ancestor. */
export declare function canonicalMissing(file: string): Promise<string>;
/** Ancestor directories of file (below root) that do not exist yet, outermost first. */
export declare function missingDirectories(root: string, file: string): Promise<string[]>;
/**
 * Fingerprint every regular file and symlink under the root. Symlinks are recorded
 * by their link text, never followed; writes through them are still rejected by
 * assertRegularPath. Inside a Git work tree only tracked and unignored files count,
 * so build caches and ignored artifacts neither slow planning nor make plans stale.
 */
export declare function snapshot(rootPath: string): Promise<Snapshot>;
/** Keep plans, journals and locks out of the user's version control without touching their ignore files. */
export declare function ignoreStateDirectory(stateDirectory: string): Promise<void>;
