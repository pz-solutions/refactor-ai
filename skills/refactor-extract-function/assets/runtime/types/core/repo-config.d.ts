/** Committable planning defaults, e.g. `{"verify":"bindings","checker":"ts7"}`. */
export interface RepoConfig {
    verify?: "full" | "bindings";
    checker?: "ts5" | "ts7" | "both";
}
/** `<root>/.refactor-ai/config.json`; absent means no defaults. Explicit plan options always win. */
export declare function readRepoConfig(root: string): Promise<RepoConfig>;
