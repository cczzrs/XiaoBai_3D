import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test, { before, after } from 'node:test';
import { APP_CONFIG } from '../web/src/config.js';

const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const THREE = await import('three');
const { importCandidate, disposeObjects, exportModel } = await import('../web/src/model-io.js');
const { createMirroredArms, setArmGuides } = await import('../web/src/arm-v59.js');
const rootURL = new URL('../', import.meta.url);
const limits = {
  maxBytes: APP_CONFIG.assets.import.maximumBytes,
  maxVertices: APP_CONFIG.assets.import.maximumVertices,
  maxMeshes: APP_CONFIG.assets.import.maximumMeshes,
  maxExtent: APP_CONFIG.assets.import.maximumExtent,
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hashArray = (array) => sha256(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
const baselineHashes = {
  arm: 'c6d26f71133dfddabfd9128e068e229be6b65c001e9a66ff914532b32e5067ee',
  head: '2fc19d89fc33f57f46ac7fe716f3ae04e1b8a243b502c0cdf625f60ac4648351',
  body: '9a7b08fa9a629f857d26d2fc8c094b95f53e8fbe2c8cf56a4c0ac7e2c529a5b4',
};
// Float32 hashes measured from the approved v59 displayLinePositions, independently
// of the new module. These distinguish v59 guides from its older triangle edges.
const guideBaselines = {
  rings: { count: 201312, hash: '414dd638e589ba68ae7d0121adc6c415e292e5186cab22693e39f98f3f376a7c' },
  straight: { count: 205632, hash: 'e8466646aa8079573c01bf22ea6a54a332589476a5c0fec1f9a4fffc7cad5489' },
  frontDiagonal: { count: 204768, hash: '381b271204eefda7e5de86f35b26685654007825b12f74d0d5e83edf8dfbc89c' },
  backDiagonal: { count: 204768, hash: '5a20c950dd65e296cbd130fc8b1b09697f090df6af6bd949231404e2fb6476fe' },
};
const resources = [];
const originalFileReader = globalThis.FileReader;
let arm;
let head;
let body;
let lines;
let sourceFingerprint;

function meshesOf(root) {
  const meshes = [];
  root.traverse((node) => { if (node.isMesh) meshes.push(node); });
  return meshes;
}

function guidesOf(root) {
  const guides = [];
  root.traverse((node) => { if (node.isLine) guides.push(node); });
  return guides;
}

function fingerprint(root) {
  const nodes = [];
  root.traverse((node) => {
    nodes.push({
      name: node.name,
      position: node.position.toArray(),
      quaternion: node.quaternion.toArray(),
      scale: node.scale.toArray(),
      visible: node.visible,
      userData: structuredClone(node.userData),
      positionHash: node.geometry ? hashArray(node.geometry.attributes.position.array) : null,
      normalHash: node.geometry?.attributes.normal ? hashArray(node.geometry.attributes.normal.array) : null,
      indexHash: node.geometry?.index ? hashArray(node.geometry.index.array) : null,
      material: node.material?.toJSON(),
    });
  });
  return nodes;
}

function materialSignature(material) {
  return { color: material.color.toArray(), roughness: material.roughness, metalness: material.metalness };
}

function draft() {
  const result = createMirroredArms(arm.root, lines, APP_CONFIG);
  resources.push(result);
  result.updateMatrixWorld(true);
  return result;
}

function orderedMeshes(root) {
  root.updateMatrixWorld(true);
  return meshesOf(root).sort((a, b) => new THREE.Box3().setFromObject(a).min.x - new THREE.Box3().setFromObject(b).min.x);
}

function effectivelyVisible(node) {
  for (let current = node; current; current = current.parent) if (!current.visible) return false;
  return true;
}

function assertWorldMirror(left, right) {
  const a = left.geometry.getAttribute('position');
  const b = right.geometry.getAttribute('position');
  assert.equal(a.count, b.count);
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  for (let index = 0; index < a.count; index += 1) {
    v.fromBufferAttribute(a, index).applyMatrix4(left.matrixWorld);
    w.fromBufferAttribute(b, index).applyMatrix4(right.matrixWorld);
    assert.ok(Math.abs(v.x + w.x) < 1e-6 && Math.abs(v.y - w.y) < 1e-6 && Math.abs(v.z - w.z) < 1e-6, `vertex ${index} is not reflected across x=0`);
  }
}

before(async () => {
  const builtin = APP_CONFIG.assets.arms.builtin;
  const files = [builtin.url, APP_CONFIG.assets.head.url, APP_CONFIG.assets.body.url];
  const loaded = await Promise.all(files.map(async (path, index) => {
    const bytes = await readFile(new URL(path, rootURL));
    assert.equal(sha256(bytes), baselineHashes[['arm', 'head', 'body'][index]]);
    const asset = await importCandidate(new File([bytes], ['left-arm.glb', 'head.glb', 'body.glb'][index]), limits);
    resources.push(asset.root);
    return asset;
  }));
  [arm, head, body] = loaded;
  lines = JSON.parse(await readFile(new URL(builtin.linesUrl, rootURL), 'utf8'));
  sourceFingerprint = fingerprint(arm.root);
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

test('v59 设计资源与原批准几何和四类显示线完全一致', () => {
  assert.equal(arm.meshes, 1);
  assert.equal(arm.vertices, 69266);
  assert.equal(arm.triangles, 138528);
  assert.equal(APP_CONFIG.assets.arms.builtin.version, 'v59');
  assert.deepEqual(APP_CONFIG.assets.arms.builtin.projectRecord, { kind: 'builtin', id: 'left-arm-v59-mirrored' });
  assert.ok(Object.isFrozen(APP_CONFIG.assets.arms.builtin));
  assert.ok(Object.isFrozen(APP_CONFIG.design.armGuides.groups));
  assert.deepEqual(Object.keys(lines).sort(), Object.keys(guideBaselines).sort());
  for (const [group, expected] of Object.entries(guideBaselines)) {
    assert.equal(lines[group].length, expected.count, group);
    assert.equal(hashArray(new Float32Array(lines[group])), expected.hash, group);
  }
});

test('设计双臂逐顶点镜像，原坐标及肩内端保留，无额外头身腿', () => {
  const pair = draft();
  assert.equal(pair.userData.designOnly, true);
  assert.equal(pair.userData.sourceVersion, 'v59');
  const meshes = orderedMeshes(pair);
  assert.equal(meshes.length, 2);
  assertWorldMirror(...meshes);
  const [left, right] = meshes;
  const source = meshesOf(arm.root)[0];
  const sourcePosition = source.geometry.getAttribute('position');
  const actualPosition = left.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  const expected = new THREE.Vector3();
  arm.root.updateMatrixWorld(true);
  for (let index = 0; index < actualPosition.count; index += 1) {
    v.fromBufferAttribute(actualPosition, index).applyMatrix4(left.matrixWorld);
    expected.fromBufferAttribute(sourcePosition, index).applyMatrix4(source.matrixWorld);
    assert.ok(v.distanceTo(expected) < 1e-6, `left source vertex ${index} moved`);
  }
  assert.ok(left.matrixWorld.determinant() > 0);
  assert.ok(right.matrixWorld.determinant() < 0);
  const box = new THREE.Box3().setFromObject(left);
  assert.ok(Math.abs(box.max.x - (-8.491738319396973)) < 1e-6);
  const shoulder = new THREE.Vector3(-8.491738319396973, 43.87334060668945, 0);
  assert.ok(new THREE.Box3().setFromObject(body.root).containsPoint(shoulder));
  assert.ok(new THREE.Box3().setFromObject(body.root).containsPoint(shoulder.clone().setX(-shoulder.x)));
  assert.deepEqual(fingerprint(arm.root), sourceFingerprint);
});

test('左右臂材质与批准头身一致，显示与材质切换不能修改源模型', () => {
  const pair = draft();
  const expected = materialSignature(head.root.getObjectByName('Head').material);
  assert.deepEqual(materialSignature(meshesOf(body.root)[0].material), expected);
  for (const mesh of meshesOf(pair)) {
    assert.deepEqual(materialSignature(mesh.material), expected);
    assert.notEqual(mesh.material, meshesOf(arm.root)[0].material);
    mesh.material.color.set('#ff0000');
  }
  setArmGuides(pair, { ...APP_CONFIG.design.armGuides, enabled: true });
  assert.deepEqual(fingerprint(arm.root), sourceFingerprint);
});

test('v59 四类 guide 原坐标和镜像逐点保留，分组开关分别生效', () => {
  const pair = draft();
  const guides = guidesOf(pair);
  assert.equal(guides.length, 8);
  for (const [group, expected] of Object.entries(guideBaselines)) {
    const matching = guides.filter((line) => line.userData.guideGroup === group);
    assert.equal(matching.length, 2, group);
    for (const line of matching) {
      assert.equal(line.userData.displayGuide, true);
      assert.equal(hashArray(line.geometry.attributes.position.array), expected.hash);
    }
    matching.sort((a, b) => a.matrixWorld.determinant() < b.matrixWorld.determinant() ? 1 : -1);
    assertWorldMirror(...matching);
  }
  for (const selected of Object.keys(guideBaselines)) {
    const groups = Object.fromEntries(Object.keys(guideBaselines).map((name) => [name, name === selected]));
    setArmGuides(pair, { ...APP_CONFIG.design.armGuides, enabled: true, groups });
    for (const line of guides) assert.equal(effectivelyVisible(line), line.userData.guideGroup === selected);
  }
  setArmGuides(pair, { ...APP_CONFIG.design.armGuides, enabled: false });
  assert.ok(guides.every((line) => !effectivelyVisible(line)));
  assert.deepEqual(fingerprint(arm.root), sourceFingerprint);
});

test('组合导出过滤显示线，GLB 重载保留双臂三角面及镜像，预览不受导出影响', async () => {
  const pair = draft();
  setArmGuides(pair, {
    ...APP_CONFIG.design.armGuides,
    enabled: true,
    groups: Object.fromEntries(Object.keys(guideBaselines).map((name) => [name, true])),
  });
  const beforeExport = fingerprint(pair);
  const output = await exportModel(pair);
  const description = JSON.parse(new TextDecoder().decode(new Uint8Array(output, 20, new DataView(output).getUint32(12, true))));
  for (const mesh of description.meshes) {
    for (const primitive of mesh.primitives) assert.equal(primitive.mode ?? 4, 4, 'guides must not enter the GLB');
  }
  assert.ok(description.nodes.some((node) => node.scale?.[0] === -1), 'the x reflection must survive export');
  assert.ok(description.nodes.every((node) => !node.extras?.displayGuide));
  const reloaded = await importCandidate(new File([output], 'mirrored-v59.glb'), limits);
  resources.push(reloaded.root);
  assert.equal(reloaded.meshes, 2);
  assert.equal(reloaded.vertices, arm.vertices * 2);
  assert.equal(reloaded.triangles, arm.triangles * 2);
  assert.equal(guidesOf(reloaded.root).length, 0);
  assertWorldMirror(...orderedMeshes(reloaded.root));
  assert.deepEqual(fingerprint(pair), beforeExport);
  assert.deepEqual(fingerprint(arm.root), sourceFingerprint);
});
