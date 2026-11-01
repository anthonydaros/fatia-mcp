import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { compareProjects, COMPARE_PROJECT_TOOLS } from '../dist/workflows/compare-projects.js';

async function project(file, {x=0,size=10,settings={layer_height:'0.2'},bad=false}={}) {
  const zip = new JSZip();
  zip.file('Metadata/project_settings.config', JSON.stringify(settings));
  zip.file('Metadata/model_settings.config', '<config><object id="1"><metadata key="name" value="part"/><metadata key="extruder" value="1"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>');
  zip.file('3D/3dmodel.model', `<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${size}" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${bad?'NaN':x} 0 0"/></build></model>`);
  await fs.writeFile(file, await zip.generateAsync({type:'nodebuffer'}));
}

test('compare projects reports settings, materials and transformed geometry deltas without mutation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'compare-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const a=path.join(root,'a.3mf'), b=path.join(root,'b.3mf');
  await project(a); await project(b,{x:20,size:15,settings:{layer_height:'0.3',filament_type:['PETG']}});
  const before = await fs.readFile(a);
  const r = await compareProjects({project_a:a,project_b:b});
  assert.equal(r.identical,false);
  assert.ok(r.changes.settings.some(c => c.key === 'layer_height'));
  assert.ok(r.changes.materials.some(c => c.key === 'filament_type'));
  assert.deepEqual(r.projects[1].objects[0].bounds_mm.min,[20,0,0]);
  assert.deepEqual(r.projects[1].objects[0].dimensions_mm,[15,10,0]);
  assert.equal(r.changes.objects.changed.length,1);
  assert.deepEqual(await fs.readFile(a),before);
  assert.equal((await compareProjects({project_a:a,project_b:a})).identical,true);
  assert.equal(COMPARE_PROJECT_TOOLS[0].name,'compare_projects');
});

test('compare rejects invalid transforms and invalid input paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'compare-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const a=path.join(root,'bad.3mf'); await project(a,{bad:true});
  await assert.rejects(compareProjects({project_a:a,project_b:a}), /transform/);
  await assert.rejects(compareProjects({project_a:'file.stl',project_b:a}), /3mf/i);
});

test('compare does not label missing geometry or non-millimeter coordinates as complete evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'compare-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const a=path.join(root,'a.3mf');
  const zip = new JSZip(); zip.file('Metadata/project_settings.config','{}');
  await fs.writeFile(a, await zip.generateAsync({type:'nodebuffer'}));
  const result = await compareProjects({project_a:a,project_b:a});
  assert.equal(result.identical,null);
  assert.equal(result.comparison_complete,false);
  await project(a);
  const withUnits = await JSZip.loadAsync(await fs.readFile(a));
  withUnits.file('3D/3dmodel.model',(await withUnits.file('3D/3dmodel.model').async('string')).replace('millimeter','inch'));
  await fs.writeFile(a,await withUnits.generateAsync({type:'nodebuffer'}));
  await assert.rejects(compareProjects({project_a:a,project_b:a}), /unit/i);
});

test('compare unit validation ignores fake model tags in comments, declarations and CDATA', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'compare-units-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const file = path.join(root,'units.3mf');
  for (const preamble of [
    '<!-- <model unit="millimeter"> -->',
    '<?fake <model unit="millimeter"> ?>',
    '<![CDATA[<model unit="millimeter">]]>',
  ]) {
    await project(file);
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const model = await zip.file('3D/3dmodel.model').async('string');
    zip.file('3D/3dmodel.model',preamble + model.replace('millimeter','centimeter'));
    await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
    await assert.rejects(compareProjects({project_a:file,project_b:file}),/millimeter|unit/i,preamble);
  }
});

test('compare detects changed triangle paint assignments even when both meshes are painted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'compare-paint-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const a = path.join(root,'a.3mf'), b = path.join(root,'b.3mf');
  await project(a);
  for (const [file,colour] of [[a,'1'],[b,'2']]) {
    const zip = await JSZip.loadAsync(await fs.readFile(a));
    const xml = (await zip.file('3D/3dmodel.model').async('string')).replace(/ paint_color="[^"]*"/g,'').replace('<triangle ',`<triangle paint_color="${colour}" `);
    zip.file('3D/3dmodel.model',xml);
    await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  }
  const result = await compareProjects({project_a:a,project_b:b});
  assert.equal(result.projects[0].objects[0].painted,true);
  assert.equal(result.projects[1].objects[0].painted,true);
  assert.equal(result.identical,false);
  assert.equal(result.changes.model_content.length,1);
  assert.equal(result.changes.model_content[0].key,'3D/3dmodel.model');
  assert.notEqual(result.changes.model_content[0].before,result.changes.model_content[0].after);
});
