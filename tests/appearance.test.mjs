import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { APP_CONFIG } from '../web/src/config.js';

const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const THREE = await import('three');
const { createProjectedUV, backgroundImageRect, createAppearanceController, createStudioLighting } = await import('../web/src/appearance.js');
after(() => resolver.deregister());

function fixture(decode = async (record) => ({ naturalWidth: record.width, naturalHeight: record.height }), viewport = () => ({ width: 640, height: 480 })) {
  const released = [];
  const scene = new THREE.Scene();
  const renderer = { capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 4 } };
  const controller = createAppearanceController({ scene, renderer, config: APP_CONFIG, viewport, onLighting() {}, decode, release: (image) => released.push(image) });
  const source = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(4, 2);
  geometry.deleteAttribute('uv');
  const original = new THREE.MeshStandardMaterial({ color: '#ad9174', roughness: 0.73 });
  const mesh = new THREE.Mesh(geometry, original);
  mesh.name = 'Head';
  source.add(mesh);
  const copy = source.clone(true);
  copy.children[0].material = original.clone();
  controller.register(copy, source, 'head', 'glb');
  const draft = copy.children[0];
  return { scene, renderer, controller, source, geometry, original, copy, draft, released };
}
const state = () => structuredClone(APP_CONFIG.appearance.defaults);
const image = (name = 'test') => ({ name: `${name}.png`, mime: 'image/png', data: name, width: 80, height: 80 });

// Orthogonal geometry checks give a meaningful oracle for preserving texture proportions.
test('无 UV 模型生成原始坐标 XY 贴图，等比例 cover 裁切不拉伸', () => {
  const geometry = new THREE.PlaneGeometry(4, 2);
  const uv = createProjectedUV(geometry.getAttribute('position'), 100, 100);
  assert.equal(uv.getX(0), 0);
  assert.equal(uv.getX(1), 1);
  assert.equal(uv.getY(0), 0.75);
  assert.equal(uv.getY(2), 0.25);
  const wide = createProjectedUV(geometry.getAttribute('position'), 400, 100);
  assert.equal(wide.getX(0), 0.25);
  assert.equal(wide.getX(1), 0.75);
  assert.equal(wide.getY(0), 1);
  assert.equal(wide.getY(2), 0);
});

test('背景 cover 和 contain 均保留图像比例与中心对齐', () => {
  assert.deepEqual(backgroundImageRect(200, 100, 300, 300, 'cover'), { x: -150, y: 0, width: 600, height: 300 });
  assert.deepEqual(backgroundImageRect(200, 100, 300, 300, 'contain'), { x: 0, y: 75, width: 300, height: 150 });
});

test('材质与 UV 仅修改副本；关闭自定义准确恢复原始颜色和粗糙度', async () => {
  const f = fixture();
  assert.notEqual(f.draft.geometry, f.geometry);
  assert.equal(f.geometry.hasAttribute('uv'), false);
  const positions = f.geometry.getAttribute('position').array.slice();
  const next = state();
  next.materials.head = { enabled: true, color: '#09bca4', roughness: 0.25, image: null };
  const prepared = await f.controller.prepare(next);
  assert.equal(f.draft.material.color.getHexString(), 'ad9174');
  f.controller.commit(prepared);
  assert.equal(f.draft.material.color.getHexString(), '09bca4');
  assert.equal(f.draft.material.roughness, 0.25);
  assert.equal(f.original.color.getHexString(), 'ad9174');
  f.controller.commit(await f.controller.prepare(state()));
  assert.equal(f.draft.material.color.getHexString(), 'ad9174');
  assert.equal(f.draft.material.roughness, 0.73);
  assert.deepEqual(f.geometry.getAttribute('position').array, positions);
  f.controller.dispose();
});

test('图像准备失败保持当前颜色、贴图和背景；释放失败事务已解码资源', async () => {
  const f = fixture(async (record) => {
    if (record.data === 'broken') throw new Error('decode failed');
    return { naturalWidth: record.width, naturalHeight: record.height, id: record.data };
  });
  const next = state();
  next.materials.head = { enabled: true, color: '#ffffff', roughness: 0.4, image: image('original') };
  f.controller.commit(await f.controller.prepare(next));
  const texture = f.draft.material.map;
  const background = f.scene.background;
  const bad = state();
  bad.materials.head = { enabled: true, color: '#ff0000', roughness: 0.2, image: image('temporary') };
  bad.materials.body.image = image('broken');
  await assert.rejects(f.controller.prepare(bad), /decode failed/);
  assert.equal(f.draft.material.map, texture);
  assert.equal(f.draft.material.color.getHexString(), 'ffffff');
  assert.equal(f.scene.background, background);
  assert.deepEqual(f.released.map((entry) => entry.id), ['temporary']);
  f.controller.dispose();
  assert.deepEqual(f.released.map((entry) => entry.id), ['temporary', 'original']);
});

test('重复使用同一贴图不重解码；取消准备和部件替换不会提前释放当前贴图', async () => {
  let count = 0;
  const f = fixture(async (record) => { count += 1; return { naturalWidth: record.width, naturalHeight: record.height }; });
  const next = state();
  next.materials.head = { enabled: true, color: '#ffffff', roughness: 0.4, image: image() };
  f.controller.commit(await f.controller.prepare(next));
  const texture = f.draft.material.map;
  let disposals = 0;
  texture.addEventListener('dispose', () => { disposals += 1; });
  const cancelled = await f.controller.prepare(next);
  cancelled.dispose();
  assert.equal(disposals, 0);
  next.materials.head.color = '#ffaa00';
  f.controller.commit(await f.controller.prepare(next));
  assert.equal(f.draft.material.map, texture);
  assert.equal(count, 1);
  f.controller.unregister(f.copy);
  assert.equal(disposals, 0);
  assert.equal(f.draft.material.color.getHexString(), 'ad9174');
  f.controller.dispose();
  assert.equal(disposals, 1);
});

test('已有 UV 保留原坐标；GLB 原生 UV 使用 glTF 图像方向', async () => {
  const f = fixture();
  f.controller.unregister(f.copy);
  const source = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshStandardMaterial());
  const copy = source.clone();
  copy.material = source.material.clone();
  const uv = source.geometry.getAttribute('uv').array.slice();
  f.controller.register(copy, source, 'arms', 'glb');
  const next = state();
  next.materials.arms = { enabled: true, color: '#ffffff', roughness: 0.4, image: image() };
  f.controller.commit(await f.controller.prepare(next));
  assert.equal(copy.material.map.flipY, false);
  assert.deepEqual(source.geometry.getAttribute('uv').array, uv);
  f.controller.dispose();
});

test('柔光模式与均匀光互斥，9 束主光总强度正确，灯架跟随相机并支持曝光', () => {
  const scene = new THREE.Scene();
  const renderer = {};
  const lighting = createStudioLighting(scene, renderer, APP_CONFIG);
  const uniform = scene.getObjectByName('XiaoBai_UniformLight');
  const rig = scene.getObjectByName('XiaoBai_CameraLightRig');
  const group = scene.getObjectByName('XiaoBai_SoftLightGroup');
  assert.equal(uniform.visible, true);
  assert.equal(group.visible, false);
  lighting.setState({ enabled: true, intensity: 7, azimuth: 0, elevation: 0, exposure: 1.75 });
  assert.equal(uniform.visible, false);
  assert.equal(group.visible, true);
  const keys = group.children.filter((entry) => entry.name.startsWith('XiaoBai_key_'));
  assert.equal(keys.length, 9);
  assert.ok(Math.abs(keys.reduce((sum, light) => sum + light.intensity, 0) - 7) < 1e-12);
  assert.equal(group.children.filter((entry) => entry.isDirectionalLight).length, 11);
  assert.equal(keys.find((entry) => entry.name === 'XiaoBai_key_0_0').position.z, APP_CONFIG.viewer.lighting.directional.distance);
  assert.equal(renderer.toneMappingExposure, 1.75);
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.set(0, 0.7, 0);
  const target = new THREE.Vector3(0, 54, 0);
  lighting.update(camera, target);
  assert.ok(rig.quaternion.equals(camera.quaternion));
  assert.ok(rig.position.equals(target));
  lighting.dispose();
});


test('批准头部的眼鼻添加皮肤 UV 后，眨眼仍写入当前几何，批准源保持原样', async () => {
  const { importCandidate, clonePart, disposeObjects } = await import('../web/src/model-io.js');
  const { createFaceRig } = await import('../web/src/face-rig.js');
  const limits = APP_CONFIG.assets.import;
  const loaded = await importCandidate(new File([await readFile(new URL('../assets/approved/head-v1/xiaobai-head.glb', import.meta.url))], 'head.glb'), {
    maxBytes: limits.maximumBytes, maxVertices: limits.maximumVertices, maxMeshes: limits.maximumMeshes, maxExtent: limits.maximumExtent,
  });
  const source = loaded.root;
  const copy = clonePart(source);
  const rig = createFaceRig(copy, APP_CONFIG);
  const eye = copy.getObjectByName(APP_CONFIG.design.face.nodes.leftEye);
  const rigGeometry = eye.geometry;
  const original = source.getObjectByName(APP_CONFIG.design.face.nodes.leftEye).geometry;
  const originalPositions = original.getAttribute('position').array.slice();
  const f = fixture();
  f.controller.register(copy, source, 'head', 'glb');
  const next = state();
  next.materials.eyes = { enabled: true, color: '#ffffff', roughness: 0.4, image: image() };
  f.controller.commit(await f.controller.prepare(next));
  assert.equal(eye.geometry, rigGeometry);
  rig.apply(APP_CONFIG.design.defaults.eyes, APP_CONFIG.design.defaults.nose, { ...APP_CONFIG.design.motion.defaults, eyesPreset: 'winkLeft' }, 0.5);
  assert.notDeepEqual(eye.geometry.getAttribute('position').array, originalPositions);
  assert.deepEqual(original.getAttribute('position').array, originalPositions);
  assert.equal(original.hasAttribute('uv'), false);
  assert.equal(eye.geometry.hasAttribute('uv'), true);
  f.controller.dispose();
  disposeObjects([source, copy]);
});


test('背景尺寸变化重新分配纹理并释放旧纹理，提交前复核视口，contain 留白保持居中', async () => {
  const previousDocument = globalThis.document;
  const canvases = [];
  globalThis.document = { createElement(tag) {
    assert.equal(tag, 'canvas');
    const drawing = [];
    const context = { fillRect: (...args) => drawing.push(['fill', ...args]), drawImage: (_image, ...args) => drawing.push(['image', ...args]) };
    const canvas = { width: 0, height: 0, drawing, getContext: () => context };
    canvases.push(canvas);
    return canvas;
  } };
  let dimensions = { width: 640, height: 384 };
  const f = fixture(undefined, () => dimensions);
  try {
    const next = state();
    next.background = { color: '#aa3311', image: { ...image(), width: 320, height: 160 }, fit: 'contain' };
    const prepared = await f.controller.prepare(next);
    const beforeCommit = prepared.background.texture;
    let beforeDisposals = 0;
    beforeCommit.addEventListener('dispose', () => { beforeDisposals += 1; });
    dimensions = { width: 640, height: 344 };
    f.controller.commit(prepared);
    assert.notEqual(f.scene.background, beforeCommit);
    assert.equal(beforeDisposals, 1);
    const firstActive = f.scene.background;
    assert.deepEqual(firstActive.image.drawing.at(-1), ['image', 0, 12, 640, 320]);
    let activeDisposals = 0;
    firstActive.addEventListener('dispose', () => { activeDisposals += 1; });
    dimensions = { width: 800, height: 500 };
    f.controller.resize();
    assert.notEqual(f.scene.background, firstActive);
    assert.notEqual(f.scene.background.image, firstActive.image);
    assert.equal(activeDisposals, 1);
    assert.equal(f.scene.background.image.width, 800);
    assert.equal(f.scene.background.image.height, 500);
    assert.deepEqual(f.scene.background.image.drawing, [['fill', 0, 0, 800, 500], ['image', 0, 50, 800, 400]]);
    const unchanged = f.scene.background;
    f.controller.resize();
    assert.equal(f.scene.background, unchanged);
    assert.equal(canvases.length, 3);
    assert.equal(unchanged.colorSpace, THREE.SRGBColorSpace);
  } finally {
    f.controller.dispose();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
