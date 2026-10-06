import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, pageVersion, configure, transact } from './auto-upgrade.mjs';

test('compares numeric stable versions and rejects prereleases', () => {
  assert.equal(compareVersions('v2.10.0', 'v2.9.9'), 1);
  assert.equal(compareVersions('v2.4.2', 'v2.4.2'), 0);
  assert.equal(compareVersions('v2.4.1', 'v2.4.2'), -1);
  assert.throws(() => compareVersions('v2.5.0-beta', 'v2.4.2'));
});
test('reads only the upstream release link in the homepage', () => {
  assert.equal(pageVersion('<a href="https://github.com/7Sageer/sublink-worker/releases/tag/v2.4.2">v2.4.2</a>'), 'v2.4.2');
  assert.throws(() => pageVersion('v99.0.0'));
});
test('uses the existing Worker and KV and refuses unexpected bindings', () => {
  const input = 'name = "sublink-worker"\nmain = "src/worker.jsx"\ncompatibility_date = "2024-07-24"\nkv_namespaces = [\n { binding = "SUBLINK_KV", id = "old" }\n]\n[assets]\ndirectory = "./public"\n';
  const output = configure(input);
  assert.match(output, /name = "sublink"/);
  assert.match(output, /d0dfa57fdac448c4b02dfcd614ac1092/);
  assert.doesNotMatch(output, /id = "old"/);
  assert.throws(() => configure(input + '\n[[d1_databases]]\n'));
});
function harness({ verifyFails = false, activateFails = false, changedExternally = false } = {}) {
  const calls = [];
  const before = { id: 'before', versions: [{ version_id: 'old', percentage: 100 }] };
  let current = before;
  return { calls, ops: {
    snapshot: async () => before,
    upload: async () => { calls.push('upload'); if (changedExternally) current = { id: 'external', versions: [{version_id:'other',percentage:100}] }; return 'new'; },
    current: async () => current,
    activate: async versions => { calls.push(versions[0].version_id); current = {id:'next',versions}; if (activateFails && versions[0].version_id === 'new') throw Error('response lost'); },
    verify: async () => { calls.push('verify'); if (verifyFails) throw Error('bad response'); },
    verifyRollback: async () => { calls.push('verifyRollback'); assert.equal(current.versions[0].version_id, 'old'); }
  }};
}
test('successful upgrade activates and verifies the candidate', async () => {
  const {calls,ops}=harness(); await transact(ops); assert.deepEqual(calls,['upload','new','verify']);
});
test('failed health check restores and verifies the original deployment', async () => {
  const {calls,ops}=harness({verifyFails:true}); await assert.rejects(transact(ops), /bad response/); assert.deepEqual(calls,['upload','new','verify','old','verifyRollback']);
});
test('lost activation response still rolls back if candidate went live', async () => {
  const {calls,ops}=harness({activateFails:true}); await assert.rejects(transact(ops), /response lost/); assert.deepEqual(calls,['upload','new','old','verifyRollback']);
});
test('external deployment during upload is never overwritten', async () => {
  const {calls,ops}=harness({changedExternally:true}); await assert.rejects(transact(ops), /changed/); assert.deepEqual(calls,['upload']);
});
