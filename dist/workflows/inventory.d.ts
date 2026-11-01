import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export declare const INVENTORY_TOOLS: Tool[];
export declare function checkFilamentAvailability(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>>;
