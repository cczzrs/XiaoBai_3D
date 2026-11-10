import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot, resolveHistoricalPath, historicalURL } from '../scripts/project-paths.mjs';

test('迁移后前端、测试和工具的相对模块引用可解析，旧批准路径指向新位置', async () => {
  for (const dir of ['web/src/', 'scripts/', 'tests/']) {
    for (const name of await readdir(new URL(dir, projectRoot))) {
      if (!/\.(?:m?js)$/.test(name)) continue;
      const file = new URL(dir + name, projectRoot);
      const code = await readFile(file, 'utf8');
      for (const [, dependency] of code.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        await access(new URL(dependency, file));
      }
    }
  }
  assert.equal(resolveHistoricalPath('src/limb-rig.js'), 'web/src/limb-rig.js');
  assert.equal(resolveHistoricalPath('qa/actions-v1-review.png'), 'docs/qa/actions-v1-review.png');
  assert.equal(resolveHistoricalPath('qa/actions-v1-test-export.glb'), 'temp/qa/actions-v1-test-export.glb');
  assert.equal(resolveHistoricalPath('qa/appearance-fixtures/undecodable.png'), 'tests/fixtures/appearance/undecodable.png');
  await access(historicalURL('src/action-motion.js'));
  await access(new URL('tests/fixtures/appearance/undecodable.png', projectRoot));
});

test('当前文档中的本地链接均存在', async () => {
  const names = ['README.md', ...(await readdir(new URL('docs/', projectRoot))).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
  for (const name of names) {
    const file = new URL(name, projectRoot);
    const text = await readFile(file, 'utf8');
    for (const [, href] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(href)) continue;
      await access(new URL(href.split('#')[0], file));
    }
  }
});

test('本地服务器从 web 提供页面，兼容原地址与共享资产，临时目录不进入网页', async (t) => {
  const server = spawn('python3', ['-B', 'scripts/serve.py', '--port', '0'], { cwd: fileURLToPath(projectRoot), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  const origin = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 5000);
    server.on('error', (error) => { clearTimeout(timer); reject(error); });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    server.stderr.on('data', (data) => { errors += data; });
    server.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  for (const [url, path] of [
    ['', 'web/index.html'], ['web/', 'web/index.html'], ['web/index.html', 'web/index.html'],
    ['src/config.js', 'web/src/config.js'], ['web/src/app.js', 'web/src/app.js'],
    ['styles/studio.css', 'web/styles/studio.css'], ['vendor/three.module.js', 'web/vendor/three.module.js'],
    ['assets/manifest.json', 'assets/manifest.json'], ['web/assets/manifest.json', 'assets/manifest.json'],
    ['web/assets/approved/head-v1/xiaobai-head.glb', 'assets/approved/head-v1/xiaobai-head.glb'],
    ['docs/approvals/actions-v1-approved.json', 'docs/approvals/actions-v1-approved.json'],
  ]) {
    const response = await fetch(new URL(url, origin));
    assert.equal(response.status, 200, url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(path, projectRoot)), url);
  }
  for (const url of ['temp/README.md', 'web/temp/README.md', 'scripts/serve.py', 'tests/project-layout.test.mjs']) {
    assert.equal((await fetch(new URL(url, origin))).status, 404, url);
  }
});
