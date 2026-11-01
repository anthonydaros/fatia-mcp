import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { STLManipulator } from '../../dist/stl/stl-manipulator.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const X2D = 'Bambu Lab X2D 0.4 nozzle';
const POSIX_ONLY = { skip: process.platform === 'win32' };

// A tiny BBL tree for an X2D, plus a fake Bambu Studio that records its arguments and writes a sliced 3MF.
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const profiles = path.join(dir, 'BambuStudio.app', 'Contents', 'Resources', 'profiles');
  const bbl = path.join(profiles, 'BBL');
  for (const kind of ['machine', 'process', 'filament']) await fs.mkdir(path.join(bbl, kind), { recursive: true });
  await fs.writeFile(path.join(bbl, 'cli_config.json'), JSON.stringify({
    printer: { 'Bambu Lab X2D': { machine_limits: { cli_safe_acceleration_x: '6000,6000' } } },
  }));
  const write = (kind, value) => fs.writeFile(path.join(bbl, kind, `${value.name}.json`), JSON.stringify(value));
  await write('machine', {
    name: X2D, nozzle_diameter: ['0.4'], machine_start_gcode: 'X2D START', z_hop: ['0.4', '0.4', '0.4'], z_hop_types: ['Auto Lift', 'Auto Lift', 'Auto Lift'],
    default_print_profile: '0.20mm Standard @BBL X2D', default_filament_profile: ['Bambu PLA Basic @BBL X2D 0.4 nozzle'],
  });
  const variants = { print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard'], print_extruder_id: ['1', '1', '2'] };
  for (const [name, layer] of [['0.20mm Standard @BBL X2D', '0.2'], ['0.12mm Fine @BBL X2D', '0.12']]) {
    await write('process', { name, compatible_printers: [X2D], layer_height: layer, sparse_infill_pattern: 'grid', outer_wall_speed: ['200', '500', '50'], ...variants });
  }
  const filament = (name, compatible, type = 'PLA') => write('filament', { name, compatible_printers: [compatible], filament_type: [type], nozzle_temperature: ['220'], filament_flow_ratio: ['0.98', '0.98', '0.98'] });
  await filament('Bambu PLA Basic @BBL X2D 0.4 nozzle', X2D);
  await filament('Generic PLA @BBL X2D', 'Bambu Lab X2D 0.6 nozzle'); // the bare name is the 0.6/0.8 variant
  await filament('Generic PLA @BBL X2D 0.4 nozzle', X2D);

  const executable = path.join(dir, 'BambuStudio.app', 'Contents', 'MacOS', 'BambuStudio');
  const capture = path.join(dir, 'args.json');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
const zip = new (require(${JSON.stringify(path.join(root, 'node_modules', 'jszip'))}))();
zip.file('Metadata/slice_info.config', '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="60"/><metadata key="weight" value="1.5"/></plate></config>');
zip.generateAsync({ type: 'nodebuffer' }).then(buffer => fs.writeFileSync(path.join(args[args.indexOf('--outputdir') + 1], args[args.indexOf('--export-3mf') + 1]), buffer));
`, { mode: 0o755 });

  // The creator's project, made on an H2D unless a config overrides it.
  const project = async (config = {}, name = 'project.3mf') => {
    const zip = new JSZip();
    zip.file('Metadata/project_settings.config', JSON.stringify({
      printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
      print_settings_id: '0.12mm Fine @BBL H2D',
      filament_settings_id: ['Generic PLA @BBL H2D', 'Mystery PETG @BBL H2D'],
      filament_type: ['PLA', 'PETG'],
      filament_colour: ['#000000', '#FFFFFF'],
      print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
      print_extruder_id: ['1', '1', '2', '2'],
      outer_wall_speed: ['100', '300', '100', '300'],
      sparse_infill_pattern: 'gyroid',
      different_settings_to_system: ['outer_wall_speed;sparse_infill_pattern', 'nozzle_temperature', '', 'machine_start_gcode'],
      ...config,
    }));
    const file = path.join(dir, name);
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    return file;
  };
  return { dir, profiles, bbl, executable, capture, project, args: async () => JSON.parse(await fs.readFile(capture, 'utf8')) };
}

// A project made for the target printer, with the printer's default process values.
const x2dDefaults = {
  printer_settings_id: X2D, print_settings_id: '0.20mm Standard @BBL X2D', filament_settings_id: ['Bambu PLA Basic @BBL X2D 0.4 nozzle'],
  print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard'], print_extruder_id: ['1', '1', '2'],
  outer_wall_speed: ['200', '500', '50'],
};

function plan(f, input, skipFilaments) {
  return new STLManipulator(path.join(f.dir, 'plan')).planProjectSettings(input, f.executable, X2D, 'X2D', skipFilaments);
}
const withProfilesRoot = (t, f) => {
  const saved = process.env.BAMBU_PROFILES_ROOT;
  process.env.BAMBU_PROFILES_ROOT = f.profiles;
  t.after(() => { if (saved === undefined) delete process.env.BAMBU_PROFILES_ROOT; else process.env.BAMBU_PROFILES_ROOT = saved; });
};

test('a project from another printer is mapped onto the X2D presets, and what does not fit is listed', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const p = await plan(f, await f.project());
  assert.equal(p.process, '0.12mm Fine @BBL X2D', 'the process preset with the same base name');
  // Extruder 1 variants map by name; the H2D's extruder 2 has no X2D match, so the X2D default stays.
  assert.deepEqual(p.overlay, { sparse_infill_pattern: 'gyroid', outer_wall_speed: ['100', '300', '50'] });
  assert.deepEqual(p.filaments, [
    { slot: 1, from: 'Generic PLA @BBL H2D', to: 'Generic PLA @BBL X2D 0.4 nozzle' },
    { slot: 2, from: 'Mystery PETG @BBL H2D', to: 'Bambu PLA Basic @BBL X2D 0.4 nozzle' },
  ]);
  assert.deepEqual(p.kept, [
    'process preset: 0.12mm Fine @BBL X2D -> 0.20mm Standard @BBL X2D',
    'outer_wall_speed: ["100","300","50"] -> ["200","500","50"]',
    'sparse_infill_pattern: gyroid -> grid',
    'filament 1: Generic PLA @BBL H2D -> Generic PLA @BBL X2D 0.4 nozzle (printer default: Bambu PLA Basic @BBL X2D 0.4 nozzle)',
  ]);
  assert.deepEqual(p.notKept, [
    'outer_wall_speed: no X2D equivalent for extruder 2 Direct Drive Standard, extruder 2 Direct Drive High Flow',
    'filament 1 Generic PLA @BBL H2D: edited nozzle_temperature (filament edits are not carried over)',
    'filament 2 Mystery PETG @BBL H2D: no X2D equivalent compatible with Bambu Lab X2D 0.4 nozzle; using Bambu PLA Basic @BBL X2D 0.4 nozzle',
    'printer: machine_start_gcode (machine settings come from Bambu Lab X2D 0.4 nozzle)',
  ]);
});

test('a project from the same printer keeps its changes; one that matches the defaults has nothing to choose', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const same = x2dDefaults;
  const changed = await plan(f, await f.project({ ...same, different_settings_to_system: ['sparse_infill_pattern', '', ''] }));
  assert.deepEqual([changed.kept, changed.notKept], [['sparse_infill_pattern: gyroid -> grid'], []]);
  // Changed in the project but already the printer default: keeping and defaults slice the same.
  const moot = await plan(f, await f.project({ ...same, sparse_infill_pattern: 'grid', different_settings_to_system: ['sparse_infill_pattern;outer_wall_speed', '', ''] }));
  assert.deepEqual([moot.kept, moot.notKept, moot.overlay], [[], [], {}]);
  // The caller's own filaments replace the project's: no slot is mapped or reported.
  assert.deepEqual((await plan(f, await f.project(same), true)).filaments, []);
});

// Bambu Studio rewrites different_settings_to_system when it saves, and hand edits never update it: for the
// project's own printer the values are trusted whole, not only the keys the list names.
const sameX2D = {
  ...x2dDefaults, print_settings_id: '0.20mm Standard @BBL X2D (project settings)',
  layer_height: '0.20', outer_wall_speed: ['100', '500', '50'], sparse_infill_pattern: 'gyroid',
  compatible_printers: [], from: 'project', different_settings_to_system: ['enable_prime_tower', '', ''],
};

test('a project for the target printer keeps every changed process value, whatever its changed-keys list says', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const p = await plan(f, await f.project(sameX2D));
  // layer_height "0.20" is the default "0.2" rewritten; the preset-identity keys are never edits.
  assert.deepEqual(p.overlay, { outer_wall_speed: ['100', '500', '50'], sparse_infill_pattern: 'gyroid' });
  assert.deepEqual(p.kept, ['sparse_infill_pattern: gyroid -> grid', 'outer_wall_speed: ["100","500","50"] -> ["200","500","50"]']);
  assert.deepEqual(p.notKept, [], 'a process name the tree does not know is not a loss when the values are kept');
});

test('slicing a project for the target printer loads its values although the changed-keys list omits them', POSIX_ONLY, async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const input = await f.project(sameX2D);
  await new STLManipulator(path.join(f.dir, 'out'))
    .sliceSTL(input, 'bambustudio', f.executable, undefined, undefined, X2D, { projectPlan: await plan(f, input) });
  const args = await f.args();
  const cli = JSON.parse(await fs.readFile(args[args.indexOf('--load-settings') + 1].split(';')[1], 'utf8'));
  assert.deepEqual([cli.sparse_infill_pattern, cli.outer_wall_speed], ['gyroid', ['100', '500', '50']]);
});

// The sparse process preset lacks keys such as wall_sequence and brim_type: the CLI resets them to its own default unless the overlay carries them.
test('a project for the target printer also keeps a changed key its process preset lacks, when it lists it; post_process never', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const config = { ...x2dDefaults, sparse_infill_pattern: 'grid', wall_sequence: 'inner-outer-inner wall', brim_type: 'outer_only', post_process: ['calc.exe'], different_settings_to_system: ['wall_sequence;post_process', '', ''] };
  const p = await plan(f, await f.project(config));
  assert.deepEqual(p.overlay, { wall_sequence: 'inner-outer-inner wall' }, 'brim_type is not listed and not in the preset: nothing says it was edited');
  assert.deepEqual([p.kept, p.notKept], [['wall_sequence: inner-outer-inner wall -> unset'], []]);
  // A project from another printer carries it the same way.
  const other = await plan(f, await f.project({ ...config, printer_settings_id: 'Bambu Lab H2D 0.4 nozzle', print_settings_id: '0.12mm Fine @BBL H2D' }));
  assert.deepEqual(other.overlay, { wall_sequence: 'inner-outer-inner wall' });
});

test('a process list that names G-code or machine keys never carries them into the slice, for either printer', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const config = { ...x2dDefaults, sparse_infill_pattern: 'grid', wall_sequence: 'inner-outer-inner wall', layer_change_gcode: 'M104 S400', machine_start_gcode: 'EVIL START', machine_max_acceleration_x: ['99999'], different_settings_to_system: ['wall_sequence;layer_change_gcode;machine_start_gcode;machine_max_acceleration_x', '', ''] };
  const same = await plan(f, await f.project(config));
  assert.deepEqual(same.overlay, { wall_sequence: 'inner-outer-inner wall' });
  const other = await plan(f, await f.project({ ...config, printer_settings_id: 'Bambu Lab H2D 0.4 nozzle', print_settings_id: '0.12mm Fine @BBL H2D' }));
  assert.deepEqual(other.overlay, { wall_sequence: 'inner-outer-inner wall' });
});

// What a tuned project lists as edited for the printer and for a filament must survive a later slice, which takes both from the presets.
const tuned = {
  ...x2dDefaults, filament_type: ['PLA'], filament_colour: ['#000000'], z_hop: ['0.8', '0.8', '0.8'], machine_start_gcode: 'EVIL START', nozzle_temperature: ['215'], filament_start_gcode: ['M104 S400'],
  different_settings_to_system: ['', 'nozzle_temperature;filament_start_gcode', 'machine_start_gcode;z_hop'],
};

test('a project for the target printer carries its edited retraction and filament keys, and never G-code or hardware keys', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const p = await plan(f, await f.project(tuned));
  assert.deepEqual(p.machineOverlay, { z_hop: ['0.8', '0.8', '0.8'] });
  assert.deepEqual(p.filaments, [{ slot: 1, from: 'Bambu PLA Basic @BBL X2D 0.4 nozzle', to: 'Bambu PLA Basic @BBL X2D 0.4 nozzle', overlay: { nozzle_temperature: ['215'] } }]);
  assert.deepEqual(p.kept.slice(1), ['printer z_hop: ["0.8","0.8","0.8"] -> ["0.4","0.4","0.4"]', 'filament 1 nozzle_temperature: ["215"] -> ["220"]']);
  assert.deepEqual(p.notKept, [
    `printer machine_start_gcode: machine settings outside the retraction family come from ${X2D}`,
    'filament 1 filament_start_gcode: G-code and preset identity come from Bambu PLA Basic @BBL X2D 0.4 nozzle',
  ]);
});

// Two slots with different values: a slot must get its own slice, never slot 1's.
test('each filament slot takes its own slice of a project vector, per slot and per slot and extruder variant', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const preset = 'Bambu PLA Basic @BBL X2D 0.4 nozzle';
  const p = await plan(f, await f.project({
    ...x2dDefaults, filament_settings_id: [preset, preset], filament_type: ['PLA', 'PLA'], filament_colour: ['#000000', '#FFFFFF'],
    nozzle_temperature: ['215', '205'], // the preset holds one value: the project holds one per slot
    filament_flow_ratio: ['0.91', '0.92', '0.93', '0.94', '0.95', '0.96'], // the preset holds three (the extruder variants): the project holds three per slot
    different_settings_to_system: ['', 'nozzle_temperature;filament_flow_ratio', 'nozzle_temperature;filament_flow_ratio', ''],
  }));
  assert.deepEqual(p.filaments.map(entry => entry.overlay), [
    { nozzle_temperature: ['215'], filament_flow_ratio: ['0.91', '0.92', '0.93'] },
    { nozzle_temperature: ['205'], filament_flow_ratio: ['0.94', '0.95', '0.96'] },
  ]);
  assert.deepEqual(p.notKept, []);
});

test('a project from another printer still carries none of its printer or filament edits', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const p = await plan(f, await f.project({ ...tuned, printer_settings_id: 'Bambu Lab H2D 0.4 nozzle', filament_settings_id: ['Generic PLA @BBL H2D'] }));
  assert.deepEqual(p.machineOverlay, {});
  assert.ok(p.filaments.every(entry => entry.overlay === undefined));
  assert.ok(p.notKept.some(line => line === `printer: machine_start_gcode, z_hop (machine settings come from ${X2D})`));
});

test('slicing a tuned project merges its printer and filament edits onto the prepared machine and filament files', POSIX_ONLY, async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const input = await f.project(tuned);
  await new STLManipulator(path.join(f.dir, 'out'))
    .sliceSTL(input, 'bambustudio', f.executable, undefined, undefined, X2D, { projectPlan: await plan(f, input) });
  const args = await f.args();
  const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
  const machine = await read(args[args.indexOf('--load-settings') + 1].split(';')[0]);
  const filament = await read(args[args.indexOf('--load-filaments') + 1].split(';')[0]);
  assert.deepEqual([machine.z_hop, machine.machine_start_gcode], [['0.8', '0.8', '0.8'], 'X2D START']);
  assert.deepEqual([filament.nozzle_temperature, filament.filament_start_gcode], [['215'], undefined]);
});

test('exportOnly writes the project without asking the slicer to slice', POSIX_ONLY, async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const input = await f.project(x2dDefaults);
  await new STLManipulator(path.join(f.dir, 'out')).sliceSTL(input, 'bambustudio', f.executable, undefined, undefined, X2D, { exportOnly: true });
  const args = await f.args();
  assert.deepEqual([args.includes('--slice'), args.includes('--export-3mf')], [false, true]);
});

test('a process preset that only other model codes carry is kept for the printer that uses it (P1S on the X1C presets)', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const P1S = 'Bambu Lab P1S 0.4 nozzle';
  const write = (kind, value) => fs.writeFile(path.join(f.bbl, kind, `${value.name}.json`), JSON.stringify(value));
  await write('machine', { name: P1S, nozzle_diameter: ['0.4'], default_print_profile: '0.20mm Standard @BBL X1C', default_filament_profile: ['Generic PLA @BBL X1C'] });
  for (const [name, layer] of [['0.20mm Standard @BBL X1C', '0.2'], ['0.12mm Fine @BBL X1C', '0.12']]) {
    await write('process', { name, compatible_printers: [P1S], layer_height: layer, sparse_infill_pattern: 'grid' });
  }
  await write('filament', { name: 'Generic PLA @BBL X1C', compatible_printers: [P1S], filament_type: ['PLA'] });
  const input = await f.project({
    printer_settings_id: P1S, print_settings_id: '0.12mm Fine @BBL X1C', filament_settings_id: ['Generic PLA @BBL X1C'],
    print_extruder_variant: [], print_extruder_id: [], different_settings_to_system: ['sparse_infill_pattern', '', ''],
  });
  const p = await new STLManipulator(path.join(f.dir, 'plan')).planProjectSettings(input, f.executable, P1S, 'P1S');
  assert.equal(p.process, '0.12mm Fine @BBL X1C');
  assert.deepEqual(p.filaments, [{ slot: 1, from: 'Generic PLA @BBL X1C', to: 'Generic PLA @BBL X1C' }]);
  assert.deepEqual(p.kept, ['process preset: 0.12mm Fine @BBL X1C -> 0.20mm Standard @BBL X1C', 'sparse_infill_pattern: gyroid -> grid']);
  assert.deepEqual(p.notKept, []);
});

test('a 3MF without project settings, or an STL, has no plan', async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const geometryOnly = path.join(f.dir, 'geometry.3mf');
  await fs.writeFile(geometryOnly, await new JSZip().file('3D/3dmodel.model', '<model/>').generateAsync({ type: 'nodebuffer' }));
  assert.equal(await plan(f, geometryOnly), undefined);
  assert.equal(await plan(f, path.join(f.dir, 'model.stl')), undefined);
});

test('slicing with a plan loads the overlaid process and the mapped filaments, never the project machine settings', POSIX_ONLY, async t => {
  const f = await fixture(t);
  withProfilesRoot(t, f);
  const input = await f.project();
  const manipulator = new STLManipulator(path.join(f.dir, 'out'));
  const slice = options => manipulator.sliceSTL(input, 'bambustudio', f.executable, undefined, undefined, X2D, options);
  const loaded = async () => {
    const args = await f.args();
    const [machine, processFile] = args[args.indexOf('--load-settings') + 1].split(';');
    return {
      machine: JSON.parse(await fs.readFile(machine, 'utf8')),
      process: JSON.parse(await fs.readFile(processFile, 'utf8')),
      filaments: await Promise.all(args[args.indexOf('--load-filaments') + 1].split(';').map(async file => JSON.parse(await fs.readFile(file, 'utf8')))),
    };
  };

  await slice({});
  let cli = await loaded();
  assert.deepEqual([cli.process.sparse_infill_pattern, cli.process.layer_height], ['grid', '0.2'], 'without a plan the printer defaults apply');
  assert.deepEqual(cli.filaments.map(x => x.filament_settings_id[0]), Array(2).fill('Bambu PLA Basic @BBL X2D 0.4 nozzle'));

  await slice({ projectPlan: await plan(f, input) });
  cli = await loaded();
  assert.deepEqual([cli.process.sparse_infill_pattern, cli.process.layer_height, cli.process.outer_wall_speed], ['gyroid', '0.12', ['100', '300', '50']]);
  assert.deepEqual(cli.filaments.map(x => x.filament_settings_id[0]), ['Generic PLA @BBL X2D 0.4 nozzle', 'Bambu PLA Basic @BBL X2D 0.4 nozzle']);
  assert.deepEqual(cli.filaments.map(x => x.filament_colour[0]), ['#000000', '#FFFFFF'], 'the project colours survive');
  assert.equal(cli.machine.machine_start_gcode, 'X2D START');
});

// The tool level: the prompt, its answers, and the settings_report in the result.
async function server(t, f, answer) {
  const out = path.join(f.dir, 'server-out');
  const prompts = [];
  const client = new Client({ name: 'project-settings-test', version: '1' }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  if (answer) client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts.push(request.params.message);
    return answer === 'decline' ? { action: 'decline' } : { action: 'accept', content: { project_settings: answer } };
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'dist/index.js')], cwd: f.dir, stderr: 'pipe',
    env: {
      ...process.env, MCP_TRANSPORT: 'stdio', TEMP_DIR: out, BAMBU_MODEL: 'x2d', SLICER_TYPE: 'bambustudio', SLICER_PATH: f.executable,
      BAMBU_PROFILES_ROOT: f.profiles, BAMBU_SLICER_PROFILE_DIRS: '', BAMBU_SLICER_PROFILE: '', SLICER_PROFILE: '', BAMBU_TEMPLATE_3MF_PATH: '',
      BAMBU_PRINTER_SERIAL: '', BAMBU_SERIAL: '', BAMBU_PRINTER_ACCESS_TOKEN: '', BAMBU_TOKEN: '',
    },
  }));
  t.after(() => client.close());
  const slice = async (input, extra = {}) => {
    const result = await client.callTool({ name: 'slice_stl', arguments: { stl_path: input, bambu_model: 'x2d', ...extra } });
    const text = result.content[0].text;
    return { error: result.isError ? text : undefined, result: result.isError ? undefined : JSON.parse(text) };
  };
  const cliLaunched = () => fs.access(f.capture).then(() => true, () => false);
  const pattern = async () => {
    const args = await f.args();
    return JSON.parse(await fs.readFile(args[args.indexOf('--load-settings') + 1].split(';')[1], 'utf8')).sparse_infill_pattern;
  };
  return { client, prompts, slice, cliLaunched, pattern };
}

test('without elicitation the call fails before slicing and tells the agent to ask the user', POSIX_ONLY, async t => {
  const f = await fixture(t);
  const s = await server(t, f);
  const { error } = await s.slice(await f.project());
  assert.match(error, /Ask the user.*project_settings "keep" or "printer_default"/s);
  assert.match(error, /sparse_infill_pattern: gyroid -> grid/);
  assert.equal(await s.cliLaunched(), false);
});

test('project_settings answers without a prompt and the result carries a settings_report', POSIX_ONLY, async t => {
  const f = await fixture(t);
  const s = await server(t, f);
  const input = await f.project();
  const keep = await s.slice(input, { project_settings: 'keep' });
  assert.equal(await s.pattern(), 'gyroid');
  assert.equal(keep.result.plates[0].weight_g, 1.5, "t2's plates survive next to the report");
  assert.equal(keep.result.settings_report.mode, 'keep');
  assert.equal(keep.result.settings_report.kept.length, 4);
  assert.deepEqual(keep.result.settings_report.filament_map[0], { slot: 1, from: 'Generic PLA @BBL H2D', to: 'Generic PLA @BBL X2D 0.4 nozzle' });

  const defaults = await s.slice(input, { project_settings: 'printer_default' });
  assert.equal(await s.pattern(), 'grid');
  assert.deepEqual([defaults.result.settings_report.mode, defaults.result.settings_report.kept], ['printer_default', []]);
  assert.ok(defaults.result.settings_report.not_kept.includes('sparse_infill_pattern: gyroid -> grid'));
  assert.deepEqual(defaults.result.settings_report.filament_map.map(x => x.to), Array(2).fill('Bambu PLA Basic @BBL X2D 0.4 nozzle'));

  assert.match((await s.slice(input, { project_settings: 'maybe' })).error, /project_settings must be/);
  assert.deepEqual(s.prompts, []);
});

test('the user is asked per file, with the differences, and the answer decides the settings', POSIX_ONLY, async t => {
  const f = await fixture(t);
  const input = await f.project();
  const asked = await server(t, f, 'keep');
  const { result } = await asked.slice(input);
  assert.equal(asked.prompts.length, 1);
  assert.match(asked.prompts[0], /project\.3mf was made for Bambu Lab H2D 0\.4 nozzle \(0\.12mm Fine @BBL H2D\).*sliced for Bambu Lab X2D 0\.4 nozzle/s);
  assert.match(asked.prompts[0], /- sparse_infill_pattern: gyroid -> grid/);
  assert.match(asked.prompts[0], /- filament 1: Generic PLA @BBL H2D -> Generic PLA @BBL X2D 0\.4 nozzle/);
  assert.match(asked.prompts[0], /Cannot be kept:\n- outer_wall_speed: no X2D equivalent/);
  assert.equal(result.settings_report.mode, 'keep');
  assert.equal(await asked.pattern(), 'gyroid');

  const defaults = await server(t, f, 'printer_default');
  assert.equal((await defaults.slice(input)).result.settings_report.mode, 'printer_default');
  assert.equal(await defaults.pattern(), 'grid');

  await fs.rm(f.capture);
  const declined = await server(t, f, 'decline');
  assert.match((await declined.slice(input)).error, /choice was cancelled; nothing was sliced/);
  assert.equal(await declined.cliLaunched(), false);
});

test('a project with nothing to choose, an STL, and an explicit slicer profile are not asked', POSIX_ONLY, async t => {
  const f = await fixture(t);
  const s = await server(t, f, 'decline');
  const plain = await f.project({ ...x2dDefaults, sparse_infill_pattern: 'grid', different_settings_to_system: ['', '', ''] });
  assert.equal((await s.slice(plain)).result.settings_report.mode, 'printer_default');

  const profile = path.join(f.dir, 'process.json');
  await fs.writeFile(profile, JSON.stringify({ name: 'Mine', sparse_infill_pattern: 'cubic' }));
  const explicit = await s.slice(await f.project(), { slicer_profile: profile });
  assert.equal(explicit.result.settings_report, undefined);
  assert.equal(await s.pattern(), 'cubic');

  const stl = path.join(f.dir, 'model.stl');
  await fs.writeFile(stl, 'fixture STL (only the fake CLI reads it)');
  assert.equal((await s.slice(stl)).result.settings_report, undefined);
  assert.deepEqual(s.prompts, []);
});

test('use_printer_filaments defaults to false so a configured printer does not silently replace project filaments', POSIX_ONLY, async t => {
  const f = await fixture(t);
  const s = await server(t, f);
  const { tools } = await s.client.listTools();
  for (const name of ['slice_stl', 'slice_with_template']) {
    const properties = tools.find(tool => tool.name === name).inputSchema.properties;
    assert.match(properties.use_printer_filaments.description, /^Default false/);
    assert.deepEqual(properties.project_settings.enum, ['keep', 'printer_default']);
  }
});
