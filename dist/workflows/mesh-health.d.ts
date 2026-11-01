import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export declare const MESH_HEALTH_TOOLS: Tool[];
export declare function analyzeMeshHealth(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>>;
