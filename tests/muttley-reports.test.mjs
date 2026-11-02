import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPrinterIdentities, resolvePrinterIdentity, printerEvidence } from '../dist/slicer/printer-identity.js';
import { buildProjectSettingsPlan, settingsReport } from '../dist/slicer/project-settings.js';
import { analyzePrintWaste } from '../dist/workflows/waste.js';
import { preflightCheck } from '../dist/knowledge/preflight.js';
async function dir(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'muttley-report-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
test('printer IDs come from selected profile tree; unknown IDs stay unknown',async t=>{
 const d=await dir(t);await fs.mkdir(path.join(d,'BBL/machine'),{recursive:true});await fs.writeFile(path.join(d,'BBL/machine/A1.json'),JSON.stringify({type:'machine_model',name:'Bambu Lab A1',model_id:'N2S'}));
 const index=await loadPrinterIdentities(d);assert.equal(resolvePrinterIdentity('N2S',index).canonical_model,'Bambu Lab A1');assert.equal(resolvePrinterIdentity('N2S',[]).canonical_model,'Bambu Lab A1');
 const evidence=printerEvidence({printer_settings_id:'Bambu Lab A1 0.4 nozzle'},{plate:{metadata:[{key:'printer_model_id',value:'N2S'}]}},index,'Bambu Lab A1');assert.equal(evidence.sliced[0].matches_target,true);
});
test('keep report distinguishes project, default and selected values',async()=>{
 const p=await buildProjectSettingsPlan({printerPreset:'A1',modelCode:'A1',config:{printer_settings_id:'A1',enable_support:'1'},machine:{default_print_profile:'Process',default_filament_profile:['PLA']},leaf:()=>undefined,flatProcess:async()=>({enable_support:'0'})});
 const r=settingsReport(p,'keep');assert.match(r.kept[0],/mantido/);assert.equal(r.details[0].project_value,'1');assert.equal(r.details[0].printer_default_value,'0');assert.equal(r.details[0].selected_value,'1');assert.equal(settingsReport(p,'printer_default').details[0].selected_value,'0');
});
function gcode(complete=true,density=true){return ['; CONFIG_BLOCK_START','; filament_diameter = 1.75',...(density?['; filament_density = 1.26']:[]),'; filament_map = 1','; enable_support = 0','; enable_prime_tower = 0','; CONFIG_BLOCK_END','; EXECUTABLE_BLOCK_START','M83','G90','; MACHINE_START_GCODE_END','; CHANGE_LAYER','; Z_HEIGHT: 0.2','; LAYER_HEIGHT: 0.2','; FEATURE: Sparse infill','G1 X10 E1','; FEATURE: Custom','G1 X20 E1',...(complete?['; MACHINE_END_GCODE_START','; EXECUTABLE_BLOCK_END']:[])].join('\n')+'\n';}
test('known waste groups survive Custom while strict totals remain unknown',async t=>{const d=await dir(t),f=path.join(d,'a.gcode');await fs.writeFile(f,gcode());const r=await analyzePrintWaste({path:f});assert.ok(r.observed_weights_g.infill>0);assert.ok(r.observed_weights_g.unclassified>0);assert.equal(r.total_waste_g,null);assert.equal(r.weights_g.part,null);await fs.writeFile(f,gcode(false));assert.equal((await analyzePrintWaste({path:f})).observed_coverage,'partial');await fs.writeFile(f,gcode(true,false));assert.equal((await analyzePrintWaste({path:f})).observed_weights_g.infill,null);});
test('preflight adds actionable groups and brief retains full accounting',async t=>{const d=await dir(t),f=path.join(d,'a.stl');await fs.writeFile(f,'solid a\nendsolid a');const deps={defaultModel:'a1',validModels:['a1'],askModel:async()=>{throw Error('unexpected')},meshInfo:async()=>({dimensions:{x:1,y:1,z:1},triangles:1}),studioVersion:async()=>null,studioInfo:async()=>({installed:false})};const full=await preflightCheck({file_path:f},deps);const brief=await preflightCheck({file_path:f,detail:'brief'},deps);assert.deepEqual(brief.accounting,full.accounting);assert.ok(full.unchecked.by_action.not_implemented>0);assert.match(full.summary.limitations.join(' '),/Blender/);assert.ok(brief.checklist.length<=5);});
test('comparison reports matching aliases and unknown sliced identity without guessing',async t=>{
 const {default:JSZip}=await import('jszip');const {compareProjects}=await import('../dist/workflows/compare-projects.js');
 const d=await dir(t);await fs.mkdir(path.join(d,'BBL/machine'),{recursive:true});await fs.writeFile(path.join(d,'BBL/machine/A1.json'),JSON.stringify({type:'machine_model',name:'Bambu Lab A1',model_id:'N2S'}));
 async function project(name,id){const zip=new JSZip();zip.file('Metadata/project_settings.config',JSON.stringify({printer_settings_id:'Bambu Lab A1 0.4 nozzle',nozzle_diameter:['0.4'],filament_type:['PLA']}));zip.file('Metadata/model_settings.config','<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate></config>');zip.file('Metadata/slice_info.config',`<config><header><header_item key="X-BBL-Client-Version" value="2.8"/></header><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="${id}"/></plate></config>`);const file=path.join(d,name);await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));return file;}
 const a=await project('a.3mf','N2S'),b=await project('b.3mf','Bambu Lab A1');
 let r=await compareProjects({project_a:a,project_b:b},{profilesRoot:d,targetModel:'a1'});assert.equal(r.comparability.comparable,true);assert.equal(r.projects[0].conditions.printer.sliced[0].matches_target,true);
 const c=await project('c.3mf','Unknown');r=await compareProjects({project_a:a,project_b:c},{profilesRoot:d});assert.equal(r.comparability.comparable,false);assert.equal(r.projects[1].conditions.printer.sliced[0].canonical_model,null);
});
test('printer_default reports actual Standard values rather than mapped Fine preset',async()=>{
 const p=await buildProjectSettingsPlan({printerPreset:'A1',modelCode:'A1',config:{printer_settings_id:'A1',print_settings_id:'Fine',layer_height:'0.16'},machine:{default_print_profile:'Standard',default_filament_profile:['PLA']},leaf:(kind,name)=>name==='Fine'?{}:undefined,flatProcess:async name=>({layer_height:name==='Fine'?'0.12':'0.20'})});
 const r=settingsReport(p,'printer_default');assert.equal(r.details.find(d=>d.key==='layer_height').selected_value,'0.20');assert.ok(r.not_kept.every(s=>!s.includes('— mantido')));
});

test('bundled model references recognize official IDs, names and model aliases without installed profiles',()=>{
 for(const value of ['N6',' n6 ','X2D','bambu lab x2d',' Bambu Lab X2D 0.4 nozzle ']){
  const r=resolvePrinterIdentity(value,[]);assert.equal(r.canonical_model,'Bambu Lab X2D');assert.equal(r.source,'bundled_reference');
 }
 assert.equal(resolvePrinterIdentity(' X1C ',[]).canonical_model,'Bambu Lab X1 Carbon');
 assert.equal(resolvePrinterIdentity('BL-P001',[]).canonical_model,'Bambu Lab X1 Carbon');
 assert.equal(resolvePrinterIdentity('a1mini',[]).canonical_model,'Bambu Lab A1 mini');
 assert.equal(resolvePrinterIdentity('O1C',[]).canonical_model,null);
 assert.equal(resolvePrinterIdentity('unknown-code',[]).source,'unknown');
});
test('selected profiles are authoritative and conflicts never guess',()=>{
 const changed=[{name:'Bambu Lab X2D',model_id:'FUTURE-ID'}];
 assert.equal(resolvePrinterIdentity('FUTURE-ID',changed).source,'installed_profile');
 assert.equal(resolvePrinterIdentity('N6',changed).canonical_model,null);
 assert.equal(resolvePrinterIdentity('x2d',changed).source,'installed_profile');
 const duplicate=[{name:'Bambu Lab A1',model_id:'N6'},{name:'Bambu Lab X2D',model_id:'N6'}];
 assert.equal(resolvePrinterIdentity('N6',duplicate).canonical_model,null);
 assert.equal(resolvePrinterIdentity('N6',[{name:'Bambu Lab Future',model_id:'N6'}]).canonical_model,'Bambu Lab Future');
});

test('every versioned official reference has an unambiguous ID and short alias',async()=>{
 const {PRINTER_REFERENCE,PRINTER_REFERENCE_VERSION}=await import('../dist/slicer/printer-reference.js');
 assert.equal(PRINTER_REFERENCE_VERSION,'2026-11-02');assert.equal(PRINTER_REFERENCE.length,14);
 for(const p of PRINTER_REFERENCE){
  assert.equal(resolvePrinterIdentity(p.model_id,[]).canonical_model,p.name);
  assert.equal(resolvePrinterIdentity(p.model_key,[]).canonical_model,p.name);
  assert.equal(resolvePrinterIdentity(p.name,[]).canonical_model,p.name);
  assert.equal(resolvePrinterIdentity(p.model_key,[p]).source,'installed_profile');
  assert.ok(p.source.startsWith('https://github.com/bambulab/BambuStudio/'));
 }
});
