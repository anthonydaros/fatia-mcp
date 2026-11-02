import test from 'node:test';
import assert from 'node:assert/strict';
import {studioRetargeter} from '../dist/tuning/retarget.js';
test('retarget budget gate runs before every actual CLI slice',async()=>{
 let calls=0,gates=0;
 const retarget=studioRetargeter({slicerPath:'unused',tempDir:'unused',printerPreset:'unused',modelCode:'A1',manipulator:{sliceSTL:async()=>{calls++;throw Error('CLI should not run')}}});
 await assert.rejects(retarget('sample.stl',{beforeSlice:()=>{gates++;throw Error('budget exhausted')}}),/budget exhausted/);
 assert.equal(calls,0);assert.equal(gates,1);
});
