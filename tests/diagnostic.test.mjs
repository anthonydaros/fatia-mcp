import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
test('diagnostic initializes32 tools without model, slicing or HTTP startup',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-check-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const {stdout}=await run(process.execPath,[entry,'--check'],{cwd:dir,timeout:15000,env:{PATH:process.env.PATH||'',BAMBU_MODEL:'',MCP_TRANSPORT:'streamable-http',SLICER_PATH:path.join(dir,'absent-slicer')}});
 const result=JSON.parse(stdout);assert.equal(result.ok,true);assert.equal(result.tools.length,32);assert.equal(result.slicer.installed,false);assert.equal(result.client_tools_loaded,'unknown');
 assert.deepEqual(await fs.readdir(dir),[]);
});
test('diagnostic preserves caller-owned temporary directory and its contents',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-check-owned-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const marker=path.join(dir,'existing-user-file.txt');await fs.writeFile(marker,'preserve');
 await run(process.execPath,[entry,'--check'],{cwd:dir,timeout:15000,env:{PATH:process.env.PATH||'',TEMP_DIR:dir,BAMBU_MODEL:'',SLICER_PATH:path.join(dir,'absent')}});
 assert.equal(await fs.readFile(marker,'utf8'),'preserve');
});
