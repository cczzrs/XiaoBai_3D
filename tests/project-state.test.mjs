import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_CONFIG } from '../src/config.js';
import { createDefaultProject, validateProject, parseProject, serializeProject, encodePart, decodePart } from '../src/project-state.js';

const triangle = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const candidate = (source = triangle) => ({ name: '手臂.obj', format: 'obj', data: Buffer.from(source).toString('base64') });

function makeGlb(gltf = { asset: { version: '2.0' } }) {
  const json = Buffer.from(JSON.stringify(gltf));
  const length = Math.ceil(json.length / 4) * 4;
  const file = Buffer.alloc(20 + length, ' ');
  file.writeUInt32LE(0x46546c67, 0);
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(file.length, 8);
  file.writeUInt32LE(length, 12);
  file.writeUInt32LE(0x4e4f534a, 16);
  json.copy(file, 20);
  return file;
}

test('默认项目从配置复制，独立输入的有效项目能规范化', () => {
  const project = {
    schema: 'xiaobai.studio.v1', revision: 1,
    design: {
      shape: { headScale: 1.1, bodyWidth: 0.9, bodyHeight: 1.2, bodyDepth: 1 },
      rig: { rootY: 20, neckY: 55 },
      pose: { headYaw: -30, headPitch: 15, headRoll: 10, bodyLean: 5 },
    },
    motion: { preset: 'nod', playing: true, speed: 1.5, amplitude: 15, progress: 0.6 },
    parts: { arms: null, legs: null },
  };
  const normalized = validateProject(project);
  assert.equal(normalized.motion.playing, false);
  assert.equal(project.motion.playing, true);
  assert.deepEqual(normalized.design, project.design);
  assert.notEqual(normalized.design.shape, project.design.shape);
  const first = createDefaultProject();
  first.design.shape.headScale = 1.2;
  assert.equal(createDefaultProject().design.shape.headScale, APP_CONFIG.design.defaults.shape.headScale);
});

test('拒绝错误版本、缺字段、未知字段和非对象', () => {
  for (const value of [null, [], 12, {}, { ...createDefaultProject(), schema: 'alien' }, { ...createDefaultProject(), revision: '1' }]) {
    assert.throws(() => validateProject(value), Error);
  }
  for (const mutate of [
    (p) => { delete p.design; }, (p) => { delete p.design.pose.headYaw; },
    (p) => { p.parts.head = candidate(); }, (p) => { p.parts.body = null; },
    (p) => { p.approved = {}; }, (p) => { p.motion.playing = 1; },
    (p) => { p.motion.preset = 'walk'; }, (p) => { delete p.motion.progress; },
  ]) {
    const p = createDefaultProject(); mutate(p);
    assert.throws(() => validateProject(p), Error);
  }
  assert.throws(() => parseProject('{oops'), /JSON/);
  assert.throws(() => parseProject({}), /JSON/);
});

test('每个形体、骨骼、姿态参数均校验类型与配置范围', () => {
  for (const [group, limits] of Object.entries(APP_CONFIG.design.limits)) {
    for (const [key, range] of Object.entries(limits)) {
      for (const bad of [NaN, Infinity, -Infinity, '1', null, true, range.min - 1, range.max + 1]) {
        const p = createDefaultProject(); p.design[group][key] = bad;
        assert.throws(() => validateProject(p), Error, `${group}.${key} should reject ${String(bad)}`);
      }
      for (const boundary of [range.min, range.max]) {
        const p = createDefaultProject(); p.design[group][key] = boundary;
        assert.equal(validateProject(p).design[group][key], boundary);
      }
    }
  }
  for (const [key, range] of Object.entries({ speed: APP_CONFIG.design.motion.speed, amplitude: APP_CONFIG.design.motion.amplitude, progress: { min: 0, max: 1 } })) {
    for (const bad of [NaN, Infinity, '1', null, range.min - 1, range.max + 1]) {
      const p = createDefaultProject(); p.motion[key] = bad;
      assert.throws(() => validateProject(p), Error);
    }
  }
});

test('项目白名单阻止原型污染、继承字段与动态属性', () => {
  const text = serializeProject(createDefaultProject());
  assert.throws(() => parseProject(text.replace('"parts": {', '"parts": { "__proto__": {"polluted": true},')), /不允许/);
  assert.throws(() => parseProject(text.replace('"parts": {', '"parts": { "constructor": {},')), /不允许/);
  const inherited = createDefaultProject();
  inherited.design.shape = Object.create({ headScale: 1 });
  assert.throws(() => validateProject(inherited), /对象类型/);
  const dynamic = createDefaultProject();
  Object.defineProperty(dynamic.motion, 'speed', { get() { throw new Error('should not execute'); }, enumerable: true });
  assert.throws(() => validateProject(dynamic), /动态属性/);
  assert.equal({}.polluted, undefined);
});

test('OBJ 候选编码、项目保存与加载完整复原，并暂停动作', async () => {
  const p = createDefaultProject();
  p.parts.arms = await encodePart(new File([triangle], '手臂.OBJ'));
  p.parts.legs = candidate('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
  p.design.rig.neckY = 60;
  p.motion = { preset: 'sway', playing: true, speed: 0.5, amplitude: 20, progress: 0.3 };
  const loaded = parseProject(serializeProject(p));
  assert.deepEqual(loaded.parts, p.parts);
  assert.deepEqual(loaded.design, p.design);
  assert.equal(loaded.motion.playing, false);
  assert.equal(loaded.motion.progress, 0.3);
  const restoredFile = decodePart(loaded.parts.arms);
  assert.equal(restoredFile.name, '手臂.OBJ');
  assert.equal(await restoredFile.text(), triangle);
  loaded.parts.arms.name = 'different.obj';
  assert.equal(p.parts.arms.name, '手臂.OBJ');
});

test('拒绝损坏 base64、格式错配、无效 OBJ 和缺失候选字段', () => {
  const invalidParts = [
    { ...candidate(), data: '' }, { ...candidate(), data: '%%%%' },
    { ...candidate(), data: 'Zh==' }, { ...candidate(), data: 'YQ' },
    { ...candidate(), data: 'Zg==\n' }, { ...candidate(), format: 'fbx' },
    { ...candidate(), data: 'A'.repeat(Math.ceil(APP_CONFIG.assets.import.maximumBytes / 3) * 4 + 4) },
    { ...candidate(), name: 'arm.glb' }, { ...candidate(), name: '../arm.obj' },
    { ...candidate(), data: Buffer.from([0, 1, 2]).toString('base64') },
    candidate('hello'), candidate('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9'),
    candidate('v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'),
    candidate('v 0x1 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'),
    candidate('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/ 2/ 3/'),
    candidate('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 2 3'),
    candidate('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -4 -2 -1'),
    { name: 'arm.obj', format: 'obj' },
  ];
  for (const part of invalidParts) {
    const p = createDefaultProject(); p.parts.arms = part;
    assert.throws(() => validateProject(p), Error);
  }
});

test('GLB 二进制头、长度、JSON 和外部依赖经过检查', async () => {
  const valid = makeGlb();
  const encoded = await encodePart(new File([valid], 'arm.glb'));
  assert.deepEqual(Buffer.from(await decodePart(encoded).arrayBuffer()), valid);
  const wrongVersion = Buffer.from(valid); wrongVersion.writeUInt32LE(1, 4);
  const wrongLength = Buffer.from(valid); wrongLength.writeUInt32LE(valid.length + 4, 8);
  const wrongChunk = Buffer.from(valid); wrongChunk.writeUInt32LE(0, 16);
  const wrongJson = Buffer.from(valid); wrongJson[20] = 33;
  for (const bytes of [Buffer.from('no model'), wrongVersion, wrongLength, wrongChunk, wrongJson,
    makeGlb({ asset: { version: '1.0' } }),
    makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 12 }] }),
    makeGlb({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/texture.png' }] }),
  ]) {
    await assert.rejects(encodePart(new File([bytes], 'arm.glb')), Error);
  }
});

test('OBJ 接受纹理、法线、科学计数法及注释，拒绝缺失坐标引用', async () => {
  const coordinates = 'v 0e0 0 0\nv 1.0 0 0\nv 0 +1.0 0\nvt .5 .5\nvn 0 0 1\n';
  const source = `${coordinates}f 1/1/1 2/1/1 3/1/1 # triangle\n`;
  assert.equal(await decodePart(await encodePart(new File([source], 'uv.obj'))).text(), source);
  await assert.rejects(encodePart(new File([`${coordinates}f 1/2/1 2/2/1 3/2/1`], 'bad-uv.obj')), /不存在/);
});

test('空文件、错误扩展名、超限文件在读取前被拒绝', async () => {
  await assert.rejects(encodePart(new File([], 'empty.obj')), /非空/);
  await assert.rejects(encodePart(new File([triangle], 'arm.txt')), /仅支持/);
  let read = false;
  await assert.rejects(encodePart({
    name: 'huge.glb', size: APP_CONFIG.assets.import.maximumBytes + 1,
    arrayBuffer() { read = true; return new ArrayBuffer(0); },
  }), /文件大小/);
  assert.equal(read, false);
});
