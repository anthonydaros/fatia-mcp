import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { flattenForCli, detectProfilesRoot, resolveBblMachineProfile } from '../slicer/profile-flatten.js';
import { profileJsonFiles } from '../slicer/profile-files.js';
import { buildProjectSettingsPlan, readProjectConfig } from '../slicer/project-settings.js';
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
// Best-effort: a leftover file is only wasted disk and must never fail a slice or mask its real error (Windows EBUSY/EPERM).
const removeQuietly = (target) => fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => { });
const BAMBU_PROFILE_ROOTS = [
    '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL',
];
const BAMBU_CLI_BED_TYPES = {
    textured_plate: 'Textured PEI Plate',
    cool_plate: 'Cool Plate',
    engineering_plate: 'Engineering Plate',
    hot_plate: 'High Temp Plate',
};
const MAIN_3MF_MODEL = '3D/3dmodel.model';
const attributeOf = (tag, name) => new RegExp(`\\s(?:\\w+:)?${name}="([^"]*)"`).exec(tag)?.[1];
// A 3MF transform is 12 numbers, a row-vector 3x4 matrix: x' = x*m00 + y*m10 + z*m20 + m30.
function matrixOf3MF(transform) {
    const matrix = new THREE.Matrix4();
    if (transform === undefined)
        return matrix;
    const t = transform.trim().split(/\s+/).map(Number);
    if (t.length !== 12 || !t.every(Number.isFinite))
        throw new Error(`Invalid 3MF transform "${transform}".`);
    return matrix.set(t[0], t[3], t[6], t[9], t[1], t[4], t[7], t[10], t[2], t[5], t[8], t[11], 0, 0, 0, 1);
}
/** Objects of one 3MF model file: mesh vertices (flat x,y,z) and component references. */
function parse3MFModel(xml) {
    const objects = new Map();
    for (const [, tag, body] of xml.matchAll(/<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
        const id = attributeOf(tag, 'id');
        if (!id)
            continue;
        const verts = [];
        for (const v of body.matchAll(/<(?:\w+:)?vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) {
            verts.push(parseFloat(v[1]), parseFloat(v[2]), parseFloat(v[3]));
        }
        const components = [...body.matchAll(/<(?:\w+:)?component\b([^>]*)>/g)].flatMap(([, ctag]) => {
            const componentId = attributeOf(ctag, 'objectid');
            return componentId ? [{ id: componentId, path: attributeOf(ctag, 'path'), matrix: matrixOf3MF(attributeOf(ctag, 'transform')) }] : [];
        });
        objects.set(id, { verts, faces: body.match(/<(?:\w+:)?triangle\s/g)?.length ?? 0, components });
    }
    return objects;
}
/** Andrew's monotone chain; returns the hull counter-clockwise. */
function convexHull(points) {
    const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const turn = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const half = (input) => {
        const chain = [];
        for (const point of input) {
            while (chain.length >= 2 && turn(chain[chain.length - 2], chain[chain.length - 1], point) <= 0)
                chain.pop();
            chain.push(point);
        }
        return chain.slice(0, -1);
    };
    return [...half(sorted), ...half(sorted.reverse())];
}
// Per-face normals, UVs and colours differ between corners of the same position and block merging; STL export needs positions only.
function keepPositionOnly(geometry) {
    for (const name of Object.keys(geometry.attributes))
        if (name !== 'position')
            geometry.deleteAttribute(name);
}
export const SLICER_TYPES = [
    'bambustudio',
    'prusaslicer',
    'cura',
    'slic3r',
];
const SLICER_TYPE_ALIASES = {
    bambustudio: 'bambustudio',
    'bambu-studio': 'bambustudio',
    bblstudio: 'bambustudio',
    prusaslicer: 'prusaslicer',
    'prusa-slicer': 'prusaslicer',
    cura: 'cura',
    curaengine: 'cura',
    slic3r: 'slic3r',
};
export function normalizeSlicerType(rawSlicerType) {
    const key = rawSlicerType.trim().toLowerCase().replace(/_/g, '-');
    const normalized = SLICER_TYPE_ALIASES[key];
    if (!normalized) {
        throw new Error(`Unsupported slicer_type: "${rawSlicerType}". Valid values: ${SLICER_TYPES.join(', ')}`);
    }
    return normalized;
}
export function isBambuCompatibleSlicer(slicerType) {
    return slicerType === 'bambustudio';
}
function isPathLikeExecutable(slicerPath) {
    return (path.isAbsolute(slicerPath) ||
        slicerPath.startsWith("./") ||
        slicerPath.startsWith("../") ||
        slicerPath.includes("/") ||
        slicerPath.includes("\\") ||
        /^[A-Za-z]:/.test(slicerPath));
}
function configuredBambuProfileDirs() {
    const override = process.env.BAMBU_SLICER_PROFILE_DIRS;
    if (override !== undefined) {
        return override.split(path.delimiter).filter(Boolean);
    }
    const home = os.homedir();
    const macAppSupport = path.join(home, 'Library', 'Application Support');
    const linuxConfig = path.join(home, '.config');
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const appNames = ['BambuStudio', 'Bambu Studio'];
    const roots = [
        macAppSupport,
        linuxConfig,
        ...(appData ? [appData] : []),
        ...(localAppData ? [localAppData] : []),
    ];
    return roots.flatMap((root) => appNames.map((appName) => path.join(root, appName, 'system', 'BBL')));
}
/** Keys every profile kind carries; they describe the file, not machine hardware. */
const PROFILE_METADATA_KEYS = new Set([
    'name', 'type', 'from', 'inherits', 'instantiation', 'setting_id', 'version', 'is_custom_defined',
    'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
]);
/**
 * Why the slicer process failed. execFile's message already carries stderr;
 * a crash often leaves stderr empty, so name the signal or exit code and add
 * the end of stdout instead. resultPath is the per-slice result.json of a
 * Bambu-style CLI.
 */
function describeSlicerFailure(error, stdout, stderr, resultPath) {
    const status = typeof error.signal === "string" && error.signal
        ? `crashed with ${error.signal}`
        : typeof error.code === "number" ? `exited with code ${error.code}` : "failed";
    const reason = resultPath ? bambuCliFailureReason(error.code, resultPath) : undefined;
    const output = stderr.trim() ? "" : stdout.trim().split("\n").slice(-20).join("\n");
    return `Slicer failed: the slicer ${status}${reason ? ` (${reason})` : ""}. ${error.message.trim()}${output ? `\nSlicer output: ${output}` : ""}`;
}
// Bambu Studio CLI errors (libslic3r/Utils.hpp). The process exits with the
// low byte of the code (Windows reports it unsigned); result.json names the error.
const BAMBU_CLI_ERRORS = {
    [-2]: "invalid parameters to the slicer",
    [-3]: "input files not found",
    [-5]: "preset file cannot be parsed",
    [-6]: "model file cannot be parsed",
    [-9]: "copying objects failed",
    [-17]: "printer is not compatible with the process preset",
    [-21]: "auto-arranging objects failed",
    [-22]: "auto-orienting objects failed",
    [-50]: "a plate is empty or has no object fully inside it; arrange the model or place it on the plate",
    [-51]: "incorrect slicing parameters",
    [-52]: "objects extend over the bed boundary",
    [-60]: "no printable objects remain after skipping",
    [-61]: "filaments are not compatible with the plate type",
    [-62]: "the filaments' temperatures differ too much",
    [-63]: "objects collide in print-by-object mode",
    [-64]: "objects collide",
    [-100]: "slicing the model failed",
    [-101]: "G-code conflicts after slicing",
    [-102]: "G-code in an unprintable area",
};
export function bambuCliFailureReason(exitCode, resultPath) {
    try {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        if (typeof result.error_string === "string" && result.error_string.trim()) {
            return `${result.error_string.trim()} [${result.return_code}]`;
        }
    }
    catch {
        // No result.json for crashes and for errors the CLI did not handle.
    }
    if (typeof exitCode !== "number")
        return undefined;
    const code = Object.keys(BAMBU_CLI_ERRORS).map(Number).find(value => (value & 0xff) === (exitCode & 0xff));
    return code === undefined ? undefined : `${BAMBU_CLI_ERRORS[code]} [${code}]`;
}
export class STLManipulator extends EventEmitter {
    constructor(tempDir = path.join(process.cwd(), 'temp')) {
        super();
        this.activeOperations = new Map();
        this.tempDir = tempDir;
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }
    /**
     * Generate a unique operation ID
     */
    generateOperationId() {
        return crypto.randomUUID();
    }
    getAvailableProfileRoots() {
        const selectedRoot = process.env.BAMBU_PROFILES_ROOT;
        return [
            ...(selectedRoot ? [path.join(selectedRoot, 'BBL')] : []),
            ...configuredBambuProfileDirs(),
            ...BAMBU_PROFILE_ROOTS,
        ].filter((root) => fs.existsSync(root));
    }
    findProfileFile(category, profileName, roots = this.getAvailableProfileRoots()) {
        if (!profileName) {
            return undefined;
        }
        for (const root of roots) {
            const candidate = profileJsonFiles(path.join(root, category))
                .find(file => path.basename(file) === `${profileName}.json`);
            if (candidate)
                return candidate;
        }
        return undefined;
    }
    buildFilamentIdIndex(roots = this.getAvailableProfileRoots()) {
        const index = new Map();
        for (const root of roots) {
            const filamentDir = path.join(root, 'filament');
            if (!fs.existsSync(filamentDir)) {
                continue;
            }
            for (const filePath of profileJsonFiles(filamentDir)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const filamentId = typeof parsed?.filament_id === 'string' ? parsed.filament_id.trim() : '';
                    if (filamentId && !index.has(filamentId)) {
                        index.set(filamentId, filePath);
                    }
                }
                catch {
                    // Ignore malformed JSON.
                }
            }
        }
        return index;
    }
    readJsonFile(filePath) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    writeTempJson(outputBase, suffix, value) {
        const serialized = JSON.stringify(value, null, 2);
        const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
        const outPath = path.join(this.tempDir, `${outputBase}_${suffix}_${hash}.json`);
        fs.writeFileSync(outPath, serialized);
        return outPath;
    }
    async resolveBambuLikeSettingsBundle(outputBase, slicerProfile, printerPreset, bambuOptions, activeProfilesRoot) {
        const roots = activeProfilesRoot
            ? [path.join(activeProfilesRoot, 'BBL')]
            : this.getAvailableProfileRoots();
        const findProfile = (kind, name) => this.findProfileFile(kind, name, kind === 'machine' ? roots : [...roots, ...configuredBambuProfileDirs()]);
        if (!printerPreset) {
            throw new Error('Printer preset is required for Bambu-compatible CLI slicing; select the exact bambu_model and nozzle_diameter.');
        }
        const machinePath = findProfile('machine', printerPreset);
        if (!machinePath) {
            throw new Error(`Printer profile "${printerPreset}" was not found. Set BAMBU_PROFILES_ROOT to the matching Bambu Studio profile tree; refusing to use printer defaults.`);
        }
        let machineConfig;
        try {
            machineConfig = this.readJsonFile(machinePath);
            if (!machineConfig || Array.isArray(machineConfig) || machineConfig.name !== printerPreset) {
                throw new Error('expected a JSON machine profile with the selected preset name');
            }
        }
        catch (error) {
            throw new Error(`Printer profile "${printerPreset}" is invalid: ${error?.message ?? error}`);
        }
        // Some machine leaves inherit their default process/filaments.
        // Resolve those selections before building the positional CLI bundle.
        machineConfig = await resolveBblMachineProfile(activeProfilesRoot ?? path.dirname(path.dirname(path.dirname(machinePath))), printerPreset);
        const filamentPaths = [];
        let processPath;
        let parsedProfile = null;
        let processSource;
        if (slicerProfile) {
            try {
                parsedProfile = this.readJsonFile(slicerProfile);
            }
            catch {
                parsedProfile = null;
            }
        }
        if (parsedProfile && typeof parsedProfile === 'object') {
            processSource = { filePath: slicerProfile, profile: parsedProfile };
            const inheritedProcessName = (typeof parsedProfile.inherits === 'string' && parsedProfile.inherits) ||
                (typeof parsedProfile.print_settings_id === 'string' &&
                    parsedProfile.print_settings_id !== parsedProfile.name
                    ? parsedProfile.print_settings_id
                    : undefined) ||
                (typeof parsedProfile.default_print_profile === 'string'
                    ? parsedProfile.default_print_profile
                    : undefined) ||
                (typeof machineConfig?.default_print_profile === 'string'
                    ? machineConfig.default_print_profile
                    : undefined);
            const inheritedProcessPath = findProfile('process', inheritedProcessName);
            const inheritedProcess = inheritedProcessPath && fs.existsSync(inheritedProcessPath)
                ? this.readJsonFile(inheritedProcessPath)
                : {};
            const mergedProcess = {
                ...inheritedProcess,
                ...parsedProfile,
                type: 'process',
            };
            processPath = this.writeTempJson(outputBase, 'process', mergedProcess);
            const defaultFilamentProfiles = !bambuOptions?.loadFilaments && Array.isArray(parsedProfile.default_filament_profile)
                ? parsedProfile.default_filament_profile
                : [];
            for (const profileName of defaultFilamentProfiles) {
                const filamentPath = findProfile('filament', String(profileName));
                if (filamentPath) {
                    filamentPaths.push(filamentPath);
                }
                else {
                    throw new Error(`Filament profile "${String(profileName)}" was not found; refusing to omit its slot.`);
                }
            }
            if (!bambuOptions?.loadFilaments && filamentPaths.length === 0 && Array.isArray(parsedProfile.filament_ids)) {
                const filamentIdIndex = this.buildFilamentIdIndex([...roots, ...configuredBambuProfileDirs()]);
                for (const filamentId of parsedProfile.filament_ids) {
                    const filamentPath = filamentIdIndex.get(String(filamentId));
                    if (filamentPath) {
                        filamentPaths.push(filamentPath);
                    }
                    else {
                        throw new Error(`Filament ID "${String(filamentId)}" could not be resolved; refusing to omit its slot.`);
                    }
                }
            }
        }
        else if (slicerProfile) {
            processPath = slicerProfile;
        }
        const plan = slicerProfile ? undefined : bambuOptions?.projectPlan;
        if (plan) {
            processPath = this.writeTempJson(outputBase, 'project_process', {
                name: `${plan.process} (project settings)`, type: 'process', from: 'User', inherits: plan.process, ...plan.overlay,
            });
            if (!bambuOptions?.loadFilaments) {
                for (const { to } of plan.filaments) {
                    const filamentPath = findProfile('filament', to);
                    if (!filamentPath)
                        throw new Error(`Filament profile "${to}" was not found; refusing to omit its slot.`);
                    filamentPaths.push(filamentPath);
                }
            }
        }
        if (!processPath) {
            const defaultProcessName = typeof machineConfig?.default_print_profile === 'string'
                ? machineConfig.default_print_profile
                : undefined;
            const defaultProcessPath = findProfile('process', defaultProcessName);
            if (defaultProcessPath)
                processPath = defaultProcessPath;
        }
        if (!bambuOptions?.loadFilaments &&
            filamentPaths.length === 0 &&
            Array.isArray(machineConfig?.default_filament_profile)) {
            for (const profileName of machineConfig.default_filament_profile) {
                const filamentPath = findProfile('filament', String(profileName));
                if (filamentPath) {
                    filamentPaths.push(filamentPath);
                }
                else {
                    throw new Error(`Filament profile "${String(profileName)}" was not found; refusing to omit its slot.`);
                }
            }
        }
        if (bambuOptions?.loadFilaments) {
            filamentPaths.length = 0;
            for (const filamentPath of bambuOptions.loadFilaments.split(';')) {
                const trimmed = filamentPath.trim();
                if (trimmed) {
                    filamentPaths.push(trimmed);
                }
            }
        }
        const settingsParts = [machinePath, processPath].filter((entry) => Boolean(entry));
        return {
            settingsArg: settingsParts.length > 0 ? settingsParts.join(';') : undefined,
            filamentPaths,
            processSource,
        };
    }
    /** Resolve BBL dependencies before invoking the CLI; failures stop the slice. */
    async maybeFlattenBundle(bundle, bambuOptions, activeProfilesRoot) {
        const parts = bundle.settingsArg?.split(';').filter(Boolean) ?? [];
        const readProfile = (filePath) => {
            try {
                const data = this.readJsonFile(filePath);
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    throw new Error('expected a JSON profile object');
                }
                return data;
            }
            catch (err) {
                throw new Error(`Cannot read slicer profile "${filePath}": ${err?.message ?? err}`);
            }
        };
        const settings = parts.map(readProfile);
        // Read every slot: filtering unreadable names would change positional mapping.
        const filaments = bundle.filamentPaths.map(readProfile);
        const profilesRoot = activeProfilesRoot ?? detectProfilesRoot(process.env.SLICER_PATH);
        const profileRoots = [path.join(profilesRoot, 'BBL')];
        const hasReferences = (profile) => (typeof profile.inherits === 'string' && profile.inherits.length > 0) ||
            (profile.include !== undefined && profile.include !== null);
        const isBundledFile = (filePath) => profileRoots.some(root => {
            const relative = path.relative(root, filePath);
            return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        });
        const isBundled = (filePath, profile) => String(profile.from).toLowerCase() === 'system' || isBundledFile(filePath);
        const needsResolution = (filePath, profile) => hasReferences(profile) || isBundled(filePath, profile);
        if (![...settings, ...filaments].some((profile, i) => needsResolution([...parts, ...bundle.filamentPaths][i], profile)))
            return bundle;
        if (parts.length !== 2) {
            throw new Error('Resolving BBL profiles requires both a machine and process profile; refusing to slice with unresolved settings.');
        }
        const [machinePath, processPath] = parts;
        const [machine, processProfile] = settings;
        const leafName = (filePath, profile) => {
            // A user preset inherits its system identity, while keeping its own values.
            const name = !isBundled(filePath, profile) && typeof profile.inherits === 'string' && profile.inherits
                ? profile.inherits
                : profile.name;
            if (typeof name !== 'string' || !name) {
                if (needsResolution(filePath, profile))
                    throw new Error(`Cannot determine the profile name for "${filePath}".`);
                return path.basename(filePath, '.json');
            }
            return name;
        };
        const flat = await flattenForCli({
            machineLeaf: leafName(machinePath, machine),
            // A generated path loses bundled provenance; inherited metadata can also
            // make a custom preset look like a system profile. Use the original source
            // only for identity and retain the prepared values in sourceProfiles below.
            processLeaf: bundle.processSource
                ? leafName(bundle.processSource.filePath, bundle.processSource.profile)
                : leafName(processPath, processProfile),
            filamentLeaves: filaments.map((profile, i) => leafName(bundle.filamentPaths[i], profile)),
            profilesRoot,
            userProfileRoots: configuredBambuProfileDirs(),
            tempDir: this.tempDir,
            bedType: this.resolveBambuStudioBedType(bambuOptions?.bedType),
            nozzleVolumeType: bambuOptions?.nozzleVolumeType,
            filamentColours: bambuOptions?.filamentColours ?? bundle.filamentColours,
            projectTowerPosition: bundle.projectTowerPosition,
            sourceProfiles: {
                machine: isBundledFile(machinePath) ? undefined : machine,
                process: isBundledFile(processPath) ? undefined : processProfile,
                filaments: filaments.map((profile, i) => isBundledFile(bundle.filamentPaths[i]) ? undefined : profile),
            },
        });
        // Standalone files retain their own identity and settings, but still need
        // the CLI colour/tower fields. Do not discard those required overlays when
        // choosing the original profile instead of the normalized BBL output.
        const withCliFields = (filePath, profile, flatPath, keys) => {
            const flattened = readProfile(flatPath);
            const fields = Object.fromEntries(keys.filter(key => flattened[key] !== undefined).map(key => [key, flattened[key]]));
            if (Object.entries(fields).every(([key, value]) => JSON.stringify(profile[key]) === JSON.stringify(value)))
                return filePath;
            return this.writeTempJson(path.basename(filePath, '.json'), 'cli', { ...profile, ...fields });
        };
        return {
            settingsArg: [
                needsResolution(machinePath, machine) ? flat.machinePath : machinePath,
                needsResolution(processPath, processProfile) ? flat.processPath
                    : withCliFields(processPath, processProfile, flat.processPath, ['wipe_tower_x', 'wipe_tower_y']),
            ].join(';'),
            filamentPaths: filaments.map((profile, i) => needsResolution(bundle.filamentPaths[i], profile) ? flat.filamentPaths[i]
                : withCliFields(bundle.filamentPaths[i], profile, flat.filamentPaths[i], ['filament_colour'])),
        };
    }
    /**
     * The CLI applies every key in every --load-settings/--load-filaments file,
     * so machine settings carried by a process or filament file (for example a
     * template 3MF's project_settings from another printer) would replace the
     * selected preset's start G-code, model, and bed geometry. The machine
     * preset owns those keys; drop them from the other profiles.
     */
    isolateMachineSettings(bundle) {
        const [machinePath, processPath] = bundle.settingsArg?.split(';') ?? [];
        if (!machinePath || !processPath)
            return bundle;
        const machineKeys = Object.keys(this.readJsonFile(machinePath)).filter(key => !PROFILE_METADATA_KEYS.has(key));
        const isolate = (filePath, label) => {
            const profile = this.readJsonFile(filePath);
            const foreign = machineKeys.filter(key => Object.prototype.hasOwnProperty.call(profile, key));
            if (foreign.length === 0)
                return filePath;
            const isolated = { ...profile };
            for (const key of foreign)
                delete isolated[key];
            console.error(`Ignoring ${foreign.length} machine setting(s) in ${label} profile ${filePath} ` +
                `(the selected machine preset owns them): ${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ', ...' : ''}`);
            return this.writeTempJson(path.basename(filePath, '.json'), `${label}_without_machine`, isolated);
        };
        return {
            ...bundle,
            settingsArg: [machinePath, isolate(processPath, 'process')].join(';'),
            filamentPaths: bundle.filamentPaths.map(filePath => isolate(filePath, 'filament')),
        };
    }
    /**
     * A project made for the target printer lists the printer and filament keys it edited; the plan carries them
     * (ProjectSettingsPlan.machineOverlay, filaments[].overlay), and they are merged here onto the prepared machine
     * and filament files, which otherwise replace every such value the project holds.
     */
    applyProjectEdits(bundle, plan, outputBase) {
        const machineEdits = plan?.machineOverlay ?? {};
        const filamentEdits = plan?.filaments.map(f => f.overlay) ?? [];
        if (!plan || !bundle.settingsArg || (Object.keys(machineEdits).length === 0 && filamentEdits.every(edits => !edits)))
            return bundle;
        if (filamentEdits.length !== bundle.filamentPaths.length && filamentEdits.some(edits => edits)) {
            throw new Error(`The project's edits cover ${filamentEdits.length} filament slots, but ${bundle.filamentPaths.length} filament profiles are loaded; refusing to drop them.`);
        }
        const merge = (filePath, edits, label) => !edits || Object.keys(edits).length === 0 ? filePath
            : this.writeTempJson(outputBase, label, { ...this.readJsonFile(filePath), ...edits });
        const [machinePath, ...rest] = bundle.settingsArg.split(';');
        return {
            ...bundle,
            settingsArg: [merge(machinePath, machineEdits, 'machine_project'), ...rest].join(';'),
            filamentPaths: bundle.filamentPaths.map((filePath, i) => merge(filePath, filamentEdits[i], `filament_${i + 1}_project`)),
        };
    }
    /** --load-filaments is positional; a single override must cover every project slot. */
    async expandProjectFilaments(inputPath, bundle) {
        if (!inputPath.toLowerCase().endsWith('.3mf') || bundle.filamentPaths.length === 0)
            return bundle;
        const data = await readProjectConfig(inputPath);
        // Geometry-only 3MFs have no embedded filament slots.
        if (!data)
            return bundle;
        const count = Math.max(0, ...['filament_settings_id', 'filament_type', 'filament_colour', 'filament_diameter']
            .map(key => Array.isArray(data[key]) ? data[key].length : 0));
        if (count === 0)
            throw new Error('Cannot determine project filament slots from project_settings.config.');
        // Keep the project's slot colours; loaded profiles carry none of their own.
        const colours = Array.isArray(data.filament_colour) && data.filament_colour.length === count &&
            data.filament_colour.every(c => typeof c === 'string' && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c))
            ? data.filament_colour
            : undefined;
        const projectTowerPosition = Object.fromEntries(['wipe_tower_x', 'wipe_tower_y']
            .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
        if (bundle.filamentPaths.length === 1) {
            return { ...bundle, filamentPaths: Array(count).fill(bundle.filamentPaths[0]), filamentColours: colours, projectTowerPosition };
        }
        if (bundle.filamentPaths.length !== count) {
            throw new Error(`Project declares ${count} filament slots, but ${bundle.filamentPaths.length} profiles were supplied. Provide one profile for all slots or one per slot.`);
        }
        return { ...bundle, filamentColours: colours, projectTowerPosition };
    }
    /**
     * Map a 3MF's creator settings onto the target printer. Undefined when the 3MF
     * carries none; the caller decides whether to keep them (BambuSliceOptions.projectPlan).
     */
    async planProjectSettings(inputPath, slicerPath, printerPreset, modelCode, skipFilaments = false) {
        const config = await readProjectConfig(inputPath);
        if (!config)
            return undefined;
        const profilesRoot = detectProfilesRoot(slicerPath);
        const roots = [path.join(profilesRoot, 'BBL'), ...configuredBambuProfileDirs()];
        return buildProjectSettingsPlan({
            config, printerPreset, modelCode, skipFilaments,
            machine: await resolveBblMachineProfile(profilesRoot, printerPreset),
            leaf: (kind, name) => {
                const file = this.findProfileFile(kind, name, roots);
                return file ? this.readJsonFile(file) : undefined;
            },
            flatProcess: name => resolveBblMachineProfile(profilesRoot, name),
        });
    }
    resolveBambuStudioBedType(bedType) {
        if (!bedType)
            return undefined;
        const normalized = bedType.trim().toLowerCase();
        if (normalized === 'supertack_plate') {
            throw new Error('BambuStudio CLI SuperTack bed type is not verified; use a pre-sliced 3MF or choose textured_plate, cool_plate, engineering_plate, or hot_plate.');
        }
        return BAMBU_CLI_BED_TYPES[normalized] || bedType;
    }
    /**
     * Load STL file and return geometry and bounding box
     */
    async loadSTL(stlFilePath, progressCallback) {
        try {
            if (progressCallback)
                progressCallback(10, "Loading STL file...");
            // Read the STL file
            const stlData = await readFileAsync(stlFilePath);
            if (progressCallback)
                progressCallback(30, "Parsing STL data...");
            // Load the STL data into a Three.js geometry
            const loader = new STLLoader();
            const rawArrayBuffer = stlData.buffer.slice(stlData.byteOffset, stlData.byteOffset + stlData.byteLength);
            const geometry = loader.parse(rawArrayBuffer);
            // Create a mesh from the geometry
            const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            // Compute the bounding box
            geometry.computeBoundingBox();
            const boundingBox = geometry.boundingBox;
            if (progressCallback)
                progressCallback(50, "STL loaded successfully");
            return { geometry, boundingBox, mesh };
        }
        catch (error) {
            console.error("Error loading STL file:", error);
            throw new Error(`Failed to load STL file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Save a geometry to STL file
     */
    async saveSTL(geometry, outputFilePath, progressCallback) {
        try {
            if (progressCallback)
                progressCallback(80, "Exporting to STL...");
            // Create mesh for export
            const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            // Export the mesh as STL
            const exporter = new STLExporter();
            const stlString = exporter.parse(mesh);
            // Write the STL to file
            await writeFileAsync(outputFilePath, stlString);
            if (progressCallback)
                progressCallback(100, "STL saved successfully");
            return outputFilePath;
        }
        catch (error) {
            console.error("Error saving STL file:", error);
            throw new Error(`Failed to save STL file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Get comprehensive information about an STL file
     */
    async getSTLInfo(stlFilePath) {
        try {
            const fileStats = fs.statSync(stlFilePath);
            // Handle 3MF files: extract mesh data from embedded object models
            if (stlFilePath.toLowerCase().endsWith('.3mf')) {
                return await this.get3MFInfo(stlFilePath, fileStats.size);
            }
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath);
            // Count faces (each face is a triangle in STL)
            const positionAttribute = geometry.getAttribute('position');
            const vertexCount = positionAttribute.count;
            const faceCount = vertexCount / 3;
            // Calculate center and dimensions
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            const dimensions = new THREE.Vector3();
            boundingBox.getSize(dimensions);
            return {
                filePath: stlFilePath,
                fileName: path.basename(stlFilePath),
                fileSize: fileStats.size,
                boundingBox: {
                    min: boundingBox.min,
                    max: boundingBox.max,
                    center,
                    dimensions
                },
                vertexCount,
                faceCount
            };
        }
        catch (error) {
            console.error("Error getting STL info:", error);
            throw new Error(`Failed to get STL info: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Extract mesh info from a 3MF file: walk the build items and their component
     * trees, applying every transform, so the box matches what the slicer places.
     */
    async get3MFInfo(filePath, fileSize) {
        const JSZip = (await import('jszip')).default;
        const data = fs.readFileSync(filePath);
        const zip = await JSZip.loadAsync(data);
        const models = new Map();
        const loadModel = async (name) => {
            const entry = name.replace(/^\/+/, '');
            if (!models.has(entry)) {
                const file = zip.file(entry);
                models.set(entry, file ? parse3MFModel(await file.async('string')) : new Map());
            }
            return models.get(entry);
        };
        const overallBox = new THREE.Box3();
        let totalVerts = 0;
        let totalFaces = 0;
        // `item` ties each mesh to its <build> entry, so a caller can group the meshes of one object and map it to a plate.
        const objects = [];
        const items = [];
        const point = new THREE.Vector3();
        // The depth limit bounds nesting, not fan-out: layered components multiply, so cap the total walk.
        let instances = 0;
        const visit = async (file, id, matrix, depth, item) => {
            if (depth > 8)
                throw new Error('3MF components are nested too deeply.');
            if (++instances > 10000)
                throw new Error('3MF has too many component instances.');
            const object = (await loadModel(file)).get(id);
            if (!object)
                return;
            const { verts } = object;
            if (verts.length > 0) {
                const box = new THREE.Box3();
                for (let i = 0; i < verts.length; i += 3)
                    box.expandByPoint(point.set(verts[i], verts[i + 1], verts[i + 2]).applyMatrix4(matrix));
                overallBox.union(box);
                totalVerts += verts.length / 3;
                totalFaces += object.faces;
                objects.push({
                    name: file === MAIN_3MF_MODEL ? `object ${id}` : path.basename(file),
                    vertexCount: verts.length / 3,
                    faceCount: object.faces,
                    boundingBox: { min: box.min, max: box.max, center: box.getCenter(new THREE.Vector3()), dimensions: box.getSize(new THREE.Vector3()) },
                    item,
                    objectId: id,
                });
            }
            for (const component of object.components) {
                await visit(component.path ?? file, component.id, matrix.clone().multiply(component.matrix), depth + 1, item);
            }
        };
        const mainXml = zip.file(MAIN_3MF_MODEL) ? await zip.file(MAIN_3MF_MODEL).async('string') : '';
        const build = /<(?:\w+:)?build\b[\s\S]*?<\/(?:\w+:)?build>/.exec(mainXml)?.[0] ?? '';
        for (const [, tag] of build.matchAll(/<(?:\w+:)?item\b([^>]*)>/g)) {
            const id = attributeOf(tag, 'objectid');
            if (!id)
                continue;
            items.push({ objectId: id, printable: attributeOf(tag, 'printable') !== '0' });
            await visit(attributeOf(tag, 'path') ?? MAIN_3MF_MODEL, id, matrixOf3MF(attributeOf(tag, 'transform')), 0, items.length - 1);
        }
        if (totalVerts === 0) {
            throw new Error('No mesh data found in 3MF file. The archive may not contain any 3D objects.');
        }
        return {
            filePath,
            fileName: path.basename(filePath),
            fileSize,
            boundingBox: { min: overallBox.min, max: overallBox.max, center: overallBox.getCenter(new THREE.Vector3()), dimensions: overallBox.getSize(new THREE.Vector3()) },
            vertexCount: totalVerts,
            faceCount: totalFaces,
            objects,
            items,
        };
    }
    /**
     * Scale an STL model uniformly or along specific axes
     */
    async scaleSTL(stlFilePath, scaleFactors, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting scaling operation...");
            // Load the STL file
            const { geometry, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying scaling transformation...");
            // Apply scaling
            let scaleX, scaleY, scaleZ;
            if (typeof scaleFactors === 'number') {
                // Uniform scaling
                scaleX = scaleY = scaleZ = scaleFactors;
            }
            else {
                // Non-uniform scaling
                [scaleX, scaleY, scaleZ] = scaleFactors;
            }
            const scaleMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
            geometry.applyMatrix4(scaleMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_scaled.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'scale',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'scale',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Rotate an STL model around specific axes
     */
    async rotateSTL(stlFilePath, rotationAngles, // [x, y, z] in degrees
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting rotation operation...");
            // Load the STL file
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying rotation transformation...");
            // Convert degrees to radians
            const [rotX, rotY, rotZ] = rotationAngles.map(angle => angle * Math.PI / 180);
            // Get the center of the model
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            // Create translation matrices to rotate around the center
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'XYZ'));
            const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
            // Apply the transformations
            geometry.applyMatrix4(toOriginMatrix);
            geometry.applyMatrix4(rotationMatrix);
            geometry.applyMatrix4(fromOriginMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_rotated.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'rotate',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'rotate',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Translate (move) an STL model along specific axes
     */
    async translateSTL(stlFilePath, translationValues, // [x, y, z] in mm
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting translation operation...");
            // Load the STL file
            const { geometry } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying translation transformation...");
            // Apply translation
            const [translateX, translateY, translateZ] = translationValues;
            const translationMatrix = new THREE.Matrix4().makeTranslation(translateX, translateY, translateZ);
            geometry.applyMatrix4(translationMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_translated.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'translate',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'translate',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Generate an SVG visualization of an STL file from multiple angles
     * @param stlFilePath Path to the STL file
     * @param width Width of each view in pixels
     * @param height Height of each view in pixels
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated SVG file
     */
    async generateVisualization(stlFilePath, width = 300, height = 300, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting visualization generation...");
            // Load the STL file
            const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(50, "Setting up 3D scene...");
            // Create a scene
            const scene = new THREE.Scene();
            scene.add(mesh);
            // Create a camera
            const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
            // Calculate the ideal camera position based on bounding box
            const size = new THREE.Vector3();
            boundingBox.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = camera.fov * (Math.PI / 180);
            const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.5; // 1.5 is a factor for some padding
            // Add lighting to the scene
            const ambientLight = new THREE.AmbientLight(0x404040); // soft white light
            scene.add(ambientLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
            directionalLight.position.set(1, 1, 1).normalize();
            scene.add(directionalLight);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Generating SVG representation...");
            // Since we can't use the DOM-dependent SVGRenderer in a Node.js environment,
            // let's create a simple representation of the model using its bounding box
            // This is a simplified visual representation
            // Create SVG content with a simple representation of the STL model
            const viewBox = `0 0 ${width * 2} ${height * 2}`;
            let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width * 2}" height="${height * 2}">`;
            // Add a title and model info
            svgContent += `
        <text x="10" y="20" font-family="Arial" font-size="16" fill="black">
          STL Visualization: ${path.basename(stlFilePath)}
        </text>
        <text x="10" y="40" font-family="Arial" font-size="12" fill="black">
          Dimensions: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} mm
        </text>
      `;
            // Define views
            const views = [
                { name: "front", transform: "rotateY(0deg)" },
                { name: "side", transform: "rotateY(90deg)" },
                { name: "top", transform: "rotateX(90deg)" },
                { name: "isometric", transform: "rotateX(30deg) rotateY(45deg)" }
            ];
            // Draw each view
            for (let i = 0; i < views.length; i++) {
                const view = views[i];
                const x = (i % 2) * width + width / 2;
                const y = Math.floor(i / 2) * height + height / 2 + 50; // Add 50px for the header text
                // Calculate a representative size for the simple cube visualization
                const cubeSize = Math.min(width, height) * 0.4;
                // Draw a simple cube representation
                svgContent += `
          <g transform="translate(${x}, ${y})">
            <rect x="${-cubeSize / 2}" y="${-cubeSize / 2}" width="${cubeSize}" height="${cubeSize}" 
                  style="fill:#e0e0e0;stroke:#000;stroke-width:1;opacity:0.8;${view.transform}" />
            <text x="0" y="${cubeSize / 2 + 30}" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
              ${view.name}
            </text>
          </g>
        `;
                if (progressCallback)
                    progressCallback(60 + (i + 1) * 10, `Generated ${view.name} view`);
            }
            // Add STL information
            svgContent += `
        <g transform="translate(20, ${height * 2 - 60})">
          <text font-family="Arial" font-size="14" fill="black">
            File: ${path.basename(stlFilePath)}
          </text>
          <text y="20" font-family="Arial" font-size="12" fill="black">
            Vertices: ${mesh.geometry.attributes.position.count / 3}
          </text>
          <text y="40" font-family="Arial" font-size="12" fill="black">
            Dimensions: W:${size.x.toFixed(2)}mm × H:${size.y.toFixed(2)}mm × D:${size.z.toFixed(2)}mm
          </text>
        </g>
      `;
            // Close the SVG
            svgContent += '</svg>';
            if (progressCallback)
                progressCallback(90, "Visualization generated");
            if (progressCallback)
                progressCallback(90, "Saving visualization...");
            // Write the SVG to file
            const outputFileName = path.basename(stlFilePath, '.stl') + '_visualization.svg';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await writeFileAsync(outputFilePath, svgContent);
            if (progressCallback)
                progressCallback(100, "Visualization saved successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'visualization',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            console.error("Error generating visualization:", error);
            this.emit('operationError', {
                operationId,
                type: 'visualization',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to generate visualization: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Apply a specific transformation to a selected section of an STL file
     * This allows for targeted modifications of specific parts of a model
     */
    async modifySection(stlFilePath, selection, transformation, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting section modification...");
            // Load the STL file
            const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(40, "Identifying section to modify...");
            // Convert named sections to actual bounding boxes
            let selectionBox;
            if (selection === 'top') {
                // Select top third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const topThreshold = boundingBox.max.y - (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, topThreshold, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z));
            }
            else if (selection === 'bottom') {
                // Select bottom third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const bottomThreshold = boundingBox.min.y + (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, bottomThreshold, boundingBox.max.z));
            }
            else if (selection === 'center') {
                // Select middle third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const bottomThreshold = boundingBox.min.y + (height / 3);
                const topThreshold = boundingBox.max.y - (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, bottomThreshold, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, topThreshold, boundingBox.max.z));
            }
            else {
                // Use the provided bounding box
                selectionBox = selection;
            }
            if (progressCallback)
                progressCallback(50, "Applying transformation to selected section...");
            // Get position attribute for direct manipulation
            const positionAttribute = geometry.getAttribute('position');
            const positions = positionAttribute.array;
            // Create transformation matrix based on the requested operation
            let transformMatrix = new THREE.Matrix4();
            const center = new THREE.Vector3();
            selectionBox.getCenter(center);
            // Matrices for transforming around the selection center
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
            // Build the appropriate transformation matrix
            switch (transformation.type) {
                case 'scale':
                    if (typeof transformation.value === 'number') {
                        transformMatrix = new THREE.Matrix4().makeScale(transformation.value, transformation.value, transformation.value);
                    }
                    else {
                        const [scaleX, scaleY, scaleZ] = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
                    }
                    break;
                case 'rotate':
                    const rotValues = (typeof transformation.value === 'number')
                        ? [0, 0, transformation.value * Math.PI / 180]
                        : transformation.value.map(v => v * Math.PI / 180);
                    transformMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotValues[0], rotValues[1], rotValues[2], 'XYZ'));
                    break;
                case 'translate':
                    if (typeof transformation.value === 'number') {
                        const translateValue = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeTranslation(translateValue, translateValue, translateValue);
                    }
                    else {
                        const [transX, transY, transZ] = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeTranslation(transX, transY, transZ);
                    }
                    break;
                default:
                    throw new Error(`Unsupported transformation type: ${transformation.type}`);
            }
            // Build complete transformation (to origin, transform, back from origin)
            const finalTransform = new THREE.Matrix4()
                .multiply(fromOriginMatrix)
                .multiply(transformMatrix)
                .multiply(toOriginMatrix);
            // Create temporary vector for calculations
            const tempVector = new THREE.Vector3();
            try {
                // Apply transformation only to vertices within the selection box
                for (let i = 0; i < positionAttribute.count; i++) {
                    tempVector.fromBufferAttribute(positionAttribute, i);
                    // Check if this vertex is within our selection box
                    if (selectionBox.containsPoint(tempVector)) {
                        // Apply the transformation to this vertex
                        tempVector.applyMatrix4(finalTransform);
                        // Update the position in the buffer
                        positionAttribute.setXYZ(i, tempVector.x, tempVector.y, tempVector.z);
                    }
                }
                // Mark the attribute as needing an update
                positionAttribute.needsUpdate = true;
                // Update the geometry's bounding box
                geometry.computeBoundingBox();
            }
            catch (error) {
                console.error("Error modifying vertices:", error);
                throw new Error(`Failed to modify section: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_modified.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'modifySection',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'modifySection',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Add a slab under the model: the model moves up by the extension along Z (the
     * printing axis), so the result is exactly the original height plus the extension.
     * The slab spans the model's bounding rectangle.
     * @param stlFilePath Path to the input STL file
     * @param extensionMm Amount to extend the base, in millimeters
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the modified STL file
     */
    async extendBase(stlFilePath, extensionMm, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (!Number.isFinite(extensionMm) || extensionMm <= 0) {
                throw new Error("extension_height must be a positive number of millimeters");
            }
            if (progressCallback)
                progressCallback(0, "Starting base extension operation...");
            console.error(`Extending base of ${stlFilePath} by ${extensionMm} mm`);
            // Load the STL file
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Creating extended base geometry...");
            // The slab keeps the model's original bottom plane (minZ) and fills up to the moved model.
            // Build it before translating: the geometry updates boundingBox in place.
            const baseGeometry = new THREE.BoxGeometry(boundingBox.max.x - boundingBox.min.x, boundingBox.max.y - boundingBox.min.y, extensionMm).toNonIndexed();
            baseGeometry.translate((boundingBox.min.x + boundingBox.max.x) / 2, (boundingBox.min.y + boundingBox.max.y) / 2, boundingBox.min.z + extensionMm / 2);
            geometry.translate(0, 0, extensionMm);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(75, "Merging geometries...");
            keepPositionOnly(geometry);
            keepPositionOnly(baseGeometry);
            const merged = BufferGeometryUtils.mergeGeometries([geometry, baseGeometry]);
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_extended.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            if (progressCallback)
                progressCallback(90, "Saving extended STL...");
            await this.saveSTL(merged, outputFilePath);
            if (progressCallback)
                progressCallback(100, "STL saved successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'extendBase',
                success: true,
                output: outputFilePath
            });
            console.error(`Modified STL saved to ${outputFilePath}`);
            return outputFilePath;
        }
        catch (error) {
            console.error("Error extending STL base:", error);
            this.emit('operationError', {
                operationId,
                type: 'extendBase',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to extend STL base: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Slice an STL or 3MF file using the specified slicer
     * @param stlFilePath Path to the input STL or 3MF file
     * @param slicerType Type of slicer (prusaslicer, cura, slic3r, bambustudio)
     * @param slicerPath Path to the slicer executable
     * @param slicerProfile Optional path to the slicer profile/config file
     * @param progressCallback Optional callback for progress updates
     * @param printerPreset Optional BambuStudio printer preset name (e.g., "Bambu Lab P1S 0.4 nozzle")
     * @param bambuOptions Optional BambuStudio-specific CLI flags
     * @param signal Aborting kills the slicer process
     * @returns Path to the generated G-code or sliced 3MF file
     */
    async sliceSTL(stlFilePath, slicerType, slicerPath, slicerProfile, progressCallback, printerPreset, bambuOptions, signal) {
        const operationId = this.generateOperationId();
        signal?.throwIfAborted();
        if (isPathLikeExecutable(slicerPath) && !fs.existsSync(slicerPath)) {
            throw new Error(`Slicer executable not found at: ${slicerPath}`);
        }
        if (slicerProfile && !fs.existsSync(slicerProfile)) {
            throw new Error(`Slicer profile not found: ${slicerProfile}`);
        }
        const outputFileName = path.basename(stlFilePath, '.stl') + '.gcode';
        let outputFilePath = path.join(this.tempDir, outputFileName);
        let args = [];
        let resultPath;
        let sliceDir;
        try {
            if (progressCallback)
                progressCallback(0, `Starting slicing with ${slicerType}...`);
            switch (slicerType) {
                case 'prusaslicer':
                case 'slic3r': // PrusaSlicer and Slic3r share similar CLI args
                    args = [
                        '--slice',
                        '--output', outputFilePath,
                        '--load', slicerProfile || '', // Pass profile path
                        stlFilePath
                    ];
                    // Remove empty profile arg if not provided
                    args = args.filter(arg => arg !== '');
                    break;
                case 'cura':
                    // CuraEngine CLI args are different, often requiring -s for settings
                    // Example: curaengine slice -v -j cura_settings.json -s layer_height=0.2 -o output.gcode -l input.stl
                    // This requires parsing the profile or passing individual settings.
                    // Keeping it simple for now, assuming profile contains necessary info.
                    args = [
                        'slice',
                        '-l', stlFilePath,
                        '-o', outputFilePath
                    ];
                    if (slicerProfile) {
                        args.push('-j', slicerProfile); // Load settings from profile definition file
                    }
                    break;
                case 'bambustudio':
                    // Bambu Studio CLI: slice and export as 3MF with embedded gcode.
                    // For 3MF input: slice in place and export sliced 3MF
                    // For STL input: slice and export as 3MF
                    {
                        const is3mf = stlFilePath.toLowerCase().endsWith('.3mf');
                        const outputBase = path.basename(stlFilePath, is3mf ? '.3mf' : '.stl');
                        const profilesRoot = detectProfilesRoot(slicerPath);
                        const rawBundle = await this.resolveBambuLikeSettingsBundle(outputBase, slicerProfile, printerPreset, bambuOptions, profilesRoot);
                        // Resolve every BBL dependency before launching the slicer.
                        const settingsBundle = await this.maybeFlattenBundle(await this.expandProjectFilaments(stlFilePath, rawBundle), bambuOptions, profilesRoot);
                        // The machine preset assumes the stock hotend; record the installed one so
                        // the sliced job's nozzle_type matches what the printer reports.
                        if (bambuOptions?.nozzleType && settingsBundle.settingsArg) {
                            const [machinePath, ...rest] = settingsBundle.settingsArg.split(';');
                            const machine = this.readJsonFile(machinePath);
                            const current = machine.nozzle_type;
                            machine.nozzle_type = Array.isArray(current) && current.length > 0
                                ? current.map(() => bambuOptions.nozzleType)
                                : [bambuOptions.nozzleType];
                            settingsBundle.settingsArg = [
                                this.writeTempJson(outputBase, `machine_${bambuOptions.nozzleType}`, machine), ...rest,
                            ].join(';');
                        }
                        const cliBundle = this.isolateMachineSettings(this.applyProjectEdits(settingsBundle, slicerProfile ? undefined : bambuOptions?.projectPlan, outputBase));
                        // One folder per slice: the CLI's plate_N.gcode and result.json names are fixed,
                        // so concurrent or repeated slices of one model must never share them.
                        sliceDir = await fs.promises.mkdtemp(path.join(this.tempDir, 'slice-'));
                        const bambuOutputPath = path.join(sliceDir, outputBase + '_sliced.3mf');
                        resultPath = path.join(sliceDir, 'result.json');
                        args = [
                            ...(bambuOptions?.exportOnly ? [] : ['--slice', String(bambuOptions?.slicePlate ?? 0)]),
                            '--outputdir', sliceDir,
                            '--export-3mf', path.basename(bambuOutputPath),
                        ];
                        if (cliBundle.settingsArg) {
                            args.push('--load-settings', cliBundle.settingsArg);
                        }
                        // Always allow newer-version 3MF files (the CLI rejects them by default)
                        args.push('--allow-newer-file');
                        // BambuSliceOptions flags
                        if (bambuOptions?.uptodate)
                            args.push('--uptodate');
                        if (bambuOptions?.ensureOnBed)
                            args.push('--ensure-on-bed');
                        if (bambuOptions?.enableTimelapse)
                            args.push('--enable-timelapse');
                        if (bambuOptions?.allowMixTemp)
                            args.push('--allow-mix-temp');
                        if (bambuOptions?.minSave)
                            args.push('--min-save');
                        if (bambuOptions?.skipModifiedGcodes)
                            args.push('--skip-modified-gcodes');
                        if (bambuOptions?.orient !== undefined)
                            args.push('--orient', bambuOptions.orient ? '1' : '0');
                        if (bambuOptions?.arrange !== undefined)
                            args.push('--arrange', bambuOptions.arrange ? '1' : '0');
                        if (bambuOptions?.repetitions !== undefined)
                            args.push('--repetitions', String(bambuOptions.repetitions));
                        if (bambuOptions?.scale !== undefined)
                            args.push('--scale', String(bambuOptions.scale));
                        if (bambuOptions?.rotate !== undefined)
                            args.push('--rotate', String(bambuOptions.rotate));
                        if (bambuOptions?.rotateX !== undefined)
                            args.push('--rotate-x', String(bambuOptions.rotateX));
                        if (bambuOptions?.rotateY !== undefined)
                            args.push('--rotate-y', String(bambuOptions.rotateY));
                        if (bambuOptions?.cloneObjects)
                            args.push('--clone-objects', bambuOptions.cloneObjects);
                        if (bambuOptions?.skipObjects)
                            args.push('--skip-objects', bambuOptions.skipObjects);
                        if (cliBundle.filamentPaths.length > 0) {
                            args.push('--load-filaments', cliBundle.filamentPaths.join(';'));
                            args.push('--load-defaultfila');
                        }
                        if (bambuOptions?.loadFilamentIds)
                            args.push('--load-filament-ids', bambuOptions.loadFilamentIds);
                        args.push(stlFilePath);
                        // Override outputFilePath for bambustudio since it produces 3MF, not gcode
                        outputFilePath = bambuOutputPath;
                    }
                    break;
                default:
                    throw new Error(`Unsupported slicer type: ${slicerType}`);
            }
            if (progressCallback)
                progressCallback(20, `Executing slicer: ${slicerPath} ${args.join(' ')}`);
            console.error(`Executing: ${slicerPath} ${args.join(' ')}`);
            // Execute the slicer
            await new Promise((resolve, reject) => {
                execFile(slicerPath, args, { signal }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Slicer Error: ${error.message}`);
                        console.error(`Slicer Stderr: ${stderr}`);
                        reject(new Error(signal?.aborted
                            ? `Slicing cancelled; the slicer process was stopped: ${stlFilePath}`
                            : describeSlicerFailure(error, stdout, stderr, resultPath)));
                    }
                    else {
                        console.error(`Slicer Stdout: ${stdout}`);
                        if (stderr) {
                            console.warn(`Slicer Stderr: ${stderr}`); // Log stderr even on success
                        }
                        resolve();
                    }
                });
            });
            if (!fs.existsSync(outputFilePath)) {
                throw new Error(`Slicer finished but output file not found: ${outputFilePath}`);
            }
            if (sliceDir) {
                // The gcode and result files are inside the 3MF; the CLI's copies are 40 MB per plate.
                const keep = path.basename(outputFilePath);
                await Promise.all((await fs.promises.readdir(sliceDir)).filter(name => name !== keep)
                    .map(name => removeQuietly(path.join(sliceDir, name))));
            }
            if (progressCallback)
                progressCallback(100, "Slicing completed successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'slice',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            console.error(`Slicing failed for ${stlFilePath}:`, error);
            if (sliceDir)
                await removeQuietly(sliceDir);
            this.emit('operationError', {
                operationId,
                type: 'slice',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    /**
     * Enhanced version of confirmTemperatures with better error handling
     * @param gcodePath Path to the G-code file
     * @param expected Expected temperature settings
     * @param progressCallback Optional callback for progress updates
     * @returns Object with comparison results
     */
    async confirmTemperatures(gcodePath, expected, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting temperature verification...");
            // Verify the G-code file exists
            if (!fs.existsSync(gcodePath)) {
                throw new Error(`G-code file not found: ${gcodePath}`);
            }
            if (progressCallback)
                progressCallback(20, "Reading G-code file...");
            // Read the G-code file
            const gcode = await readFileAsync(gcodePath, 'utf8');
            const lines = gcode.split('\n');
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(50, "Analyzing temperature commands...");
            // Extract temperature settings from G-code
            const actual = {};
            const allTemperatures = { extruder: [], bed: [] };
            for (const line of lines) {
                // Look for extruder temperature (M104 or M109)
                const extruderMatch = line.match(/M10[49] S(\d+)/);
                if (extruderMatch) {
                    const temp = parseInt(extruderMatch[1], 10);
                    allTemperatures.extruder.push(temp);
                    // Keep the first temperature for compatibility with original function
                    if (!actual.extruder) {
                        actual.extruder = temp;
                    }
                }
                // Look for bed temperature (M140 or M190)
                const bedMatch = line.match(/M1[49]0 S(\d+)/);
                if (bedMatch) {
                    const temp = parseInt(bedMatch[1], 10);
                    allTemperatures.bed.push(temp);
                    // Keep the first temperature for compatibility with original function
                    if (!actual.bed) {
                        actual.bed = temp;
                    }
                }
            }
            if (progressCallback)
                progressCallback(80, "Comparing temperatures...");
            // Compare actual with expected
            let match = true;
            if (expected.extruder !== undefined && actual.extruder !== expected.extruder) {
                match = false;
            }
            if (expected.bed !== undefined && actual.bed !== expected.bed) {
                match = false;
            }
            if (progressCallback)
                progressCallback(100, "Temperature verification complete");
            this.emit('operationComplete', {
                operationId,
                type: 'confirmTemperatures',
                success: true,
                result: { match, actual, expected, allTemperatures }
            });
            return { match, actual, expected, allTemperatures };
        }
        catch (error) {
            console.error("Error confirming temperatures:", error);
            this.emit('operationError', {
                operationId,
                type: 'confirmTemperatures',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to confirm temperatures: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Merge vertices within a specified tolerance.
     */
    async mergeVertices(stlFilePath, tolerance = 0.01, // Default tolerance in mm
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting vertex merging...");
            const { geometry } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(60, "Merging vertices...");
            const originalVertexCount = geometry.attributes.position.count;
            keepPositionOnly(geometry);
            const mergedGeometry = BufferGeometryUtils.mergeVertices(geometry, tolerance);
            mergedGeometry.computeVertexNormals();
            const newVertexCount = mergedGeometry.attributes.position.count;
            console.error(`Merged vertices: ${originalVertexCount} -> ${newVertexCount} (Tolerance: ${tolerance}mm)`);
            if (progressCallback)
                progressCallback(70, `Vertices merged: ${originalVertexCount} -> ${newVertexCount}`);
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            const outputFileName = path.basename(stlFilePath, '.stl') + '_merged.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await this.saveSTL(mergedGeometry, outputFilePath, progressCallback); // 80-100% progress
            this.emit('operationComplete', { operationId, type: 'mergeVertices', success: true, output: outputFilePath, verticesRemoved: originalVertexCount - newVertexCount });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', { operationId, type: 'mergeVertices', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Center the model at the origin (0,0,0).
     */
    async centerModel(stlFilePath, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting centering operation...");
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(60, "Calculating center...");
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            if (center.lengthSq() < 0.0001) { // Already centered (or very close)
                if (progressCallback)
                    progressCallback(100, "Model is already centered.");
                console.error("Model already centered. No changes made.");
                this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: stlFilePath, message: "Model already centered." });
                return stlFilePath; // Return original path
            }
            if (progressCallback)
                progressCallback(70, `Applying translation: (${-center.x.toFixed(2)}, ${-center.y.toFixed(2)}, ${-center.z.toFixed(2)})`);
            const translationMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            geometry.applyMatrix4(translationMatrix);
            geometry.computeBoundingBox(); // Recompute bounds after moving
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            const outputFileName = path.basename(stlFilePath, '.stl') + '_centered.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await this.saveSTL(geometry, outputFilePath, progressCallback); // 80-100% progress
            this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: outputFilePath });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', { operationId, type: 'centerModel', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Rotate the model so its largest flat face lies on the XY plane (Z=0).
     */
    async layFlat(stlFilePath, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting lay flat operation...");
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50%
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(55, "Analyzing faces...");
            const positionAttribute = geometry.getAttribute('position');
            if (!positionAttribute)
                throw new Error("Geometry has no position attribute.");
            // Triangles in one plane (same quantized normal and offset) form one face, in a single pass.
            // shortcut: a plane exactly on a bucket edge could split in two; widen the buckets if that shows up.
            const center = boundingBox.getCenter(new THREE.Vector3());
            const faces = new Map();
            const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
            const cross = new THREE.Vector3(), edge = new THREE.Vector3();
            const volumeMoment = new THREE.Vector3(), surfaceMoment = new THREE.Vector3();
            let volume = 0, surface = 0;
            const vertexAt = (target, index) => target.fromBufferAttribute(positionAttribute, index).sub(center);
            for (let i = 0; i + 2 < positionAttribute.count; i += 3) {
                vertexAt(a, i);
                vertexAt(b, i + 1);
                vertexAt(c, i + 2);
                cross.subVectors(c, b).cross(edge.subVectors(a, b));
                const area = cross.length() / 2;
                if (!(area > 1e-12))
                    continue; // degenerate triangle
                // Centre of mass: signed tetrahedra against the centre for a closed mesh, triangle areas otherwise.
                const tetra = a.dot(edge.crossVectors(b, c)) / 6;
                volume += tetra;
                volumeMoment.addScaledVector(edge.copy(a).add(b).add(c), tetra / 4);
                surface += area;
                surfaceMoment.addScaledVector(edge.copy(a).add(b).add(c), area / 3);
                const normal = cross.divideScalar(2 * area);
                const key = [normal.x, normal.y, normal.z].map(v => Math.round(v * 1000)).join(',') + ',' + Math.round(normal.dot(a) / 0.05);
                const face = faces.get(key) ?? { area: 0, normal: new THREE.Vector3(), triangles: [] };
                face.area += area;
                face.normal.addScaledVector(normal, area);
                face.triangles.push(i);
                faces.set(key, face);
            }
            for (const face of faces.values())
                face.normal.normalize(); // summed so far, area-weighted
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(65, "Finding largest stable flat face...");
            // shortcut: the volume centroid assumes a closed, consistently wound mesh.
            const size = boundingBox.getSize(new THREE.Vector3());
            const centerOfMass = Math.abs(volume) > 1e-9 * size.x * size.y * size.z
                ? volumeMoment.divideScalar(volume)
                : surfaceMoment.divideScalar(surface);
            // A face is a stable base when its plane supports the whole mesh (nothing sticks out past it, which
            // rules out the flank of a fin) and the centre of mass, projected along the face normal,
            // falls inside the convex hull of the face's points.
            const isStable = (face) => {
                const u = new THREE.Vector3(Math.abs(face.normal.x) < 0.9 ? 1 : 0, Math.abs(face.normal.x) < 0.9 ? 0 : 1, 0).cross(face.normal).normalize();
                const v = new THREE.Vector3().crossVectors(face.normal, u);
                const points = [];
                for (const start of face.triangles) {
                    for (let k = 0; k < 3; k++) {
                        vertexAt(a, start + k);
                        points.push([a.dot(u), a.dot(v)]);
                    }
                }
                const hull = convexHull(points);
                const px = centerOfMass.dot(u), py = centerOfMass.dot(v);
                const supportsCenter = hull.length >= 3 && hull.every(([x1, y1], k) => {
                    const [x2, y2] = hull[(k + 1) % hull.length];
                    return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1) >= -1e-6 * Math.hypot(x2 - x1, y2 - y1);
                });
                if (!supportsCenter)
                    return false;
                // The O(vertices) scan runs last, only for the few faces whose hull holds the centre of mass.
                const planeD = vertexAt(a, face.triangles[0]).dot(face.normal);
                for (let q = 0; q < positionAttribute.count; q++) {
                    if (vertexAt(a, q).dot(face.normal) > planeD + 0.05)
                        return false;
                }
                return true;
            };
            const ranked = [...faces.values()].sort((p, q) => q.area - p.area);
            let target;
            for (const face of ranked) {
                if (target && face.area < target.area * (1 - 1e-6))
                    break;
                if (!isStable(face))
                    continue;
                // Equal areas (a plate's top and bottom): prefer the face already pointing down so a seated part is not flipped.
                if (!target || face.normal.z < target.normal.z)
                    target = face;
            }
            if (!target && ranked.length > 0) {
                console.error("No flat face supports the centre of mass; using the largest flat face.");
                target = ranked[0];
            }
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (!target) {
                // Only a mesh without any face area reaches this.
                console.warn("Could not find a suitable large flat face to lay down. No changes made.");
                this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: stlFilePath, message: "No suitable flat face found." });
                return stlFilePath;
            }
            const targetNormal = target.normal;
            const downVector = new THREE.Vector3(0, 0, -1); // Target normal (pointing down)
            if (progressCallback)
                progressCallback(80, "Calculating rotation...");
            // Calculate the rotation needed to align targetNormal with downVector
            const quaternion = new THREE.Quaternion().setFromUnitVectors(targetNormal, downVector);
            const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
            // Rotate around the model's center
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
            // Apply rotation
            geometry.applyMatrix4(toOriginMatrix);
            geometry.applyMatrix4(rotationMatrix);
            geometry.applyMatrix4(fromOriginMatrix);
            // Translate so the new bottom is at Z=0
            geometry.computeBoundingBox(); // Recompute bounds after rotation
            const newMinZ = geometry.boundingBox.min.z;
            const translateToZeroMatrix = new THREE.Matrix4().makeTranslation(0, 0, -newMinZ);
            geometry.applyMatrix4(translateToZeroMatrix);
            geometry.computeBoundingBox(); // Final bounds
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            const outputFileName = path.basename(stlFilePath, '.stl') + '_flat.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await this.saveSTL(geometry, outputFilePath, progressCallback); // 90-100% progress
            this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: outputFilePath });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', { operationId, type: 'layFlat', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
}
