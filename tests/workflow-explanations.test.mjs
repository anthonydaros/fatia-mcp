import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareProject } from '../dist/tuning/prepare.js';
import { parsePrepareArgs, PREPARE_TOOLS } from '../dist/tuning/prepare-tool.js';
import { preflightCheck } from '../dist/knowledge/preflight.js';
import { getKb } from '../dist/knowledge/loader.js';
import { buildLayoutProject, X2D } from './fixtures/layout-project.mjs';

const CROSS = 'gcode.unprotected_travel_crossing_count';
const action = {
  id: 'test.travel', title: 'travel', kind: 'ladder', phase: 'post-slice', scope: 'process', when: { all: [] },
  confidence: 'oficial', risk: 'low', priority: 10, relax: false, rules: [], src: [], printers: [], applies_to: null,
  trigger: { fact: CROSS, op: 'gt', value: '0' },
  steps: ['3', '4'].map(value => ({ set: { wall_loops: value }, why: 'travel', cost: 'time', confidence: 'oficial', src: [] })),
  exhausted: 'done',
};
function outcome(crossing, time = 100) {
  return {
    gcode: { facts: { [CROSS]: crossing, 'gcode.layer_count': 1 }, evidence: {}, complete: true, blind: [], stats: { lines: 1, bytes: 1, ms: 1 }, details: { header: {} } },
    slice: { sliceInfo: { plate: { metadata: [{ key: 'index', value: '1' }, { key: 'prediction', value: String(time) }, { key: 'weight', value: '2' }], filament: { id: '1', type: 'PLA', used_g: '2', used_m: '1' } } } }, ms: 1,
  };
}
async function setup(t, overrides = {}, extraDeps = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-alternatives-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'part.3mf');
  await fs.writeFile(source, await buildLayoutProject({ objects: [{ id: 1, name: 'box', size: [10, 10, 10], at: [30, 30] }], plates: [['1:0']] }));
  let calls = 0;
  const script = [outcome(20), outcome(10, 120), outcome(0, 140)];
  const input = { path: source, plateIndex: 0, layout: { mode: 'off' }, model: 'x2d', maxSlices: 12, maxMinutes: 20, outputDir: path.join(dir, 'out'), openInStudio: false, apply: 'recommended', dryRun: false, ...overrides };
  const deps = { tuning: { actions: [action], noAction: [] }, printerPreset: X2D, tempDir: path.join(dir, 'tmp'),
    slice: async () => { const step = script[Math.min(calls++, script.length - 1)]; if (step instanceof Error) throw step; return step; },
    installedStudio: async () => '2.8.4.57', preflight: async () => ({ findings: [] }), openInStudio: async () => { throw new Error('must not open'); }, ...extraDeps };
  return { dir, input, script, run: () => prepareProject(input, deps), calls: () => calls };
}

test('select_round is an optional bounded integer without changing parser defaults', () => {
  assert.equal(PREPARE_TOOLS[0].inputSchema.properties.select_round.type, 'integer');
  assert.equal(parsePrepareArgs({ path: 'a.3mf', select_round: 0 }).selectRound, 0);
  assert.equal(Object.hasOwn(parsePrepareArgs({ path: 'a.3mf' }), 'selectRound'), false);
  for (const value of [-1, 1.2, '1', null, Infinity]) assert.throws(() => parsePrepareArgs({ path: 'a.3mf', select_round: value }), /select_round/);
});

test('alternatives expose cumulative settings, measurements, blockers and persistent exclusive projects', async t => {
  const h = await setup(t);
  const report = await h.run();
  assert.equal(report.delivered.round, 2);
  assert.deepEqual(report.alternatives.map(a => a.round_id), [0, 1, 2]);
  assert.deepEqual(report.alternatives.map(a => a.selected), [false, false, true]);
  assert.equal(report.alternatives[1].settings.wall_loops, '3');
  assert.equal(report.alternatives[2].settings.wall_loops, '4');
  assert.equal(report.alternatives[1].estimates.print_time_s, 120);
  assert.deepEqual(report.alternatives[1].blockers, []);
  for (const a of report.alternatives) {
    assert.equal(a.artifact.available, true);
    assert.equal(path.dirname(a.artifact.path), h.input.outputDir);
    await fs.access(a.artifact.path);
  }
  assert.equal((await fs.readdir(path.join(h.dir, 'tmp'))).length, 0, 'scratch cleaned');
  const again = await h.run();
  assert.ok(again.alternatives.every(a => !report.alternatives.some(b => a.artifact.path === b.artifact.path)), 'outputs never overwritten');
});

test('an explicit measured eligible earlier round is delivered without more slices', async t => {
  const h = await setup(t, { selectRound: 1 });
  const report = await h.run();
  assert.equal(report.delivered.round, 1);
  assert.equal(h.calls(), 3);
  assert.equal(report.alternatives.find(a => a.round_id === 1).selected, true);
  assert.equal(report.metrics.rows.find(m => m.fact === 'plate.time_s').after, 120);
});

test('unavailable and failed selections retain measurements and do not deliver the default', async t => {
  for (const selectRound of [49, 2]) {
    const h = await setup(t, { selectRound });
    if (selectRound === 2) h.script[2] = new Error('slice failed');
    const report = await h.run();
    assert.equal(report.delivered, null);
    assert.equal(report.stop.reason, 'error');
    assert.match(report.stop.detail, /select_round/);
    assert.ok(report.history.some(r => r.slice.measured));
    assert.ok(report.alternatives.every(a => !a.selected));
  }
});

test('known blocker selection is rejected and a final preflight blocker prevents explicit delivery/open', async t => {
  let opened = 0;
  const h = await setup(t, { selectRound: 1, openInStudio: true }, {
    preflight: async () => ({ findings: [{ rule_id: 'test.blocker', severity: 'blocker' }] }),
    openInStudio: async () => { opened++; },
  });
  const report = await h.run();
  assert.equal(report.delivered, null);
  assert.equal(opened, 0);
  assert.equal(report.stop.reason, 'error');
  assert.ok(report.alternatives.find(a => a.round_id === 1).blockers.some(b => b.rule_id === 'test.blocker'));
});

test('cancellation and dry runs never persist selectable artifacts', async t => {
  const controller = new AbortController();
  const h = await setup(t, { signal: controller.signal }, { preflight: async () => { controller.abort(); return { findings: [] }; } });
  const report = await h.run();
  assert.equal(report.stop.reason, 'cancelled');
  assert.ok(report.alternatives.every(a => !a.artifact.available));
  assert.deepEqual(await fs.readdir(h.input.outputDir), []);
  const dry = await setup(t, { dryRun: true });
  assert.deepEqual((await dry.run()).alternatives, []);
});

test('preflight explanation and next_action are grounded in the actual fired rule', async t => {
  const h = await setup(t);
  const report = await preflightCheck({ file_path: h.input.path, min_severity: 'tip', max_findings: 200 }, {
    defaultModel: 'x2d', validModels: ['x2d'], askModel: async () => 'x2d',
    meshInfo: async () => ({ boundingBox: { dimensions: { x: 10, y: 10, z: 10 } }, faceCount: 12 }),
    studioVersion: async () => '2.8.4.57', studioInfo: async () => ({}),
  });
  assert.ok(report.findings.length > 0);
  for (const finding of report.findings) {
    const rule = getKb().ruleById.get(finding.rule_id);
    assert.equal(finding.explanation.problem, rule.problem);
    assert.deepEqual(finding.explanation.condition, rule.detect.when);
    assert.deepEqual(finding.explanation.observed, finding.evidence);
    assert.deepEqual(finding.next_action.settings, rule.solution.settings);
    assert.deepEqual(finding.next_action.steps, rule.solution.steps);
    assert.equal(finding.next_action.message, rule.solution.message);
    assert.deepEqual(finding.next_action.approval, finding.approval);
  }
});

test('known measured blockers and slicer ignored settings cannot be selected', async t => {
  for (const kind of ['blocker', 'ignored']) {
    const h = await setup(t, { selectRound: 1 });
    if (kind === 'blocker') h.script[1].gcode.facts['gcode.tool_xy_outside_area_count'] = 4;
    else h.script[1].block = { wall_loops: '2' };
    const report = await h.run();
    assert.equal(report.delivered, null);
    assert.match(report.selection.error, /not eligible/);
    const candidate = report.alternatives.find(a => a.round_id === 1);
    assert.equal(candidate.eligible, false);
    assert.ok(candidate.ineligible_reasons.includes(kind === 'blocker' ? 'known_blocker' : 'settings_not_reached_slice'));
    assert.equal(candidate.artifact.available, false);
  }
});

test('cancelling while checking alternatives removes every newly saved project', async t => {
  const controller = new AbortController();
  let checks = 0;
  const h = await setup(t, { signal: controller.signal }, { preflight: async () => {
    if (++checks === 3) controller.abort();
    return { findings: [] };
  } });
  const report = await h.run();
  assert.equal(report.stop.reason, 'cancelled');
  assert.equal(report.delivered, null);
  assert.ok(report.alternatives.every(a => !a.artifact.available && !a.selected));
  assert.deepEqual(await fs.readdir(h.input.outputDir), []);
});

test('an incomplete G-code scan cannot be explicitly selected as a verified measured candidate', async t => {
  const h = await setup(t, { selectRound: 1 });
  h.script[1].gcode.complete = false;
  const report = await h.run();
  assert.equal(report.delivered, null);
  const candidate = report.alternatives.find(a => a.round_id === 1);
  assert.ok(candidate.ineligible_reasons.includes('incomplete_gcode'));
  assert.equal(candidate.gcode_complete, false);
  assert.equal(candidate.artifact.path, null);
});
