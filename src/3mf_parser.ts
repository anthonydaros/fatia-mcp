import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { ThreeMFData, BambuSlicerConfig, ThreeMFMetadata, ThreeMFObject, ThreeMFBuildItem, ThreeMFPlateObjects } from './types.js';
import * as fs from 'fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

// Parses Bambu Studio's JSON config data
function parseBambuJSONConfig(jsonData: any): Partial<BambuSlicerConfig> {
    const config: Partial<BambuSlicerConfig> = {};

    // Map known keys, converting types as needed
    if (jsonData.layer_height !== undefined) config.layer_height = parseFloat(jsonData.layer_height);
    if (jsonData.initial_layer_print_height !== undefined) config.first_layer_height = parseFloat(jsonData.initial_layer_print_height);
    if (jsonData.sparse_infill_density !== undefined) config.sparse_infill_density = parseFloat(jsonData.sparse_infill_density);
    if (jsonData.sparse_infill_pattern !== undefined) config.sparse_infill_pattern = String(jsonData.sparse_infill_pattern);
    if (jsonData.enable_support !== undefined) config.support_enabled = String(jsonData.enable_support) === '1' || String(jsonData.enable_support).toLowerCase() === 'true';
    if (jsonData.support_type !== undefined) config.support_type = String(jsonData.support_type);
    if (jsonData.support_angle !== undefined) config.support_threshold_angle = parseFloat(jsonData.support_angle);
    if (jsonData.raft_layers !== undefined) config.raft_layers = parseInt(String(jsonData.raft_layers), 10);
    if (jsonData.brim_width !== undefined) config.brim_width = parseFloat(jsonData.brim_width);
    if (jsonData.wall_loops !== undefined) config.wall_loops = parseInt(String(jsonData.wall_loops), 10);
    if (jsonData.top_shell_layers !== undefined) config.top_shell_layers = parseInt(String(jsonData.top_shell_layers), 10);
    if (jsonData.bottom_shell_layers !== undefined) config.bottom_shell_layers = parseInt(String(jsonData.bottom_shell_layers), 10);

    // Temperatures (handle potential arrays)
    if (Array.isArray(jsonData.nozzle_temperature) && jsonData.nozzle_temperature.length > 0) {
        config.nozzle_temperature = jsonData.nozzle_temperature.map((t: string | number) => parseFloat(String(t)));
    } else if (jsonData.nozzle_temperature !== undefined) {
         config.nozzle_temperature = [parseFloat(String(jsonData.nozzle_temperature))];
    }
    // Bed Temp (prefer initial layer temp)
    let bedTempKey = jsonData.hot_plate_temp_initial_layer !== undefined ? 'hot_plate_temp_initial_layer' : 'hot_plate_temp';
    if (jsonData[bedTempKey] !== undefined) {
         if (Array.isArray(jsonData[bedTempKey]) && jsonData[bedTempKey].length > 0) {
              config.bed_temperature = parseFloat(String(jsonData[bedTempKey][0]));
         } else {
             config.bed_temperature = parseFloat(String(jsonData[bedTempKey]));
         }
    }
    
    // Filaments and Flow (handle potential arrays)
    if (Array.isArray(jsonData.filament_type) && jsonData.filament_type.length > 0) {
        config.filament_type = jsonData.filament_type.map(String);
    }
    if (Array.isArray(jsonData.filament_flow_ratio) && jsonData.filament_flow_ratio.length > 0) {
        config.flow_ratio = jsonData.filament_flow_ratio.map((f: string | number) => parseFloat(String(f)));
    }

    // Store remaining keys found in the config
    for (const key in jsonData) {
        if (!config.hasOwnProperty(key)) {
            // Simple assignment for remaining keys, preserving original type if possible
            config[key] = jsonData[key]; 
        }
    }

    return config;
}

async function parseBambuConfig(zip: JSZip): Promise<Partial<BambuSlicerConfig>> {
    // Look for common Bambu config file names
    const potentialFiles = [
        'Metadata/project_settings.config',
        'Metadata/Slic3r_PE.config',
        'Metadata/model_settings.config',
        'Metadata/slice_info.config'
    ];
    let configFile = null;
    let configContent = '';

    for (const name of potentialFiles) {
        const file = zip.file(name);
        if (file) {
            configFile = file;
            configContent = await file.async('string');
            console.error(`Found Bambu config file: ${configFile.name}`);
            break; // Use the first one found (project usually has the most)
        }
    }

    if (configFile && configContent) {
        try {
            // Attempt to parse as JSON
            const jsonData = JSON.parse(configContent);
            const parsedConfig = parseBambuJSONConfig(jsonData);
            console.error('Bambu config parsed successfully as JSON.');
            return parsedConfig;
        } catch (jsonError: any) {
            console.warn(`Failed to parse ${configFile.name} as JSON: ${jsonError.message}. Attempting INI parse as fallback...`);
            // Fallback: Try parsing as INI if JSON fails (though unlikely based on sample)
            try {
                 const parsedConfig = parseFallbackINIConfig(configContent); // Keep a simple INI parser as fallback
                 console.error('Bambu config parsed successfully as INI (fallback).');
                 return parsedConfig;
            } catch (iniError: any) {
                 console.error(`Error parsing Bambu config ${configFile.name} as INI (fallback):`, iniError);
                 return {};
            }
        }
    } else {
        console.error('No Bambu-specific config file found in Metadata directory.');
        return {};
    }
}

// Fallback INI parser (Simplified version of the previous one)
function parseFallbackINIConfig(configContent: string): Partial<BambuSlicerConfig> {
     const config: Partial<BambuSlicerConfig> = {};
     const lines = configContent.split(/\r?\n/);
     for (const line of lines) {
         const trimmedLine = line.trim();
         if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) continue;
         const equalsIndex = trimmedLine.indexOf('=');
         if (equalsIndex === -1) continue;
         const key = trimmedLine.substring(0, equalsIndex).trim();
         const value = trimmedLine.substring(equalsIndex + 1).trim();
         // Simple assignment - no type conversion here for fallback
         config[key] = value;
     }
     return config;
 }

async function parse3DModelConfig(zip: JSZip): Promise<{ metadata: ThreeMFMetadata, objects: ThreeMFObject[], build: { items: ThreeMFBuildItem[] } }> {
    const modelFile = zip.file('3D/3dmodel.model');
    if (!modelFile) {
        throw new Error('3D/3dmodel.model not found in 3MF archive');
    }

    const modelContent = await modelFile.async('string');
    try {
        const parsedXml = await parseStringPromise(modelContent, {
            explicitArray: false, 
            mergeAttrs: true,
            charkey: 'value'
        });

        const modelData = parsedXml.model;
        if (!modelData) {
            throw new Error('Invalid 3dmodel.model format: <model> tag not found.');
        }

        const metadata: ThreeMFMetadata = { unit: modelData.unit || 'millimeter' };
        if (modelData.metadata) {
            const metas = Array.isArray(modelData.metadata) ? modelData.metadata : [modelData.metadata];
            metas.forEach((meta: any) => {
                if (meta.name && meta.value !== undefined) {
                    metadata[meta.name] = String(meta.value);
                }
            });
        }

        const objects: ThreeMFObject[] = [];
        if (modelData.resources?.object) {
            const resources = Array.isArray(modelData.resources.object) ? modelData.resources.object : [modelData.resources.object];
            resources.forEach((objResource: any) => {
                objects.push({
                    id: objResource.id, 
                    name: objResource.name,
                    type: objResource.type || 'model'
                    // Actual mesh data (vertices, triangles) is nested deeper if needed
                });
            });
        }

        const buildItems: ThreeMFBuildItem[] = [];
        if (modelData.build?.item) {
            const items = Array.isArray(modelData.build.item) ? modelData.build.item : [modelData.build.item];
            items.forEach((item: any) => {
                buildItems.push({
                    objectId: item.objectid,
                    transform: item.transform
                });
            });
        }

        console.error('3dmodel.model parsed successfully.');
        return { metadata, objects, build: { items: buildItems } };

    } catch (error: any) {
        console.error('Error parsing 3dmodel.model XML:', error);
        throw new Error(`Failed to parse 3dmodel.model: ${error.message}`);
    }
}

export { ThreeMFData };

export async function parse3MF(filePath: string): Promise<ThreeMFData> {
    console.error(`Parsing 3MF file: ${filePath}`);
    try {
        const data = await fs.readFile(filePath);
        const zip = await JSZip.loadAsync(data);

        // List files for debugging
        // const fileList = Object.keys(zip.files);
        // console.error('Files in 3MF:', fileList);

        const { metadata, objects, build } = await parse3DModelConfig(zip);
        const bambuConfig = await parseBambuConfig(zip);

        // Combine data into the final structure
        const combinedData: ThreeMFData = {
            metadata,
            objects,
            build,
            slicerConfig: bambuConfig
        };

        console.error('3MF parsing completed.');
        return combinedData;

    } catch (error: any) {
        console.error(`Error parsing 3MF file ${filePath}:`, error);
        throw new Error(`Failed to parse 3MF file: ${error.message}`);
    }
}

export async function extractBambuTemplateSettings(
    filePath: string,
    outputDir: string
): Promise<string> {
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    const potentialFiles = [
        'Metadata/project_settings.config',
        'Metadata/Slic3r_PE.config',
        'Metadata/model_settings.config',
        'Metadata/slice_info.config'
    ];

    for (const name of potentialFiles) {
        const file = zip.file(name);
        if (!file) continue;

        const content = await file.async('string');
        // Content hash in the name: templates sharing one TEMP_DIR must not overwrite each other.
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
        const { name: base, ext } = path.parse(name.replace(/\//g, '_'));
        const outputPath = path.join(outputDir, `${base}_${hash}${ext}`);
        await fs.writeFile(outputPath, content, 'utf8');
        return outputPath;
    }

    throw new Error(`No slicer settings config found in template 3MF: ${filePath}`);
}

/** Per-plate time, weight, filament use and slicer warnings from the parsed root <config> of a slice_info.config. */
export function sliceResultsFrom(config: any) {
    const list = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
    return list(config?.plate).map((plate) => {
        const metadata = Object.fromEntries(list(plate.metadata).map((item) => [item.key, item.value]));
        return {
            index: Number(metadata.index),
            prediction_s: Number(metadata.prediction),
            weight_g: Number(metadata.weight),
            filaments: list(plate.filament).map((filament) => ({
                type: filament.type,
                color: filament.color,
                used_g: Number(filament.used_g),
                used_m: Number(filament.used_m),
            })),
            warnings: list(plate.warning).map((warning) => ({
                msg: warning.msg,
                level: Number(warning.level),
                error_code: warning.error_code,
            })),
        };
    });
}

/** Per-plate time, weight, filament use and slicer warnings that Bambu Studio records in a sliced 3MF. */
export async function readSliceResults(filePath: string) {
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    const sliceInfo = zip.file('Metadata/slice_info.config');
    if (!sliceInfo) throw new Error(`Sliced 3MF has no Metadata/slice_info.config: ${filePath}`);
    const parsed = await parseStringPromise(await sliceInfo.async('string'), { explicitArray: false, mergeAttrs: true });
    return sliceResultsFrom(parsed?.config);
}

export async function analyze3MFPlateObjects(
    filePath: string,
    plateIndex: number = 0
): Promise<ThreeMFPlateObjects> {
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    const plateName = `Metadata/plate_${plateIndex + 1}.json`;
    const plateFile = zip.file(plateName);

    if (!plateFile) {
        throw new Error(`3MF is missing ${plateName}; cannot list plate objects.`);
    }

    const plateJson = JSON.parse(await plateFile.async('string'));
    const bboxObjects = Array.isArray(plateJson?.bbox_objects) ? plateJson.bbox_objects : [];
    const sliceInfoObjects: Array<{ id: number; name: string | null }> = [];
    const sliceInfo = zip.file('Metadata/slice_info.config');

    if (sliceInfo) {
        try {
            const parsed = await parseStringPromise(await sliceInfo.async('string'), {
                explicitArray: false,
                mergeAttrs: true,
            });
            const plateNodes = parsed?.config?.plate
                ? Array.isArray(parsed.config.plate) ? parsed.config.plate : [parsed.config.plate]
                : [];
            const plateNumber = plateIndex + 1;
            const selectedPlate =
                plateNodes.find((plate: any) => {
                    const metadata = Array.isArray(plate?.metadata)
                        ? plate.metadata
                        : plate?.metadata
                            ? [plate.metadata]
                            : [];
                    return metadata.some((item: any) => item?.key === 'index' && Number(item?.value) === plateNumber);
                }) || plateNodes[plateIndex] || plateNodes[0];
            const objectNodes = selectedPlate?.object
                ? Array.isArray(selectedPlate.object) ? selectedPlate.object : [selectedPlate.object]
                : [];
            for (const object of objectNodes) {
                const id = Number.parseInt(String(object?.identify_id ?? ''), 10);
                if (!Number.isInteger(id)) continue;
                sliceInfoObjects.push({
                    id,
                    name: typeof object?.name === 'string' ? object.name : null,
                });
            }
        } catch {
            // Fall back to bbox IDs for older or malformed 3MFs.
        }
    }

    return {
        plateIndex,
        objects: bboxObjects
            .map((object: any, index: number) => {
                const sliceObject = sliceInfoObjects[index];
                const id = sliceObject?.id ?? Number(object?.id);
                if (!Number.isInteger(id)) return null;
                return {
                    id,
                    name: sliceObject?.name || (typeof object?.name === 'string' ? object.name : `object_${id}`),
                    area: Number.isFinite(Number(object?.area)) ? Number(object.area) : null,
                    bbox: object?.bbox ?? null,
                };
            })
            .filter((object: unknown): object is NonNullable<typeof object> => object !== null),
    };
}
