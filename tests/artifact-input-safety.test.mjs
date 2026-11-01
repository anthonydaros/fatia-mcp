import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { STLManipulator } from '../dist/stl/stl-manipulator.js';
import { parse3MF, extractBambuTemplateSettings, readSliceResults, analyze3MFPlateObjects } from '../dist/3mf_parser.js';
import { readProjectConfig } from '../dist/slicer/project-settings.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-input-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function clientIn(t, dir) {
  const client = new Client({ name: 'artifact-input-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'dist/index.js')], cwd: dir,
    env: { PATH: process.env.PATH || '', HOME: dir, USERPROFILE: dir, MCP_TRANSPORT: 'stdio', BAMBU_MODEL: '', TEMP_DIR: '' }, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

test('save_template refuses an existing destination without changing its bytes', async t => {
  const dir = await workspace(t), client = await clientIn(t, dir);
  const source = path.join(dir, 'source.json'), destination = path.join(dir, 'settings.json');
  await fs.writeFile(source, '{"new":true}'); await fs.writeFile(destination, '{"sentinel":true}');
  const result = await client.callTool({ name: 'save_template', arguments: { source_path: source, template_name: 'settings', template_dir: dir } });
  assert.equal(result.isError, true);
  assert.equal(await fs.readFile(destination, 'utf8'), '{"sentinel":true}');
});

test('concurrent and repeated STL edits preserve every earlier result', async t => {
  const dir = await workspace(t), source = path.join(dir, 'cube.stl');
  await fs.copyFile(path.join(ROOT, 'test/sample_cube.stl'), source);
  const m = new STLManipulator(path.join(dir, 'work'));
  const first = await m.scaleSTL(source, 1), before = await fs.readFile(first);
  const others = await Promise.all([m.scaleSTL(source, 2), m.scaleSTL(source, 3)]);
  assert.equal(new Set([first, ...others]).size, 3);
  assert.deepEqual(await fs.readFile(first), before);
  assert.notDeepEqual(await fs.readFile(others[0]), await fs.readFile(others[1]));
});

test('STL transformations reject invalid numeric inputs before exporting', async t => {
  const dir = await workspace(t), source = path.join(dir, 'cube.stl');
  await fs.copyFile(path.join(ROOT, 'test/sample_cube.stl'), source);
  const m = new STLManipulator(path.join(dir, 'work'));
  for (const value of [NaN, Infinity, 'oops']) {
    await assert.rejects(m.scaleSTL(source, [value, 1, 1]), /finite|number/i);
    await assert.rejects(m.rotateSTL(source, [value, 0, 0]), /finite|number/i);
  }
  for (const value of [0, -1, NaN, Infinity]) await assert.rejects(m.mergeVertices(source, value), /positive|finite/i);
  assert.deepEqual(await fs.readdir(path.join(dir, 'work')), []);
});

test('MCP rejects wrong argument types instead of exporting a NaN mesh', async t => {
  const dir = await workspace(t), client = await clientIn(t, dir);
  const source = path.join(dir, 'cube.stl'); await fs.copyFile(path.join(ROOT, 'test/sample_cube.stl'), source);
  const bad = await client.callTool({ name: 'scale_stl', arguments: { stl_path: source, scale_x: 'oops' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /scale_x|argument|number/i);
  const good = await client.callTool({ name: 'scale_stl', arguments: { stl_path: source, scale_x: 2 } });
  assert.notEqual(good.isError, true);
  assert.doesNotMatch(await fs.readFile(good.content[0].text, 'utf8'), /NaN/);
});

test('finite scale factors that overflow vertex storage cannot export an invalid STL', async t => {
  const dir = await workspace(t), source = path.join(dir, 'cube.stl'), work = path.join(dir, 'work');
  await fs.copyFile(path.join(ROOT, 'test/sample_cube.stl'), source);
  const m = new STLManipulator(work);
  await assert.rejects(m.scaleSTL(source, [1e40, 1, 1]), /finite/i);
  assert.deepEqual(await fs.readdir(work), [], 'invalid transformed geometry leaves no output');
});

const readers = [
  ['parse3MF', (file, dir) => parse3MF(file)],
  ['template', (file, dir) => extractBambuTemplateSettings(file, dir)],
  ['slice results', file => readSliceResults(file)],
  ['plate objects', file => analyze3MFPlateObjects(file)],
  ['mesh info', (file, dir) => new STLManipulator(dir).getSTLInfo(file)],
  ['project config', file => readProjectConfig(file)],
];
async function archive() {
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', '<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>');
  zip.file('Metadata/project_settings.config', '{"wall_loops":"2"}');
  zip.file('Metadata/slice_info.config', '<config><plate><metadata key="index" value="1"/></plate></config>');
  zip.file('Metadata/plate_1.json', '{"bbox_objects":[]}');
  zip.file('unrelated.txt', 'CRC_SENTINEL');
  return zip;
}
for (const kind of ['case collision', 'duplicate', 'corrupt CRC']) {
  test(`every public 3MF reader rejects ${kind} before selecting entries`, async t => {
    const dir = await workspace(t), zip = await archive();
    if (kind !== 'corrupt CRC') {
      zip.file('Metadata/Shadow.txt', 'one'); zip.file('Metadata/shadow.txt', 'two');
    }
    let bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    if (kind === 'duplicate') bytes = Buffer.from(bytes.toString('latin1').replaceAll('Metadata/Shadow.txt', 'Metadata/shadow.txt'), 'latin1');
    if (kind === 'corrupt CRC') bytes[bytes.indexOf('CRC_SENTINEL')] ^= 1;
    const file = path.join(dir, 'bad.3mf'); await fs.writeFile(file, bytes);
    for (const [name, read] of readers) await assert.rejects(read(file, dir), /Print archive safety:/, name);
  });
}
test('safe 3MF readers retain valid project settings and geometry', async t => {
  const dir = await workspace(t), zip = await archive(), file = path.join(dir, 'good.3mf');
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.equal((await readProjectConfig(file)).wall_loops, '2');
  assert.equal((await parse3MF(file)).objects.length, 1);
  assert.equal((await new STLManipulator(dir).getSTLInfo(file)).faceCount, 1);
});
