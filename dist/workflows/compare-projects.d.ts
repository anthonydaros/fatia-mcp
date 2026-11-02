import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export interface CompareProjectDeps {
    profilesRoot?: string;
    targetModel?: string;
    signal?: AbortSignal;
}
export declare const COMPARE_PROJECT_TOOLS: Tool[];
export declare function compareProjects(args: Record<string, unknown>, deps?: CompareProjectDeps): Promise<Record<string, unknown>>;
