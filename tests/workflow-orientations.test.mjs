import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { comparePrintOrientations, ORIENTATION_TOOLS } from '../dist/workflows/orientations.js';
import { openProject } from '../dist/knowledge/facts/settings.js';
import { readProjectMesh } from '../dist/tuning/mesh-read.js';
const preset='Bambu Lab P1S 0.4 nozzle';
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-orientation-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const zip=new JSZip();zip.file('3D/3dmodel.model','<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="3" z="0"/><vertex x="0" y="0" z="4"/></vertices><triangles><triangle v1="0" v2="2" v3="1" paint_color="a"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1" transform="2 0 0 0 3 0 0 0 4 110 120 3"/></build></model>');
 zip.file('Metadata/project_settings.config',JSON.stringify({printer_settings_id:preset,print_settings_id:'Process',filament_settings_id:['PLA'],layer_height:'0.2',different_settings_to_system:['','','']}));
 zip.file('Metadata/model_settings.config','<config><object id="1"/><plate><metadata key="plater_id" value="1"/><metadata key="thumbnail_file" value="Metadata/plate_1.png"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>');
 zip.file('Metadata/plate_1.png','old preview');zip.file('Metadata/plate_1.gcode','stale');
 const file=path.join(dir,'source.3mf');await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
 return {dir,file,deps:{printerPreset:preset,tempDir:dir,outputDir:path.join(dir,'out'),slice:async()=>measured(100,2)}};
}
function measured(time,weight,complete=true) {return {gcode:{facts:{'gcode.support_weight_g':.5},evidence:{},blind:[],details:{header:{}},complete},slice:{sliceInfo:{plate:{metadata:[{key:'index',value:'1'},{key:'prediction',value:String(time)},{key:'weight',value:String(weight)}]}}}};}
function bounds(s) {const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(let i=0;i<s.pos.length;i++){const a=i%3;lo[a]=Math.min(lo[a],s.pos[i]);hi[a]=Math.max(hi[a],s.pos[i]);}return {lo,hi};}
test('orientation tool schema has bounded explicit rotations',()=>{assert.equal(ORIENTATION_TOOLS[0].name,'compare_print_orientations');assert.equal(ORIENTATION_TOOLS[0].inputSchema.properties.orientations.maxItems,6);});
test('orientation composes scaled transform, rests on bed and preserves source and painted geometry',async t=>{
 const {file,deps}=await fixture(t),before=await fs.readFile(file);let calls=0;deps.slice=async candidate=>{calls++;const mesh=await readProjectMesh(await openProject(candidate),0);const b=bounds(mesh.objects[0].soup);assert.ok(Math.abs(b.lo[2])<1e-8);return measured(100/calls,2);};
 const r=await comparePrintOrientations({path:file,orientations:[{name:'original',rotation_x:0},{name:'side',rotation_x:90}]},deps);
 assert.equal(r.slices,2);assert.equal(r.fastest,1);assert.equal(r.orientations[1].status,'measured');
 const candidate=r.orientations[1].output_path;const z=await JSZip.loadAsync(await fs.readFile(candidate));assert.equal(z.file('Metadata/plate_1.png'),null);assert.equal(z.file('Metadata/plate_1.gcode'),null);assert.match(await z.file('3D/3dmodel.model').async('string'),/paint_color="a"/);
 const b=bounds((await readProjectMesh(await openProject(candidate),0)).objects[0].soup);assert.deepEqual(b.hi.map((v,i)=>Math.round(v-b.lo[i])),[4,16,9]);assert.deepEqual(await fs.readFile(file),before);
});
test('orientation budget counts failed attempts and leaves unattempted candidates visible',async t=>{
 const {file,deps}=await fixture(t);let calls=0;deps.slice=async()=>{calls++;throw Error('slice failed');};const r=await comparePrintOrientations({path:file,max_slices:1},deps);
 assert.equal(calls,1);assert.equal(r.slices,1);assert.equal(r.stop_reason,'budget_slices');assert.equal(r.orientations[0].status,'error');assert.equal(r.orientations[1].status,'not_run');assert.equal(r.fastest,null);
});
test('cancel during final slice removes only owned output and excludes incomplete scans',async t=>{
 const {file,deps}=await fixture(t);await fs.mkdir(deps.outputDir);await fs.writeFile(path.join(deps.outputDir,'keep'),'keep');const c=new AbortController();deps.signal=c.signal;deps.slice=async()=>{c.abort();return measured(1,1);};
 const r=await comparePrintOrientations({path:file,orientations:[{name:'one'}]},deps);assert.equal(r.stop_reason,'cancelled');assert.equal(r.fastest,null);assert.deepEqual(await fs.readdir(deps.outputDir),['keep']);
 const r2=await comparePrintOrientations({path:file,orientations:[{name:'one'}]},{...deps,signal:undefined,slice:async()=>measured(1,1,false)});assert.equal(r2.fastest,null);
});
test('orientation validates finite rotations, printer and reliable single plate before slicing',async t=>{
 const {file,deps}=await fixture(t);for(const extra of [{orientations:[]},{orientations:[{name:'bad',rotation_x:NaN}]},{orientations:[{name:'bad',rotation_z:361}]},{plate_index:1},{max_slices:0}]) await assert.rejects(comparePrintOrientations({path:file,...extra},deps));
 await assert.rejects(comparePrintOrientations({path:file},{...deps,printerPreset:'wrong'}),/printer|match/i);
 const z=await JSZip.loadAsync(await fs.readFile(file));z.file('3D/3dmodel.model',(await z.file('3D/3dmodel.model').async('string')).replace('unit="millimeter"','unit="inch"'));await fs.writeFile(file,await z.generateAsync({type:'nodebuffer'}));await assert.rejects(comparePrintOrientations({path:file},deps),/millimeter/i);
});
test('orientation rejects multiple objects or malformed plate membership without slice calls',async t=>{
 const {file,deps}=await fixture(t);let calls=0;deps.slice=async()=>{calls++;return measured(1,1);};
 const z=await JSZip.loadAsync(await fs.readFile(file));z.file('3D/3dmodel.model',(await z.file('3D/3dmodel.model').async('string')).replace('</build>','<item objectid="1"/></build>'));await fs.writeFile(file,await z.generateAsync({type:'nodebuffer'}));
 await assert.rejects(comparePrintOrientations({path:file},deps),/one printable/i);assert.equal(calls,0);
 z.file('Metadata/model_settings.config','<config><plate><metadata key="plater_id" value="1"/></plate></config>');await fs.writeFile(file,await z.generateAsync({type:'nodebuffer'}));
 await assert.rejects(comparePrintOrientations({path:file},deps),/membership/i);assert.equal(calls,0);
});
test('orientation wall time budget prevents new slice attempts',async t=>{
 const {file,deps}=await fixture(t);let now=0,calls=0;deps.now=()=>now;deps.slice=async()=>{calls++;now=60001;return measured(1,1);};
 const r=await comparePrintOrientations({path:file,max_minutes:1},deps);assert.equal(calls,1);assert.equal(r.stop_reason,'budget_minutes');assert.equal(r.slices,1);assert.equal(r.fastest,null);
});
test('orientation refuses finite transforms whose world geometry overflows',async t=>{
 const {file,deps}=await fixture(t);let calls=0;deps.slice=async()=>{calls++;return measured(1,1);};const z=await JSZip.loadAsync(await fs.readFile(file));z.file('3D/3dmodel.model',(await z.file('3D/3dmodel.model').async('string')).replace('transform="2 0 0 0 3 0 0 0 4 110 120 3"','transform="1e308 0 0 0 3 0 0 0 4 110 120 3"'));await fs.writeFile(file,await z.generateAsync({type:'nodebuffer'}));
 await assert.rejects(comparePrintOrientations({path:file},deps),/finite/i);assert.equal(calls,0);
});
