import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG as config } from '../web/src/config.js';
import { describeActionApproval } from '../web/src/action-approval.js';
import { createDefaultProject, parseProject } from '../web/src/project-state.js';
import { historicalURL } from '../scripts/project-paths.mjs';

const root = new URL('../', import.meta.url);
const readJSON = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('最新批准记录继承前序基线，交付文件、动作计算及评审图字节保持一致', async () => {
  const record = await readJSON('docs/approvals/actions-v1-approved.json');
  const prior = await readJSON(record.priorApproval);
  assert.equal(record.approval, 'approved');
  assert.equal(record.userApprovalText, '全部批准！更新所有相关文档和代码。');
  assert.equal(record.lockedFileSnapshot.length, 24);
  for (const previous of prior.lockedFileSnapshot) {
    assert.deepEqual(record.lockedFileSnapshot.find((entry) => entry.path === previous.path), previous);
  }
  for (const entry of [...record.lockedFileSnapshot, ...record.implementationSnapshot, ...record.reviewedEvidence]) {
    const bytes = await readFile(historicalURL(entry.path));
    assert.equal(bytes.length, entry.sizeBytes, entry.path);
    assert.equal(hash(bytes), entry.sha256, entry.path);
  }
  assert.equal(record.reviewedKnownEffects[0].status, 'accepted-as-reviewed');
});

test('配置、批准参数、已保存项目及资产清单的当前状态一致，历史来源不被重写', async () => {
  const record = await readJSON('docs/approvals/actions-v1-approved.json');
  const manifest = await readJSON('assets/manifest.json');
  const parameters = await readJSON('assets/design/actions-v1/default-parameters.json');
  const source = await readJSON('assets/design/actions-v1/provenance.json');
  const { approval, approvalFile, bindingApproval, ...motionConfiguration } = config.design.actions;
  assert.equal(approval, 'approved');
  assert.equal(approvalFile.replace(/^\.\//, ''), manifest.approved.actions.approvalFile);
  assert.equal(bindingApproval.replace(/^\.\//, ''), record.priorApproval);
  assert.deepEqual(motionConfiguration, record.motionConfiguration);
  assert.deepEqual(config.design.actions.defaults, parameters.parameters);
  assert.equal(config.design.actions.waveSide, parameters.waveSide);
  const project = parseProject(await readFile(new URL('assets/design/actions-v1/project.json', root), 'utf8'));
  assert.deepEqual(project.actions, createDefaultProject().actions);
  assert.equal(manifest.approved.actions.status, 'approved');
  assert.equal(manifest.pending.actions, undefined);
  assert.equal(manifest.approved.actions.sha256, source.model.sha256);
  assert.equal(source.approval, 'pending-user-review'); // Historical delivery metadata.
});

test('每个参数或招手侧修改均标记独立副本，恢复后才重新匹配批准默认值', () => {
  const base = createDefaultProject().actions;
  const before = structuredClone(base);
  assert.equal(describeActionApproval(base, config).motionApproval, 'approved');
  assert.equal(describeActionApproval(base, config).motionApprovalScope, 'motion-definitions-and-parameters-only');
  for (const entry of config.design.actions.parameters) {
    const changed = structuredClone(base);
    const [group, key] = entry.path.split('.');
    changed.parameters[group][key] += entry.step * (changed.parameters[group][key] === entry.max ? -1 : 1);
    const status = describeActionApproval(changed, config);
    assert.equal(status.motionApproval, 'modified-design-copy', entry.path);
    assert.equal(status.motionBaselineApproval, 'approved');
    assert.equal(status.motionApprovalFile, config.design.actions.approvalFile);
    changed.parameters[group][key] = base.parameters[group][key];
    assert.equal(describeActionApproval(changed, config).motionApproval, 'approved');
  }
  assert.equal(describeActionApproval({ ...base, waveSide: 'R' }, config).motionApproval, 'modified-design-copy');
  assert.deepEqual(base, before);
});
