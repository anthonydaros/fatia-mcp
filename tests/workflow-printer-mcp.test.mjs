import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=fileURLToPath(new URL('../',import.meta.url));
test('printer comparison is exposed through the existing tool and validates modes without a default model',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-printer-mcp-')),client=new Client({name:'printer-compare-test',version:'1'});
 t.after(async()=>{await client.close();await fs.rm(dir,{recursive:true,force:true});});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--stdio'],cwd:dir,stderr:'pipe',env:{PATH:process.env.PATH||'',BAMBU_MODEL:'',FATIA_OUTPUT_DIR:path.join(dir,'outputs')}}));
 const tools=(await client.listTools()).tools;assert.equal(tools.length,32);
 const schema=tools.find(t=>t.name==='compare_slice_scenarios').inputSchema;
 assert.ok(schema.properties.printers,'the existing comparison tool accepts two printer targets');
 const empty=await client.callTool({name:'compare_slice_scenarios',arguments:{path:path.join(dir,'missing.3mf')}});
 assert.equal(empty.isError,true);assert.match(empty.content[0].text,/scenarios.*printers|printers.*scenarios/i);
 const base={path:path.join(dir,'missing.3mf'),printers:[{bambu_model:'a1'},{bambu_model:'x2d'}]};
 const missing=await client.callTool({name:'compare_slice_scenarios',arguments:base});
 assert.equal(missing.isError,true);assert.match(missing.content[0].text,/ENOENT|no such file|cannot.*file/i);
 for(const extra of [{printers:[{bambu_model:'a1'}]},{scenarios:[{name:'x',settings:{}}]},{plate_index:0},{bambu_model:'p1s'},{material_price_per_kg:-1},{printers:[{bambu_model:'a1',power_w:NaN},{bambu_model:'x2d'}]}]){
  const r=await client.callTool({name:'compare_slice_scenarios',arguments:{...base,...extra}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/argument|invalid|finite|printers|scenario|plate|model/i);
 }
});

test('real Studio CLI compares A1 and X2D through MCP with explicit operating costs', {skip:process.env.CI?'Optional installed Studio CLI':process.platform!=='darwin'?'Local Studio fixture is macOS':false,timeout:180000},async t=>{
 const {existsSync}=await import('node:fs');const slicerPath=process.env.SLICER_PATH||'/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
 if(!existsSync(slicerPath)){t.skip('Studio absent');return;}
 const {STLManipulator}=await import('../dist/stl/stl-manipulator.js'),{studioRetargeter}=await import('../dist/tuning/retarget.js');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-two-printers-real-')),client=new Client({name:'two-printers-real',version:'1'});
 t.after(async()=>{await client.close();await fs.rm(dir,{recursive:true,force:true});});
 const tempDir=path.join(dir,'work'),manipulator=new STLManipulator(tempDir),printerPreset='Bambu Lab X2D 0.4 nozzle';
 const baseline=await studioRetargeter({slicerPath,tempDir,printerPreset,modelCode:'X2D',manipulator})(path.join(root,'test/sample_cube.stl'));
 const baselineFile=path.join(dir,'baseline.3mf');await fs.writeFile(baselineFile,baseline.archive);
 const {writeTunedProject}=await import('../dist/tuning/project-writer.js');
 // Align this authored quality value with the A1 preset so the test compares equivalent settings.
 const {path:file}=await writeTunedProject({source:baselineFile,output:path.join(dir,'cube.3mf'),target:{printerPreset},changes:[{key:'elefant_foot_compensation',value:'0.075',scope:'process'}]});const before=await fs.readFile(file);
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js'),'--stdio'],cwd:dir,stderr:'pipe',env:{PATH:process.env.PATH||'',BAMBU_MODEL:'',SLICER_PATH:slicerPath,NOZZLE_DIAMETER:'0.4',FATIA_OUTPUT_DIR:path.join(dir,'outputs')}}));
 const response=await client.callTool({name:'compare_slice_scenarios',arguments:{path:file,printers:[{bambu_model:'a1',power_w:100},{bambu_model:'x2d',power_w:200}],material_price_per_kg:100,electricity_price_per_kwh:1,currency:'BRL',max_slices:4,max_minutes:2}},undefined,{timeout:150000});
 assert.notEqual(response.isError,true,JSON.stringify(response));const r=JSON.parse(response.content[0].text);
 assert.equal(r.printers.length,2);assert.ok(r.printers.every(p=>p.eligible),JSON.stringify(r.printers.map(p=>({model:p.bambu_model,reasons:p.ineligible_reasons,error:p.error}))));assert.ok(r.printers.every(p=>p.time_s>0&&p.weight_g>0&&p.total_cost>0),JSON.stringify(r));
 assert.deepEqual(await fs.readFile(file),before);assert.ok(r.slices<=4);for(const p of r.printers)assert.ok(await fs.stat(p.output_path));
 t.diagnostic(JSON.stringify({slices:r.slices,printers:r.printers.map(p=>({model:p.bambu_model,time_s:p.time_s,weight_g:p.weight_g,total_cost:p.total_cost})),recommendation:r.recommendation}));
});
