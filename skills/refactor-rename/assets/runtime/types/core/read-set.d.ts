export declare const inputMethods: readonly ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"];
export interface ReadSetEntry {
    method: typeof inputMethods[number];
    args: any[];
    digest: string;
}
export declare const inputHash: (value: unknown) => string;
export declare function assertReadSetShape(inputs: ReadSetEntry[]): void;
/** Loaded only for plans that recorded TypeScript inputs; C# has no TS dependency. */
export declare function assertReadSetFresh(inputs: ReadSetEntry[], compilerBase?: string): Promise<void>;
