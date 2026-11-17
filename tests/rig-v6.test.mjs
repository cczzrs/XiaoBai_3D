import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { APP_CONFIG as config } from '../web/src/config.js';
import { createDefaultProject } from '../web/src/project-state.js';
import { historicalURL } from '../scripts/project-paths.mjs';

const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { clonePart, exportModel, disposeObjects } = await import('../web/src/model-io.js');
const { createMirroredArms } = await import('../web/src/arm-v59.js');
const { createLimbRig } = await import('../web/src/limb-rig-v6.js');
const { sampleAction, applyAction, minimumSkinnedY } = await import('../web/src/action-motion.js');
const { bakeActionClips } = await import('../web/src/action-export-v6.js');
const projectRoot = new URL('../', import.meta.url), output = new URL('temp/legs-v6-rig/', projectRoot);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const attributeHash = a => sha256(new Uint8Array(a.array.buffer, a.array.byteOffset, a.array.byteLength));
const meshes = root => { const out = []; root.traverse(n => { if (n.isMesh) out.push(n); }); return out; };
const bones = root => { const out = []; root.traverse(n => { if (n.isBone) out.push(n); }); return out; };
const neutral = () => structuredClone(config.design.binding.defaults);
const sources = {}, sourceHashes = {}, fixtures = [];
const report = { schema: 'xiaobai.legs-v6-rig-test.v1', sourceSha256: null, checks: {}, poses: [], export: null, limitations: ['Sampled local triangle orientation and edge deformation do not prove absence of every global self-intersection.'] };
const previousFileReader = globalThis.FileReader;
let guides;

function attributes(mesh) {
  const g = mesh.geometry;
  return { position: attributeHash(g.attributes.position), normal: attributeHash(g.attributes.normal), index: attributeHash(g.index) };
}

// Independent CPU evaluation of the same linear skin matrices consumed by
// glTF/WebGL. This intentionally does not use mesh.applyBoneTransform().
function evaluated(mesh) {
  mesh.updateWorldMatrix(true, false);
  const { position, normal, skinIndex, skinWeight } = mesh.geometry.attributes;
  const matrices = mesh.isSkinnedMesh ? mesh.skeleton.bones.map((bone, i) => new THREE.Matrix4()
    .multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).multiply(bone.matrixWorld)
    .multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix).elements) : [mesh.matrixWorld.elements];
  const p = new Float64Array(position.count * 3), n = new Float64Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i), nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    let px = 0, py = 0, pz = 0, ax = 0, ay = 0, az = 0;
    for (let c = 0; c < (mesh.isSkinnedMesh ? 4 : 1); c += 1) {
      const w = mesh.isSkinnedMesh ? skinWeight.array[i * 4 + c] : 1;
      if (!w) continue;
      const m = matrices[mesh.isSkinnedMesh ? skinIndex.array[i * 4 + c] : 0];
      px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      ax += w * (m[0] * nx + m[4] * ny + m[8] * nz);
      ay += w * (m[1] * nx + m[5] * ny + m[9] * nz);
      az += w * (m[2] * nx + m[6] * ny + m[10] * nz);
    }
    const length = Math.hypot(ax, ay, az);
    p.set([px, py, pz], i * 3); n.set([ax / length, ay / length, az / length], i * 3);
  }
  return { positions: p, normals: n };
}

function maximumError(a, b, start = 0, end = a.length) {
  assert.equal(a.length, b.length); let maximum = 0;
  for (let i = start; i < end; i += 1) { assert.ok(Number.isFinite(a[i])); maximum = Math.max(maximum, Math.abs(a[i] - b[i])); }
  return maximum;
}

function fixture({ legacy = false } = {}) {
  const root = new THREE.Group(); root.name = 'XiaoBai_DesignDraft';
  root.userData = { rigType: 'rig-v6-design', rigApproval: 'pending', sourceVersion: 'legs-v6', designOnly: true };
  const rootBone = new THREE.Bone(), bodyBone = new THREE.Bone(), neckBone = new THREE.Bone(), headBone = new THREE.Bone();
  [rootBone.name, bodyBone.name, neckBone.name, headBone.name] = ['XiaoBai_RigRoot', 'XiaoBai_RigBody', 'XiaoBai_RigNeck', 'XiaoBai_RigHead'];
  root.add(rootBone); rootBone.add(bodyBone); bodyBone.add(neckBone); neckBone.add(headBone);
  const { rootY, neckY } = config.design.defaults.rig, { bodyCenterY, headCenterY } = config.design.rigVisual;
  rootBone.position.y = rootY; bodyBone.position.y = bodyCenterY - rootY;
  neckBone.position.y = neckY - bodyCenterY; headBone.position.y = headCenterY - neckY;
  const armPair = createMirroredArms(sources.arms, guides, config), parts = {};
  for (const slot of ['head', 'arms', 'legs']) {
    const source = slot === 'arms' ? armPair : slot === 'legs' && legacy ? sources.legacyLegs : sources[slot], draft = clonePart(source);
    const wrapper = new THREE.Group(), offset = new THREE.Group();
    const pivot = slot === 'head' ? headCenterY : slot === 'legs' ? rootY : bodyCenterY;
    wrapper.add(offset); offset.position.y = -pivot; offset.add(draft);
    (slot === 'head' ? headBone : slot === 'legs' ? rootBone : bodyBone).add(wrapper);
    parts[slot] = { source, draft, wrapper, offset, metadata: { format: 'glb', designOnly: slot !== 'head',
      builtin: slot === 'legs' ? legacy ? 'legs-smooth-v2-mirrored' : 'body-legs-fair-v6' : config.assets[slot].builtin?.projectRecord.id,
      sourceVersion: slot === 'legs' ? legacy ? 'legs-v2' : 'legs-v6' : config.assets[slot].builtin?.version ?? config.assets[slot].version } };
  }
  root.updateMatrixWorld(true);
  const baseline = evaluated(meshes(parts.legs.draft)[0]), raw = attributes(meshes(parts.legs.draft)[0]);
  const legBaselines = meshes(parts.legs.draft).map(m => ({ ...evaluated(m), raw: attributes(m) }));
  const rig = createLimbRig({ draftRoot: root, rootBone, bodyBone, config });
  assert.equal(rig.bindPart(parts.arms, 'arms'), true); assert.equal(rig.bindPart(parts.legs, 'legs'), true);
  rig.apply(neutral()); root.updateMatrixWorld(true);
  const f = { root, rootBone, bodyBone, parts, rig, armPair, baseline, raw, legBaselines, mesh: meshes(parts.legs.draft)[0] };
  fixtures.push(f); return f;
}

function reset(f) {
  f.root.position.set(0, 0, 0); bones(f.root).forEach(b => b.quaternion.identity());
  f.rig.apply(neutral()); f.root.updateMatrixWorld(true);
}

function poseGeometry(f, label, deferAssertions = false) {
  const state = evaluated(f.mesh), ids = f.mesh.geometry.index.array;
  let minimumArea = Infinity, opposedFaces = 0, minimumFaceNormalDot = 1, minimumY = Infinity;
  const opposedExamples = [], opposedSourceBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < state.positions.length; i += 1) assert.ok(Number.isFinite(state.positions[i]) && Number.isFinite(state.normals[i]), `${label}: nonfinite`);
  for (let i = 1; i < state.positions.length; i += 3) minimumY = Math.min(minimumY, state.positions[i]);
  for (let i = 0; i < ids.length; i += 3) {
    const a = ids[i] * 3, b = ids[i + 1] * 3, c = ids[i + 2] * 3, p = state.positions, n = state.normals;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const length = Math.hypot(fx, fy, fz); minimumArea = Math.min(minimumArea, length / 2);
    const nx = n[a] + n[b] + n[c], ny = n[a + 1] + n[b + 1] + n[c + 1], nz = n[a + 2] + n[b + 2] + n[c + 2];
    const dot = (fx * nx + fy * ny + fz * nz) / (length * Math.hypot(nx, ny, nz));
    minimumFaceNormalDot = Math.min(minimumFaceNormalDot, dot);
    if (dot <= 0) {
      opposedFaces += 1;
      const sourcePosition = f.mesh.geometry.attributes.position;
      const source = [ids[i], ids[i + 1], ids[i + 2]].map(id => [sourcePosition.getX(id), sourcePosition.getY(id), sourcePosition.getZ(id)]);
      for (const point of source) for (let axis = 0; axis < 3; axis += 1) {
        opposedSourceBounds.min[axis] = Math.min(opposedSourceBounds.min[axis], point[axis]);
        opposedSourceBounds.max[axis] = Math.max(opposedSourceBounds.max[axis], point[axis]);
      }
      if (opposedExamples.length < 12) opposedExamples.push({ face: i / 3, ids: Array.from(ids.slice(i, i + 3)), source, dot });
    }
  }
  let maximumFootDistanceError = 0;
  // The accepted bulb-shaped foot moves rigidly with its ankle: it must not
  // be split into different rotations through its broad toe/instep surface.
  for (const offset of [0, 15041]) for (let i = offset; i < offset + 15041; i += 1) for (const anchor of [offset, offset + 15040]) {
    const a = i * 3, b = anchor * 3, p = state.positions, q = f.baseline.positions;
    const actual = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    const expected = Math.hypot(q[a] - q[b], q[a + 1] - q[b + 1], q[a + 2] - q[b + 2]);
    maximumFootDistanceError = Math.max(maximumFootDistanceError, Math.abs(actual - expected));
  }
  const result = { label, minimumArea, minimumFaceNormalDot, opposedFaces, minimumY, maximumFootDistanceError, ...(opposedFaces ? { opposedSourceBounds, opposedExamples } : {}) };
  report.poses.push(result);
  if (!deferAssertions) {
    assert.ok(minimumArea > 1e-12, JSON.stringify(result));
    assert.equal(opposedFaces, 0, JSON.stringify(result));
    assert.ok(maximumFootDistanceError < 1e-8, `${label}: accepted foot deforms by ${maximumFootDistanceError}`);
  }
  return state;
}

before(async () => {
  for (const [slot, path] of Object.entries({ head: config.assets.head.url, arms: config.assets.arms.builtin.url, legs: './assets/design/legs-v6/body-legs.glb', legacyLegs: './assets/design/legs-v2/legs.glb' })) {
    const bytes = await readFile(new URL(path, projectRoot)); sourceHashes[slot] = sha256(bytes);
    sources[slot] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  }
  report.sourceSha256 = sourceHashes.legs;
  guides = JSON.parse(await readFile(new URL(config.assets.arms.builtin.linesUrl, projectRoot), 'utf8'));
  globalThis.FileReader = class {
    async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
    async readAsDataURL(blob) { this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`; this.onloadend?.(); }
  };
  await mkdir(output, { recursive: true });
});

after(async () => {
  await writeFile(new URL('independent-rig-check.json', output), JSON.stringify(report, null, 2) + '\n');
  for (const f of fixtures) f.rig.dispose();
  disposeObjects([...Object.values(sources), ...fixtures.flatMap(f => [f.root, f.armPair])]);
  if (previousFileReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = previousFileReader;
  hook.deregister();
});

test('v6 adds a single continuous body/leg skin while neutral geometry and both feet remain exact', () => {
  const f = fixture(), state = evaluated(f.mesh);
  assert.equal(f.mesh.isSkinnedMesh, true); assert.equal(meshes(f.parts.legs.draft).length, 1);
  assert.equal(f.mesh.geometry.attributes.position.count, 144419); assert.equal(f.mesh.geometry.index.count / 3, 288834);
  assert.deepEqual(attributes(f.mesh), f.raw);
  assert.ok(maximumError(state.positions, f.baseline.positions) < 1e-10);
  assert.ok(maximumError(state.normals, f.baseline.normals) < 1e-10);
  assert.ok(maximumError(state.positions, f.baseline.positions, 0, 15041 * 2 * 3) < 1e-10);
  assert.equal(bones(f.root).length, 20); assert.equal(meshes(f.root).filter(m => m.isSkinnedMesh).length, 3);
  assert.equal(f.rig.getStats().completeLimbRig, true); assert.equal(f.rig.getStats().fusedBodyLegs, true);
  report.checks.neutral = { meshes: 7, skins: 3, bones: 20, rawGeometryExact: true, footVerticesPerSide: 15041, maximumWorldPositionError: maximumError(state.positions, f.baseline.positions) };
});

test('v6 weights are finite, normalized, symmetric and never cross to the opposite foot', () => {
  const f = fixture(), g = f.mesh.geometry, p = g.attributes.position, w = g.attributes.skinWeight, ids = g.attributes.skinIndex;
  const names = f.mesh.skeleton.bones.map(b => b.name), bodyId = names.indexOf('XiaoBai_RigBody');
  const mirrorName = name => name.replace(/([LR])$/, side => side === 'L' ? 'R' : 'L');
  const mirrorId = names.map(name => names.indexOf(mirrorName(name)));
  const key = (x, y, z) => [x, y, z].map(v => Math.round(v * 1e5)).join(':');
  const byPosition = new Map(Array.from({ length: p.count }, (_, i) => [key(p.getX(i), p.getY(i), p.getZ(i)), i]));
  const influences = i => {
    const map = new Map();
    for (let c = 0; c < 4; c += 1) if (w.array[i * 4 + c]) map.set(ids.array[i * 4 + c], (map.get(ids.array[i * 4 + c]) ?? 0) + w.array[i * 4 + c]);
    return map;
  };
  for (let i = 0; i < p.count; i += 1) {
    let sum = 0;
    for (let c = 0; c < 4; c += 1) {
      const weight = w.array[i * 4 + c], id = ids.array[i * 4 + c];
      assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 1); assert.ok(Number.isInteger(id) && id >= 0 && id < 20); sum += weight;
      if (weight && p.getY(i) <= 13.44798) assert.ok(!names[id].endsWith(p.getX(i) < 0 ? 'R' : 'L'), `cross-side weight at ${i}`);
    }
    assert.equal(sum, 1);
    // The accepted rest surface above y32.684898 remains byte-exact. In motion,
    // the new rig transitions through the lower torso up to y40 to avoid the
    // earlier short-leg compression folds; only that upper attachment is rigid.
    if (p.getY(i) >= 40) assert.deepEqual([...influences(i)], [[bodyId, 1]], `upper body ${i}`);
    const other = byPosition.get(key(-p.getX(i), p.getY(i), p.getZ(i))); assert.notEqual(other, undefined);
    const a = influences(i), b = influences(other);
    for (const [id, weight] of a) assert.ok(Math.abs(weight - (b.get(mirrorId[id]) ?? 0)) <= 2 ** -23, `asymmetric influence ${i}`);
  }
  report.checks.weights = { vertices: p.count, maximumInfluences: 4, exactSum: 1, mirrored: true, oppositeFootInfluences: 0, upperBodyBoneOnlyAboveY: 40 };
});

test('v6 hip, knee and ankle edits move only their side and preserve the continuous surface', () => {
  const f = fixture();
  for (const side of ['L', 'R']) for (const [joint, angle] of [['hip', 15], ['knee', 20], ['ankle', 12]]) {
    reset(f); const setting = neutral(); setting.rotations[joint + side] = [angle, 0, 0];
    f.rig.apply(setting); f.root.updateMatrixWorld(true); const state = poseGeometry(f, joint + side);
    const ownStart = side === 'R' ? 0 : 15041 * 3, otherStart = side === 'L' ? 0 : 15041 * 3;
    assert.ok(maximumError(state.positions, f.baseline.positions, ownStart, ownStart + 15041 * 3) > 0.01);
    assert.ok(maximumError(state.positions, f.baseline.positions, otherStart, otherStart + 15041 * 3) < 1e-10);
    const restPositions = f.mesh.geometry.attributes.position;
    for (let i = 0; i < restPositions.count; i += 1) if (restPositions.getY(i) >= 40) {
      for (let axis = 0; axis < 3; axis += 1) assert.ok(Math.abs(state.positions[i * 3 + axis] - f.baseline.positions[i * 3 + axis]) < 1e-10);
    }
    assert.deepEqual(attributes(f.mesh), f.raw);
  }
  reset(f); f.bodyBone.rotation.x = THREE.MathUtils.degToRad(12); f.root.updateMatrixWorld(true);
  const state = poseGeometry(f, 'bodyLean12');
  assert.ok(maximumError(state.positions, f.baseline.positions, 30082 * 3, 50627 * 3) > 0.1);
  reset(f); assert.ok(maximumError(evaluated(f.mesh).positions, f.baseline.positions) < 1e-10);
  report.checks.independentJoints = true;
});

test('v6 rest-joint relocation and release/rebind retain the exact accepted neutral shape', () => {
  const f = fixture(); const setting = neutral(); setting.offsets.hipL = [-0.3, 0.5, 0.2]; setting.offsets.ankleR = [0.2, 0.4, -0.3];
  f.rig.apply(setting); f.root.updateMatrixWorld(true);
  assert.ok(maximumError(evaluated(f.mesh).positions, f.baseline.positions) < 1e-10);
  assert.equal(f.rig.releasePart(f.parts.legs), true);
  assert.ok(meshes(f.parts.legs.draft).every(m => !m.isSkinnedMesh && !m.geometry.attributes.skinWeight));
  assert.equal(f.rig.getStats().completeLimbRig, false);
  assert.equal(f.rig.bindPart(f.parts.legs, 'legs'), true); f.mesh = meshes(f.parts.legs.draft)[0]; reset(f);
  assert.deepEqual(attributes(f.mesh), f.raw); assert.ok(maximumError(evaluated(f.mesh).positions, f.baseline.positions) < 1e-10);
  report.checks.rebind = true;
});

test('the new rig engine still binds the legacy v2 pair with unchanged neutral geometry and four skins', () => {
  const f = fixture({ legacy: true }), pair = meshes(f.parts.legs.draft);
  assert.equal(pair.length, 2); assert.equal(meshes(f.root).filter(m => m.isSkinnedMesh).length, 4);
  assert.equal(f.rig.getStats().completeLimbRig, true); assert.equal(f.rig.getStats().fusedBodyLegs, false);
  for (let i = 0; i < pair.length; i += 1) {
    assert.deepEqual(attributes(pair[i]), f.legBaselines[i].raw);
    assert.ok(maximumError(evaluated(pair[i]).positions, f.legBaselines[i].positions) < 1e-10);
  }
  report.checks.legacyV2 = { skins: 4, exactNeutralGeometry: true };
});

test('v6 supports the five existing action definitions without local folded triangles across dense default phases', () => {
  const f = fixture(), actions = createDefaultProject().actions, reportStart = report.poses.length;
  const phases = name => ['walk', 'run'].includes(name) ? Array.from({ length: 32 }, (_, i) => i / 32) : name === 'sit' ? [0] : [0, 0.25, 0.5, 0.75];
  for (const name of config.design.actions.names) for (const phase of phases(name)) {
    reset(f); const sample = sampleAction(name, phase, actions, config); applyAction(f.root, sample, config);
    poseGeometry(f, `${name}:${phase}`, true);
    if (sample.grounded) assert.ok(Math.abs(minimumSkinnedY([f.mesh]) - config.design.actions.ground.level) < 1e-8, `${name}:${phase}: not grounded`);
    assert.deepEqual(attributes(f.mesh), f.raw);
  }
  reset(f); assert.ok(maximumError(evaluated(f.mesh).positions, f.baseline.positions) < 1e-10);
  const failed = report.poses.slice(reportStart).filter(p => p.minimumArea <= 1e-12 || p.opposedFaces > 0 || p.maximumFootDistanceError >= 1e-8)
    .map(({ label, minimumArea, minimumFaceNormalDot, opposedFaces, opposedSourceBounds, maximumFootDistanceError }) => ({ label, minimumArea, minimumFaceNormalDot, opposedFaces, opposedSourceBounds, maximumFootDistanceError }));
  assert.deepEqual(failed, []);
  report.checks.actionKeyframes = { counts: Object.fromEntries(config.design.actions.names.map(name => [name, phases(name).length])), allFinite: true, opposedFaces: 0, acceptedFeetRigid: true };
});

test('v6 action GLB roundtrips one shared body/leg skin, two arm skins, twenty bones and five clips', async () => {
  const f = fixture(), original = attributes(f.mesh), { root, clips } = bakeActionClips(f.root, createDefaultProject().actions, config);
  const bytes = await exportModel(root, clips), loaded = await new GLTFLoader().parseAsync(bytes, '');
  const skins = meshes(loaded.scene).filter(m => m.isSkinnedMesh), fused = skins.find(m => m.name === 'BodyLegs_DesignV6');
  assert.ok(fused); assert.equal(skins.length, 3); assert.equal(bones(loaded.scene).length, 20); assert.equal(loaded.animations.length, 5);
  assert.deepEqual(loaded.animations.map(c => Math.round(c.duration * 100) / 100), [1.2, 0.8, 2, 4, 1]);
  assert.equal(attributeHash(fused.geometry.attributes.position), original.position); assert.equal(attributeHash(fused.geometry.index), original.index);
  assert.ok(maximumError(evaluated(fused).positions, f.baseline.positions) < 2e-5);
  assert.notEqual(root.userData.rigApproval, 'approved', 'new v6 binding must not inherit old rig-v1 approval');
  const loadedRest = evaluated(fused), loadedArms = skins.filter(m => m !== fused);
  const armRest = loadedArms.map(evaluated);
  for (const clip of loaded.animations) {
    assert.equal(clip.tracks.length, 22);
    for (const track of clip.tracks) {
      assert.ok(Array.from(track.values).every(Number.isFinite)); const width = track.getValueSize();
      assert.ok(maximumError(track.values.slice(0, width), track.values.slice(-width)) < 1e-5);
    }
    const mixer = new THREE.AnimationMixer(loaded.scene); mixer.clipAction(clip).play(); mixer.setTime(clip.duration * 0.25); loaded.scene.updateMatrixWorld(true);
    const actual = evaluated(fused);
    assert.ok(actual.positions.every(Number.isFinite));
    if (/walk|run|sit/.test(clip.name)) {
      assert.ok(maximumError(actual.positions, loadedRest.positions) > 0.1, `${clip.name}: no leg motion`);
      assert.ok(Math.abs(minimumSkinnedY([fused]) - config.design.actions.ground.level) < 2e-5, `${clip.name}: exported ground drift`);
    }
    if (clip.name.includes('wave')) assert.ok(loadedArms.some((m, i) => maximumError(evaluated(m).positions, armRest[i].positions) > 0.1));
    if (clip.name.includes('thinking')) assert.ok(loaded.scene.getObjectByName('Nose').morphTargetInfluences.some(w => w > 0));
    mixer.stopAllAction(); loaded.scene.updateMatrixWorld(true);
  }
  assert.deepEqual(attributes(f.mesh), original);
  report.export = { passed: true, bytes: bytes.byteLength, sha256: sha256(new Uint8Array(bytes)), skins: 3, bones: 20, vertices: fused.geometry.attributes.position.count, triangles: fused.geometry.index.count / 3, rigApproval: root.userData.rigApproval, clips: loaded.animations.map(c => ({ name: c.name, duration: c.duration, tracks: c.tracks.length })) };
  await writeFile(new URL('actions-test-export.glb', output), Buffer.from(bytes));
  disposeObjects([root, loaded.scene]);
});

test('v6 source geometry, all twenty-four approved baselines and the approved action implementation remain byte-exact', async () => {
  const approval = JSON.parse(await readFile(new URL('docs/approvals/actions-v1-approved.json', projectRoot), 'utf8'));
  const locks = await Promise.all(approval.lockedFileSnapshot.map(async item => {
    const bytes = await readFile(historicalURL(item.path)); return { path: item.path, unchanged: bytes.byteLength === item.sizeBytes && sha256(bytes) === item.sha256 };
  }));
  assert.equal(locks.length, 24); assert.deepEqual(locks.filter(item => !item.unchanged), []);
  const implementationLocks = await Promise.all(approval.implementationSnapshot.map(async item => {
    const bytes = await readFile(historicalURL(item.path)); return { path: item.path, unchanged: bytes.byteLength === item.sizeBytes && sha256(bytes) === item.sha256 };
  }));
  assert.equal(implementationLocks.length, 2); assert.deepEqual(implementationLocks.filter(item => !item.unchanged), []);
  const approvedBinding = JSON.parse(await readFile(new URL('assets/design/rig-v1/parameters.json', projectRoot), 'utf8'));
  assert.deepEqual(config.design.binding, { ...approvedBinding.binding, approval: 'approved' });
  assert.equal(sha256(await readFile(new URL('assets/design/legs-v6/body-legs.glb', projectRoot))), 'd6304d97b26ddd0745a1907f0d423611f40f2b7949c1d528be97bd9a3ec16edd');
  assert.deepEqual(meshes(sources.legs).map(attributes), [fixtures[0].raw]);
  report.checks.sourceAndApprovalLocks = locks;
  report.checks.actionImplementationLocks = implementationLocks;
  report.checks.legacyBindingConfiguration = true;
});
