import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ScenarioDeps } from './scenarios.js';
export declare const ORIENTATION_TOOLS: Tool[];
export declare function comparePrintOrientations(args: Record<string, unknown>, deps: ScenarioDeps): Promise<Record<string, any>>;
