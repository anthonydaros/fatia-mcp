import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export declare const WASTE_TOOLS: Tool[];
export declare function analyzePrintWaste(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>>;
