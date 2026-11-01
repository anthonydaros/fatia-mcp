import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export declare const GEOMETRY_TOOLS: Tool[];
export declare function requireMillimeters(bytes: Buffer): void;
export declare function extractObjects(args: Record<string, unknown>, outputDir: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
export declare function createFitTest(args: Record<string, unknown>, outputDir: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
