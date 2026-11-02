import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ScenarioDeps } from './scenarios.js';
export declare const ORIENTATION_TOOLS: Tool[];
export type Rotation = {
    name: string;
    rotation_x: number;
    rotation_y: number;
    rotation_z: number;
};
export interface OrientationCandidateOptions {
    plateIndex: number;
    itemIndex?: number;
    rotation: Rotation;
    allowMoveXY?: boolean;
}
export declare function writeOrientationCandidate(source: string, output: string, options: OrientationCandidateOptions, signal?: AbortSignal): Promise<Record<string, any>>;
export declare function orientationRotations(source: string, plateIndex: number, itemIndex: number | undefined, search: 'orthogonal' | 'sampled', signal?: AbortSignal): Promise<Rotation[]>;
export declare function comparePrintOrientations(args: Record<string, unknown>, deps: ScenarioDeps): Promise<Record<string, any>>;
