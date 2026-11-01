import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export declare const PROFILE_TOOLS: Tool[];
export declare function listSlicerProfiles(args: Record<string, unknown>, deps?: {
    slicerPath?: string;
    profilesRoot?: string;
    userProfileRoots?: string[];
}): Promise<Record<string, unknown>>;
