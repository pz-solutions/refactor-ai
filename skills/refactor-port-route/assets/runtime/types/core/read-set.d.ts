export declare const inputMethods: readonly ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"];
export interface ReadSetEntry {
    method: typeof inputMethods[number];
    args: any[];
    digest: string;
}
export declare const inputHash: (value: unknown) => string;
export declare function assertReadSetShape(inputs: ReadSetEntry[]): void;
/** Explain directory guards without dumping file contents or opaque digests. */
export declare function inputQueryDetails(input: ReadSetEntry): string;
/** Loaded only for plans that recorded TypeScript inputs; C# has no TS dependency. */
export declare function assertReadSetFresh(inputs: ReadSetEntry[], compilerBase?: string): Promise<void>;
