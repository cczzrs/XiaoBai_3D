import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_CONFIG } from '../web/src/config.js';
import { createDefaultProject, validateProject, validateAppearance, validateBinding, parseProject, serializeProject, encodePart, decodePart } from '../web/src/project-state.js';
import { getBuiltinPartAsset } from '../web/src/builtin-parts.js';

const triangle = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const candidate = (source = triangle) => ({ name: '手臂.obj', format: 'obj', data: Buffer.from(source).toString('base64') });
const imageRecord = () => ({ name: '纹理.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGNcsOUEAxgwQSgGBgYAJgwCIOCXehUAAAAASUVORK5CYII=', width: 3, height: 2 });

// 固定的历史输入，避免通过删除当前默认字段来模拟旧版而掩盖兼容性问题。
function legacyProject() {
  return {
    schema: 'xiaobai.studio.v1', revision: 1,
    design: {
      shape: { headScale: 1.1, bodyWidth: 0.9, bodyHeight: 1.2, bodyDepth: 1 },
      rig: { rootY: 20, neckY: 55 },
      pose: { headYaw: -30, headPitch: 15, headRoll: 10, bodyLean: 5 },
    },
    motion: { preset: 'nod', playing: true, speed: 1.5, amplitude: 15, progress: 0.6 },
    parts: { arms: null, legs: null },
  };
}

function version2Project() {
  const project = legacyProject();
  project.revision = 2;
  project.design.eyes = { width: 1.2, height: 0.85, spacing: 1.1, offsetY: -1.2, gazeX: 2.1, gazeY: -1.5, leftOpen: 0.4, rightOpen: 0.8 };
  project.design.nose = { width: 1.4, height: 1.2, offsetY: 0.6, protrusion: 1.5, tilt: -10 };
  Object.assign(project.motion, { eyesPreset: 'blink', nosePreset: 'twitch', eyeAmplitude: 0.65, noseAmplitude: 0.35 });
  return project;
}

function version3Project() {
  const project = version2Project();
  project.revision = 3;
  project.appearance = {
    materials: {
      head: { enabled: true, color: '#ABCDEF', roughness: 0.4, image: imageRecord() },
      body: { enabled: true, color: '#AABBCC', roughness: 0.6, image: null },
      arms: { enabled: false, color: '#FFF1D9', roughness: 0.7, image: null },
      legs: { enabled: false, color: '#FFF1D9', roughness: 0.7, image: null },
      eyes: { enabled: false, color: '#26231F', roughness: 0.62, image: null },
      nose: { enabled: false, color: '#26231F', roughness: 0.62, image: null },
    },
    background: { color: '#334455', image: { ...imageRecord(), name: '背景.png' }, fit: 'contain' },
    lighting: { enabled: true, azimuth: -90, elevation: 30, intensity: 7, exposure: 1.5 },
  };
  return project;
}

function version4Project() {
  const project = version3Project();
  project.revision = 4;
  project.expression = { preset: 'thinking', intensity: 0.7 };
  return project;
}

function version5Project() {
  const project = version4Project();
  project.revision = 5;
  project.parts.arms = { kind: 'builtin', id: 'left-arm-v59-mirrored' };
  return project;
}

function version6Project(legId = 'legs-reference-v1-mirrored') {
  const project = version5Project();
  project.revision = 6;
  project.parts.legs = { kind: 'builtin', id: legId };
  return project;
}

const BINDING_JOINT_KEYS = [
  'shoulderL', 'elbowL', 'wristL', 'handTipL', 'hipL', 'kneeL', 'ankleL', 'toeTipL',
  'shoulderR', 'elbowR', 'wristR', 'handTipR', 'hipR', 'kneeR', 'ankleR', 'toeTipR',
];
function neutralBinding() {
  return {
    offsets: Object.fromEntries(BINDING_JOINT_KEYS.map((key) => [key, [0, 0, 0]])),
    rotations: Object.fromEntries(BINDING_JOINT_KEYS.map((key) => [key, [0, 0, 0]])),
  };
}

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

test('默认项目从配置复制，独立旧版输入补入中立参数并迁移为 revision 8', () => {
  const project = legacyProject();
  const normalized = validateProject(project);
  assert.equal(normalized.revision, 8);
  assert.equal(normalized.motion.playing, false);
  assert.equal(project.motion.playing, true);
  assert.deepEqual(normalized.design, {
    ...project.design,
    eyes: { width: 1, height: 1, spacing: 1, offsetY: 0, gazeX: 0, gazeY: 0, leftOpen: 1, rightOpen: 1 },
    nose: { width: 1, height: 1, offsetY: 0, protrusion: 0, tilt: 0 },
  });
  assert.deepEqual(normalized.motion, { ...project.motion, playing: false, eyesPreset: 'none', nosePreset: 'none', eyeAmplitude: 1, noseAmplitude: 1 });
  assert.notEqual(normalized.design.shape, project.design.shape);
  assert.equal(Object.hasOwn(project.design, 'eyes'), false);
  assert.equal(project.revision, 1);
  assert.deepEqual(normalized.appearance, APP_CONFIG.appearance.defaults);
  assert.deepEqual(normalized.expression, { preset: 'neutral', intensity: 1 });
  const first = createDefaultProject();
  first.design.shape.headScale = 1.2;
  first.design.eyes.width = 0.8;
  first.design.nose.width = 1.5;
  first.motion.eyesPreset = 'blink';
  first.appearance.materials.head.color = '#123456';
  first.expression.intensity = 0.4;
  assert.equal(createDefaultProject().design.shape.headScale, APP_CONFIG.design.defaults.shape.headScale);
  assert.equal(createDefaultProject().design.eyes.width, APP_CONFIG.design.defaults.eyes.width);
  assert.equal(createDefaultProject().design.nose.width, APP_CONFIG.design.defaults.nose.width);
  assert.equal(createDefaultProject().motion.eyesPreset, APP_CONFIG.design.motion.defaults.eyesPreset);
  assert.equal(createDefaultProject().appearance.materials.head.color, APP_CONFIG.appearance.defaults.materials.head.color);
  assert.deepEqual(createDefaultProject().expression, { preset: 'neutral', intensity: 1 });
});

test('拒绝错误版本、缺字段、未知字段和非对象', () => {
  for (const value of [null, [], 12, {}, { ...createDefaultProject(), schema: 'alien' }, { ...createDefaultProject(), revision: '1' }]) {
    assert.throws(() => validateProject(value), Error);
  }
  for (const revision of [0, 9, '2', 1.5, NaN, null, true]) {
    assert.throws(() => validateProject({ ...createDefaultProject(), revision }), /revision/);
  }
  for (const mutate of [
    (p) => { delete p.design; }, (p) => { delete p.design.pose.headYaw; },
    (p) => { p.parts.head = candidate(); }, (p) => { p.parts.body = null; },
    (p) => { p.approved = {}; }, (p) => { p.motion.playing = 1; },
    (p) => { p.motion.preset = 'unsupported-action'; }, (p) => { delete p.motion.progress; },
  ]) {
    const p = createDefaultProject(); mutate(p);
    assert.throws(() => validateProject(p), Error);
  }
  assert.throws(() => parseProject('{oops'), /JSON/);
  assert.throws(() => parseProject({}), /JSON/);
});

test('每个形体、骨骼、姿态、眼睛和鼻子参数均校验类型与配置范围', () => {
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
  for (const [key, range] of Object.entries({
    speed: APP_CONFIG.design.motion.speed, amplitude: APP_CONFIG.design.motion.amplitude,
    progress: APP_CONFIG.design.motion.timeline,
    eyeAmplitude: APP_CONFIG.design.motion.eyeAmplitude, noseAmplitude: APP_CONFIG.design.motion.noseAmplitude,
  })) {
    for (const bad of [NaN, Infinity, -Infinity, '1', null, true, range.min - 1, range.max + 1]) {
      const p = createDefaultProject(); p.motion[key] = bad;
      assert.throws(() => validateProject(p), Error);
    }
    for (const boundary of [range.min, range.max]) {
      const p = createDefaultProject(); p.motion[key] = boundary;
      assert.equal(validateProject(p).motion[key], boundary);
    }
  }
});

test('旧版保存与加载迁移后保留全部原参数和候选文件', async () => {
  const original = legacyProject();
  original.parts.arms = candidate();
  original.parts.legs = candidate('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
  const before = structuredClone(original);
  const migrated = parseProject(JSON.stringify(original));
  for (const group of ['shape', 'rig', 'pose']) assert.deepEqual(migrated.design[group], original.design[group]);
  for (const key of ['preset', 'speed', 'amplitude', 'progress']) assert.equal(migrated.motion[key], original.motion[key]);
  assert.deepEqual(migrated.parts, original.parts);
  assert.equal(await decodePart(migrated.parts.arms).text(), triangle);
  assert.deepEqual(parseProject(serializeProject(original)), migrated);
  assert.deepEqual(parseProject(serializeProject(migrated)), migrated);
  assert.deepEqual(original, before);
  migrated.parts.arms.name = 'different.obj';
  assert.equal(original.parts.arms.name, '手臂.obj');
});

test('revision 1 必须先通过历史字段校验，拒绝夹带眼鼻字段或坏候选', () => {
  for (const mutate of [
    (p) => { p.design.eyes = structuredClone(APP_CONFIG.design.defaults.eyes); },
    (p) => { p.design.nose = structuredClone(APP_CONFIG.design.defaults.nose); },
    ...['eyesPreset', 'nosePreset', 'eyeAmplitude', 'noseAmplitude'].map((key) => (p) => { p.motion[key] = APP_CONFIG.design.motion.defaults[key]; }),
    (p) => { p.design.shape.eyeWidth = 1; },
    (p) => { delete p.design.rig.rootY; },
    (p) => { p.design.pose.headYaw = NaN; },
    (p) => { p.design.shape.headScale = 100; },
    (p) => { p.motion.speed = '1'; },
    (p) => { p.motion.preset = 'blink'; },
    (p) => { p.motion.playing = 1; },
    (p) => { delete p.motion.progress; },
    (p) => { p.parts.head = null; },
    (p) => { p.parts.arms = { ...candidate(), data: 'broken' }; },
  ]) {
    const p = legacyProject(); mutate(p);
    assert.throws(() => validateProject(p), Error);
  }
  const injected = JSON.stringify(legacyProject()).replace('"motion":{', '"motion":{"__proto__":{"polluted":true},');
  assert.throws(() => parseProject(injected), /不允许/);
  assert.equal({}.polluted, undefined);
});

test('revision 2 严格要求全部眼鼻字段且不接受额外字段', () => {
  for (const group of ['eyes', 'nose']) {
    const missingGroup = version2Project();
    delete missingGroup.design[group];
    assert.throws(() => validateProject(missingGroup), /缺少/);
    for (const key of Object.keys(APP_CONFIG.design.defaults[group])) {
      const missingField = version2Project();
      delete missingField.design[group][key];
      assert.throws(() => validateProject(missingField), /缺少/);
    }
    const extraField = version2Project();
    extraField.design[group].unknown = 1;
    assert.throws(() => validateProject(extraField), /不允许/);
  }
  for (const key of ['eyesPreset', 'nosePreset', 'eyeAmplitude', 'noseAmplitude']) {
    const p = version2Project(); delete p.motion[key];
    assert.throws(() => validateProject(p), /缺少/);
  }
  const missingAll = legacyProject(); missingAll.revision = 2;
  assert.throws(() => validateProject(missingAll), /缺少/);
});

test('眼鼻动作预设仅接受各自配置枚举', () => {
  for (const [key, allowed] of [['eyesPreset', APP_CONFIG.design.motion.eyesPresets], ['nosePreset', APP_CONFIG.design.motion.nosePresets]]) {
    for (const value of allowed) {
      const p = createDefaultProject(); p.motion[key] = value;
      assert.equal(validateProject(p).motion[key], value);
    }
    for (const value of ['', 'walk', 'BLINK', null, false, 1, {}, ['none']]) {
      const p = createDefaultProject(); p.motion[key] = value;
      assert.throws(() => validateProject(p), /预设/);
    }
  }
  const swapped = createDefaultProject();
  swapped.motion.eyesPreset = 'twitch';
  assert.throws(() => validateProject(swapped), /眼睛/);
  swapped.motion.eyesPreset = 'none'; swapped.motion.nosePreset = 'blink';
  assert.throws(() => validateProject(swapped), /鼻子/);
});

test('眨眼加鼻子抽动、视线环顾加鼻子伸缩可完整保存恢复且动作暂停', () => {
  for (const [eyesPreset, nosePreset] of [['blink', 'twitch'], ['lookAround', 'stretch']]) {
    const p = createDefaultProject();
    p.design.eyes = { width: 1.2, height: 0.85, spacing: 1.1, offsetY: -1.2, gazeX: 2.1, gazeY: -1.5, leftOpen: 0.4, rightOpen: 0.8 };
    p.design.nose = { width: 1.4, height: 1.2, offsetY: 0.6, protrusion: 1.5, tilt: -10 };
    Object.assign(p.motion, { eyesPreset, nosePreset, eyeAmplitude: 0.65, noseAmplitude: 0.35, playing: true, progress: 0.45 });
    const loaded = parseProject(serializeProject(p));
    assert.deepEqual(loaded, { ...p, motion: { ...p.motion, playing: false } });
    assert.equal(p.motion.playing, true);
    assert.equal(loaded.revision, 8);
  }
});

test('revision 1 和 2 严格迁移外观，原设计动作候选完整保留', () => {
  for (const original of [legacyProject(), version2Project()]) {
    original.parts.arms = candidate();
    const loaded = parseProject(JSON.stringify(original));
    assert.equal(loaded.revision, 8);
    assert.deepEqual(loaded.appearance, APP_CONFIG.appearance.defaults);
    assert.deepEqual(loaded.parts, original.parts);
    for (const [group, values] of Object.entries(original.design)) assert.deepEqual(loaded.design[group], values);
    for (const [key, value] of Object.entries(original.motion)) assert.equal(loaded.motion[key], key === 'playing' ? false : value);
    assert.equal(Object.hasOwn(original, 'appearance'), false);
    original.appearance = structuredClone(APP_CONFIG.appearance.defaults);
    assert.throws(() => validateProject(original), /旧版.*appearance/);
  }
});

test('revision 3 材质图片、背景图片和光照可完整保存恢复', () => {
  const project = version3Project();
  project.appearance.materials.head = { enabled: true, color: '#123456', roughness: 0.4, image: imageRecord() };
  project.appearance.materials.eyes = { enabled: true, color: '#222222', roughness: 0.2, image: imageRecord() };
  project.appearance.background = { color: '#ABCDEF', image: { ...imageRecord(), name: '背景.png' }, fit: 'contain' };
  project.appearance.lighting = { enabled: true, azimuth: -120, elevation: 45, intensity: 6.5, exposure: 1.5 };
  const restored = parseProject(serializeProject(project));
  assert.deepEqual(restored, { ...project, revision: 8, motion: { ...project.motion, playing: false }, expression: { preset: 'neutral', intensity: 1 }, binding: neutralBinding(), actions: createDefaultProject().actions });
  restored.appearance.materials.head.image.name = '新名字.png';
  assert.equal(project.appearance.materials.head.image.name, '纹理.png');
  assert.notEqual(restored.appearance.lighting, project.appearance.lighting);
});

test('revision 4 顶层表情的所有预设、强度边界可独立保存恢复', () => {
  for (const preset of Object.keys(APP_CONFIG.design.expression.presets)) {
    for (const intensity of [APP_CONFIG.design.expression.intensity.min, 0.45, APP_CONFIG.design.expression.intensity.max]) {
      const project = createDefaultProject();
      project.expression = { preset, intensity };
      project.design.eyes.gazeX = 1.3;
      project.design.nose.tilt = -8;
      Object.assign(project.motion, { eyesPreset: 'blink', nosePreset: 'twitch', progress: 0.6, playing: true });
      const restored = parseProject(serializeProject(project));
      assert.deepEqual(restored, { ...project, motion: { ...project.motion, playing: false } });
      assert.notEqual(restored.expression, project.expression);
      assert.equal(Object.hasOwn(restored.design, 'expression'), false);
    }
  }
});

test('revision 1、2、3 迁移中立表情且完整保留历史字段，拒绝夹带 expression', () => {
  for (const original of [legacyProject(), version2Project(), version3Project()]) {
    original.parts.arms = candidate();
    original.parts.legs = { ...candidate(), name: '腿脚.obj' };
    const before = structuredClone(original);
    const restored = parseProject(JSON.stringify(original));
    assert.equal(restored.revision, 8);
    assert.deepEqual(restored.expression, { preset: 'neutral', intensity: 1 });
    assert.deepEqual(restored.parts, original.parts);
    for (const group of Object.keys(original.design)) assert.deepEqual(restored.design[group], original.design[group]);
    for (const key of Object.keys(original.motion)) assert.equal(restored.motion[key], key === 'playing' ? false : original.motion[key]);
    if (original.appearance) assert.deepEqual(restored.appearance, original.appearance);
    assert.deepEqual(original, before);
    for (const expression of [{ preset: 'neutral', intensity: 1 }, null, undefined]) {
      assert.throws(() => validateProject({ ...original, expression }), /旧版.*expression/);
    }
  }
  const missingAppearance = version3Project(); delete missingAppearance.appearance;
  assert.throws(() => validateProject(missingAppearance), /缺少字段：appearance/);
});

test('revision 4 表情严格必填，拒绝未知预设、错误强度、缺失和多余字段', () => {
  const missing = createDefaultProject(); delete missing.expression;
  assert.throws(() => validateProject(missing), /缺少字段：expression/);
  for (const expression of [null, [], {}, { preset: 'neutral' }, { intensity: 1 }, { preset: 'neutral', intensity: 1, extra: true }]) {
    assert.throws(() => validateProject({ ...createDefaultProject(), expression }), Error);
  }
  for (const preset of ['', 'unknown', 'NEUTRAL', '__proto__', 'constructor', 'toString', 1, false, null, ['neutral'], { toString() { throw new Error('must not execute'); } }]) {
    assert.throws(() => validateProject({ ...createDefaultProject(), expression: { preset, intensity: 1 } }), /表情预设/);
  }
  const range = APP_CONFIG.design.expression.intensity;
  for (const intensity of [NaN, Infinity, -Infinity, '1', true, null, range.min - 0.01, range.max + 0.01]) {
    assert.throws(() => validateProject({ ...createDefaultProject(), expression: { preset: 'neutral', intensity } }), /表情强度/);
  }
});

test('表情保留原型与动态属性防护，不执行恶意取值', () => {
  const text = serializeProject(createDefaultProject());
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => parseProject(text.replace('"expression": {', `"expression": { "${key}": {"polluted": true},`)), /不允许/);
  }
  const inherited = createDefaultProject();
  inherited.expression = Object.assign(Object.create({ polluted: true }), { preset: 'neutral', intensity: 1 });
  assert.throws(() => validateProject(inherited), /对象类型/);
  for (const key of ['preset', 'intensity']) {
    const dynamic = createDefaultProject();
    Object.defineProperty(dynamic.expression, key, { get() { throw new Error('must not execute'); } });
    assert.throws(() => validateProject(dynamic), /动态属性/);
  }
  const rootDynamic = createDefaultProject();
  Object.defineProperty(rootDynamic, 'expression', { get() { throw new Error('must not execute'); } });
  assert.throws(() => validateProject(rootDynamic), /动态属性/);
  assert.equal({}.polluted, undefined);
});

test('外观字段严格必填，颜色、布尔、适配和图片错误均拒绝', () => {
  for (const mutate of [
    (p) => { delete p.appearance; },
    (p) => { delete p.appearance.materials; },
    (p) => { delete p.appearance.materials.nose; },
    (p) => { delete p.appearance.materials.head.image; },
    (p) => { p.appearance.materials.head.enabled = 1; },
    (p) => { p.appearance.lighting.enabled = 'true'; },
    (p) => { p.appearance.materials.extra = {}; },
    (p) => { p.appearance.materials.head.foo = 1; },
    (p) => { p.appearance.background.fit = 'stretch'; },
    (p) => { delete p.appearance.lighting.exposure; },
    (p) => { p.appearance.lighting.distance = 280; },
    (p) => { p.appearance.background.image = { ...imageRecord(), width: 20 }; },
    (p) => { p.appearance.materials.body.image = { ...imageRecord(), mime: 'image/jpeg' }; },
  ]) {
    const p = createDefaultProject(); mutate(p);
    assert.throws(() => validateProject(p), Error);
  }
  for (const value of ['red', '#123', '#12345678', '#ZZZZZZ', ' #123456', null, 123456]) {
    const p = createDefaultProject(); p.appearance.background.color = value;
    assert.throws(() => validateProject(p), /颜色/);
    p.appearance = structuredClone(APP_CONFIG.appearance.defaults); p.appearance.materials.head.color = value;
    assert.throws(() => validateProject(p), /颜色/);
  }
  const p = createDefaultProject(); p.appearance.background.color = '#aabbcc';
  assert.equal(validateProject(p).appearance.background.color, '#AABBCC');
});

test('材质粗糙度和所有光照参数校验有限数值及配置边界', () => {
  const targets = [
    ...Object.keys(APP_CONFIG.appearance.defaults.materials).map((slot) => ({ range: APP_CONFIG.appearance.limits.roughness, set: (p, value) => { p.appearance.materials[slot].roughness = value; } })),
    ...['azimuth', 'elevation', 'intensity', 'exposure'].map((key) => ({ range: APP_CONFIG.viewer.lighting.limits[key], set: (p, value) => { p.appearance.lighting[key] = value; } })),
  ];
  for (const { range, set } of targets) {
    for (const value of [NaN, Infinity, -Infinity, true, '1', null, range.min - 0.01, range.max + 0.01]) {
      const p = createDefaultProject(); set(p, value);
      assert.throws(() => validateProject(p), Error);
    }
    for (const value of [range.min, range.max]) {
      const p = createDefaultProject(); set(p, value);
      assert.deepEqual(validateProject(p), p);
    }
  }
});

test('外观与图片仍阻止原型注入，项目文本总额在 JSON 解析前限制', () => {
  const text = serializeProject(createDefaultProject());
  for (const [field, injection] of [['appearance', '__proto__'], ['materials', 'constructor'], ['background', 'prototype']]) {
    const polluted = text.replace(`"${field}": {`, `"${field}": { "${injection}": {"polluted": true},`);
    assert.throws(() => parseProject(polluted), /不允许/);
  }
  const p = createDefaultProject();
  p.appearance.materials.head.image = JSON.parse(JSON.stringify(imageRecord()).replace('{', '{"__proto__":{},'));
  assert.throws(() => validateProject(p), /不允许/);
  const dynamic = structuredClone(APP_CONFIG.appearance.defaults);
  Object.defineProperty(dynamic, 'lighting', { get() { throw new Error('must not execute'); } });
  assert.throws(() => validateAppearance(dynamic), /动态属性/);
  assert.throws(() => parseProject(' '.repeat(APP_CONFIG.appearance.images.maximumProjectBytes + 1)), /总大小/);
  assert.equal({}.polluted, undefined);
});

test('项目白名单阻止原型污染、继承字段与动态属性', () => {
  const text = serializeProject(createDefaultProject());
  assert.throws(() => parseProject(text.replace('"parts": {', '"parts": { "__proto__": {"polluted": true},')), /不允许/);
  assert.throws(() => parseProject(text.replace('"parts": {', '"parts": { "constructor": {},')), /不允许/);
  assert.throws(() => parseProject(text.replace('"eyes": {', '"eyes": { "__proto__": {"polluted": true},')), /不允许/);
  assert.throws(() => parseProject(text.replace('"nose": {', '"nose": { "constructor": {},')), /不允许/);
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
  Object.assign(p.motion, { preset: 'sway', playing: true, speed: 0.5, amplitude: 20, progress: 0.3 });
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

test('revision 8 默认内置双臂及腿脚 v2 可保存恢复，与配置及解码结果无可变共享引用', () => {
  const project = createDefaultProject();
  const expected = {
    arms: { kind: 'builtin', id: 'left-arm-v59-mirrored' },
    legs: { kind: 'builtin', id: 'legs-smooth-v2-mirrored' },
  };
  assert.equal(project.revision, 8);
  assert.deepEqual(project.parts, expected);
  const restored = parseProject(serializeProject(project));
  assert.deepEqual(restored, project);
  for (const slot of ['arms', 'legs']) {
    assert.deepEqual(APP_CONFIG.assets[slot].builtin.projectRecord, expected[slot]);
    assert.ok(Object.isFrozen(APP_CONFIG.assets[slot].builtin.projectRecord));
    assert.notEqual(project.parts[slot], APP_CONFIG.assets[slot].builtin.projectRecord);
    const decoded = decodePart(restored.parts[slot], slot);
    assert.deepEqual(decoded, expected[slot]);
    assert.notEqual(decoded, restored.parts[slot]);
    decoded.id = 'edited';
    restored.parts[slot].id = 'other';
  }
  assert.deepEqual(project.parts, expected);
  assert.deepEqual(createDefaultProject().parts, expected);
});

test('revision 6 腿脚 v1 保留版本、模型路径及全部原参数，显式换成 v2 后才引用新版', () => {
  const original = version5Project();
  original.revision = 6;
  original.parts.legs = { kind: 'builtin', id: 'legs-reference-v1-mirrored' };
  const before = structuredClone(original);
  const restored = parseProject(serializeProject(original));
  assert.deepEqual(restored, { ...original, revision: 8, motion: { ...original.motion, playing: false }, binding: neutralBinding(), actions: createDefaultProject().actions });
  const decoded = decodePart(restored.parts.legs, 'legs');
  assert.deepEqual(decoded, { kind: 'builtin', id: 'legs-reference-v1-mirrored' });
  const asset = getBuiltinPartAsset(APP_CONFIG, 'legs', decoded);
  assert.equal(asset.version, 'legs-v1');
  assert.equal(asset.url, './assets/design/legs-v1/legs.glb');
  assert.equal(asset.label, 'legs-v1 · 圆润腿脚');
  assert.equal(asset.approved, false);
  assert.ok(Object.isFrozen(asset));
  decoded.id = 'changed';
  assert.equal(restored.parts.legs.id, 'legs-reference-v1-mirrored');
  assert.deepEqual(original, before);

  restored.parts.legs = structuredClone(APP_CONFIG.assets.legs.builtin.projectRecord);
  const updated = parseProject(serializeProject(restored));
  assert.deepEqual(updated.parts.arms, original.parts.arms);
  assert.deepEqual(updated.design, original.design);
  assert.deepEqual(updated.appearance, original.appearance);
  assert.deepEqual(updated.expression, original.expression);
  const currentAsset = getBuiltinPartAsset(APP_CONFIG, 'legs', decodePart(updated.parts.legs, 'legs'));
  assert.equal(currentAsset.version, 'legs-v2');
  assert.equal(currentAsset.url, './assets/design/legs-v2/legs.glb');
  assert.equal(currentAsset.label, 'legs-v2 · 平滑腿根');
  assert.equal(currentAsset.approved, true);
  assert.equal(currentAsset.approvalFile, './docs/approvals/legs-v2-approved.json');
  for (const id of ['unknown', '__proto__', 'constructor', 'left-arm-v59-mirrored']) {
    assert.equal(getBuiltinPartAsset(APP_CONFIG, 'legs', { kind: 'builtin', id }), null);
  }
  assert.equal(getBuiltinPartAsset(APP_CONFIG, 'arms', original.parts.legs), null);
  assert.equal(getBuiltinPartAsset(APP_CONFIG, 'head', original.parts.legs), null);
});

test('显式移除双臂或腿脚后的 null 保存恢复仍为空，不回退到内置模型', () => {
  for (const slot of ['arms', 'legs']) {
    const project = createDefaultProject();
    project.parts[slot] = null;
    assert.deepEqual(parseProject(serializeProject(project)).parts, project.parts);
  }
  const project = createDefaultProject(); project.parts = { arms: null, legs: null };
  assert.deepEqual(parseProject(serializeProject(project)).parts, project.parts);
});

test('revision 1 至 4 的空手臂和导入候选保持原意，不自动安装 v59', () => {
  for (const make of [legacyProject, version2Project, version3Project, version4Project]) {
    for (const arms of [null, candidate()]) {
      const original = make();
      original.parts.arms = arms;
      const before = structuredClone(original);
      const migrated = parseProject(JSON.stringify(original));
      assert.equal(migrated.revision, 8);
      assert.deepEqual(migrated.parts, original.parts);
      for (const [key, value] of Object.entries(original.design)) assert.deepEqual(migrated.design[key], value);
      if (original.expression) assert.deepEqual(migrated.expression, original.expression);
      if (original.appearance) assert.deepEqual(migrated.appearance, original.appearance);
      assert.deepEqual(original, before);
      original.parts.arms = { kind: 'builtin', id: 'left-arm-v59-mirrored' };
      assert.throws(() => validateProject(original), /旧版.*内置/);
    }
  }
});

test('revision 1 至 5 的空腿脚及导入腿脚不自动替换，revision 5 双臂记录完整保留', async () => {
  for (const make of [legacyProject, version2Project, version3Project, version4Project, version5Project]) {
    const armRecords = make === version5Project ? [null, candidate(), version5Project().parts.arms] : [null, candidate()];
    for (const arms of armRecords) {
      for (const legs of [null, { ...candidate(), name: '腿脚.obj' }]) {
        const original = make(); original.parts = { arms, legs };
        const before = structuredClone(original);
        const migrated = parseProject(JSON.stringify(original));
        assert.equal(migrated.revision, 8);
        assert.deepEqual(migrated.parts, original.parts);
        for (const [key, value] of Object.entries(original.design)) assert.deepEqual(migrated.design[key], value);
        for (const [key, value] of Object.entries(original.motion)) assert.equal(migrated.motion[key], key === 'playing' ? false : value);
        if (original.appearance) assert.deepEqual(migrated.appearance, original.appearance);
        if (original.expression) assert.deepEqual(migrated.expression, original.expression);
        assert.deepEqual(parseProject(serializeProject(migrated)), migrated);
        assert.deepEqual(original, before);
        if (legs) {
          const file = decodePart(migrated.parts.legs, 'legs');
          assert.equal(file.name, '腿脚.obj');
          assert.equal(await file.text(), triangle);
        }
        for (const id of ['legs-reference-v1-mirrored', 'legs-smooth-v2-mirrored']) {
          original.parts.legs = { kind: 'builtin', id };
          assert.throws(() => validateProject(original), /旧版.*内置/);
        }
      }
    }
  }
});

test('内置记录拒绝错误槽位、未知 id、任意 URL、额外字段及动态属性', () => {
  for (const [slot, valid] of [
    ['arms', { kind: 'builtin', id: 'left-arm-v59-mirrored' }],
    ['legs', { kind: 'builtin', id: 'legs-reference-v1-mirrored' }],
    ['legs', { kind: 'builtin', id: 'legs-smooth-v2-mirrored' }],
  ]) {
    const otherSlot = slot === 'arms' ? 'legs' : 'arms';
    const wrongSlot = createDefaultProject(); wrongSlot.parts[otherSlot] = valid;
    assert.throws(() => validateProject(wrongSlot), /槽位/);
    for (const rejectedSlot of [otherSlot, 'head', 'body', '__proto__', 'constructor']) {
      assert.throws(() => decodePart(valid, rejectedSlot), /槽位/);
    }
    for (const value of [
      { kind: 'builtin', id: 'unknown' }, { kind: 'file', id: valid.id },
      { kind: 'builtin' }, { kind: 'builtin', id: valid.id, url: 'https://example.com/part.glb' },
      { ...valid, name: 'part.glb' }, { ...valid, id: 59 }, { ...valid, kind: null },
    ]) {
      const project = createDefaultProject(); project.parts[slot] = value;
      assert.throws(() => validateProject(project), Error);
      assert.throws(() => decodePart(value, slot), Error);
    }
    for (const key of ['kind', 'id']) {
      const project = createDefaultProject();
      Object.defineProperty(project.parts[slot], key, { get() { throw new Error('must not execute'); }, enumerable: true });
      assert.throws(() => validateProject(project), /动态属性/);
      assert.throws(() => decodePart(project.parts[slot], slot), /动态属性/);
    }
    const inherited = Object.assign(Object.create({ untrusted: true }), valid);
    assert.throws(() => decodePart(inherited, slot), /对象类型/);
    const polluted = JSON.parse(JSON.stringify(valid).replace('{', '{"__proto__":{},'));
    assert.throws(() => decodePart(polluted, slot), /不允许/);
  }
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


test('revision 8 默认绑定独立复制配置：16 个关节偏移及旋转全部中立', () => {
  const first = createDefaultProject();
  const second = createDefaultProject();
  assert.equal(first.revision, 8);
  assert.deepEqual(first.binding, neutralBinding());
  assert.deepEqual(APP_CONFIG.design.binding.defaults, neutralBinding());
  assert.deepEqual(new Set(Object.keys(APP_CONFIG.design.binding.joints)), new Set(BINDING_JOINT_KEYS));
  assert.equal(Object.keys(APP_CONFIG.design.binding.joints).length, 16);
  assert.ok(Object.isFrozen(APP_CONFIG.design.binding.defaults));
  for (const group of ['offsets', 'rotations']) {
    for (const key of BINDING_JOINT_KEYS) {
      assert.notEqual(first.binding[group][key], second.binding[group][key]);
      assert.notEqual(first.binding[group][key], APP_CONFIG.design.binding.defaults[group][key]);
      assert.ok(Object.isFrozen(APP_CONFIG.design.binding.defaults[group][key]));
    }
  }
  first.binding.offsets.shoulderL[0] = 1.25;
  first.binding.rotations.kneeR[2] = -23.5;
  assert.deepEqual(second.binding, neutralBinding());
  assert.deepEqual(APP_CONFIG.design.binding.defaults, neutralBinding());
  assert.deepEqual(createDefaultProject().binding, neutralBinding());
});

test('revision 8 保存恢复所有非中立关节浮点参数，不共享数组且不注入运行时动作', () => {
  const project = createDefaultProject();
  for (const [i, key] of BINDING_JOINT_KEYS.entries()) {
    project.binding.offsets[key] = [i / 8 - 1, 1.25, -0.625];
    project.binding.rotations[key] = [i * 2.5 - 20, -13.125, 57.25];
  }
  const before = structuredClone(project);
  const normalized = validateBinding(project.binding);
  const loaded = parseProject(serializeProject(project));
  assert.deepEqual(normalized, project.binding);
  assert.deepEqual(loaded, project);
  assert.deepEqual(Object.keys(loaded.binding).sort(), ['offsets', 'rotations']);
  for (const group of ['offsets', 'rotations']) {
    for (const key of BINDING_JOINT_KEYS) {
      assert.notEqual(normalized[group][key], project.binding[group][key]);
      assert.notEqual(loaded.binding[group][key], project.binding[group][key]);
    }
  }
  loaded.binding.offsets.shoulderL[0] = 4.75;
  normalized.rotations.kneeR[0] = -49.5;
  assert.deepEqual(project, before);
});

test('revision 1 至 6 独立历史输入中立迁移绑定，原参数和空槽/文件/v1/v2 资源保持', () => {
  const fixtures = [legacyProject(), version2Project(), version3Project(), version4Project(), version5Project(), version6Project(), version6Project('legs-smooth-v2-mirrored')];
  fixtures[0].parts.arms = candidate();
  fixtures[1].parts.legs = { ...candidate(), name: '旧腿.obj' };
  for (const original of fixtures) {
    const before = structuredClone(original);
    const loaded = parseProject(JSON.stringify(original));
    assert.equal(loaded.revision, 8);
    assert.deepEqual(loaded.binding, neutralBinding());
    assert.equal(loaded.motion.playing, false);
    assert.deepEqual(loaded.parts, original.parts);
    for (const [group, values] of Object.entries(original.design)) assert.deepEqual(loaded.design[group], values);
    for (const [key, value] of Object.entries(original.motion)) assert.deepEqual(loaded.motion[key], key === 'playing' ? false : value);
    if (original.appearance) assert.deepEqual(loaded.appearance, original.appearance);
    if (original.expression) assert.deepEqual(loaded.expression, original.expression);
    assert.deepEqual(parseProject(serializeProject(loaded)), loaded);
    assert.deepEqual(original, before);
    for (const binding of [neutralBinding(), null, undefined]) {
      assert.throws(() => validateProject({ ...original, binding }), /旧版.*binding/);
    }
  }
});

test('revision 8 绑定严格必填，拒绝缺关节/额外关节/层级/动作字段和错误向量', () => {
  const missing = createDefaultProject(); delete missing.binding;
  assert.throws(() => validateProject(missing), /缺少字段：binding/);
  for (const value of [null, [], {}, { offsets: {} }, { ...neutralBinding(), joints: [] }, { ...neutralBinding(), clips: [] }]) {
    assert.throws(() => validateProject({ ...createDefaultProject(), binding: value }), Error);
  }
  for (const group of ['offsets', 'rotations']) {
    for (const key of BINDING_JOINT_KEYS) {
      const missing = neutralBinding(); delete missing[group][key];
      assert.throws(() => validateBinding(missing), /缺少字段/);
      const extra = neutralBinding(); extra[group].unknown = [0, 0, 0];
      assert.throws(() => validateBinding(extra), /不允许/);
      for (const value of [null, 0, {}, [0, 0], [0, 0, 0, 0], new Array(3), new Float32Array(3)]) {
        const binding = neutralBinding(); binding[group][key] = value;
        assert.throws(() => validateBinding(binding), Error);
      }
    }
  }
});

test('绑定各关节三轴仅接受有限浮点数及配置边界', () => {
  for (const group of ['offsets', 'rotations']) {
    const range = APP_CONFIG.design.binding.limits[group];
    for (const key of BINDING_JOINT_KEYS) {
      for (let axis = 0; axis < 3; axis += 1) {
        for (const value of [NaN, Infinity, -Infinity, '1', true, null, range.min - 0.001, range.max + 0.001]) {
          const binding = neutralBinding(); binding[group][key][axis] = value;
          assert.throws(() => validateBinding(binding), Error, `${group}.${key}[${axis}] should reject ${String(value)}`);
        }
        for (const value of [range.min, 0.375, range.max]) {
          const binding = neutralBinding(); binding[group][key][axis] = value;
          assert.equal(validateBinding(binding)[group][key][axis], value);
        }
      }
    }
  }
});

test('绑定字典和向量阻止原型注入、继承、符号字段和 getter 执行', () => {
  const bomb = () => { throw new Error('getter must not execute'); };
  const factories = [
    () => { const p = createDefaultProject(); Object.defineProperty(p, 'binding', { get: bomb }); return p; },
    () => { const p = createDefaultProject(); Object.defineProperty(p.binding, 'offsets', { get: bomb }); return p; },
    () => { const p = createDefaultProject(); Object.defineProperty(p.binding.rotations, 'kneeR', { get: bomb }); return p; },
    () => { const p = createDefaultProject(); Object.defineProperty(p.binding.offsets.shoulderL, '0', { get: bomb }); return p; },
  ];
  for (const make of factories) assert.throws(() => validateProject(make()), /动态属性/);
  for (const mutate of [
    (b) => { Object.setPrototypeOf(b, { unknown: true }); },
    (b) => { Object.setPrototypeOf(b.offsets, { unknown: true }); },
    (b) => { Object.setPrototypeOf(b.offsets.shoulderL, Object.create(Array.prototype)); },
    (b) => { b.offsets.shoulderL.extra = 1; },
    (b) => { b.rotations.kneeR[Symbol('hidden')] = 0; },
    (b) => { b[Symbol('hidden')] = true; },
    (b) => { b.offsets.constructor = [0, 0, 0]; },
  ]) {
    const binding = neutralBinding(); mutate(binding);
    assert.throws(() => validateBinding(binding), Error);
  }
  const text = serializeProject(createDefaultProject());
  for (const field of ['binding', 'offsets', 'rotations']) {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => parseProject(text.replace(`"${field}": {`, `"${field}": { "${key}": {"polluted": true},`)), /不允许/);
    }
  }
  const nullDictionary = neutralBinding();
  Object.setPrototypeOf(nullDictionary, null);
  Object.setPrototypeOf(nullDictionary.offsets, null);
  assert.deepEqual(validateBinding(nullDictionary), neutralBinding());
  assert.equal({}.polluted, undefined);
});
