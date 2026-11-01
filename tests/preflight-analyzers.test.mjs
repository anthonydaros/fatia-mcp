import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { preflightCheck } from '../dist/knowledge/preflight.js';
import { STLManipulator } from '../dist/stl/stl-manipulator.js';
import { buildLayoutProject, x2dConfig } from './fixtures/layout-project.mjs';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const deps = { defaultModel: 'x2d', validModels: ['x2d'], askModel: async () => 'x2d', meshInfo: file => new STLManipulator(dir).getSTLInfo(file), studioVersion: async () => '2.8.4.57', studioInfo: async () => ({}) };
  return { dir, run: (file, checks, extra = {}) => preflightCheck({ file_path: file, checks, max_findings: 200 }, { ...deps, ...extra }) };
}
const code = [
  '; HEADER_BLOCK_START', '; total layer number: 1', '; HEADER_BLOCK_END',
  '; CONFIG_BLOCK_START', '; retraction_minimum_travel = 1', '; filament_map = 1', '; filament_diameter = 1.75', '; filament_density = 1.26', '; filament_max_volumetric_speed = 21', '; enable_support = 0', '; ironing_type = no ironing', '; brim_type = no_brim', '; enable_prime_tower = 0', '; CONFIG_BLOCK_END',
  '; EXECUTABLE_BLOCK_START', 'M83', 'G90', '; MACHINE_START_GCODE_END',
  '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2', 'G1 Z.2', 'G1 X0 Y0 F6000',
  '; FEATURE: Outer wall', '; LINE_WIDTH: 0.42', 'G1 X10 Y0 E1 F1800', 'G1 X20 Y0 F6000', 'G1 X20 Y10 E1 F1800',
  '; MACHINE_END_GCODE_START', '; EXECUTABLE_BLOCK_END', '',
].join('\n');

test('opt-in preflight G-code scanning detects an unprotected travel with measured evidence', async t => {
  const { dir, run } = await setup(t), file = path.join(dir, 'part.gcode'); await fs.writeFile(file, code);
  const off = await run(file, {}); assert.ok(!off.findings.some(f => f.rule_id === 'bambu.travel.unprotected-travel'));
  const on = await run(file, { gcode: true });
  const finding = on.findings.find(f => f.rule_id === 'bambu.travel.unprotected-travel');
  assert.ok(finding); assert.equal(finding.evidence['gcode.unprotected_travel_count'], 1);
  assert.ok(on.stage_reached.includes('post-slice-gcode')); assert.equal(on.analysis.gcode.complete, true); assert.equal(on.analysis.gcode.evidence['gcode.unprotected_travel_count'].approx, false);
});

test('partial G-code cannot turn incomplete measurements into a preflight finding or a zero', async t => {
  const { dir, run } = await setup(t), file = path.join(dir, 'cut.gcode'); await fs.writeFile(file, code.replace('; EXECUTABLE_BLOCK_END\n', ''));
  const result = await run(file, { gcode: true }); assert.equal(result.analysis.gcode.complete, false);
  assert.ok(!result.findings.some(f => f.rule_id === 'bambu.travel.unprotected-travel'));
  assert.ok(result.unchecked.total > 0);
});

test('preflight fast mesh detects several top levels and G-code scanning works inside 3MF', async t => {
  const { dir, run } = await setup(t), file = path.join(dir, 'part.3mf');
  const bytes = await buildLayoutProject({ objects: [{ id: 1, name: 'base', size: [10, 10, 2], at: [30, 30] }, { id: 2, name: 'letters', size: [5, 5, 4], at: [50, 30] }], plates: [['1:0', '2:0']], config: x2dConfig({ ironing_type: 'topmost' }) });
  const zip = await JSZip.loadAsync(bytes);
  // Two cuboids in the SAME mesh: a 2 mm base plus a raised top at 4 mm.
  const positions = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,2],[10,0,2],[10,10,2],[0,10,2],[2,2,2],[7,2,2],[7,7,2],[2,7,2],[2,2,4],[7,2,4],[7,7,4],[2,7,4]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const verts = positions.map(v => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('');
  const tris = [0,8].flatMap(offset => faces.map(f => `<triangle v1="${f[0]+offset}" v2="${f[1]+offset}" v3="${f[2]+offset}"/>`)).join('');
  zip.file('3D/3dmodel.model', `<model><resources><object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);
  zip.file('Metadata/model_settings.config', '<config><object id="1"><part id="1" subtype="normal_part"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>');
  zip.file('Metadata/plate_1.gcode', code); await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await run(file, { mesh: 'fast', gcode: true });
  assert.equal(result.analysis.mesh.facts['mesh.top_surface_levels'], 2);
  assert.ok(result.findings.some(f => f.rule_id === 'bambu.ironing.topmost-leaves-base-scratched'));
  assert.ok(result.findings.some(f => f.rule_id === 'bambu.travel.unprotected-travel'));
  assert.equal(result.accounting.candidates, result.accounting.findings + result.accounting.checklist + result.accounting.not_fired + result.accounting.unchecked + result.accounting.hidden);
});

test('preflight propagates cancellation instead of swallowing an aborted scan', async t => {
  const { dir, run } = await setup(t), file = path.join(dir, 'part.gcode'); await fs.writeFile(file, code);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(file, { gcode: true }, { signal: controller.signal }), /abort/i);
});
