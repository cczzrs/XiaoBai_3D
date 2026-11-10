import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test, { before, after } from 'node:test';
import { APP_CONFIG } from '../web/src/config.js';

const resolver = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : specifier, context);
} });
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { clonePart, disposeObjects, exportModel } = await import('../web/src/model-io.js');
const { createMirroredArms } = await import('../web/src/arm-v59.js');
const { createLimbRig } = await import('../web/src/limb-rig.js');
const rootURL = new URL('../', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashAttribute = attribute => sha256(new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
const originalFileReader = globalThis.FileReader;
const sources = {};
const initialSources = {};
const fixtures = [];
let lines;

function meshesOf(root) {
  const meshes = [];
  root.traverse(node => { if (node.isMesh) meshes.push(node); });
  return meshes;
}
function bonesOf(root) {
  const bones = [];
  root.traverse(node => { if (node.isBone) bones.push(node); });
  return bones;
}
function materialSignature(mesh) {
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => ({
    type: material.type, color: material.color.toArray(), roughness: material.roughness, metalness: material.metalness,
    emissive: material.emissive.toArray(), opacity: material.opacity, transparent: material.transparent,
    alphaTest: material.alphaTest, side: material.side,
    maps: ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'].map(key => [key, Boolean(material[key])]),
  }));
}
function fingerprint(root) {
  root.updateMatrixWorld(true);
  return meshesOf(root).map(mesh => ({
    name: mesh.name, position: hashAttribute(mesh.geometry.attributes.position), normal: hashAttribute(mesh.geometry.attributes.normal),
    indices: hashAttribute(mesh.geometry.index), transform: mesh.matrixWorld.toArray(), material: materialSignature(mesh),
  }));
}
function meshKey(mesh) { return `${mesh.name}:${Math.sign(mesh.matrixWorld.determinant())}`; }
function plainMeshData(mesh) {
  return {
    position: hashAttribute(mesh.geometry.attributes.position), normal: hashAttribute(mesh.geometry.attributes.normal),
    indices: hashAttribute(mesh.geometry.index), material: materialSignature(mesh),
  };
}

// Independent CPU skin evaluation, including inverse-transpose object normals and
// mirrored mesh transforms. It does not call the rig's weight/pose implementation.
function worldData(mesh, includeNormals = true) {
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.attributes.position;
  const normal = mesh.geometry.attributes.normal;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const worldPositions = new Float64Array(position.count * 3);
  const worldNormals = includeNormals ? new Float64Array(position.count * 3) : null;
  const skin = mesh.isSkinnedMesh ? mesh.skeleton.bones.map((bone, i) => new THREE.Matrix4()
    .multiplyMatrices(mesh.bindMatrixInverse, bone.matrixWorld)
    .multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix).elements) : null;
  const weights = mesh.geometry.attributes.skinWeight;
  const joints = mesh.geometry.attributes.skinIndex;
  const point = new THREE.Vector3();
  const direction = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
    const nx = normal.getX(index), ny = normal.getY(index), nz = normal.getZ(index);
    if (skin) {
      point.set(0, 0, 0); direction.set(0, 0, 0);
      for (let channel = 0; channel < 4; channel += 1) {
        const weight = weights.array[index * 4 + channel];
        if (weight === 0) continue;
        const matrix = skin[joints.array[index * 4 + channel]];
        point.x += weight * (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]);
        point.y += weight * (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]);
        point.z += weight * (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);
        if (includeNormals) {
          direction.x += weight * (matrix[0] * nx + matrix[4] * ny + matrix[8] * nz);
          direction.y += weight * (matrix[1] * nx + matrix[5] * ny + matrix[9] * nz);
          direction.z += weight * (matrix[2] * nx + matrix[6] * ny + matrix[10] * nz);
        }
      }
    } else { point.set(x, y, z); direction.set(nx, ny, nz); }
    point.applyMatrix4(mesh.matrixWorld).toArray(worldPositions, index * 3);
    if (includeNormals) direction.applyMatrix3(normalMatrix).normalize().toArray(worldNormals, index * 3);
  }
  return { positions: worldPositions, normals: worldNormals };
}
function maxDifference(actual, expected) {
  assert.equal(actual.length, expected.length);
  let maximum = 0;
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(Number.isFinite(actual[i]), `nonfinite evaluated component ${i}`);
    maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
  }
  return maximum;
}
function assertNear(actual, expected, tolerance, label) {
  const error = maxDifference(actual, expected);
  assert.ok(error <= tolerance, `${label}: maximum error ${error}, tolerance ${tolerance}`);
  return error;
}
function assertSourcesUnchanged() {
  for (const [slot, source] of Object.entries(sources)) assert.deepEqual(fingerprint(source), initialSources[slot], `${slot} source was mutated`);
}
function neutral() { return structuredClone(APP_CONFIG.design.binding.defaults); }

function fixture({ bind = true } = {}) {
  const draftRoot = new THREE.Group();
  const rootBone = new THREE.Bone(), bodyBone = new THREE.Bone(), neckBone = new THREE.Bone(), headBone = new THREE.Bone();
  [rootBone.name, bodyBone.name, neckBone.name, headBone.name] = ['XiaoBai_RigRoot', 'XiaoBai_RigBody', 'XiaoBai_RigNeck', 'XiaoBai_RigHead'];
  draftRoot.add(rootBone); rootBone.add(bodyBone); bodyBone.add(neckBone); neckBone.add(headBone);
  const { bodyCenterY, headCenterY } = APP_CONFIG.design.rigVisual;
  const { rootY, neckY } = APP_CONFIG.design.defaults.rig;
  rootBone.position.y = rootY; bodyBone.position.y = bodyCenterY - rootY;
  neckBone.position.y = neckY - bodyCenterY; headBone.position.y = headCenterY - neckY;
  const parts = {};
  const armPair = createMirroredArms(sources.arms, lines, APP_CONFIG);
  for (const slot of ['head', 'body', 'arms', 'legs']) {
    const source = slot === 'arms' ? armPair : sources[slot];
    const draft = clonePart(source);
    const wrapper = new THREE.Group(), offset = new THREE.Group();
    const pivot = slot === 'head' ? headCenterY : slot === 'legs' ? rootY : bodyCenterY;
    wrapper.add(offset); offset.position.y = -pivot; offset.add(draft);
    (slot === 'head' ? headBone : slot === 'legs' ? rootBone : bodyBone).add(wrapper);
    parts[slot] = { source, draft, wrapper, offset, metadata: {
      sourceVersion: APP_CONFIG.assets[slot].builtin?.version ?? APP_CONFIG.assets[slot].version,
      builtin: APP_CONFIG.assets[slot].builtin?.projectRecord.id,
      format: 'glb', designOnly: slot === 'arms' || slot === 'legs',
    } };
  }
  draftRoot.updateMatrixWorld(true);
  const baseline = new Map();
  for (const [slot, part] of Object.entries(parts)) for (const mesh of meshesOf(part.draft)) {
    baseline.set(meshKey(mesh), { slot, side: new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()).x < 0 ? 'L' : 'R', ...plainMeshData(mesh), ...worldData(mesh) });
  }
  const rig = createLimbRig({ draftRoot, rootBone, bodyBone, config: APP_CONFIG });
  if (bind) {
    assert.equal(rig.bindPart(parts.arms, 'arms'), true);
    assert.equal(rig.bindPart(parts.legs, 'legs'), true);
    rig.apply(neutral());
    draftRoot.updateMatrixWorld(true);
  }
  const result = { draftRoot, rootBone, bodyBone, neckBone, headBone, parts, baseline, rig, armPair };
  fixtures.push(result);
  return result;
}
function assertRest(f, tolerance = 1e-10) {
  f.draftRoot.updateMatrixWorld(true);
  const meshes = meshesOf(f.draftRoot);
  assert.equal(meshes.length, 9);
  for (const mesh of meshes) {
    const expected = f.baseline.get(meshKey(mesh)); assert.ok(expected, `unexpected mesh ${meshKey(mesh)}`);
    assert.deepEqual(plainMeshData(mesh), { position: expected.position, normal: expected.normal, indices: expected.indices, material: expected.material }, `${mesh.name}: source attributes changed`);
    const actual = worldData(mesh);
    assertNear(actual.positions, expected.positions, tolerance, `${mesh.name}: rest world positions`);
    assertNear(actual.normals, expected.normals, tolerance, `${mesh.name}: rest world normals`);
  }
}

before(async () => {
  for (const [slot, path] of Object.entries({ head: APP_CONFIG.assets.head.url, body: APP_CONFIG.assets.body.url, arms: APP_CONFIG.assets.arms.builtin.url, legs: APP_CONFIG.assets.legs.builtin.url })) {
    const bytes = await readFile(new URL(path, rootURL));
    sources[slot] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
    initialSources[slot] = fingerprint(sources[slot]);
  }
  lines = JSON.parse(await readFile(new URL(APP_CONFIG.assets.arms.builtin.linesUrl, rootURL), 'utf8'));
  globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
});
after(() => {
  assertSourcesUnchanged();
  for (const f of fixtures) f.rig.dispose();
  disposeObjects([...Object.values(sources), ...fixtures.flatMap(f => [f.draftRoot, f.armPair])]);
  if (originalFileReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = originalFileReader;
  resolver.deregister();
});

test('绑定基线来自明确腿脚批准，13 个锁定文件保持原字节', async () => {
  const approval = JSON.parse(await readFile(new URL('../docs/approvals/legs-v2-approved.json', import.meta.url), 'utf8'));
  assert.equal(approval.userApprovalText, '批准腿脚 v2！接下来绑定关节，仍然在设计副本中操作，已批准的头部、身体、手臂和腿部外形不要改动，完成绑定后先让我确认，再制作动作。');
  assert.equal(approval.approval, 'approved');
  assert.equal(approval.constraints.animationClipsAuthorized, false);
  assert.equal(approval.lockedFileSnapshot.length, 13);
  for (const file of approval.lockedFileSnapshot) {
    const bytes = await readFile(new URL(file.path, rootURL));
    assert.equal(bytes.length, file.sizeBytes, `${file.path}: size changed`);
    assert.equal(sha256(bytes), file.sha256, `${file.path}: hash changed`);
  }
  assert.equal(APP_CONFIG.assets.legs.builtin.approved, true);
  assert.equal(APP_CONFIG.assets.legs.versions['legs-reference-v1-mirrored'].approved, false);
});

test('20 骨和 4 个蒙皮只加入设计副本，静态世界形体及原属性不变', () => {
  const f = fixture();
  assert.equal(f.rig.bones.length, 16);
  assert.equal(bonesOf(f.draftRoot).length, 20);
  assert.equal(new Set(bonesOf(f.draftRoot).map(bone => bone.name)).size, 20);
  assert.equal(meshesOf(f.draftRoot).filter(mesh => mesh.isSkinnedMesh).length, 4);
  assertRest(f);
  assertSourcesUnchanged();
});

test('蒙皮权重有限归一化、索引有效且仅影响所属侧；逆绑定矩阵正确', () => {
  const f = fixture();
  for (const [slot, part] of Object.entries(f.parts)) for (const mesh of meshesOf(part.draft)) {
    if (!mesh.isSkinnedMesh) { assert.ok(slot === 'head' || slot === 'body'); continue; }
    const baseline = f.baseline.get(meshKey(mesh));
    const weights = mesh.geometry.attributes.skinWeight, indices = mesh.geometry.attributes.skinIndex;
    assert.equal(weights.itemSize, 4); assert.equal(indices.itemSize, 4);
    assert.equal(weights.count, mesh.geometry.attributes.position.count); assert.equal(indices.count, weights.count);
    assert.equal(mesh.skeleton.bones.length, 20); assert.equal(mesh.skeleton.boneInverses.length, 20);
    for (let i = 0; i < 20; i += 1) {
      const inverse = mesh.skeleton.boneInverses[i];
      assert.ok(inverse.elements.every(Number.isFinite));
      const identity = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[i].matrixWorld, inverse);
      assertNear(identity.elements, new THREE.Matrix4().elements, 1e-9, 'inverse bind');
    }
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      let sum = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        const weight = weights.array[vertex * 4 + channel], index = indices.array[vertex * 4 + channel];
        assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 1);
        assert.ok(Number.isInteger(index) && index >= 0 && index < 20);
        sum += weight;
        if (!weight) continue;
        const bone = mesh.skeleton.bones[index];
        const key = bone.name.replace('XiaoBai_Rig_', '');
        if (['XiaoBai_RigRoot', 'XiaoBai_RigBody'].includes(bone.name)) continue;
        const joint = APP_CONFIG.design.binding.joints[key];
        assert.ok(joint && joint.slot === slot && joint.side === baseline.side, `${mesh.name}: foreign influence ${bone.name}`);
      }
      assert.equal(sum, 1, `vertex ${vertex}: weight sum ${sum}`);
    }
  }
});

test('调整关节位置重新绑定，零旋转仍保持批准外形', () => {
  const f = fixture();
  const settings = neutral();
  settings.offsets.elbowL = [1.2, -0.5, 0.7];
  settings.offsets.hipR = [-0.7, 0.6, 0.4];
  f.rig.apply(settings);
  f.draftRoot.updateMatrixWorld(true);
  assertRest(f);
  f.rig.apply(neutral());
  assertRest(f);
  assertSourcesUnchanged();
});

test('绑定只接受已批准的版本，移除再绑定恢复原部件且不影响其它槽位', () => {
  const f = fixture({ bind: false });
  const metadata = structuredClone(f.parts.legs.metadata);
  f.parts.legs.metadata.builtin = 'legs-reference-v1-mirrored';
  f.parts.legs.metadata.sourceVersion = 'legs-v1';
  assert.equal(f.rig.bindPart(f.parts.legs, 'legs'), false);
  assert.equal(f.rig.bindPart({ ...f.parts.arms, metadata: { format: 'glb' } }, 'arms'), false);
  assert.equal(meshesOf(f.draftRoot).filter(mesh => mesh.isSkinnedMesh).length, 0);
  f.parts.legs.metadata = metadata;
  assert.equal(f.rig.bindPart(f.parts.arms, 'arms'), true);
  assert.equal(f.rig.bindPart(f.parts.arms, 'arms'), true);
  assert.equal(f.rig.bindPart(f.parts.legs, 'legs'), true);
  assert.equal(meshesOf(f.draftRoot).filter(mesh => mesh.isSkinnedMesh).length, 4);
  assert.equal(f.rig.releasePart(f.parts.arms), true);
  assert.equal(f.rig.releasePart(f.parts.arms), false);
  assert.ok(meshesOf(f.parts.arms.draft).every(mesh => !mesh.isSkinnedMesh && !mesh.geometry.attributes.skinWeight));
  assert.equal(meshesOf(f.parts.legs.draft).filter(mesh => mesh.isSkinnedMesh).length, 2);
  assertRest(f);
  assert.equal(f.rig.bindPart(f.parts.arms, 'arms'), true);
  assertRest(f);
  assertSourcesUnchanged();
});

test('肩肘腕及髋膝踝单关节中等旋转局限于所属侧，头身及另一侧不动', () => {
  const f = fixture();
  const cases = [ ['shoulder', [0, 0, 18]], ['elbow', [0, 20, 0]], ['wrist', [12, 0, 0]], ['hip', [15, 0, 0]], ['knee', [20, 0, 0]], ['ankle', [12, 0, 0]] ];
  for (const [prefix, rotation] of cases) for (const side of ['L', 'R']) {
    const key = prefix + side, joint = APP_CONFIG.design.binding.joints[key];
    const setting = neutral(); setting.rotations[key] = rotation;
    f.rig.apply(setting); f.draftRoot.updateMatrixWorld(true);
    let moved = false;
    for (const mesh of meshesOf(f.draftRoot)) {
      const expected = f.baseline.get(meshKey(mesh));
      const actual = worldData(mesh);
      const error = maxDifference(actual.positions, expected.positions);
      assert.ok(actual.normals.every(Number.isFinite));
      if (expected.slot === joint.slot && expected.side === side) moved ||= error > 0.001;
      else assert.ok(error <= 1e-10, `${key} moved unrelated ${meshKey(mesh)} by ${error}`);
      assert.deepEqual(plainMeshData(mesh), { position: expected.position, normal: expected.normal, indices: expected.indices, material: expected.material });
    }
    assert.ok(moved, `${key} did not deform its limb`);
    f.rig.apply(neutral()); assertRest(f);
  }
  assertSourcesUnchanged();
});

test('GLB 往返保留 4 个 skins、20 骨及静态形体，不生成动作片段或显示线', async () => {
  const f = fixture();
  const posed = neutral();
  posed.rotations.elbowL = [0, 20, 0];
  posed.rotations.kneeR = [18, 0, 0];
  posed.offsets.wristL = [0.5, 0.3, -0.4];
  for (const settings of [neutral(), posed]) {
    f.rig.apply(settings);
    f.draftRoot.updateMatrixWorld(true);
    const before = new Map(meshesOf(f.draftRoot).map(mesh => [meshKey(mesh), { raw: plainMeshData(mesh), ...worldData(mesh) }]));
    const output = await exportModel(f.draftRoot);
    const view = new DataView(output);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(output, 20, view.getUint32(12, true))));
    assert.equal(json.skins.length, 4);
    assert.equal(new Set(json.skins.flatMap(skin => skin.joints)).size, 20);
    assert.ok(json.skins.every(skin => skin.joints.length === 20 && skin.inverseBindMatrices !== undefined));
    assert.equal(json.animations?.length ?? 0, 0);
    assert.ok(json.nodes.every(node => !node.extras?.displayGuide));
    assert.ok(json.meshes.every(mesh => mesh.primitives.every(primitive => (primitive.mode ?? 4) === 4)));
    const loaded = await new GLTFLoader().parseAsync(output, '');
    loaded.scene.updateMatrixWorld(true);
    assert.equal(loaded.animations.length, 0); assert.equal(bonesOf(loaded.scene).length, 20);
    const reloadedMeshes = meshesOf(loaded.scene);
    assert.equal(reloadedMeshes.length, 9); assert.equal(reloadedMeshes.filter(mesh => mesh.isSkinnedMesh).length, 4);
    for (const mesh of reloadedMeshes) {
      // GLTFLoader uniquifies the second Arm_L node name after serialization.
      if (mesh.name === 'Arm_L_1') mesh.name = 'Arm_L';
      const expected = before.get(meshKey(mesh)); assert.ok(expected, `unexpected reload mesh ${meshKey(mesh)}`);
      assert.deepEqual(plainMeshData(mesh), expected.raw);
      const actual = worldData(mesh);
      assertNear(actual.positions, expected.positions, 2e-5, `${mesh.name}: reloaded world positions`);
      assertNear(actual.normals, expected.normals, 2e-6, `${mesh.name}: reloaded world normals`);
    }
    for (const mesh of meshesOf(f.draftRoot)) {
      const expected = before.get(meshKey(mesh));
      assert.deepEqual(plainMeshData(mesh), expected.raw);
      const actual = worldData(mesh);
      assertNear(actual.positions, expected.positions, 0, 'export changed current pose');
      assertNear(actual.normals, expected.normals, 0, 'export changed current normals');
    }
    disposeObjects([loaded.scene]);
  }
  f.rig.apply(neutral());
  assertRest(f); assertSourcesUnchanged();
});
