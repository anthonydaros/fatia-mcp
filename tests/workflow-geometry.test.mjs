import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createFitTest, extractObjects, GEOMETRY_TOOLS, requireMillimeters } from '../dist/workflows/geometry.js';
import { readStlMesh } from '../dist/tuning/mesh-read.js';

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-geometry-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function bounds(soup) {
  return [0,1,2].map(axis => {
    const values = Array.from(soup.pos).filter((_,i) => i % 3 === axis);
    return [Math.min(...values), Math.max(...values)];
  });
}
function closed(soup) {
  const edges = new Map();
  const key = i => Array.from(soup.pos.slice(i*3,i*3+3)).map(v => v.toFixed(5)).join(',');
  for (let i=0;i<soup.idx.length;i+=3) {
    const v = Array.from(soup.idx.slice(i,i+3)).map(key);
    for (let j=0;j<3;j++) {
      const a=v[j], b=v[(j+1)%3], k=[a,b].sort().join('|');
      const e=edges.get(k) ?? [0,0]; e[0]++; e[1]+=a<b ? 1 : -1; edges.set(k,e);
    }
  }
  assert.ok(edges.size > 0);
  for (const e of edges.values()) assert.deepEqual(e,[2,0]);
  assert.ok(Array.from(soup.pos).every(Number.isFinite));
}
async function project(dir, transform='2 0 0 0 3 0 0 0 4 10 20 30') {
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', `<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1" printable="0"/><item objectid="1" transform="${transform}"/></build></model>`);
  const file = path.join(dir,'source.3mf');
  await fs.writeFile(file, await zip.generateAsync({type:'nodebuffer'}));
  return file;
}
test('schemas expose exactly the geometry tools', () => {
  assert.deepEqual(GEOMETRY_TOOLS.map(t=>t.name),['extract_3mf_objects','create_fit_test']);
});
test('extract preserves source, stable item index and world transform; rejects unknown selections', async t => {
  const dir=await workspace(t), file=await project(dir), before=await fs.readFile(file);
  const result=await extractObjects({file_path:file,item_indices:[1]},dir);
  assert.equal(result.objects[0].item_index,1);
  const soup=(await readStlMesh(result.objects[0].file_path)).objects[0].soup;
  assert.deepEqual(bounds(soup),[[10,12],[20,23],[30,34]]); closed(soup);
  assert.deepEqual(await fs.readFile(file),before);
  await assert.rejects(extractObjects({file_path:file,item_indices:[0]},dir),/printable|unknown/i);
  await assert.rejects(extractObjects({file_path:file,item_indices:[99]},dir),/printable|unknown/i);
  const second=await extractObjects({file_path:file,item_indices:[1]},dir);
  assert.notEqual(second.output_dir,result.output_dir);
  assert.deepEqual(await fs.readFile(second.objects[0].file_path),await fs.readFile(result.objects[0].file_path));
});
test('fit coupons are deterministic closed pin/socket meshes with real radial clearances', async t => {
  const dir=await workspace(t);
  const args={gaps_mm:[0.1,0.3],peg_diameter_mm:6,depth_mm:10};
  const result=await createFitTest(args,dir), second=await createFitTest(args,dir);
  assert.equal(result.gap_convention,'radial');
  assert.equal(result.coupons.length,2);
  assert.match(result.instructions,/physical/i);
  const manifest=JSON.parse(await fs.readFile(result.manifest_path,'utf8'));
  assert.equal(manifest.coupons[1].hole_diameter_mm,6.6);
  for (const [i,c] of result.coupons.entries()) {
    assert.equal(c.radial_gap_mm,args.gaps_mm[i]);
    assert.equal(c.diametral_gap_mm,2*args.gaps_mm[i]);
    for (const kind of ['pin','socket']) {
      const file=c[`${kind}_path`], soup=(await readStlMesh(file)).objects[0].soup;
      closed(soup);
      assert.deepEqual(bounds(soup)[2], [0,kind==='pin'?14:10]);
      assert.deepEqual(await fs.readFile(file),await fs.readFile(second.coupons[i][`${kind}_path`]));
      if (kind==='socket') {
        const radii=[];
        for(let j=0;j<soup.pos.length;j+=3) radii.push(Math.hypot(soup.pos[j],soup.pos[j+1]));
        assert.ok(Math.abs(Math.min(...radii)-c.hole_diameter_mm/2)<1e-5);
        assert.ok(Math.max(...radii)>c.hole_diameter_mm/2+1.9);
      } else assert.ok(Math.abs(bounds(soup)[0][1]-3)<1e-5);
    }
  }
});
test('range includes endpoints, rejects invalid or excessive parameters and leaves no cancelled delivery', async t => {
  const dir=await workspace(t);
  const result=await createFitTest({gap_start_mm:0.1,gap_end_mm:0.3,gap_step_mm:0.1},dir);
  assert.deepEqual(result.coupons.map(c=>c.radial_gap_mm),[0.1,0.2,0.3]);
  for(const args of [{gaps_mm:[]},{gaps_mm:[NaN]},{gaps_mm:[-1]},{gaps_mm:[0.1,0.1]},{peg_diameter_mm:Infinity},{depth_mm:0},{gap_start_mm:0,gap_end_mm:1,gap_step_mm:0.0001},{gaps_mm:[0.2],gap_step_mm:0.1}]) {
    await assert.rejects(createFitTest(args,dir));
  }
  const before=await fs.readdir(dir), controller=new AbortController(); controller.abort();
  await assert.rejects(createFitTest({},dir,controller.signal),/abort/i);
  assert.deepEqual(await fs.readdir(dir),before);
});
test('malformed transforms fail before output',async t=>{
 const dir=await workspace(t), file=await project(dir,'1 0 NaN');
 await assert.rejects(extractObjects({file_path:file},dir),/transform/i);
 assert.deepEqual(await fs.readdir(dir),['source.3mf']);
});
test('plate selection excludes modifiers and keeps build-item indices stable',async t=>{
  const dir=await workspace(t), file=await project(dir,'1 0 0 0 1 0 0 0 1 0 0 0');
  const zip=await JSZip.loadAsync(await fs.readFile(file));
  let model=await zip.file('3D/3dmodel.model').async('string');
  const object=model.match(/<object id="1">[\s\S]*?<\/object>/)[0];
  model=model.replace('</resources>',object.replace('id="1"','id="2"').replaceAll('x="1"','x="100"')+'<object id="3"><components><component objectid="1"/><component objectid="2"/></components></object></resources>');
  model=model.replace('</build>','<item objectid="3"/></build>');
  zip.file('3D/3dmodel.model',model);
  zip.file('Metadata/model_settings.config','<config><object id="3"><part id="1" subtype="normal_part"/><part id="2" subtype="modifier_part"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="1"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance></plate></config>');
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  const result=await extractObjects({file_path:file,plate_index:1},dir);
  assert.deepEqual(result.objects.map(o=>o.item_index),[2]);
  assert.equal(result.plate_membership,'verified');
  assert.equal(result.objects[0].triangle_count,4);
  assert.deepEqual(bounds((await readStlMesh(result.objects[0].file_path)).objects[0].soup),[[0,1],[0,1],[0,1]]);
  await assert.rejects(extractObjects({file_path:file,plate_index:0,item_indices:[2]},dir),/unknown|printable/i);
  await assert.rejects(extractObjects({file_path:file,plate_index:2},dir),/plate/i);
});
test('non-mm units and transformed float overflow are refused without a partial delivery',async t=>{
  const dir=await workspace(t), file=await project(dir);
  const zip=await JSZip.loadAsync(await fs.readFile(file));
  zip.file('3D/3dmodel.model',(await zip.file('3D/3dmodel.model').async('string')).replace('unit="millimeter"','unit="inch"'));
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  await assert.rejects(extractObjects({file_path:file},dir),/millimeter/);
  await project(dir,'1e300 0 0 0 1 0 0 0 1 0 0 0');
  await assert.rejects(extractObjects({file_path:file},dir),/finite STL/);
  assert.deepEqual(await fs.readdir(dir),['source.3mf']);
});
test('mid-delivery cancellation removes only exclusively created files',async t=>{
  const dir=await workspace(t), controller=new AbortController();
  const original=fs.open;
  let delivery;
  fs.open=async function(file,...args){
    const handle=await original.call(this,file,...args);
    if(String(file).endsWith('.stl')) {
      delivery=path.dirname(file);
      await fs.writeFile(path.join(delivery,'unrelated.txt'),'keep');
      controller.abort();
    }
    return handle;
  };
  try { await assert.rejects(createFitTest({},dir,controller.signal),/abort/i); }
  finally { fs.open=original; }
  assert.deepEqual(await fs.readdir(delivery),['unrelated.txt']);
  assert.equal(await fs.readFile(path.join(delivery,'unrelated.txt'),'utf8'),'keep');
});
test('a comment cannot spoof the declared model units',async t=>{
 const dir=await workspace(t), file=await project(dir), zip=await JSZip.loadAsync(await fs.readFile(file));
 const model=(await zip.file('3D/3dmodel.model').async('string')).replace('unit="millimeter"','unit="inch"');
 zip.file('3D/3dmodel.model','<!-- <model unit="millimeter"> -->'+model);
 await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
 await assert.rejects(extractObjects({file_path:file},dir),/millimeter/);
});

test('unit validation reads exact attributes and respects quoted greater-than signs',()=>{
  const root = '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:test="urn:test"';
  for (const attrs of [" test:note=' unit=\"millimeter\"' unit=\"inch\"", " test:note=' > unit=\"millimeter\"' unit=\"inch\"", ' test:unit="millimeter" unit="inch"']) {
    assert.throws(()=>requireMillimeters(Buffer.from(root+attrs+'></model>')),/millimeter/);
  }
  assert.doesNotThrow(()=>requireMillimeters(Buffer.from('<![CDATA[<model unit=\"inch\">]]><?check ignored?><model unit=\"millimeter\"></model>')));
  for (const attrs of [" test:note=' > unit=\"inch\"' unit=\"millimeter\"", ' test:unit="inch"', '']) {
    assert.doesNotThrow(()=>requireMillimeters(Buffer.from('<?xml version="1.0"?><!-- <model unit="inch"> -->'+root+attrs+'></model>')));
  }
});
test('generic plate zero is explicitly unknown and absent or malformed metadata cannot verify other plates',async t=>{
  const dir=await workspace(t), file=await project(dir);
  await assert.rejects(extractObjects({file_path:file,plate_index:999},dir),/plate/i);
  const result=await extractObjects({file_path:file},dir);
  assert.equal(result.plate_membership,'unknown');
  assert.match(result.warnings.join(' '),/membership.*unknown/i);
  assert.equal(JSON.parse(await fs.readFile(result.manifest_path,'utf8')).plate_membership,'unknown');
  const before=await fs.readdir(dir);
  await assert.rejects(extractObjects({file_path:file,plate_index:999},dir),/plate/i);
  assert.deepEqual(await fs.readdir(dir),before);
  for (const metadata of ['<config><plate>', '<config/>', '<config><plate><metadata key="plater_id" value="1000"/><model_instance><metadata key="instance_id" value="0"/></model_instance></plate></config>']) {
    const zip=await JSZip.loadAsync(await fs.readFile(file));
    zip.file('Metadata/model_settings.config',metadata);
    await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
    const existing=await fs.readdir(dir);
    await assert.rejects(extractObjects({file_path:file,plate_index:999},dir),/plate/i);
    assert.deepEqual(await fs.readdir(dir),existing);
  }
});
