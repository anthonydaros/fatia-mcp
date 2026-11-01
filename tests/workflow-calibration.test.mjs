import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { CALIBRATION_TOOLS, createCalibrationProject } from '../dist/workflows/calibration.js';
import { openProject } from '../dist/knowledge/facts/settings.js';
import { readProjectMesh } from '../dist/tuning/mesh-read.js';
const preset='Bambu Lab P1S 0.4 nozzle';
async function setup(t, overrides={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-calibration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const zip=new JSZip();zip.file('Metadata/project_settings.config',JSON.stringify({printer_settings_id:preset,print_settings_id:'Process',filament_settings_id:['PLA'],filament_type:['PLA'],filament_flow_ratio:['1'],nozzle_temperature:['220'],nozzle_temperature_initial_layer:['220'],nozzle_temperature_range_low:['190'],nozzle_temperature_range_high:['240'],filament_retraction_length:['nil'],printable_area:['0x0','256x0','256x256','0x256'],printable_height:'256',layer_height:'0.2',different_settings_to_system:['','',''],...overrides}));zip.file('3D/3dmodel.model','<model><resources/><build/></model>');zip.file('Metadata/plate_1.gcode','stale');zip.file('Metadata/private_thumbnail.png','stale');
 const file=path.join(dir,'source.3mf');await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
 return{dir,file,deps:{printerPreset:preset,tempDir:path.join(dir,'tmp'),outputDir:path.join(dir,'outputs'),maxNozzleTemperature:300}};
}
function closed(soup) {
 const edges=new Map();
 for(let i=0;i<soup.idx.length;i+=3)for(let j=0;j<3;j++){const a=soup.idx[i+j],b=soup.idx[i+(j+1)%3],k=[a,b].sort((a,b)=>a-b).join(':');const e=edges.get(k)??[0,0];e[0]++;e[1]+=a<b?1:-1;edges.set(k,e);}
 for(const e of edges.values())assert.deepEqual(e,[2,0]);
}
test('calibration schema and fixed-temperature projects preserve source and contain closed fresh geometry',async t=>{
 assert.deepEqual(CALIBRATION_TOOLS.map(x=>x.name),['create_calibration_project']);
 const{file,deps}=await setup(t),before=await fs.readFile(file);
 const r=await createCalibrationProject({path:file,kind:'temperature',values:[200,220]},deps);
 assert.equal(r.projects.length,2);assert.equal(r.sliced,false);assert.match(r.instructions,/separate|fixed/i);
 for(const [i,p]of r.projects.entries()){
  const project=await openProject(p.output_path);assert.deepEqual(project.config.nozzle_temperature,[String([200,220][i])]);assert.deepEqual(project.config.nozzle_temperature_initial_layer,['220']);
  assert.ok(!project.names.some(x=>x.endsWith('.gcode')||x.includes('private_thumbnail')));
  const mesh=await readProjectMesh(project,0);assert.equal(mesh.objects.length,1);closed(mesh.objects[0].soup);
 }
 assert.deepEqual(await fs.readFile(file),before);assert.ok(await fs.stat(r.manifest_path));
 const again=await createCalibrationProject({path:file,kind:'temperature',values:[200]},deps);assert.notEqual(again.output_dir,r.output_dir);
});
test('flow and retraction candidates retain correct filament settings and useful distinct coupon shapes',async t=>{
 const{file,deps}=await setup(t);
 for(const[kind,values,key]of[['flow_ratio',[.94,1.02],'filament_flow_ratio'],['retraction',[.2,.8],'filament_retraction_length']]){
  const r=await createCalibrationProject({path:file,kind,values},deps);
  for(const[i,p]of r.projects.entries()){
   const project=await openProject(p.output_path);assert.deepEqual(project.config[key],[String(values[i])]);assert.match(project.config.different_settings_to_system[1],new RegExp(key));
   const soup=(await readProjectMesh(project,0)).objects[0].soup;closed(soup);assert.ok(soup.idx.length>=36);
  }
 }
});
test('calibration rejects unsafe or unsupported parameters without output',async t=>{
 const{file,deps}=await setup(t);
 for(const args of[{kind:'temperature',values:[180]},{kind:'temperature',values:[250]},{kind:'flow_ratio',values:[NaN]},{kind:'retraction',values:[-1]},{kind:'retraction',values:[5]},{kind:'flow_ratio',values:[1,1]},{kind:'flow_ratio',values:[]},{kind:'machine_gcode',values:[1]}])await assert.rejects(createCalibrationProject({path:file,...args},deps));
 await assert.rejects(createCalibrationProject({path:file,kind:'temperature',values:[220]},{...deps,maxNozzleTemperature:210}),/temperature|machine/i);
 assert.deepEqual(await fs.readdir(path.dirname(file)),['source.3mf']);
});
test('calibration requires matching single-filament baseline, real existing keys and declared temperature range',async t=>{
 for(const overrides of[{filament_settings_id:['A','B']},{printer_settings_id:'Other'},{filament_flow_ratio:undefined},{nozzle_temperature_range_high:undefined},{printable_area:undefined}]){
  const{file,deps}=await setup(t,overrides);const kind='filament_flow_ratio'in overrides?'flow_ratio':'temperature';
  await assert.rejects(createCalibrationProject({path:file,kind,values:kind==='flow_ratio'?[1]:[220]},deps));
 }
});
test('already cancelled calls do not create or remove delivery files',async t=>{
 const{file,deps}=await setup(t);await fs.mkdir(deps.outputDir);await fs.writeFile(path.join(deps.outputDir,'keep'),'keep');const c=new AbortController();c.abort();
 await assert.rejects(createCalibrationProject({path:file,kind:'flow_ratio',values:[1]},{...deps,signal:c.signal}),/abort/i);
 assert.deepEqual(await fs.readdir(deps.outputDir),['keep']);
});

test('cancellation after the manifest write removes only this run artifacts',async t=>{
 const{file,deps}=await setup(t);await fs.mkdir(deps.outputDir);await fs.writeFile(path.join(deps.outputDir,'keep'),'keep');
 const controller=new AbortController(),write=fs.writeFile;
 t.mock.method(fs,'writeFile',async function(file,...args){const result=await write.call(this,file,...args);if(path.basename(String(file))==='manifest.json')controller.abort();return result;});
 await assert.rejects(createCalibrationProject({path:file,kind:'flow_ratio',values:[.96,1]},{...deps,signal:controller.signal}),/abort/i);
 assert.deepEqual(await fs.readdir(deps.outputDir),['keep']);assert.deepEqual(await fs.readdir(deps.tempDir),[]);
});
