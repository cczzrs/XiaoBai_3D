import * as THREE from 'three';
import { fusedLegWeights, validateFusedLegWeights } from './fused-leg-skinning.js';

const BUILTINS = {
  arms: { id: 'left-arm-v59-mirrored', version: 'v59' },
  legs: { id: 'legs-smooth-v2-mirrored', version: 'legs-v2' },
  fusedLegs: { id: 'body-legs-fair-v6', version: 'legs-v6' },
  splitLegs: { id: 'legs-separated-v7', version: 'legs-v7' },
  splitBody: { id: 'body-companion-v7', version: 'body-design-v7' },
};
const ZERO = [0, 0, 0];
const clamp = THREE.MathUtils.clamp;
const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const vector = (value, label) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${label} 必须是三个有限数值。`);
  return value;
};

function replaceChild(parent, oldChild, newChild) {
  const index = parent.children.indexOf(oldChild);
  parent.remove(oldChild);
  parent.add(newChild);
  parent.children.splice(parent.children.indexOf(newChild), 1);
  parent.children.splice(index, 0, newChild);
}

function materialsOf(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }

/**
 * Skin only the explicitly supported design copies. Geometry attributes and
 * reflected parent transforms stay intact; binding adds weights and matrices.
 * Joint positions and offsets use the unposed draft's H100 coordinates.
 */
export function createLimbRig({ draftRoot, rootBone, bodyBone, config }) {
  const settings = config.design.binding;
  const fusedSettings = config.design.bindingV6;
  if (!settings?.joints || !settings.weights) throw new Error('缺少集中配置的四肢绑定参数。');
  if (!rootBone?.isBone || !bodyBone?.isBone || !draftRoot?.isObject3D) throw new Error('四肢绑定需要设计副本及根/身体骨骼。');
  const definitions = settings.joints;
  const keys = Object.keys(definitions);
  const baseBones = [];
  rootBone.traverse((object) => { if (object.isBone) baseBones.push(object); });
  const boneMap = {};
  const records = new Map();
  const modelInverse = new THREE.Matrix4();
  const point = new THREE.Vector3();
  let state = { offsets: {}, rotations: {} };
  let lastRestSignature = '';
  let disposed = false;

  for (const key of keys) {
    const definition = definitions[key];
    vector(definition.position, `${key}.position`);
    if (!['arms', 'legs'].includes(definition.slot) || !['L', 'R'].includes(definition.side)) throw new Error(`${key} 的四肢分组无效。`);
    const bone = new THREE.Bone();
    bone.name = `XiaoBai_Rig_${key}`;
    bone.userData = { jointKey: key, slot: definition.slot, side: definition.side, designOnly: true };
    boneMap[key] = bone;
  }
  const bones = keys.map((key) => boneMap[key]);
  for (const key of keys) {
    const parent = definitions[key].parent;
    const object = parent === 'body' ? bodyBone : parent === 'root' ? rootBone : boneMap[parent];
    if (!object || object === boneMap[key]) throw new Error(`${key} 的父骨骼无效。`);
    object.add(boneMap[key]);
  }
  const allBones = [...baseBones, ...bones];
  const boneIndex = new Map(allBones.map((bone, index) => [bone, index]));
  for (const side of ['L', 'R']) for (const name of ['shoulder', 'elbow', 'wrist', 'handTip', 'hip', 'knee', 'ankle', 'toeTip']) {
    if (!boneMap[`${name}${side}`]) throw new Error(`缺少 ${name}${side} 骨骼。`);
  }

  function restPoint(key) {
    return definitions[key].position.map((value, axis) => value + (state.offsets[key]?.[axis] ?? 0));
  }

  function normalizeState(next = {}) {
    const result = { offsets: {}, rotations: {} };
    for (const kind of ['offsets', 'rotations']) for (const key of keys) {
      result[kind][key] = [...vector(next[kind]?.[key] ?? settings.defaults?.[kind]?.[key] ?? ZERO, `${kind}.${key}`)];
    }
    return result;
  }

  function restSignature() {
    return JSON.stringify({ offsets: state.offsets, parents: baseBones.map((bone) => [...bone.position, ...bone.scale]) });
  }

  function updateSkeletons() {
    draftRoot.updateWorldMatrix(true, false);
    // SkinnedMesh updates its attached bind inverse in updateMatrixWorld,
    // not in Object3D.updateWorldMatrix's alternate traversal.
    draftRoot.updateMatrixWorld(true);
    for (const record of records.values()) for (const item of record.items) item.mesh.skeleton?.update();
  }

  function positionBones() {
    const done = new Set();
    const visiting = new Set();
    function place(key) {
      if (done.has(key)) return;
      if (visiting.has(key)) throw new Error('骨骼父级不能形成循环。');
      visiting.add(key);
      const parent = definitions[key].parent;
      if (boneMap[parent]) place(parent);
      const bone = boneMap[key];
      bone.parent.updateWorldMatrix(true, false);
      point.fromArray(restPoint(key)).applyMatrix4(draftRoot.matrixWorld);
      bone.position.copy(bone.parent.worldToLocal(point));
      bone.scale.set(1, 1, 1);
      bone.userData.restPosition = restPoint(key);
      bone.updateWorldMatrix(false, false);
      visiting.delete(key);
      done.add(key);
    }
    for (const key of keys) place(key);
  }

  function writeWeights(item, slot) {
    const geometry = item.mesh.geometry;
    const positions = geometry.attributes.position;
    const indices = new Uint16Array(positions.count * 4);
    const weights = new Float32Array(positions.count * 4);
    const transform = modelInverse.clone().multiply(item.mesh.matrixWorld);
    const fused = item.fusedBodyLegs || item.splitBodyLegs;
    const side = item.side;
    const settingsWeights = settings.weights;
    const rootIndex = boneIndex.get(rootBone);
    const bodyIndex = boneIndex.get(bodyBone);
    const indexOf = (name, limbSide = side) => boneIndex.get(boneMap[`${name}${limbSide}`]);
    const elbow = fused ? null : Math.abs(restPoint(`elbow${side}`)[0]);
    const wrist = fused ? null : Math.abs(restPoint(`wrist${side}`)[0]);
    const kneeY = fused ? null : restPoint(`knee${side}`)[1];
    const ankleY = fused ? null : restPoint(`ankle${side}`)[1];
    const fusedJoints = fused ? Object.fromEntries(['L', 'R'].map(limbSide => [limbSide, {
      indices: [bodyIndex, indexOf('ankle', 'L'), indexOf('ankle', 'R'), indexOf('knee', limbSide)],
    }])) : null;
    for (let i = 0; i < positions.count; i += 1) {
      point.fromBufferAttribute(positions, i).applyMatrix4(transform);
      let ids;
      let values;
      if (fused) {
        const joint = fusedJoints[point.x < 0 ? 'L' : 'R'];
        ids = joint.indices;
        values = fusedLegWeights(point, item.splitBodyLegs ? config.design.bindingV7.weights : fusedSettings.weights);
      } else if (slot === 'arms') {
        const outward = Math.abs(point.x);
        const { armAnchor, armElbow, armWrist } = settingsWeights;
        const free = smooth((outward - armAnchor.fullAt) / (armAnchor.freeAt - armAnchor.fullAt));
        const e = smooth((outward - elbow + armElbow.width / 2) / armElbow.width);
        const w = smooth((outward - wrist + armWrist.width / 2) / armWrist.width);
        ids = [bodyIndex, indexOf('shoulder'), indexOf('elbow'), indexOf('wrist')];
        values = [1 - free, free * (1 - e), free * e * (1 - w), free * e * w];
      } else {
        const { legKnee, legAnkle, legCollar } = settingsWeights;
        const k = smooth((kneeY + legKnee.width / 2 - point.y) / legKnee.width);
        const a = smooth((ankleY + legAnkle.width / 2 - point.y) / legAnkle.width);
        const ring = Math.floor((i - legCollar.firstBlendVertex) / legCollar.radial);
        const contactRing = (legCollar.contactVertex - legCollar.firstBlendVertex) / legCollar.radial;
        const anchored = i >= legCollar.contactVertex ? 1 : smooth((ring / contactRing - legCollar.anchorStart) / (1 - legCollar.anchorStart));
        const free = 1 - anchored;
        ids = [rootIndex, indexOf('hip'), indexOf('knee'), indexOf('ankle')];
        values = [anchored, free * (1 - k), free * k * (1 - a), free * k * a];
      }
      if (!values.every(Number.isFinite)) throw new Error('蒙皮权重配置产生无效数值。');
      const sum = values.reduce((total, value) => total + value, 0);
      // Every n / 2^24 is exactly representable in Float32. Balance rounding
      // in the largest influence so the stored sum is exactly one, avoiding
      // a tiny rest-pose scale drift from independently rounded weights.
      const denominator = 2 ** 24;
      const integers = values.map((value) => Math.round(value / sum * denominator));
      const largest = values.indexOf(Math.max(...values));
      integers[largest] += denominator - integers.reduce((total, value) => total + value, 0);
      for (let j = 0; j < 4; j += 1) {
        indices[i * 4 + j] = ids[j];
        weights[i * 4 + j] = integers[j] / denominator;
      }
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  }

  // Root/body rotations may already hold the existing studio pose. Calculate
  // inverses in neutral temporarily, then restore that pose without baking it.
  function rebind() {
    const rotations = allBones.map((bone) => bone.quaternion.clone());
    try {
      for (const bone of allBones) bone.quaternion.identity();
      draftRoot.updateWorldMatrix(true, true);
      positionBones();
      draftRoot.updateWorldMatrix(true, true);
      modelInverse.copy(draftRoot.matrixWorld).invert();
      for (const record of records.values()) for (const item of record.items) {
        writeWeights(item, record.slot);
        item.mesh.skeleton?.dispose();
        const skeleton = new THREE.Skeleton(allBones);
        item.mesh.bind(skeleton, item.mesh.matrixWorld.clone());
      }
      lastRestSignature = restSignature();
    } finally {
      allBones.forEach((bone, i) => bone.quaternion.copy(rotations[i]));
      updateSkeletons();
    }
  }

  function apply(next = {}) {
    if (disposed) throw new Error('四肢绑定已释放。');
    state = normalizeState(next);
    if (restSignature() !== lastRestSignature) rebind();
    for (const key of keys) {
      const angles = state.rotations[key].map(THREE.MathUtils.degToRad);
      boneMap[key].rotation.set(...angles, 'XYZ');
    }
    updateSkeletons();
  }

  function bindPart(part, slot) {
    if (disposed) throw new Error('四肢绑定已释放。');
    if (records.has(part)) return true;
    const fused = slot === 'legs' && part?.metadata?.builtin === BUILTINS.fusedLegs.id;
    const splitLegs = slot === 'legs' && part?.metadata?.builtin === BUILTINS.splitLegs.id;
    const splitBody = slot === 'body' && part?.metadata?.builtin === BUILTINS.splitBody.id;
    const split = splitLegs || splitBody;
    const spatial = fused || split;
    const expected = fused ? BUILTINS.fusedLegs : splitLegs ? BUILTINS.splitLegs : splitBody ? BUILTINS.splitBody : BUILTINS[slot];
    if (!expected || part?.metadata?.builtin !== expected.id || part.metadata.sourceVersion !== expected.version) return false;
    if (spatial) {
      const spatialSettings = split ? config.design.bindingV7 : fusedSettings;
      validateFusedLegWeights(spatialSettings?.weights);
      if (!spatialSettings.version) throw new Error('缺少身体与腿的空间绑定版本。');
    }
    if (!part.draft?.isObject3D || !part.wrapper?.parent) throw new Error('先将设计部件放入中性骨骼层级，再进行绑定。');
    let owner = part.wrapper;
    while (owner && owner !== draftRoot) owner = owner.parent;
    if (!owner || part.draft === part.source || part.draft === part.build) throw new Error('蒙皮绑定仅能修改独立的设计副本。');
    const meshes = [];
    part.draft.traverse((object) => { if (object.isMesh) meshes.push(object); });
    if (meshes.length !== (fused || splitBody ? 1 : 2) || meshes.some((mesh) => mesh.isSkinnedMesh || mesh.children.length || !mesh.geometry.attributes.position || !mesh.geometry.attributes.normal)) throw new Error('内置部件的静态网格结构与绑定版本不一致。');
    const bindingVersion = split ? config.design.bindingV7.version : fused ? fusedSettings.version : settings.version;
    const record = { slot, part, items: [], fusedBodyLegs: fused, splitBodyLegs: split, bindingVersion, originalUserData: structuredClone(part.draft.userData) };
    try {
      // Side is established by the existing hierarchy, including reflection.
      // Its side groups and local matrices are retained without baking them.
      draftRoot.updateWorldMatrix(true, true);
      const invDraft = draftRoot.matrixWorld.clone().invert();
      for (const original of meshes) {
        const geometry = original.geometry.clone();
        const material = Array.isArray(original.material) ? original.material.map((value) => value.clone()) : original.material.clone();
        const mesh = new THREE.SkinnedMesh(geometry, material);
        THREE.Object3D.prototype.copy.call(mesh, original, false);
        mesh.geometry = geometry;
        mesh.material = material;
        mesh.frustumCulled = false;
        mesh.userData = { ...mesh.userData, designOnly: true, skinning: true, bindingVersion, bindingSlot: fused ? 'body-legs' : slot, sourceVersion: expected.version, ...(spatial ? { bindingApproval: 'pending' } : {}) };
        geometry.computeBoundingBox();
        const center = geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(invDraft.clone().multiply(original.matrixWorld));
        const side = fused || splitBody ? 'both' : center.x < 0 ? 'L' : 'R';
        mesh.userData.bindingSide = side;
        const parent = original.parent;
        replaceChild(parent, original, mesh);
        record.items.push({ original, mesh, parent, side, fusedBodyLegs: fused, splitBodyLegs: split });
      }
      if (!fused && !splitBody && new Set(record.items.map((item) => item.side)).size !== 2) throw new Error('内置四肢未保持左右镜像分组。');
      records.set(part, record);
      part.draft.userData = { ...part.draft.userData, designOnly: true, skinning: true, bindingVersion, ...(spatial ? { bindingApproval: 'pending' } : {}) };
      rebind();
      apply(state);
      return true;
    } catch (error) {
      records.set(part, record);
      releasePart(part);
      throw error;
    }
  }

  function releasePart(part) {
    const record = records.get(part);
    if (!record) return false;
    records.delete(part);
    for (const { original, mesh, parent } of record.items) {
      if (mesh.parent === parent) replaceChild(parent, mesh, original);
      mesh.skeleton?.dispose();
      mesh.geometry.dispose();
      materialsOf(mesh).forEach((material) => material.dispose());
    }
    part.draft.userData = record.originalUserData;
    return true;
  }

  function getStats() {
    const active = [...records.values()];
    const items = active.flatMap((record) => record.items);
    const armsBound = active.some(record => record.slot === 'arms' && record.items.length === 2);
    const legsBound = active.some(record => record.slot === 'legs' && (record.fusedBodyLegs ? record.items.length === 1 : record.items.length === 2));
    const splitBodyLegs = active.some(record => record.splitBodyLegs);
    const bodyBound = active.some(record => record.slot === 'body' && record.splitBodyLegs && record.items.length === 1);
    const rigVersion = splitBodyLegs ? config.design.bindingV7.version : active.some(record => record.fusedBodyLegs) ? fusedSettings.version : settings.version;
    return {
      bones: allBones.length, limbBones: bones.length, skinnedMeshes: items.length,
      weightedVertices: items.reduce((sum, item) => sum + item.mesh.geometry.attributes.position.count, 0),
      maximumInfluences: 4, slots: active.map((record) => record.slot),
      armsBound, legsBound, bodyBound, completeLimbRig: armsBound && legsBound && (!splitBodyLegs || bodyBound),
      splitBodyLegs, rigVersion,
      fusedBodyLegs: active.some(record => record.fusedBodyLegs),
      bindingVersions: [...new Set(active.map(record => record.bindingVersion))],
      skinning: 'linear-blend', animations: 0,
    };
  }

  function dispose() {
    if (disposed) return;
    for (const part of [...records.keys()]) releasePart(part);
    for (const bone of bones) bone.removeFromParent();
    disposed = true;
  }

  apply(settings.defaults);
  return { bones, boneMap, bindPart, releasePart, apply, getStats, dispose };
}
