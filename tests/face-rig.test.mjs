import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test, { after, before } from 'node:test';
import { APP_CONFIG } from '../src/config.js';

const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three' ? new URL('../vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const THREE = await import('three');
const { createFaceRig, sampleFaceMotion } = await import('../src/face-rig.js');
const { importCandidate, clonePart, disposeObjects, exportModel } = await import('../src/model-io.js');
const limits = {
  maxBytes: APP_CONFIG.assets.import.maximumBytes,
  maxVertices: APP_CONFIG.assets.import.maximumVertices,
  maxMeshes: APP_CONFIG.assets.import.maximumMeshes,
  maxExtent: APP_CONFIG.assets.import.maximumExtent,
};
const { eyes, nose } = APP_CONFIG.design.defaults;
const motion = APP_CONFIG.design.motion.defaults;
let source, copy, rig;
const objects = [];
const originalFileReader = globalThis.FileReader;

const mesh = (root, key) => root.getObjectByName(APP_CONFIG.design.face.nodes[key]);
const positions = (root, key) => mesh(root, key).geometry.getAttribute('position').array;
const normals = (root, key) => mesh(root, key).geometry.getAttribute('normal').array;

before(async () => {
  const loaded = await importCandidate(new File([await readFile(new URL('../assets/approved/head-v1/xiaobai-head.glb', import.meta.url))], 'head.glb'), limits);
  source = loaded.root;
  copy = clonePart(source);
  rig = createFaceRig(copy, APP_CONFIG);
  objects.push(source, copy);
  globalThis.FileReader = class {
    async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  };
});

after(() => {
  disposeObjects(objects);
  if (originalFileReader === undefined) delete globalThis.FileReader;
  else globalThis.FileReader = originalFileReader;
  resolver.deregister();
});

test('眼鼻设计复制几何且默认参数、重置与批准顶点及法线逐项一致', () => {
  rig.reset();
  assert.equal(mesh(copy, 'head').geometry, mesh(source, 'head').geometry);
  for (const key of ['leftEye', 'rightEye', 'nose']) {
    assert.notEqual(mesh(copy, key).geometry, mesh(source, key).geometry);
    assert.deepEqual(positions(copy, key), positions(source, key));
    assert.deepEqual(normals(copy, key), normals(source, key));
  }
  rig.apply({ ...eyes, width: 1.3, offsetY: 3, leftOpen: 0 }, { ...nose, width: 1.6, tilt: 20, protrusion: 2 }, motion, 0);
  assert.notDeepEqual(positions(copy, 'leftEye'), positions(source, 'leftEye'));
  assert.notDeepEqual(positions(copy, 'nose'), positions(source, 'nose'));
  rig.reset();
  for (const key of ['leftEye', 'rightEye', 'nose']) {
    assert.deepEqual(positions(copy, key), positions(source, key));
    assert.deepEqual(normals(copy, key), normals(source, key));
  }
});

function silhouetteSamples(root, key) {
  const array = positions(root, key);
  return Array.from({ length: 128 }, (_, sample) => {
    const angle = sample / 128 * Math.PI * 2;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let maximum = -Infinity, index = 0;
    for (let i = 0; i < array.length; i += 3) {
      const projection = array[i] * ux + array[i + 1] * uy;
      if (projection > maximum) { maximum = projection; index = i; }
    }
    return { ux, uy, maximum, index };
  });
}

function assertSilhouetteUnchanged(key, samples) {
  const original = positions(source, key), changed = positions(copy, key);
  for (const { ux, uy, maximum, index } of samples) {
    assert.deepEqual(changed.slice(index, index + 3), original.slice(index, index + 3), `${key} outer support vertex must remain exact`);
    for (let i = 0; i < changed.length; i += 3) {
      assert.ok(changed[i] * ux + changed[i + 1] * uy <= maximum + 1e-5, `${key} interior escaped original silhouette`);
    }
  }
}

test('开合与目光只改变眼内部：保留两眼外轮廓且左右动作独立', () => {
  const samples = { leftEye: silhouetteSamples(source, 'leftEye'), rightEye: silhouetteSamples(source, 'rightEye') };
  const result = rig.apply(eyes, nose, { ...motion, eyesPreset: 'winkLeft' }, 0.5);
  assert.equal(result.eyes.leftOpen, 0);
  assert.equal(result.eyes.rightOpen, 1);
  assert.deepEqual(positions(copy, 'rightEye'), positions(source, 'rightEye'));
  assert.deepEqual(positions(copy, 'nose'), positions(source, 'nose'));
  assertSilhouetteUnchanged('leftEye', samples.leftEye);
  const sourceEye = positions(source, 'leftEye'), closedEye = positions(copy, 'leftEye');
  const centerIndices = [];
  for (let i = 0; i < sourceEye.length; i += 3) {
    if (Math.abs(sourceEye[i] + 19.7) < 1e-4) centerIndices.push(i);
  }
  const nearest = (target) => centerIndices.reduce((best, index) => Math.abs(sourceEye[index + 1] - target) < Math.abs(sourceEye[best + 1] - target) ? index : best);
  const innerTop = nearest(65.8 + 6.95), innerBottom = nearest(65.8 - 6.95);
  const outerTop = nearest(65.8 + 11.25), outerBottom = nearest(65.8 - 11.25);
  const apertureHeight = closedEye[innerTop + 1] - closedEye[innerBottom + 1];
  assert.ok(apertureHeight > 0 && apertureHeight < 1, `thin interior slit ${apertureHeight}`);
  assert.deepEqual(closedEye.slice(outerTop, outerTop + 3), sourceEye.slice(outerTop, outerTop + 3));
  assert.deepEqual(closedEye.slice(outerBottom, outerBottom + 3), sourceEye.slice(outerBottom, outerBottom + 3));
  let meshes = 0;
  copy.traverse((object) => { if (object.isMesh) meshes += 1; });
  assert.equal(meshes, 4);
  rig.apply(eyes, nose, { ...motion, eyesPreset: 'winkRight' }, 0.5);
  assert.deepEqual(positions(copy, 'leftEye'), positions(source, 'leftEye'));
  assert.notDeepEqual(positions(copy, 'rightEye'), positions(source, 'rightEye'));
  for (const progress of [0.125, 0.25, 0.75, 0.875]) {
    rig.apply(eyes, nose, { ...motion, eyesPreset: 'lookAround' }, progress);
    assertSilhouetteUnchanged('leftEye', samples.leftEye);
    assertSilhouetteUnchanged('rightEye', samples.rightEye);
  }
});

test('闭眼保留整个黑色外眼圈，只有内部开口收成弧形细缝', () => {
  rig.apply({ ...eyes, leftOpen: 0, rightOpen: 0 }, nose, motion, 0);
  source.updateMatrixWorld(true);
  copy.updateMatrixWorld(true);
  const head = mesh(source, 'head');
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  for (const [key, centerX] of [['leftEye', -19.7], ['rightEye', 19.7]]) {
    for (const offset of [-8, -4, 0, 4, 8]) {
      ray.ray.origin.set(centerX, 65.8 + offset, 100);
      const eyeHit = ray.intersectObject(mesh(copy, key), false)[0];
      const headHit = ray.intersectObject(head, false)[0];
      assert.ok(eyeHit && headHit && eyeHit.point.z > headHit.point.z, `${key} retained outer eye must remain visible at ${offset}`);
    }
    ray.ray.origin.set(centerX, 65.8 + APP_CONFIG.design.face.aperture.closed.curve, 100);
    assert.equal(ray.intersectObject(mesh(copy, key), false).length, 0, 'closed aperture is a thin curved slit inside the original ring');
  }
});

test('七种表情锁定外缘；非自然表情改变内部，强度0和reset精确恢复', () => {
  const samples = { leftEye: silhouetteSamples(source, 'leftEye'), rightEye: silhouetteSamples(source, 'rightEye') };
  const names = Object.keys(APP_CONFIG.design.expression.presets);
  assert.deepEqual(names, ['neutral', 'cute', 'happy', 'angry', 'thinking', 'surprised', 'sleepy']);
  for (const preset of names) {
    rig.apply(eyes, nose, motion, 0, { preset, intensity: 1 });
    for (const key of ['leftEye', 'rightEye']) {
      assertSilhouetteUnchanged(key, samples[key]);
      if (preset !== 'neutral') assert.notDeepEqual(positions(copy, key), positions(source, key));
    }
    assert.deepEqual(positions(copy, 'nose'), positions(source, 'nose'));
    rig.apply(eyes, nose, motion, 0, { preset, intensity: 0 });
    for (const key of ['leftEye', 'rightEye']) {
      assert.deepEqual(positions(copy, key), positions(source, key));
      assert.deepEqual(normals(copy, key), normals(source, key));
    }
  }
  rig.apply(eyes, nose, { ...motion, eyesPreset: 'blink' }, 0.5, { preset: 'thinking', intensity: 0.8 });
  rig.reset();
  for (const key of ['leftEye', 'rightEye']) {
    assert.deepEqual(positions(copy, key), positions(source, key));
    assert.deepEqual(normals(copy, key), normals(source, key));
  }
});

test('眼内部表情保留已有UV、几何对象和索引，形体控件仍能显式修改外形', () => {
  const eye = mesh(copy, 'leftEye');
  const geometry = eye.geometry;
  const indices = geometry.index.array.slice();
  const uv = new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2).fill(0.25), 2);
  geometry.setAttribute('uv', uv);
  rig.apply({ ...eyes, width: 1.2, height: 1.1 }, nose, motion, 0, { preset: 'happy', intensity: 1 });
  assert.equal(eye.geometry, geometry);
  assert.equal(eye.geometry.getAttribute('uv'), uv);
  assert.ok(uv.array.every((value) => value === 0.25));
  assert.deepEqual(geometry.index.array, indices);
  const bounds = geometry.boundingBox;
  assert.ok(Math.abs(bounds.max.x - bounds.min.x - 16.1 * 1.2) < 1e-4);
  assert.ok(Math.abs(bounds.max.y - bounds.min.y - 22.5 * 1.1) < 1e-4);
  rig.reset();
  assert.equal(eye.geometry.getAttribute('uv'), uv);
});

test('面部动作端点中性、幅度为零静止且眼鼻动作可同时采样', () => {
  const neutral = sampleFaceMotion(motion, 0, APP_CONFIG);
  for (const eyesPreset of APP_CONFIG.design.motion.eyesPresets) {
    for (const nosePreset of APP_CONFIG.design.motion.nosePresets) {
      const active = { ...motion, eyesPreset, nosePreset };
      assert.deepEqual(sampleFaceMotion(active, 0, APP_CONFIG), neutral);
      assert.deepEqual(sampleFaceMotion(active, 1, APP_CONFIG), neutral);
      for (const progress of [0.125, 0.25, 0.5, 0.875]) {
        const stopped = sampleFaceMotion({ ...active, eyeAmplitude: 0, noseAmplitude: 0 }, progress, APP_CONFIG);
        for (const group of ['eyes', 'nose']) {
          for (const key of Object.keys(neutral[group])) assert.equal(stopped[group][key] || 0, neutral[group][key]);
        }
      }
    }
  }
  const mixed = sampleFaceMotion({ ...motion, eyesPreset: 'lookAround', nosePreset: 'twitch' }, 0.125, APP_CONFIG);
  assert.ok(mixed.eyes.gazeX > 0);
  assert.ok(mixed.eyes.gazeY > 0);
  assert.equal(mixed.nose.tilt, APP_CONFIG.design.face.animation.noseTilt);
  const closed = sampleFaceMotion({ ...motion, eyesPreset: 'blink', nosePreset: 'stretch' }, 0.5, APP_CONFIG);
  assert.equal(closed.eyes.leftOpen, 0);
  assert.equal(closed.eyes.rightOpen, 0);
  assert.equal(closed.nose.width, APP_CONFIG.design.face.animation.noseStretch);
});

test('静态参数叠加动作仍限制在配置范围且极值几何保持有限', () => {
  const limits = APP_CONFIG.design.limits;
  for (const boundary of ['min', 'max']) {
    const eyeEdge = Object.fromEntries(Object.entries(limits.eyes).map(([key, value]) => [key, value[boundary]]));
    const noseEdge = Object.fromEntries(Object.entries(limits.nose).map(([key, value]) => [key, value[boundary]]));
    for (const [eyesPreset, nosePreset, progress] of [['lookAround', 'twitch', 0.125], ['blink', 'stretch', 0.5], ['lookAround', 'twitch', 0.875]]) {
      const effective = rig.apply(eyeEdge, noseEdge, { ...motion, eyesPreset, nosePreset }, progress);
      for (const group of ['eyes', 'nose']) {
        for (const [key, value] of Object.entries(effective[group])) {
          assert.ok(value >= limits[group][key].min && value <= limits[group][key].max);
        }
      }
      for (const key of ['leftEye', 'rightEye', 'nose']) assert.ok(positions(copy, key).every(Number.isFinite));
    }
  }
});

test('调节眼鼻位置大小后仍贴合原头面：独立三角求交复核浮雕高度', () => {
  rig.apply({ ...eyes, width: 1.3, height: 1.2, spacing: 1.15, gazeX: 2.5, offsetY: 2 }, { ...nose, width: 1.8, height: 1.4, tilt: 18, offsetY: -2 }, motion, 0);
  const head = mesh(source, 'head');
  head.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  const depth = (x, y) => {
    ray.ray.origin.set(x, y, 100);
    const hits = ray.intersectObject(head, false);
    assert.ok(hits.length > 0, 'feature must remain over the actual head surface');
    return hits[0].point.z;
  };
  for (const key of ['leftEye', 'rightEye', 'nose']) {
    const original = positions(source, key), changed = positions(copy, key);
    // Sample independent mesh indices including off-center vertices. The actual head
    // ray test does not reuse the rig's sampled attachment grid.
    for (let vertex = 47; vertex < original.length / 3; vertex += 701) {
      const i = vertex * 3;
      const before = original[i + 2] - depth(original[i], original[i + 1]);
      const after = changed[i + 2] - depth(changed[i], changed[i + 1]);
      assert.ok(Math.abs(after - before) < 0.04, `${key} attachment error ${Math.abs(after - before)}`);
    }
  }
});

test('鼻子隆起增加鼻尖高度而鼻根仍嵌入头面，静态GLB导出保持设计结果', async () => {
  rig.apply(eyes, { ...nose, protrusion: 2 }, motion, 0);
  const sourceNose = positions(source, 'nose'), changedNose = positions(copy, 'nose');
  const delta = Array.from({ length: sourceNose.length / 3 }, (_, i) => changedNose[i * 3 + 2] - sourceNose[i * 3 + 2]);
  assert.ok(Math.abs(Math.max(...delta) - 2) < 1e-4);
  assert.ok(Math.min(...delta) <= 0, 'nose root must not translate outward with the tip');
  rig.apply({ ...eyes, leftOpen: 0, gazeX: 1 }, { ...nose, width: 1.5, tilt: 10, protrusion: 1 }, motion, 0);
  const originalHead = positions(source, 'head').slice();
  const originalEye = positions(source, 'leftEye').slice();
  const output = await exportModel(copy);
  const reloaded = await importCandidate(new File([output], 'face-design.glb'), limits);
  objects.push(reloaded.root);
  for (const key of ['leftEye', 'rightEye', 'nose']) assert.deepEqual(positions(reloaded.root, key), positions(copy, key));
  assert.deepEqual(positions(source, 'head'), originalHead);
  assert.deepEqual(positions(source, 'leftEye'), originalEye);
  rig.reset();
});
