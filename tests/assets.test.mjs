import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const baselines = [
  { version: 'head-v1', filename: 'xiaobai-head.glb', sha256: '2fc19d89fc33f57f46ac7fe716f3ae04e1b8a243b502c0cdf625f60ac4648351' },
  { version: 'body-v7', filename: 'xiaobai-torso.glb', sha256: '9a7b08fa9a629f857d26d2fc8c094b95f53e8fbe2c8cf56a4c0ac7e2c529a5b4' },
];

test('批准头部和身体与原审批 SHA-256 一致', async () => {
  for (const { version, filename, sha256 } of baselines) {
    const base = new URL(`assets/approved/${version}/`, root);
    const approval = JSON.parse(await readFile(new URL('APPROVAL.json', base), 'utf8'));
    assert.equal(approval.status, 'approved');
    assert.equal(approval.id, version);
    assert.equal(approval.files[filename], sha256);
    assert.equal(hash(await readFile(new URL(filename, base))), sha256);
  }
});

test('本地 Three.js 加载、导出和交互依赖齐全', async () => {
  const files = [
    'LICENSE', 'three.module.js', 'three.core.js',
    'addons/loaders/GLTFLoader.js', 'addons/loaders/OBJLoader.js',
    'addons/exporters/GLTFExporter.js', 'addons/controls/OrbitControls.js',
    'addons/utils/BufferGeometryUtils.js', 'addons/utils/SkeletonUtils.js',
  ];
  for (const file of files) {
    const url = new URL(`web/vendor/${file}`, root);
    await access(url);
    if (!file.endsWith('.js')) continue;
    const code = await readFile(url, 'utf8');
    assert.ok(code.length > 0, file);
    for (const [, dependency] of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (dependency.startsWith('.')) await access(new URL(dependency, url));
    }
  }
});
