import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = fileURLToPath(new URL('../', import.meta.url));
test('32-tool MCP dispatches new read/write workflows and validates nested scenario inputs', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-workflow-mcp-'));
    const client = new Client({ name: 'workflow-mcp-test', version: '1' });
    t.after(async () => { await client.close(); await fs.rm(dir, { recursive: true, force: true }); });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/index.js'), '--stdio'], cwd: dir, stderr: 'pipe', env: { PATH: process.env.PATH || '', BAMBU_MODEL: 'p1s', FATIA_OUTPUT_DIR: path.join(dir, 'outputs'), TEMP_DIR: '' } }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 32);
    const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.notEqual(r.isError, true, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', '<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>');
    zip.file('Metadata/project_settings.config', '{"printer_settings_id":"Bambu Lab P1S 0.4 nozzle"}');
    zip.file('Metadata/model_settings.config', '<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>');
    zip.file('Metadata/slice_info.config', '<config><plate><metadata key="index" value="1"/><metadata key="weight" value="10"/><metadata key="prediction" value="60"/></plate></config>');
    const file = path.join(dir, 'part.3mf');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const fit = await call('create_fit_test', { gaps_mm: [.2] });
    assert.equal(fit.coupons.length, 1);
    assert.ok(await fs.stat(fit.manifest_path));
    const extracted = await call('extract_3mf_objects', { file_path: file, item_indices: [0] });
    assert.equal(extracted.objects.length, 1);
    assert.ok(await fs.stat(extracted.objects[0].file_path));
    const comparison = await call('compare_projects', { project_a: file, project_b: file });
    assert.equal(comparison.identical, true);
    const cost = await call('estimate_print_cost', { path: file, material_price_per_kg: 100 });
    assert.equal(cost.per_project.material_cost, 1);
    const health = await call('analyze_mesh_health', { path: file });
    assert.ok(health);
    const inventory = await call('check_filament_availability', { path: file, filaments: [{ slot: 1, available_g: 100 }] });
    assert.equal(inventory.status, 'unknown', 'weight without slot consumption cannot establish stock sufficiency');
    const waste = await client.callTool({ name: 'analyze_print_waste', arguments: { path: file } });
    assert.ok(waste.content[0].text, 'missing G-code must be reported');
    for (const [name, arguments_] of [
      ['compare_print_orientations', { path: file, orientations: [{ name: 'bad', rotation_x: 361 }] }],
      ['create_calibration_project', { path: file, kind: 'unsupported', values: [1] }],
      ['check_filament_availability', { path: file, filaments: [{ slot: 1, available_g: -1 }] }],
    ]) {
      const invalid = await client.callTool({ name, arguments: arguments_ });
      assert.equal(invalid.isError, true, name);
      assert.match(invalid.content[0].text, /argument|must|invalid/i);
    }
    const bad = await client.callTool({ name: 'compare_slice_scenarios', arguments: { path: file, scenarios: [{ name: 'bad', settings: { machine_start_gcode: 'x' } }] } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /argument|additional|setting/i);
    await client.close();
    assert.ok(await fs.stat(fit.manifest_path), 'delivery survives MCP shutdown');
    assert.ok(await fs.stat(extracted.objects[0].file_path));
});
