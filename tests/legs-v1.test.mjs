import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test, { after, before } from 'node:test';
import { APP_CONFIG } from '../web/src/config.js';

const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const THREE = await import('three');
const { createLegGeometry, createLegsDraft } = await import('../web/src/leg-geometry.js');
const { importCandidate, exportModel, describeObject, disposeObjects } = await import('../web/src/model-io.js');
const resources = [];
const originalFileReader = globalThis.FileReader;
const limits = {
  maxBytes: APP_CONFIG.assets.import.maximumBytes,
  maxVertices: APP_CONFIG.assets.import.maximumVertices,
  maxMeshes: APP_CONFIG.assets.import.maximumMeshes,
  maxExtent: APP_CONFIG.assets.import.maximumExtent,
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hashAttribute = (attribute) => sha256(new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
const near = (actual, expected, tolerance = 0.01, label = 'value') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected} (tolerance ${tolerance})`);

function meshesOf(root) {
  const meshes = [];
  root.traverse((node) => { if (node.isMesh) meshes.push(node); });
  return meshes;
}

function draft() {
  const root = createLegsDraft(APP_CONFIG);
  root.updateMatrixWorld(true);
  resources.push(root);
  return root;
}

function orderedMeshes(root) {
  root.updateMatrixWorld(true);
  return meshesOf(root).sort((a, b) => new THREE.Box3().setFromObject(a).min.x - new THREE.Box3().setFromObject(b).min.x);
}

function fingerprint(root) {
  root.updateMatrixWorld(true);
  return meshesOf(root).map((mesh) => ({
    positions: hashAttribute(mesh.geometry.attributes.position),
    normals: hashAttribute(mesh.geometry.attributes.normal),
    indices: hashAttribute(mesh.geometry.index),
    transform: mesh.matrixWorld.toArray(),
    color: mesh.material.color.toArray(),
    roughness: mesh.material.roughness,
    metalness: mesh.material.metalness,
  }));
}

// Independent triangle/edge audit: topology is evaluated from the final mesh,
// rather than assuming that a row-based construction is watertight or outward.
function auditClosedGeometry(geometry) {
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const indices = geometry.index;
  assert.ok(indices && indices.count % 3 === 0);
  assert.equal(positions.count, normals.count);
  for (let i = 0; i < positions.count; i += 1) {
    const coordinates = [positions.getX(i), positions.getY(i), positions.getZ(i)];
    assert.ok(coordinates.every(Number.isFinite), `nonfinite vertex ${i}`);
    const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
    assert.ok(normal.toArray().every(Number.isFinite), `nonfinite normal ${i}`);
    near(normal.length(), 1, 2e-5, `normal ${i} length`);
  }
  const edges = new Map();
  const used = new Set();
  const adjacency = Array.from({ length: positions.count }, () => []);
  let volume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const vertexNormal = new THREE.Vector3();
  for (let i = 0; i < indices.count; i += 3) {
    const triangle = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
    assert.equal(new Set(triangle).size, 3, `repeated vertex in triangle ${i / 3}`);
    for (const index of triangle) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < positions.count, `invalid index ${index}`);
      used.add(index);
    }
    a.fromBufferAttribute(positions, triangle[0]);
    b.fromBufferAttribute(positions, triangle[1]);
    c.fromBufferAttribute(positions, triangle[2]);
    faceNormal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    assert.ok(faceNormal.lengthSq() > 1e-14, `degenerate triangle ${i / 3}`);
    for (const index of triangle) {
      vertexNormal.fromBufferAttribute(normals, index);
      assert.ok(faceNormal.dot(vertexNormal) > 0, `normal opposes winding at triangle ${i / 3}, vertex ${index}`);
    }
    volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
    for (let edge = 0; edge < 3; edge += 1) {
      const from = triangle[edge];
      const to = triangle[(edge + 1) % 3];
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const value = edges.get(key) ?? { count: 0, direction: 0 };
      value.count += 1;
      value.direction += from < to ? 1 : -1;
      edges.set(key, value);
      adjacency[from].push(to);
      adjacency[to].push(from);
    }
  }
  for (const [key, value] of edges) {
    assert.equal(value.count, 2, `nonmanifold or boundary edge ${key}`);
    assert.equal(value.direction, 0, `inconsistent winding on edge ${key}`);
  }
  assert.equal(used.size, positions.count, 'unused vertices');
  const visited = new Set([0]);
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const next of adjacency[queue[cursor]]) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  assert.equal(visited.size, positions.count, 'leg and foot must form one connected surface');
  assert.equal(positions.count - edges.size + indices.count / 3, 2, 'closed leg surface must have sphere topology');
  assert.ok(volume > 0, `signed volume must be positive for outward winding, received ${volume}`);
}

function assertMirrored(root) {
  const [left, right] = orderedMeshes(root);
  assert.equal(meshesOf(root).length, 2);
  assert.ok(left.matrixWorld.determinant() < 0);
  assert.ok(right.matrixWorld.determinant() > 0);
  const a = left.geometry.attributes.position;
  const b = right.geometry.attributes.position;
  assert.equal(a.count, b.count);
  const first = new THREE.Vector3();
  const second = new THREE.Vector3();
  for (let i = 0; i < a.count; i += 1) {
    first.fromBufferAttribute(a, i).applyMatrix4(left.matrixWorld);
    second.fromBufferAttribute(b, i).applyMatrix4(right.matrixWorld);
    near(first.x, -second.x, 1e-6, `mirror x ${i}`);
    near(first.y, second.y, 1e-6, `mirror y ${i}`);
    near(first.z, second.z, 1e-6, `mirror z ${i}`);
  }
}

before(() => {
  globalThis.FileReader = class {
    async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  };
});

after(() => {
  disposeObjects(resources);
  if (originalFileReader === undefined) delete globalThis.FileReader;
  else globalThis.FileReader = originalFileReader;
  resolver.deregister();
});

test('legs-v1 单腿为有限、闭合、连通且朝外的非退化三角曲面', () => {
  const geometry = createLegGeometry(APP_CONFIG.design.legs);
  try { auditClosedGeometry(geometry); } finally { geometry.dispose(); }
});

test('腿脚保持待批准设计状态，双腿逐点镜像并使用独立几何和材质', () => {
  const root = draft();
  assert.equal(root.userData.designOnly, true);
  assert.equal(root.userData.approval, 'pending');
  assert.equal(root.userData.version, 'legs-v1');
  assert.equal(APP_CONFIG.assets.legs.approved, false);
  assert.equal(APP_CONFIG.assets.legs.versions['legs-reference-v1-mirrored'].approved, false);
  assert.ok(Object.isFrozen(APP_CONFIG.design.legs));
  assert.ok(Object.isFrozen(APP_CONFIG.design.legs.sampling));
  assertMirrored(root);
  const [left, right] = orderedMeshes(root);
  assert.notEqual(left.geometry, right.geometry);
  assert.notEqual(left.material, right.material);
  for (const mesh of [left, right]) {
    assert.equal(mesh.userData.approval, 'pending');
    assert.equal(mesh.userData.designOnly, true);
    assert.equal(mesh.isSkinnedMesh, undefined);
    assert.equal(mesh.material.color.getHexString(), 'fff1d9');
    near(mesh.material.roughness, 0.7, 1e-8);
  }
});

test('模型落在 y=0，成对尺寸及单脚外包络符合本候选尺寸', () => {
  const root = draft();
  const bounds = describeObject(root).bounds;
  for (let axis = 0; axis < 3; axis += 1) {
    near(bounds.min[axis], [-27.35, 0, -7.5][axis], 0.01, `bounds min ${axis}`);
    near(bounds.max[axis], [27.35, 30, 15.5][axis], 0.01, `bounds max ${axis}`);
  }
  const right = orderedMeshes(root)[1];
  const positions = right.geometry.attributes.position;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let floorVertices = 0;
  const includeFootPoint = (x, z) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  };
  for (let i = 0; i < positions.count; i += 1) {
    const y = positions.getY(i);
    assert.ok(y >= 0, `vertex ${i} below floor`);
    if (y === 0) floorVertices += 1;
    if (y <= 15.8) includeFootPoint(positions.getX(i), positions.getZ(i));
  }
  // The foot-height plane need not coincide with a sampled row. Include actual
  // triangle/plane intersections, so changing ring count cannot bias the width.
  const indices = right.geometry.index;
  for (let i = 0; i < indices.count; i += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = indices.getX(i + edge);
      const b = indices.getX(i + (edge + 1) % 3);
      const ay = positions.getY(a);
      const by = positions.getY(b);
      if ((ay < 15.8 && by > 15.8) || (by < 15.8 && ay > 15.8)) {
        const fraction = (15.8 - ay) / (by - ay);
        includeFootPoint(
          THREE.MathUtils.lerp(positions.getX(a), positions.getX(b), fraction),
          THREE.MathUtils.lerp(positions.getZ(a), positions.getZ(b), fraction),
        );
      }
    }
  }
  assert.ok(floorVertices > 0, 'sole must touch floor');
  near(maxX - minX, 22.7, 0.01, 'single foot width');
  near(maxZ - minZ, 23, 0.01, 'single foot depth');
});

test('实际 legs.glb 与生成几何一致，导出重载保留曲面、法线、镜像和待批准状态', async () => {
  const root = draft();
  const expected = fingerprint(root);
  const diskBytes = await readFile(new URL('../assets/design/legs-v1/legs.glb', import.meta.url));
  const provenance = JSON.parse(await readFile(new URL('../assets/design/legs-v1/provenance.json', import.meta.url), 'utf8'));
  assert.equal(diskBytes.length, provenance.bytes);
  assert.equal(sha256(diskBytes), provenance.sha256);
  assert.equal(provenance.approval, 'pending');
  for (const [name, bytes] of [['legs.glb', diskBytes], ['legs-roundtrip.glb', await exportModel(root)]]) {
    const imported = await importCandidate(new File([bytes], name), limits);
    resources.push(imported.root);
    assert.equal(imported.meshes, 2);
    assertMirrored(imported.root);
    assert.deepEqual(fingerprint(imported.root), expected, `${name}: GLB roundtrip changed geometry, normals, transform or material`);
    for (const mesh of meshesOf(imported.root)) auditClosedGeometry(mesh.geometry);
    for (const mesh of meshesOf(imported.root)) assert.equal(mesh.userData.approval, 'pending');
  }
  assert.deepEqual(fingerprint(root), expected, 'export mutated design geometry');
});

test('本次腿部工作未更改已批准头身和 v59 臂部资源', async () => {
  // Fixed hashes captured before leg work; keep this independent of the new
  // approval record or generator. Finder's .DS_Store is excluded from the repo test.
  const locked = {
    'assets/approved/body-v7/APPROVAL.json': [7086, '7c1f4146bcaaa2ea411527bd4a3d8745eedd298f16f8e7d9405e5ba6934aea30'],
    'assets/approved/body-v7/xiaobai-torso.glb': [1322824, '9a7b08fa9a629f857d26d2fc8c094b95f53e8fbe2c8cf56a4c0ac7e2c529a5b4'],
    'assets/approved/head-v1/APPROVAL.json': [2140, 'ab29e766d9bb084108a6412c52e40e1197e7ff0070c086de909a845f4f001722'],
    'assets/approved/head-v1/xiaobai-head.glb': [4227680, '2fc19d89fc33f57f46ac7fe716f3ae04e1b8a243b502c0cdf625f60ac4648351'],
    'assets/design/arms-v59/SOURCE-APPROVAL.md': [536, '0194a9b6c01fc4be6c92edaf6da7416caaa9385bf8e0f97ba5c5cef909770146'],
    'assets/design/arms-v59/display-lines.json': [15318752, '92bc26b0692742e7c1dacc9baf34e485ca0267c8ee98bce6106b286d5f29717e'],
    'assets/design/arms-v59/left-arm.glb': [3326332, 'c6d26f71133dfddabfd9128e068e229be6b65c001e9a66ff914532b32e5067ee'],
    'assets/design/arms-v59/provenance.json': [1024, '0421681cccd824e24c60261a1811db3d6decd8c505595f9c1e7c364b6a9c6eeb'],
  };
  for (const [path, [size, hash]] of Object.entries(locked)) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(bytes.length, size, `${path}: size changed`);
    assert.equal(sha256(bytes), hash, `${path}: content changed`);
  }
});
