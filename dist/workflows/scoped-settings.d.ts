import type JSZip from 'jszip';
import { type ObjectEdit } from '../tuning/project-text.js';
export interface ScopedSettings {
    itemIndices: number[];
    settings: Record<string, string>;
}
export interface UniformLayers {
    height: string;
    itemIndices?: number[];
}
export declare function buildItems(zip: JSZip): Promise<Array<{
    objectId: string;
    path: string;
}>>;
export declare function applyScopedSettings(zip: JSZip, modelText: string, scoped: ScopedSettings[], uniform?: UniformLayers): Promise<{
    modelText: string;
    rewritten: Map<string, string>;
    edits: ObjectEdit[];
    uniformItemIndices: number[];
}>;
