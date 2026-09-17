import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test, { before, after } from 'node:test';
import { APP_CONFIG } from '../src/config.js';

// The browser import map points at the same vendored copy. No npm dependency is needed.
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three' ? new URL('../vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const { importCandidate, clonePart, disposeObjects, exportModel } = await import('../src/model-io.js');
const limits = {
  maxBytes: APP_CONFIG.assets.import.maximumBytes,
  maxVertices: APP_CONFIG.assets.import.maximumVertices,
  maxMeshes: APP_CONFIG.assets.import.maximumMeshes,
  maxExtent: APP_CONFIG.assets.import.maximumExtent,
};
const resources = [];
let head;
let body;
const originalFileReader = globalThis.FileReader;

function meshesOf(root) {
  const meshes = [];
  root.traverse((object) => { if (object.isMesh) meshes.push(object); });
  return meshes;
}

function meshFingerprints(root) {
  const hash = (array) => createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
  return meshesOf(root).map((mesh) => ({
    positions: hash(mesh.geometry.attributes.position.array),
    normals: hash(mesh.geometry.attributes.normal.array),
    indices: mesh.geometry.index ? hash(mesh.geometry.index.array) : null,
    material: mesh.material.toJSON(),
  }));
}

function glbDescription(buffer) {
  const view = new DataView(buffer);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, view.getUint32(12, true))));
}

function glbWithDescription(description) {
  const json = Buffer.from(JSON.stringify(description));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const buffer = Buffer.alloc(20 + jsonLength, ' ');
  buffer.writeUInt32LE(0x46546c67, 0);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(jsonLength, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  json.copy(buffer, 20);
  return buffer;
}

before(async () => {
  // Only the two approved XiaoBai assets are read from disk. Triangle strings below are
  // tiny parser fixtures, never substitute XiaoBai geometry or saved project assets.
  head = await importCandidate(new File([await readFile(new URL('../assets/approved/head-v1/xiaobai-head.glb', import.meta.url))], 'head.glb'), limits);
  body = await importCandidate(new File([await readFile(new URL('../assets/approved/body-v7/xiaobai-torso.glb', import.meta.url))], 'body.glb'), limits);
  resources.push(head.root, body.root);
  // GLTFExporter uses this browser API to read its resulting Blob.
  globalThis.FileReader = class {
    async readAsArrayBuffer(blob) {
      this.result = await blob.arrayBuffer();
      this.onloadend?.();
    }
  };
});

after(() => {
  disposeObjects(resources);
  if (originalFileReader === undefined) delete globalThis.FileReader;
  else globalThis.FileReader = originalFileReader;
  resolver.deregister();
});

test('批准 GLB 读取为原始四个头部网格和一个身体网格', () => {
  assert.equal(head.meshes, 4);
  assert.equal(head.vertices, 92836);
  assert.equal(head.triangles, 185664);
  assert.equal(body.meshes, 1);
  assert.equal(body.vertices, 36674);
  assert.equal(body.triangles, 73344);
  assert.ok(Math.abs(head.bounds.min[1] - 41.8) < 1e-5);
  assert.ok(Math.abs(head.bounds.max[1] - 98.4) < 1e-5);
  assert.ok(Math.abs(body.bounds.min[1] - 16.4499263763) < 1e-5);
  assert.equal(body.bounds.max[1], 56);
});

test('显示副本的线框材质不改变批准模型的材质和几何', () => {
  const before = meshFingerprints(head.root);
  const copy = clonePart(head.root);
  resources.push(copy);
  const originals = meshesOf(head.root);
  meshesOf(copy).forEach((mesh, index) => {
    assert.notEqual(mesh.material, originals[index].material);
    assert.equal(mesh.geometry, originals[index].geometry);
    mesh.material.wireframe = true;
    assert.equal(originals[index].material.wireframe, false);
  });
  assert.deepEqual(meshFingerprints(head.root), before);
});

test('单文件 OBJ 能导入三角面并在缺少法线时补齐法线', async () => {
  const result = await importCandidate(new File(['v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n'], 'parser-fixture.obj'), limits);
  resources.push(result.root);
  assert.equal(result.meshes, 1);
  assert.equal(result.vertices, 3);
  assert.equal(result.triangles, 1);
  assert.deepEqual(result.bounds, { min: [0, 0, 0], max: [2, 2, 0] });
  assert.equal(meshesOf(result.root)[0].geometry.attributes.normal.count, 3);
});

test('拒绝损坏、非有限数值、超限、外部资源和非静态候选文件', async () => {
  await assert.rejects(importCandidate(new File(['bad glb'], 'bad.glb'), limits), /GLB/);
  await assert.rejects(importCandidate(new File(['v NaN 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3'], 'bad.obj'), limits), /无效数值/);
  await assert.rejects(importCandidate(new File(['v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3'], 'large.obj'), { ...limits, maxBytes: 1 }), /上限/);
  const external = glbWithDescription({ asset: { version: '2.0' }, buffers: [{ byteLength: 10, uri: 'https://invalid.example/forbidden.bin' }] });
  await assert.rejects(importCandidate(new File([external], 'external.glb'), limits), /外部文件引用/);
  const rigged = glbWithDescription({ asset: { version: '2.0' }, skins: [{}] });
  await assert.rejects(importCandidate(new File([rigged], 'rigged.glb'), limits), /静态模型/);
  const huge = glbWithDescription({ asset: { version: '2.0' }, accessors: [{ count: 2 ** 40 }] });
  await assert.rejects(importCandidate(new File([huge], 'huge.glb'), limits), /导入上限/);
});

test('线框预览导出仍为三角面 GLB，重载保持顶点、边界且不改源模型', async () => {
  const sourceBefore = meshFingerprints(head.root);
  const preview = clonePart(head.root);
  resources.push(preview);
  meshesOf(preview).forEach((mesh) => { mesh.material.wireframe = true; });
  const previewBefore = meshFingerprints(preview);
  const warnings = [];
  const originalWarn = console.warn;
  let output;
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    output = await exportModel(preview);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(output instanceof ArrayBuffer);
  assert.deepEqual(warnings, []);
  const exported = glbDescription(output);
  for (const mesh of exported.meshes) {
    for (const primitive of mesh.primitives) assert.equal(primitive.mode ?? 4, 4, 'display wireframe must never become GLTF line primitives');
  }
  const reloaded = await importCandidate(new File([output], 'roundtrip.glb'), limits);
  resources.push(reloaded.root);
  assert.equal(reloaded.meshes, head.meshes);
  assert.equal(reloaded.vertices, head.vertices);
  assert.equal(reloaded.triangles, head.triangles);
  assert.deepEqual(reloaded.bounds, head.bounds);
  assert.deepEqual(meshFingerprints(head.root), sourceBefore);
  assert.deepEqual(meshFingerprints(preview), previewBefore);
});
