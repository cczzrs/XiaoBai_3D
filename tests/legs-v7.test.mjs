import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
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
const { createLimbRig } = await import('../web/src/limb-rig-v7.js');
const { createLimbRig: createV6Rig } = await import('../web/src/limb-rig-v6.js');
const { bakeActionClips } = await import('../web/src/action-export-v7.js');
const { sampleAction, applyAction, minimumSkinnedY } = await import('../web/src/action-motion.js');
const rootURL = new URL('../', import.meta.url), output = new URL('temp/legs-v7/', rootURL);
const defaultDirectory = await access(new URL('assets/design/legs-v7/legs.glb', rootURL)).then(() => 'assets/design/legs-v7').catch(() => 'temp/generated/legs-v7');
const candidate = new URL(`${process.env.LEGS_V7_DIRECTORY ?? defaultDirectory}/`, rootURL);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const attributeHash = a => sha256(new Uint8Array(a.array.buffer, a.array.byteOffset, a.array.byteLength));
const raw = mesh => Object.fromEntries(['position', 'normal'].map(name => [name, attributeHash(mesh.geometry.attributes[name])]).concat([['index', attributeHash(mesh.geometry.index)]]));
const meshes = root => { const result = []; root.traverse(n => { if (n.isMesh) result.push(n); }); return result; };
const bones = root => { const result = []; root.traverse(n => { if (n.isBone) result.push(n); }); return result; };
const pointKey = (x, y, z) => `${x}:${y}:${z}`;
const faceKey = ids => { const start = ids.indexOf(Math.min(...ids)); return [...ids.slice(start), ...ids.slice(0, start)].join(':'); };
const vector = (a, i) => [a.getX(i), a.getY(i), a.getZ(i)];
const sources = {}, sourceHashes = {}, fixtures = [], report = { schema: 'xiaobai.legs-v7-test.v1', candidate: candidate.pathname, checks: {}, poses: [], export: null,
  limitations: ['Cap containment is checked at every neutral vertex and triangle centroid, plus approximately one thousand samples per piece in walk/run/sit key poses against the actual assembled exterior triangles. This is not an exhaustive animated global intersection proof.', 'The eighty sampled poses establish exact original-vertex and shared-seam deformation, with bounded and reported deviation at new cut vertices; they do not prove validity of arbitrary user-edited joint extremes.'] };
let guides, sourceMesh, sourcePositions, sourceNormals, sourceIndex, sourceByPosition, sourceFaces, candidates, descriptions, geometryAudit, cutPoints;
const descriptionCache = new WeakMap();
const previousFileReader = globalThis.FileReader;

// Independent CPU linear-skin evaluation; does not use applyBoneTransform.
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

function describe(mesh) {
  if (descriptionCache.has(mesh)) return descriptionCache.get(mesh);
  const { position: p, normal: n } = mesh.geometry.attributes, index = mesh.geometry.index.array;
  const sourceIds = new Int32Array(p.count).fill(-1), outer = [], caps = [], outerVertices = new Set();
  const part = geometryAudit.parts[mesh.name === 'Leg_L' ? 'left' : mesh.name === 'Leg_R' ? 'right' : 'body'];
  if (geometryAudit.cutPointSources) {
    sourceIds.set(part.sourceVertexIds);
    for (let face = 0; face < index.length / 3; face += 1) {
      const ids = Array.from(index.slice(face * 3, face * 3 + 3));
      if (face < part.outerTriangleCount) { outer.push({ face, sourceFace: part.sourceFaceIds[face], ids }); ids.forEach(id => outerVertices.add(id)); }
      else caps.push(face);
    }
    const result = { mesh, sourceIds, outer, caps, outerVertices }; descriptionCache.set(mesh, result); return result;
  }
  for (let i = 0; i < p.count; i += 1) {
    const id = sourceByPosition.get(pointKey(p.getX(i), p.getY(i), p.getZ(i)));
    if (id !== undefined && vector(n, i).every((v, axis) => v === sourceNormals.array[id * 3 + axis])) sourceIds[i] = id;
  }
  for (let i = 0; i < index.length; i += 3) {
    const ids = Array.from(index.slice(i, i + 3)), mapped = ids.map(id => sourceIds[id]);
    const sourceFace = mapped.every(id => id >= 0) ? sourceFaces.get(faceKey(mapped)) : undefined;
    if (sourceFace !== undefined) { outer.push({ face: i / 3, sourceFace, ids }); ids.forEach(id => outerVertices.add(id)); }
    else caps.push(i / 3);
  }
  const result = { mesh, sourceIds, outer, caps, outerVertices };
  descriptionCache.set(mesh, result);
  return result;
}

// Actual delivered v6 triangles, accelerated by projected XY cells. Ray hits
// are paired to test neutral cap points, including concave cross-sections.
function zIntervals(positions = sourcePositions.array, triangleIndices = sourceIndex) {
  const cells = new Map(), spatialCells = new Map(), size = 1;
  const at = id => Array.from(positions.slice(id * 3, id * 3 + 3));
  const closeKey = point => point.map(value => Math.round(value * 1e6)).join(':');
  const surfaceVertices = new Set(Array.from({ length: positions.length / 3 }, (_, id) => closeKey(at(id))));
  for (let i = 0; i < triangleIndices.length; i += 3) {
    const p = Array.from(triangleIndices.slice(i, i + 3), at);
    const a = p[1].map((v, k) => v - p[0][k]), b = p[2].map((v, k) => v - p[0][k]), det = a[0] * b[1] - a[1] * b[0];
    const tri = { p: p[0], a, b, det };
    const lows = [0, 1, 2].map(axis => Math.floor(Math.min(...p.map(v => v[axis])) / size)), highs = [0, 1, 2].map(axis => Math.floor(Math.max(...p.map(v => v[axis])) / size));
    for (let x = lows[0]; x <= highs[0]; x += 1) for (let y = lows[1]; y <= highs[1]; y += 1) for (let z = lows[2]; z <= highs[2]; z += 1) {
      const key = `${x}:${y}:${z}`; if (!spatialCells.has(key)) spatialCells.set(key, []); spatialCells.get(key).push(tri);
    }
    if (Math.abs(det) < 1e-12) continue;
    for (let x = Math.floor(Math.min(...p.map(v => v[0])) / size); x <= Math.floor(Math.max(...p.map(v => v[0])) / size); x += 1)
      for (let y = Math.floor(Math.min(...p.map(v => v[1])) / size); y <= Math.floor(Math.max(...p.map(v => v[1])) / size); y += 1) {
        const key = `${x}:${y}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(tri);
      }
  }
  const depth = point => {
    if (surfaceVertices.has(closeKey(point))) return 0;
    const hits = [];
    for (const t of cells.get(`${Math.floor(point[0] / size)}:${Math.floor(point[1] / size)}`) ?? []) {
      const x = point[0] - t.p[0], y = point[1] - t.p[1];
      const u = (x * t.b[1] - y * t.b[0]) / t.det, v = (t.a[0] * y - t.a[1] * x) / t.det;
      if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
      hits.push(t.p[2] + u * t.a[2] + v * t.b[2]);
    }
    hits.sort((a, b) => a - b);
    const unique = hits.filter((value, i) => i === 0 || value - hits[i - 1] > 1e-5);
    let depth = -Infinity;
    for (let i = 0; i + 1 < unique.length; i += 2) depth = Math.max(depth, Math.min(point[2] - unique[i], unique[i + 1] - point[2]));
    return depth;
  };
  const triangle = new THREE.Triangle(), query = new THREE.Vector3(), closest = new THREE.Vector3();
  depth.distance = point => {
    const origin = point.map(value => Math.floor(value / size)), nearby = new Set();
    for (let x = origin[0] - 1; x <= origin[0] + 1; x += 1) for (let y = origin[1] - 1; y <= origin[1] + 1; y += 1) for (let z = origin[2] - 1; z <= origin[2] + 1; z += 1)
      for (const tri of spatialCells.get(`${x}:${y}:${z}`) ?? []) nearby.add(tri);
    query.fromArray(point); let distance = Infinity;
    for (const t of nearby) {
      triangle.a.fromArray(t.p); triangle.b.set(t.p[0] + t.a[0], t.p[1] + t.a[1], t.p[2] + t.a[2]); triangle.c.set(t.p[0] + t.b[0], t.p[1] + t.b[1], t.p[2] + t.b[2]);
      triangle.closestPointToPoint(query, closest); distance = Math.min(distance, closest.distanceTo(query));
    }
    return distance;
  };
  return depth;
}

function combinedOuter(surfaceMeshes, posed = false) {
  const positions = new Float64Array((sourcePositions.count + cutPoints.size) * 3), indices = [];
  for (const mesh of surfaceMeshes) {
    const d = describe(mesh), values = posed ? evaluated(mesh).positions : mesh.geometry.attributes.position.array;
    for (const id of d.outerVertices) positions.set(values.slice(id * 3, id * 3 + 3), d.sourceIds[id] * 3);
    for (const face of d.outer) indices.push(...face.ids.map(id => d.sourceIds[id]));
  }
  return { positions, indices };
}

function fixture(legacy = false) {
  const root = new THREE.Group(); root.name = 'XiaoBai_DesignDraft';
  root.userData = { rigType: legacy ? 'rig-v6' : 'rig-v7', rigApproval: 'pending', designOnly: true };
  const rootBone = new THREE.Bone(), bodyBone = new THREE.Bone(), neckBone = new THREE.Bone(), headBone = new THREE.Bone();
  [rootBone.name, bodyBone.name, neckBone.name, headBone.name] = ['XiaoBai_RigRoot', 'XiaoBai_RigBody', 'XiaoBai_RigNeck', 'XiaoBai_RigHead'];
  root.add(rootBone); rootBone.add(bodyBone); bodyBone.add(neckBone); neckBone.add(headBone);
  const { rootY, neckY } = config.design.defaults.rig, { bodyCenterY, headCenterY } = config.design.rigVisual;
  rootBone.position.y = rootY; bodyBone.position.y = bodyCenterY - rootY; neckBone.position.y = neckY - bodyCenterY; headBone.position.y = headCenterY - neckY;
  const rig = (legacy ? createV6Rig : createLimbRig)({ draftRoot: root, rootBone, bodyBone, config });
  const armPair = createMirroredArms(sources.arms, guides, config), parts = {};
  for (const slot of legacy ? ['head', 'arms', 'legs'] : ['head', 'arms', 'body', 'legs']) {
    const source = slot === 'arms' ? armPair : legacy && slot === 'legs' ? sources.v6 : sources[slot], draft = clonePart(source);
    const wrapper = new THREE.Group(), offset = new THREE.Group(), pivot = slot === 'head' ? headCenterY : slot === 'legs' ? rootY : bodyCenterY;
    wrapper.add(offset); offset.position.y = -pivot; offset.add(draft);
    (slot === 'head' ? headBone : slot === 'legs' ? rootBone : bodyBone).add(wrapper);
    const metadata = slot === 'legs' ? { builtin: legacy ? 'body-legs-fair-v6' : 'legs-separated-v7', sourceVersion: legacy ? 'legs-v6' : 'legs-v7' }
      : slot === 'body' ? { builtin: 'body-companion-v7', sourceVersion: 'body-design-v7' }
      : { builtin: config.assets[slot].builtin?.projectRecord.id, sourceVersion: config.assets[slot].builtin?.version ?? config.assets[slot].version };
    parts[slot] = { source, draft, wrapper, offset, metadata: { ...metadata, format: 'glb', designOnly: true } };
    root.updateMatrixWorld(true);
    if (slot !== 'head') assert.equal(rig.bindPart(parts[slot], slot), true, `${slot} did not bind`);
  }
  rig.apply(structuredClone(config.design.binding.defaults)); root.updateMatrixWorld(true);
  const f = { root, rootBone, bodyBone, rig, parts, armPair, surfaces: meshes(parts.legs.draft).concat(legacy ? [] : meshes(parts.body.draft)) };
  fixtures.push(f); return f;
}

function reset(f) {
  f.root.position.set(0, 0, 0); bones(f.root).forEach(b => b.quaternion.identity());
  f.rig.apply(structuredClone(config.design.binding.defaults)); f.root.updateMatrixWorld(true);
}

function comparePose(f, reference, label) {
  const actual = f.surfaces.map(evaluated), expected = evaluated(reference.surfaces[0]);
  let maximumPositionError = 0, maximumNormalError = 0, maximumCutPositionError = 0, maximumCutRelativeError = 0, nonfinite = 0;
  for (let m = 0; m < f.surfaces.length; m += 1) {
    const d = describe(f.surfaces[m]), state = actual[m];
    for (const value of [...state.positions, ...state.normals]) if (!Number.isFinite(value)) nonfinite += 1;
    for (const id of d.outerVertices) {
      const sourceId = d.sourceIds[id];
      if (sourceId < sourcePositions.count) for (let axis = 0; axis < 3; axis += 1) {
        maximumPositionError = Math.max(maximumPositionError, Math.abs(state.positions[id * 3 + axis] - expected.positions[sourceId * 3 + axis]));
        maximumNormalError = Math.max(maximumNormalError, Math.abs(state.normals[id * 3 + axis] - expected.normals[sourceId * 3 + axis]));
      } else {
        const cut = cutPoints.get(sourceId), edge = vector(sourcePositions, cut.a).map((v, axis) => v - sourcePositions.array[cut.b * 3 + axis]);
        const delta = [0, 1, 2].map(axis => state.positions[id * 3 + axis] - ((1 - cut.t) * expected.positions[cut.a * 3 + axis] + cut.t * expected.positions[cut.b * 3 + axis]));
        const error = Math.hypot(...delta); maximumCutPositionError = Math.max(maximumCutPositionError, error); maximumCutRelativeError = Math.max(maximumCutRelativeError, error / Math.hypot(...edge));
      }
    }
  }
  // All duplicate boundary vertices are independently skinned. Check actual
  // positions and normals agree across separate meshes, including cut points.
  const boundary = new Map(); let maximumSeamPositionError = 0, maximumSeamNormalError = 0;
  for (let m = 0; m < f.surfaces.length; m += 1) {
    const d = describe(f.surfaces[m]);
    for (const id of d.outerVertices) {
      const key = d.sourceIds[id], p = actual[m].positions.slice(id * 3, id * 3 + 3), n = actual[m].normals.slice(id * 3, id * 3 + 3), prior = boundary.get(key);
      if (prior) { maximumSeamPositionError = Math.max(maximumSeamPositionError, Math.hypot(...p.map((v, k) => v - prior.p[k]))); maximumSeamNormalError = Math.max(maximumSeamNormalError, Math.hypot(...n.map((v, k) => v - prior.n[k]))); }
      else boundary.set(key, { p, n });
    }
  }
  const entry = { label, maximumPositionError, maximumNormalError, maximumCutPositionError, maximumCutRelativeError, maximumSeamPositionError, maximumSeamNormalError, nonfinite };
  report.poses.push(entry);
  assert.equal(nonfinite, 0); assert.ok(maximumPositionError < 1e-9, JSON.stringify(entry)); assert.ok(maximumNormalError < 1e-9, JSON.stringify(entry));
  assert.ok(maximumSeamPositionError < 1e-9 && maximumSeamNormalError < 1e-9, JSON.stringify(entry));
  assert.ok(maximumCutPositionError < 0.005 && maximumCutRelativeError < 0.02, JSON.stringify(entry));
  return entry;
}

before(async () => {
  for (const [slot, path] of Object.entries({ head: new URL(config.assets.head.url, rootURL), arms: new URL(config.assets.arms.builtin.url, rootURL),
    legs: new URL('legs.glb', candidate), body: new URL('body.glb', candidate), v6: new URL('assets/design/legs-v6/body-legs.glb', rootURL) })) {
    const bytes = await readFile(path); sourceHashes[slot] = sha256(bytes);
    sources[slot] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  }
  guides = JSON.parse(await readFile(new URL(config.assets.arms.builtin.linesUrl, rootURL), 'utf8'));
  sourceMesh = meshes(sources.v6)[0]; sourcePositions = sourceMesh.geometry.attributes.position; sourceNormals = sourceMesh.geometry.attributes.normal; sourceIndex = sourceMesh.geometry.index.array;
  sourceByPosition = new Map(Array.from({ length: sourcePositions.count }, (_, i) => [pointKey(...vector(sourcePositions, i)), i]));
  sourceFaces = new Map(); for (let i = 0; i < sourceIndex.length; i += 3) sourceFaces.set(faceKey(Array.from(sourceIndex.slice(i, i + 3))), i / 3);
  geometryAudit = JSON.parse(await readFile(new URL('geometry-audit.json', candidate), 'utf8'));
  cutPoints = new Map((geometryAudit.cutPointSources ?? []).map(point => [point.globalId, point]));
  candidates = [...meshes(sources.legs), ...meshes(sources.body)]; descriptions = candidates.map(describe);
  globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
  await mkdir(output, { recursive: true });
});

after(async () => {
  await mkdir(output, { recursive: true });
  report.sourceHashes = sourceHashes; await writeFile(new URL('independent-v7-check.json', output), JSON.stringify(report, null, 2) + '\n');
  for (const f of fixtures) f.rig.dispose();
  disposeObjects([...Object.values(sources), ...fixtures.flatMap(f => [f.root, f.armPair])]);
  if (previousFileReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = previousFileReader;
  hook.deregister();
});

test('v7 delivers two independent leg meshes and one separately stored body design mesh', async () => {
  assert.equal(meshes(sources.legs).length, 2); assert.equal(meshes(sources.body).length, 1);
  assert.deepEqual(meshes(sources.legs).map(m => m.name).sort(), ['Leg_L', 'Leg_R']);
  assert.equal(new Set(candidates.map(m => m.geometry)).size, 3);
  for (const name of ['position', 'normal']) assert.equal(new Set(candidates.map(m => m.geometry.attributes[name].array.buffer)).size, 3);
  assert.equal(new Set(candidates.map(m => m.geometry.index.array.buffer)).size, 3);
  for (const model of [sources.legs, sources.body]) model.traverse(n => { assert.deepEqual(n.position.toArray(), [0, 0, 0]); assert.deepEqual(n.scale.toArray(), [1, 1, 1]); assert.deepEqual(n.quaternion.toArray(), [0, 0, 0, 1]); });
  for (const [name, file] of [['Leg_L', 'leg-left.glb'], ['Leg_R', 'leg-right.glb']]) {
    const bytes = await readFile(new URL(file, candidate)), loaded = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    assert.equal(meshes(loaded.scene).length, 1); const single = meshes(loaded.scene)[0]; assert.equal(single.name, name); assert.deepEqual(raw(single), raw(sources.legs.getObjectByName(name))); disposeObjects([loaded.scene]);
  }
  report.checks.independence = { legMeshes: 2, bodyMeshes: 1, separateGeometryAndBuffers: true, standaloneLegFilesExact: true };
});

test('the separated outer triangles cover the unchanged v6 surface without overlaps or holes', () => {
  const children = new Map(), deliveredChildren = new Map(); let maximumCutCoordinateError = 0, maximumCutNormalError = 0, maximumOffPlaneError = 0;
  const barycentric = (face, point) => {
    const ids = Array.from(sourceIndex.slice(face * 3, face * 3 + 3)), [a, b, c] = ids.map(id => vector(sourcePositions, id));
    const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i]), q = point.map((value, i) => value - a[i]);
    const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0), uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), det = uu * vv - uv * uv;
    const x = (dot(q, u) * vv - dot(q, v) * uv) / det, y = (dot(q, v) * uu - dot(q, u) * uv) / det;
    maximumOffPlaneError = Math.max(maximumOffPlaneError, Math.hypot(...q.map((value, i) => value - x * u[i] - y * v[i])));
    assert.ok(x > -2e-4 && y > -2e-4 && x + y < 1 + 2e-4); return [x, y];
  };
  const signedArea = points => points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0) / 2;
  const intersectionArea = (a, b) => {
    let polygon = a;
    for (let edge = 0; edge < 3 && polygon.length; edge += 1) {
      const p = b[edge], q = b[(edge + 1) % 3], distance = r => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const next = [];
      for (let i = 0; i < polygon.length; i += 1) {
        const p0 = polygon[i], p1 = polygon[(i + 1) % polygon.length], d0 = distance(p0), d1 = distance(p1);
        if (d0 >= 0) next.push(p0);
        if ((d0 >= 0) !== (d1 >= 0)) { const t = d0 / (d0 - d1); next.push(p0.map((v, j) => v + t * (p1[j] - v))); }
      }
      polygon = next;
    }
    return polygon.length >= 3 ? Math.abs(signedArea(polygon)) : 0;
  };
  for (const d of descriptions) {
    const p = d.mesh.geometry.attributes.position, n = d.mesh.geometry.attributes.normal;
    for (const id of d.outerVertices) {
      const globalId = d.sourceIds[id], point = vector(p, id), normal = vector(n, id);
      if (globalId < sourcePositions.count) { assert.deepEqual(point, vector(sourcePositions, globalId)); assert.deepEqual(normal, vector(sourceNormals, globalId)); }
      else {
        const cut = cutPoints.get(globalId); assert.ok(cut && cut.t > 0 && cut.t < 1);
        const expectedPoint = [0, 1, 2].map(axis => (1 - cut.t) * sourcePositions.array[cut.a * 3 + axis] + cut.t * sourcePositions.array[cut.b * 3 + axis]);
        const expectedNormal = [0, 1, 2].map(axis => (1 - cut.t) * sourceNormals.array[cut.a * 3 + axis] + cut.t * sourceNormals.array[cut.b * 3 + axis]);
        const length = Math.hypot(...expectedNormal);
        maximumCutCoordinateError = Math.max(maximumCutCoordinateError, Math.hypot(...point.map((v, axis) => v - expectedPoint[axis])));
        maximumCutNormalError = Math.max(maximumCutNormalError, Math.hypot(...normal.map((v, axis) => v - expectedNormal[axis] / length)));
      }
    }
    for (const face of d.outer) {
      assert.ok(Number.isInteger(face.sourceFace) && face.sourceFace >= 0 && face.sourceFace < sourceIndex.length / 3);
      const originalIds = Array.from(sourceIndex.slice(face.sourceFace * 3, face.sourceFace * 3 + 3));
      const deliveredTriangle = [], canonical = [[0, 0], [1, 0], [0, 1]];
      const triangle = face.ids.map(id => {
        const old = originalIds.indexOf(d.sourceIds[id]);
        if (old >= 0) { deliveredTriangle.push(canonical[old]); return canonical[old]; }
        deliveredTriangle.push(barycentric(face.sourceFace, vector(p, id)));
        const cut = cutPoints.get(d.sourceIds[id]), a = originalIds.indexOf(cut.a), b = originalIds.indexOf(cut.b);
        assert.ok(a >= 0 && b >= 0, 'cut point must lie on the declared source triangle edge');
        return canonical[a].map((v, axis) => (1 - cut.t) * v + cut.t * canonical[b][axis]);
      });
      assert.ok(signedArea(triangle) > 0, `source face ${face.sourceFace} flips`);
      if (!children.has(face.sourceFace)) children.set(face.sourceFace, []); children.get(face.sourceFace).push(triangle);
      if (!deliveredChildren.has(face.sourceFace)) deliveredChildren.set(face.sourceFace, []); deliveredChildren.get(face.sourceFace).push(deliveredTriangle);
    }
  }
  assert.equal(children.size, 288834); let maximumAreaError = 0, maximumOverlapArea = 0, maximumFloat32AreaError = 0, subdividedSourceFaces = 0;
  for (const triangles of children.values()) {
    if (triangles.length > 1) subdividedSourceFaces += 1;
    maximumAreaError = Math.max(maximumAreaError, Math.abs(triangles.reduce((sum, t) => sum + signedArea(t), 0) - 0.5));
    for (let i = 0; i < triangles.length; i += 1) for (let j = i + 1; j < triangles.length; j += 1) maximumOverlapArea = Math.max(maximumOverlapArea, intersectionArea(triangles[i], triangles[j]));
  }
  for (const triangles of deliveredChildren.values()) maximumFloat32AreaError = Math.max(maximumFloat32AreaError, Math.abs(triangles.reduce((sum, t) => sum + signedArea(t), 0) - 0.5));
  report.checks.outerShell = { sourceTriangles: children.size, subdividedSourceFaces, cutPoints: cutPoints.size, maximumAreaError, maximumOverlapArea, maximumFloat32AreaError, maximumCutCoordinateError, maximumCutNormalError, maximumOffPlaneError,
    parts: descriptions.map(d => ({ name: d.mesh.name, outerTriangles: d.outer.length, capTriangles: d.caps.length })) };
  assert.ok(maximumAreaError < 1e-8 && maximumOverlapArea < 1e-8, JSON.stringify(report.checks.outerShell));
  assert.ok(maximumCutCoordinateError < 3e-6 && maximumOffPlaneError < 3e-6 && maximumCutNormalError < 2e-7, JSON.stringify(report.checks.outerShell));
});

test('each accepted foot keeps all 15041 vertices and 29920 triangles on its corresponding independent leg', () => {
  const result = [];
  for (const [side, start] of [['R', 0], ['L', 15041]]) {
    const d = descriptions.find(d => d.mesh.name === `Leg_${side}`), ids = new Set([...d.outerVertices].map(id => d.sourceIds[id]));
    for (let id = start; id < start + 15041; id += 1) assert.ok(ids.has(id), `${side}: missing foot vertex ${id}`);
    const count = d.outer.filter(f => f.ids.every(id => d.sourceIds[id] >= start && d.sourceIds[id] < start + 15041)).length;
    assert.equal(count, 29920); result.push({ side, vertices: 15041, triangles: count });
  }
  report.checks.acceptedFeet = result;
});

test('each separated piece is closed after position welding, with internal caps and finite geometry', () => {
  const exterior = combinedOuter(candidates), depth = zIntervals(exterior.positions, exterior.indices), summaries = [];
  report.checks.closedPieces = summaries;
  for (const d of descriptions) {
    const { position: p, normal: n } = d.mesh.geometry.attributes, indices = d.mesh.geometry.index.array, weld = new Map(), ids = [], points = [];
    for (let i = 0; i < p.count; i += 1) {
      const point = vector(p, i), key = pointKey(...point); assert.ok(point.every(Number.isFinite) && vector(n, i).every(Number.isFinite));
      if (!weld.has(key)) { weld.set(key, points.length); points.push(point); } ids.push(weld.get(key));
    }
    const edges = new Map(), faceSet = new Set(), parent = Array.from({ length: points.length }, (_, i) => i), faceNormals = [], capFaces = new Set(d.caps);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    let minimumArea = Infinity, volume = 0, capOpposedNormals = 0, capMinimumNormalDot = 1;
    for (let i = 0; i < indices.length; i += 3) {
      const tri = Array.from(indices.slice(i, i + 3), id => ids[id]), [a, b, c] = tri.map(id => points[id]);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], magnitude = Math.hypot(...cross); minimumArea = Math.min(minimumArea, magnitude / 2);
      const faceNormal = cross.map(v => v / magnitude); faceNormals.push(faceNormal);
      if (capFaces.has(i / 3)) for (const id of indices.slice(i, i + 3)) {
        const normal = vector(n, id), dot = faceNormal.reduce((sum, v, axis) => sum + v * normal[axis], 0) / Math.hypot(...normal);
        capMinimumNormalDot = Math.min(capMinimumNormalDot, dot); if (dot <= 0) capOpposedNormals += 1;
      }
      volume += (a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2]) / 6;
      const face = tri.slice().sort((a, b) => a - b).join(':'); assert.ok(!faceSet.has(face), `${d.mesh.name}: duplicate face`); faceSet.add(face);
      for (let k = 0; k < 3; k += 1) {
        const a = tri[k], b = tri[(k + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`, edge = edges.get(key) ?? [0, 0, []];
        edge[0] += 1; edge[1] += a < b ? 1 : -1; edge[2].push(i / 3); edges.set(key, edge); parent[find(a)] = find(b);
      }
    }
    const outside = [], capVertices = new Set(d.caps.flatMap(face => Array.from(indices.slice(face * 3, face * 3 + 3))));
    let capSamples = 0, minimumCapDepth = Infinity, maximumOutsideDistance = 0;
    const inspect = (point, location) => {
      const value = depth(point); minimumCapDepth = Math.min(minimumCapDepth, value); capSamples += 1;
      if (value < -2e-5) { const distance = depth.distance(point); maximumOutsideDistance = Math.max(maximumOutsideDistance, distance); if (distance > 2e-5 && outside.length < 8) outside.push({ point, value, distance, location }); }
    };
    for (const id of capVertices) inspect(vector(p, id), `vertex:${id}`);
    for (const face of d.caps) inspect([0, 1, 2].map(axis => Array.from(indices.slice(face * 3, face * 3 + 3)).reduce((sum, id) => sum + p.array[id * 3 + axis] / 3, 0)), `face:${face}`);
    const seamAngles = [], capAngles = [];
    for (const edge of edges.values()) if (edge[0] === 2 && edge[2].some(f => capFaces.has(f))) {
      const [a, b] = edge[2].map(f => faceNormals[f]), angle = Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, v, axis) => sum + v * b[axis], 0)))) * 180 / Math.PI;
      (edge[2].every(f => capFaces.has(f)) ? capAngles : seamAngles).push(angle);
    }
    seamAngles.sort((a, b) => a - b); capAngles.sort((a, b) => a - b);
    let maximumPoleApproachAngle = 0, maximumTopMeridianTurn = 0;
    if (/^Leg_/.test(d.mesh.name)) for (const cap of geometryAudit.parts[d.mesh.name === 'Leg_L' ? 'left' : 'right'].caps) {
      const pole = vector(p, cap.poleVertex); assert.ok(n.getY(cap.poleVertex) > 0.98, 'leg pole normal must point upward');
      for (let j = 0; j < cap.verticesPerRing; j += 1) {
        const top = [cap.ringCount - 3, cap.ringCount - 2, cap.ringCount - 1].map(row => vector(p, cap.vertexStart + row * cap.verticesPerRing + j)).concat([pole]);
        const last = top[3].map((v, axis) => v - top[2][axis]);
        maximumPoleApproachAngle = Math.max(maximumPoleApproachAngle, Math.atan2(Math.abs(last[1]), Math.hypot(last[0], last[2])) * 180 / Math.PI);
        for (let k = 1; k < top.length - 1; k += 1) {
          const a = top[k].map((v, axis) => v - top[k - 1][axis]), b = top[k + 1].map((v, axis) => v - top[k][axis]);
          maximumTopMeridianTurn = Math.max(maximumTopMeridianTurn, Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, v, axis) => sum + v * b[axis], 0) / Math.hypot(...a) / Math.hypot(...b)))) * 180 / Math.PI);
        }
      }
    }
    const summary = { name: d.mesh.name, components: new Set(parent.map((_, i) => find(i))).size, nonmanifoldEdges: [...edges.values()].filter(e => e[0] !== 2).length,
      inconsistentEdges: [...edges.values()].filter(e => e[1] !== 0).length, euler: points.length - edges.size + indices.length / 3, minimumArea, volume, capSamples, minimumCapDepth, maximumOutsideDistance, outside,
      capOpposedNormals, capMinimumNormalDot, maximumSeamFaceAngle: seamAngles.at(-1), p99SeamFaceAngle: seamAngles[Math.floor(seamAngles.length * 0.99)], maximumCapFaceAngle: capAngles.at(-1), p99CapFaceAngle: capAngles[Math.floor(capAngles.length * 0.99)], maximumPoleApproachAngle, maximumTopMeridianTurn };
    summaries.push(summary);
    assert.equal(summary.components, 1); assert.equal(summary.nonmanifoldEdges, 0, JSON.stringify(summary)); assert.equal(summary.inconsistentEdges, 0); assert.equal(summary.euler, 2);
    assert.ok(minimumArea > 1e-12 && volume > 0, JSON.stringify(summary));
  }
  assert.deepEqual(summaries.filter(s => s.outside.length), [], JSON.stringify(summaries));
  assert.deepEqual(summaries.filter(s => s.capOpposedNormals || s.maximumCapFaceAngle >= 90 || s.maximumSeamFaceAngle >= 30), [], JSON.stringify(summaries));
  assert.deepEqual(summaries.filter(s => s.maximumPoleApproachAngle >= 10 || s.maximumTopMeridianTurn >= 15), [], JSON.stringify(summaries));
});

test('v7 binds five skins to twenty bones and preserves v6 outer weights and neutral shape', () => {
  const f = fixture(), reference = fixture(true); assert.equal(meshes(f.root).filter(m => m.isSkinnedMesh).length, 5); assert.equal(bones(f.root).length, 20);
  const original = reference.surfaces[0].geometry.attributes, seamWeights = new Map();
  for (const mesh of f.surfaces) {
    const d = describe(mesh), a = mesh.geometry.attributes;
    for (const id of d.outerVertices) for (let c = 0; c < 4; c += 1) {
      if (d.sourceIds[id] < sourcePositions.count) {
        assert.equal(a.skinIndex.array[id * 4 + c], original.skinIndex.array[d.sourceIds[id] * 4 + c]);
        assert.equal(a.skinWeight.array[id * 4 + c], original.skinWeight.array[d.sourceIds[id] * 4 + c]);
      }
      const key = `${d.sourceIds[id]}:${c}`, pair = [a.skinIndex.array[id * 4 + c], a.skinWeight.array[id * 4 + c]];
      if (seamWeights.has(key)) assert.deepEqual(pair, seamWeights.get(key)); else seamWeights.set(key, pair);
    }
    for (let i = 0; i < a.position.count; i += 1) {
      const weights = Array.from(a.skinWeight.array.slice(i * 4, i * 4 + 4)); assert.ok(weights.every(w => Number.isFinite(w) && w >= 0 && w <= 1)); assert.equal(weights.reduce((a, b) => a + b), 1);
    }
  }
  comparePose(f, reference, 'neutral');
  report.checks.binding = { skins: 5, bones: 20, exactOriginalVertexWeights: true, exactSharedSeamWeights: true, exactWeightSum: 1 };
});

test('independent pieces preserve their seams and bound cut-vertex deformation across joints and all five actions', () => {
  const f = fixture(), reference = fixture(true), actions = createDefaultProject().actions;
  for (const side of ['L', 'R']) for (const [joint, angle] of [['hip', 15], ['knee', 20], ['ankle', 12]]) {
    for (const target of [f, reference]) { reset(target); const state = structuredClone(config.design.binding.defaults); state.rotations[joint + side] = [angle, 0, 0]; target.rig.apply(state); target.root.updateMatrixWorld(true); }
    comparePose(f, reference, `${joint}${side}`);
  }
  for (const target of [f, reference]) { reset(target); target.bodyBone.rotation.x = THREE.MathUtils.degToRad(12); target.root.updateMatrixWorld(true); }
  comparePose(f, reference, 'bodyLean12');
  for (const name of config.design.actions.names) {
    const phases = ['walk', 'run'].includes(name) ? Array.from({ length: 32 }, (_, i) => i / 32) : name === 'sit' ? [0] : [0, 0.25, 0.5, 0.75];
    for (const phase of phases) {
      const sample = sampleAction(name, phase, actions, config);
      for (const target of [f, reference]) { reset(target); applyAction(target.root, sample, config); }
      comparePose(f, reference, `${name}:${phase}`);
      if (sample.grounded) assert.ok(Math.abs(minimumSkinnedY(f.surfaces) - config.design.actions.ground.level) < 1e-8);
      if (['walk', 'run', 'sit'].includes(name) && phase === 0) {
        const exterior = combinedOuter(f.surfaces, true), depth = zIntervals(exterior.positions, exterior.indices), poseCaps = [];
        for (const mesh of f.surfaces) {
          const d = describe(mesh), positions = evaluated(mesh).positions, indices = mesh.geometry.index.array;
          const capVertices = [...new Set(d.caps.flatMap(face => Array.from(indices.slice(face * 3, face * 3 + 3))))], outside = [];
          let samples = 0, minimumDepth = Infinity, maximumOutsideDistance = 0;
          const inspect = (point, location) => { const value = depth(point); samples += 1; minimumDepth = Math.min(minimumDepth, value); if (value < -2e-5) { const distance = depth.distance(point); maximumOutsideDistance = Math.max(maximumOutsideDistance, distance); if (distance > 2e-5 && outside.length < 8) outside.push({ point, value, distance, location }); } };
          const vertexStep = Math.max(1, Math.floor(capVertices.length / 500)), faceStep = Math.max(1, Math.floor(d.caps.length / 500));
          for (let i = 0; i < capVertices.length; i += vertexStep) { const id = capVertices[i]; inspect(Array.from(positions.slice(id * 3, id * 3 + 3)), `vertex:${id}`); }
          for (let i = 0; i < d.caps.length; i += faceStep) { const face = d.caps[i]; inspect([0, 1, 2].map(axis => Array.from(indices.slice(face * 3, face * 3 + 3)).reduce((sum, id) => sum + positions[id * 3 + axis] / 3, 0)), `face:${face}`); }
          poseCaps.push({ name: mesh.name, samples, minimumDepth, maximumOutsideDistance, outside });
        }
        report.checks.animatedCaps ??= []; report.checks.animatedCaps.push({ pose: name, parts: poseCaps });
      }
    }
  }
  for (const target of [f, reference]) reset(target); comparePose(f, reference, 'restored');
  assert.deepEqual(report.checks.animatedCaps.flatMap(pose => pose.parts.filter(part => part.outside.length).map(part => ({ pose: pose.pose, ...part }))), []);
  report.checks.motion = { poses: 80, exactOriginalVertexDeformation: true, exactSharedBoundaryDeformation: true, cutVertexDeviationQuantified: true };
});

test('GLB export and reload preserve separate body and legs, five skins and five playable clips', async () => {
  const f = fixture(), { root, clips } = bakeActionClips(f.root, createDefaultProject().actions, config), bytes = await exportModel(root, clips);
  const loaded = await new GLTFLoader().parseAsync(bytes, ''), skinMeshes = meshes(loaded.scene).filter(m => m.isSkinnedMesh);
  assert.equal(meshes(loaded.scene).length, 9); assert.equal(skinMeshes.length, 5); assert.equal(bones(loaded.scene).length, 20); assert.equal(loaded.animations.length, 5);
  const legMeshes = skinMeshes.filter(m => /^Leg_[LR]$/.test(m.name)); assert.equal(legMeshes.length, 2);
  assert.equal(root.userData.rigType, 'rig-v7'); assert.equal(root.userData.rigApproval, 'pending'); assert.equal(root.userData.deformationApproval, 'pending');
  for (const mesh of f.surfaces) { const exported = loaded.scene.getObjectByName(mesh.name); assert.ok(exported?.isSkinnedMesh); assert.equal(attributeHash(exported.geometry.attributes.position), raw(mesh).position); assert.equal(attributeHash(exported.geometry.index), raw(mesh).index); }
  const surfaceNames = new Set(f.surfaces.map(m => m.name)), loadedSurfaces = skinMeshes.filter(m => surfaceNames.has(m.name)), rest = loadedSurfaces.map(evaluated);
  for (const clip of loaded.animations) {
    assert.equal(clip.tracks.length, 22); for (const track of clip.tracks) assert.ok(Array.from(track.values).every(Number.isFinite));
    const mixer = new THREE.AnimationMixer(loaded.scene); mixer.clipAction(clip).play(); mixer.setTime(clip.duration * 0.25); loaded.scene.updateMatrixWorld(true);
    if (/walk|run|sit/.test(clip.name)) {
      const changed = loadedSurfaces.some((m, i) => evaluated(m).positions.some((v, j) => Math.abs(v - rest[i].positions[j]) > 0.1)); assert.ok(changed, `${clip.name}: no motion`);
      assert.ok(Math.abs(minimumSkinnedY(loadedSurfaces) - config.design.actions.ground.level) < 2e-5);
    }
    mixer.stopAllAction(); loaded.scene.updateMatrixWorld(true);
  }
  await writeFile(new URL('actions-test-export.glb', output), Buffer.from(bytes));
  report.export = { bytes: bytes.byteLength, sha256: sha256(new Uint8Array(bytes)), meshes: 9, skins: 5, bones: 20, clips: loaded.animations.map(c => ({ name: c.name, duration: c.duration, tracks: c.tracks.length })), rigApproval: 'pending' };
  disposeObjects([root, loaded.scene]);
});

test('v6 geometry, approved originals, historical implementations and rig-v1 settings remain byte exact', async () => {
  assert.equal(sourceHashes.v6, 'd6304d97b26ddd0745a1907f0d423611f40f2b7949c1d528be97bd9a3ec16edd');
  const approval = JSON.parse(await readFile(new URL('docs/approvals/actions-v1-approved.json', rootURL), 'utf8'));
  const locks = await Promise.all([...approval.lockedFileSnapshot, ...approval.implementationSnapshot].map(async item => {
    const bytes = await readFile(historicalURL(item.path)); return { path: item.path, unchanged: bytes.byteLength === item.sizeBytes && sha256(bytes) === item.sha256 };
  }));
  assert.equal(locks.length, 26); assert.deepEqual(locks.filter(item => !item.unchanged), []);
  const approved = JSON.parse(await readFile(new URL('assets/design/rig-v1/parameters.json', rootURL), 'utf8')); assert.deepEqual(config.design.binding, { ...approved.binding, approval: 'approved' });
  report.checks.immutableBaselines = locks;
});
