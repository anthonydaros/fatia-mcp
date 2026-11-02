export interface OptimizationOptions {
    objective: 'balanced' | 'time' | 'material';
    constraints: Partial<Record<'min_wall_loops' | 'min_infill_density' | 'min_top_shell_layers' | 'min_bottom_shell_layers' | 'max_layer_height' | 'max_outer_wall_speed' | 'max_outer_wall_acceleration', number>>;
    candidates?: Array<{
        name: string;
        settings: Record<string, unknown>;
    }>;
    allow_reorientation: boolean;
    targets: Array<{
        plate_index: number;
        item_index: number;
    }>;
}
export declare const OPTIMIZATION_SCHEMA: {
    type: string;
    additionalProperties: boolean;
    description: string;
    properties: {
        objective: {
            type: string;
            enum: string[];
            default: string;
            description: string;
        };
        constraints: {
            type: string;
            additionalProperties: boolean;
            description: string;
            properties: {
                [k: string]: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
            };
        };
        candidates: {
            type: string;
            minItems: number;
            maxItems: number;
            description: string;
            items: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    name: {
                        type: string;
                        minLength: number;
                        maxLength: number;
                    };
                    settings: {
                        type: string;
                        additionalProperties: boolean;
                        properties: any;
                    };
                };
            };
        };
        allow_reorientation: {
            type: string;
            default: boolean;
            description: string;
        };
        targets: {
            type: string;
            maxItems: number;
            description: string;
            items: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    plate_index: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    item_index: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                };
            };
        };
    };
};
export declare function parseOptimizationOptions(value: unknown): OptimizationOptions;
