export declare function sha256(value: string | Uint8Array): string;
export interface Snapshot {
    files: Record<string, string>;
    hash: string;
}
export declare function inside(root: string, file: string): string;
export declare function assertRegularPath(root: string, file: string, allowMissing?: boolean): Promise<void>;
/** Canonicalize a possibly missing path via its nearest existing ancestor. */
export declare function canonicalMissing(file: string): Promise<string>;
/** Ancestor directories of file (below root) that do not exist yet, outermost first. */
export declare function missingDirectories(root: string, file: string): Promise<string[]>;
export declare function snapshot(rootPath: string): Promise<Snapshot>;
