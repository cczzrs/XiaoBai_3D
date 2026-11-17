import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { historicalURL } from '../scripts/project-paths.mjs';

const root = new URL('../', import.meta.url);
const defaultDirectory = await access(new URL('assets/design/legs-v8/legs.glb', root)).then(() => 'assets/design/legs-v8').catch(() => 'temp/generated/legs-v8');
const candidate = new URL(`${process.env.LEGS_V8_DIRECTORY ?? defaultDirectory}/`, root);
const output = new URL('temp/legs-v8/', root);
// Fixed independently from the accepted foot, rather than copied from a new audit.
const FOOT_COUNT = 15041, FOOT_FIRST_RING = 14881, FOOT_TRIANGLES = 29920, RADIAL = 160, FRONT_BACK_Z = 4;
const POSITION_EPSILON = 2e-6, SURFACE_EPSILON = 3e-6, UPPER_NORMAL_EPSILON = 1e-5;
const report = { schema: 'xiaobai.legs-v8-independent-geometry.v1', candidate: candidate.pathname, checks: {}, sourceHashes: {},
  tolerances: { position: POSITION_EPSILON, reflectedSurface: SURFACE_EPSILON, upperNormal: UPPER_NORMAL_EPSILON, inheritedFootNormalReflection: 5e-4, hiddenSurface: 0.002 },
  limitations: ['The accepted foot normals are retained byte-for-byte; their inherited front/back reflection discrepancy is reported separately.', 'Neutral containment samples all vertices and triangle centroids; this is not a global triangle-intersection or animated-pose proof.', 'Shading-rate samples and mesh continuity require accompanying multi-angle Chrome visual review.'] };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const mul = (a, s) => a.map(v => v * s);
const distance = (a, b) => length(sub(a, b));
const blend = (a, b, t) => a.map((v, i) => v + t * (b[i] - v));
const unit = a => a.map(v => v / length(a));
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (length(a) * length(b))))) * 180 / Math.PI;
const reflectPoint = p => [p[0], p[1], 2 * FRONT_BACK_Z - p[2]];
const reflectNormal = n => [n[0], n[1], -n[2]];
const faceKey = ids => { const start = ids.indexOf(Math.min(...ids)); return [...ids.slice(start), ...ids.slice(0, start)].join(':'); };
const bufferFor = (values, type = Float32Array) => Buffer.from(new type(values.flat()).buffer);
const meshHashes = mesh => ({ positions: sha256(bufferFor(mesh.positions)), normals: sha256(bufferFor(mesh.normals)), indices: sha256(bufferFor(mesh.indices, Uint32Array)) });

// Direct GLB/accessor decoding keeps the assertions independent of the model generators.
function decodeGLB(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12), document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = bytes.subarray(28 + jsonLength);
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const formats = { 5126: ['readFloatLE', 4], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4], 5121: ['readUInt8', 1] };
  const accessor = id => {
    const a = document.accessors[id], view = document.bufferViews[a.bufferView];
    assert.ok(!a.sparse, 'Unexpected sparse accessor');
    const [read, bytesPerElement] = formats[a.componentType], width = widths[a.type];
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride ?? bytesPerElement * width;
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, j) => binary[read](start + stride * i + bytesPerElement * j)));
  };
  return { document, meshes: document.nodes.filter(node => node.mesh !== undefined).map(node => {
    const primitives = document.meshes[node.mesh].primitives; assert.equal(primitives.length, 1);
    const p = primitives[0]; assert.ok(p.mode === undefined || p.mode === 4);
    const scale = node.scale ?? [1, 1, 1];
    assert.deepEqual(node.translation ?? [0, 0, 0], [0, 0, 0]); assert.deepEqual(node.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]); assert.equal(node.matrix, undefined);
    assert.ok(scale.every(v => Math.abs(v) === 1), 'Only an exact mesh mirror is allowed here');
    const positions = accessor(p.attributes.POSITION).map(a => a.map((v, i) => v * scale[i]));
    const normals = accessor(p.attributes.NORMAL).map(a => a.map((v, i) => v * scale[i]));
    const indices = accessor(p.indices).flat();
    if (scale.reduce((a, b) => a * b, 1) < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    return { ...node, attributes: p.attributes, positions, normals, indices };
  }) };
}

function reflectionMap(mesh) {
  const cells = new Map(), step = POSITION_EPSILON;
  const cell = p => p.map(v => Math.floor(v / step));
  for (let i = 0; i < mesh.positions.length; i += 1) {
    const key = cell(mesh.positions[i]).join(':'); if (!cells.has(key)) cells.set(key, []); cells.get(key).push(i);
  }
  let maximumPositionError = 0;
  const partners = mesh.positions.map((p, i) => {
    const q = reflectPoint(p), c = cell(q); let best = -1, error = Infinity;
    for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1)
      for (const id of cells.get([c[0] + x, c[1] + y, c[2] + z].join(':')) ?? []) {
        const d = distance(q, mesh.positions[id]); if (d < error) { error = d; best = id; }
      }
    assert.ok(best >= 0 && error <= POSITION_EPSILON, `${mesh.name}: unpaired vertex ${i} ${p}, error=${error}`);
    maximumPositionError = Math.max(maximumPositionError, error); return best;
  });
  return { partners, maximumPositionError };
}

function closestTriangleDistance(q, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(q, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return distance(q, a);
  const bp = sub(q, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return distance(q, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return distance(q, blend(a, b, d1 / (d1 - d3)));
  const cp = sub(q, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return distance(q, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return distance(q, blend(a, c, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return distance(q, blend(b, c, (d4 - d3) / (d4 - d3 + d5 - d6)));
  const inverse = 1 / (va + vb + vc), v = vb * inverse, w = vc * inverse;
  return distance(q, a.map((value, i) => value + ab[i] * v + ac[i] * w));
}

function topology(mesh) {
  const positionIds = new Map(), welded = [], points = [], edges = new Map(), faces = new Set();
  for (const p of mesh.positions) { const key = p.join(':'); if (!positionIds.has(key)) { positionIds.set(key, points.length); points.push(p); } welded.push(positionIds.get(key)); }
  const parents = points.map((_, i) => i), find = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; } return id; };
  const result = { name: mesh.name, vertices: mesh.positions.length, weldedVertices: points.length, triangles: mesh.indices.length / 3, signedVolume: 0,
    nonfinite: 0, degenerateTriangles: 0, opposedNormals: 0, duplicateFaces: 0, minimumTriangleArea: Infinity, minimumNormalLength: Infinity, maximumNormalLength: 0 };
  for (const p of [...mesh.positions, ...mesh.normals]) if (!p.every(Number.isFinite)) result.nonfinite += 1;
  for (const n of mesh.normals) { result.minimumNormalLength = Math.min(result.minimumNormalLength, length(n)); result.maximumNormalLength = Math.max(result.maximumNormalLength, length(n)); }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const original = mesh.indices.slice(i, i + 3), ids = original.map(id => welded[id]), p = original.map(id => mesh.positions[id]);
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0])), area = length(n) / 2;
    result.minimumTriangleArea = Math.min(result.minimumTriangleArea, area); if (area <= 1e-12) result.degenerateTriangles += 1;
    for (const id of original) if (dot(n, mesh.normals[id]) < -1e-10) result.opposedNormals += 1;
    result.signedVolume += dot(p[0], cross(p[1], p[2])) / 6;
    const face = ids.slice().sort((a, b) => a - b).join(':'); if (faces.has(face)) result.duplicateFaces += 1; faces.add(face);
    for (let j = 0; j < 3; j += 1) {
      const a = ids[j], b = ids[(j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key) ?? { count: 0, winding: 0 }; edge.count += 1; edge.winding += a < b ? 1 : -1; edges.set(key, edge); parents[find(a)] = find(b);
    }
  }
  result.components = new Set(parents.map((_, i) => find(i))).size;
  result.nonmanifoldEdges = [...edges.values()].filter(e => e.count !== 2).length;
  result.inconsistentWindingEdges = [...edges.values()].filter(e => e.winding !== 0).length;
  result.eulerCharacteristic = points.length - edges.size + mesh.indices.length / 3;
  return result;
}

// XY-cell acceleration of intersections with the actual delivered triangles.
function surfaceSampler(mesh) {
  const cells = new Map(), size = 1, points = mesh.positions, normals = mesh.normals;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = mesh.indices.slice(i, i + 3), p = ids.map(id => points[id]);
    const ab = sub(p[1], p[0]), ac = sub(p[2], p[0]), determinant = ab[0] * ac[1] - ab[1] * ac[0];
    const face = { ids, a: p[0], ab, ac, determinant };
    for (let x = Math.floor(Math.min(...p.map(v => v[0])) / size); x <= Math.floor(Math.max(...p.map(v => v[0])) / size); x += 1)
      for (let y = Math.floor(Math.min(...p.map(v => v[1])) / size); y <= Math.floor(Math.max(...p.map(v => v[1])) / size); y += 1) {
        const key = `${x}:${y}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(face);
      }
  }
  const sample = (x, y) => {
    const hits = [];
    for (const f of cells.get(`${Math.floor(x / size)}:${Math.floor(y / size)}`) ?? []) {
      if (Math.abs(f.determinant) < 1e-14) continue;
      const dx = x - f.a[0], dy = y - f.a[1], u = (dx * f.ac[1] - f.ac[0] * dy) / f.determinant, v = (f.ab[0] * dy - dx * f.ab[1]) / f.determinant;
      if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
      const z = f.a[2] + f.ab[2] * u + f.ac[2] * v;
      if (!hits.some(h => Math.abs(h.point[2] - z) < 1e-6)) hits.push({ point: [x, y, z], normal: unit([0, 1, 2].map(k => (1 - u - v) * normals[f.ids[0]][k] + u * normals[f.ids[1]][k] + v * normals[f.ids[2]][k])) });
    }
    return hits.sort((a, b) => a.point[2] - b.point[2]);
  };
  sample.nearestDistance = point => {
    const nearby = new Set(), x = Math.floor(point[0] / size), y = Math.floor(point[1] / size);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (const face of cells.get(`${x + dx}:${y + dy}`) ?? []) nearby.add(face);
    return Math.min(...[...nearby].map(f => closestTriangleDistance(point, ...f.ids.map(id => points[id]))));
  };
  return sample;
}

let legs, body, sourceFoot, audit, bodyAudit, sourceFootIndices, reflect;
before(async () => {
  const load = async (name, url) => { const bytes = await readFile(url); report.sourceHashes[name] = sha256(bytes); return decodeGLB(bytes); };
  [legs, body, sourceFoot, audit, bodyAudit] = await Promise.all([
    load('legsV8', new URL('legs.glb', candidate)), load('bodyV8', new URL('body.glb', candidate)),
    load('legsV4', new URL('assets/design/legs-v4/legs.glb', root)), json(new URL('geometry-audit.json', candidate)), json(new URL('body-audit.json', candidate)),
  ]);
  sourceFoot = sourceFoot.meshes.find(m => m.name === 'Leg_R');
  sourceFootIndices = [];
  for (let i = 0; i < sourceFoot.indices.length; i += 3) if (Math.max(...sourceFoot.indices.slice(i, i + 3)) < FOOT_COUNT) sourceFootIndices.push(...sourceFoot.indices.slice(i, i + 3));
  assert.equal(sourceFootIndices.length / 3, FOOT_TRIANGLES);
  reflect = new Map(); await mkdir(output, { recursive: true });
});
after(async () => { await mkdir(output, { recursive: true }); await writeFile(new URL('independent-v8-geometry-check.json', output), JSON.stringify(report, null, 2) + '\n'); });

test('v8 delivers two independent legs, a separate body companion, and exact standalone leg files', async () => {
  assert.equal(legs.meshes.length, 2); assert.equal(body.meshes.length, 1);
  assert.deepEqual(legs.meshes.map(m => m.name).sort(), ['Leg_L', 'Leg_R']);
  assert.notEqual(legs.meshes[0].mesh, legs.meshes[1].mesh);
  for (const name of ['POSITION', 'NORMAL']) assert.notEqual(legs.meshes[0].attributes[name], legs.meshes[1].attributes[name]);
  for (const model of [legs, body]) for (const n of model.document.nodes) {
    assert.deepEqual(n.translation ?? [0, 0, 0], [0, 0, 0]); assert.deepEqual(n.scale ?? [1, 1, 1], n.name === 'Leg_L' ? [-1, 1, 1] : [1, 1, 1]); assert.deepEqual(n.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]); assert.equal(n.matrix, undefined);
  }
  for (const [name, file] of [['Leg_L', 'leg-left.glb'], ['Leg_R', 'leg-right.glb']]) {
    const single = decodeGLB(await readFile(new URL(file, candidate))); assert.equal(single.meshes.length, 1); assert.equal(single.meshes[0].name, name);
    assert.deepEqual(meshHashes(single.meshes[0]), meshHashes(legs.meshes.find(m => m.name === name)));
  }
  report.checks.independence = { legMeshes: 2, bodyMeshes: 1, distinctMeshAccessors: true, standaloneFilesExact: true };
});

test('each accepted foot retains all position, normal and oriented triangle bytes', () => {
  const results = [];
  for (const mesh of legs.meshes) {
    const sign = mesh.name === 'Leg_R' ? 1 : -1;
    const positions = sourceFoot.positions.slice(0, FOOT_COUNT).map(p => [p[0] * sign, p[1], p[2]]), normals = sourceFoot.normals.slice(0, FOOT_COUNT).map(n => [n[0] * sign, n[1], n[2]]);
    const expectedIndices = [];
    for (let i = 0; i < sourceFootIndices.length; i += 3) expectedIndices.push(...(sign > 0 ? sourceFootIndices.slice(i, i + 3) : [sourceFootIndices[i], sourceFootIndices[i + 2], sourceFootIndices[i + 1]]));
    const actualIndices = [];
    for (let i = 0; i < mesh.indices.length; i += 3) if (Math.max(...mesh.indices.slice(i, i + 3)) < FOOT_COUNT) actualIndices.push(...mesh.indices.slice(i, i + 3));
    assert.deepEqual(bufferFor(mesh.positions.slice(0, FOOT_COUNT)), bufferFor(positions), `${mesh.name}: foot positions changed`);
    assert.deepEqual(bufferFor(mesh.normals.slice(0, FOOT_COUNT)), bufferFor(normals), `${mesh.name}: foot normals changed`);
    assert.deepEqual(bufferFor(actualIndices, Uint32Array), bufferFor(expectedIndices, Uint32Array), `${mesh.name}: foot oriented triangles changed`);
    results.push({ name: mesh.name, vertices: FOOT_COUNT, triangles: actualIndices.length / 3, positionNormalAndIndexBytesExact: true });
  }
  report.checks.acceptedFeet = results;
});

test('the complete independent legs reflect about z=4, with inherited foot normals reported separately', () => {
  const results = [];
  for (const mesh of legs.meshes) {
    const mapping = reflectionMap(mesh); reflect.set(mesh.name, mapping.partners);
    let maximumFootNormalError = 0, maximumUpperNormalError = 0;
    for (let i = 0; i < mesh.positions.length; i += 1) {
      const error = distance(reflectNormal(mesh.normals[i]), mesh.normals[mapping.partners[i]]);
      if (i < FOOT_COUNT) maximumFootNormalError = Math.max(maximumFootNormalError, error); else maximumUpperNormalError = Math.max(maximumUpperNormalError, error);
    }
    results.push({ name: mesh.name, planeZ: FRONT_BACK_Z, maximumPositionError: mapping.maximumPositionError, maximumFootNormalError, maximumUpperNormalError });
    assert.ok(maximumFootNormalError < 5e-4, JSON.stringify(results.at(-1)));
    assert.ok(maximumUpperNormalError < UPPER_NORMAL_EPSILON, JSON.stringify(results.at(-1)));
  }
  report.checks.frontBackReflection = results;
});

test('actual reflected upper triangles and preserved foot surfaces agree, not only the vertex cloud', () => {
  const results = [];
  for (const mesh of legs.meshes) {
    const partners = reflect.get(mesh.name) ?? reflectionMap(mesh).partners, faces = new Set(), adjacent = Array.from({ length: FOOT_COUNT }, () => []);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const ids = mesh.indices.slice(i, i + 3); faces.add(faceKey(ids));
      if (Math.max(...ids) < FOOT_COUNT) for (const id of ids) adjacent[id].push(ids);
    }
    let upperTriangles = 0, missingReflectedUpperTriangles = 0, maximumFootSurfaceError = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const ids = mesh.indices.slice(i, i + 3), reflected = ids.map(id => partners[id]);
      if (Math.max(...ids) >= FOOT_COUNT) { upperTriangles += 1; if (!faces.has(faceKey([reflected[0], reflected[2], reflected[1]]))) missingReflectedUpperTriangles += 1; continue; }
      const q = reflectPoint([0, 1, 2].map(k => ids.reduce((sum, id) => sum + mesh.positions[id][k], 0) / 3));
      const nearby = new Map(); for (const id of reflected) for (const f of adjacent[id]) nearby.set(faceKey(f), f);
      maximumFootSurfaceError = Math.max(maximumFootSurfaceError, Math.min(...[...nearby.values()].map(f => closestTriangleDistance(q, ...f.map(id => mesh.positions[id])))));
    }
    results.push({ name: mesh.name, upperTriangles, missingReflectedUpperTriangles, maximumFootReflectedCentroidDistance: maximumFootSurfaceError });
    assert.equal(missingReflectedUpperTriangles, 0); assert.ok(maximumFootSurfaceError <= SURFACE_EPSILON, JSON.stringify(results.at(-1)));
  }
  report.checks.reflectedSurfaces = results;
});

test('every upper ring has the same front/back centre and a rounded elliptical crown', () => {
  const results = [];
  for (const mesh of legs.meshes) {
    const cap = mesh.positions.length - 1; assert.equal((cap - FOOT_FIRST_RING) % RADIAL, 0);
    let maximumCenterError = 0, maximumRadiusMismatch = 0, maximumRingYSpread = 0;
    const ringSummaries = [];
    for (let start = FOOT_FIRST_RING; start < cap; start += RADIAL) {
      const ring = mesh.positions.slice(start, start + RADIAL), zs = ring.map(p => p[2]), ys = ring.map(p => p[1]), minimum = Math.min(...zs), maximum = Math.max(...zs);
      maximumCenterError = Math.max(maximumCenterError, Math.abs((minimum + maximum) / 2 - FRONT_BACK_Z));
      maximumRadiusMismatch = Math.max(maximumRadiusMismatch, Math.abs(maximum + minimum - FRONT_BACK_Z * 2)); maximumRingYSpread = Math.max(maximumRingYSpread, Math.max(...ys) - Math.min(...ys));
      ringSummaries.push({ y: ys[0], centerZ: (minimum + maximum) / 2, radiusZ: (maximum - minimum) / 2 });
    }
    const pole = mesh.positions[cap], last = ringSummaries.at(-1), previous = ringSummaries.at(-2), deltaY = pole[1] - last.y;
    const lastRadiusX = (Math.max(...mesh.positions.slice(cap - RADIAL, cap).map(p => p[0])) - Math.min(...mesh.positions.slice(cap - RADIAL, cap).map(p => p[0]))) / 2;
    const poleRadii = [lastRadiusX ** 2 / (2 * deltaY), last.radiusZ ** 2 / (2 * deltaY)];
    const verticalToRadialRatio = deltaY / Math.min(lastRadiusX, last.radiusZ);
    results.push({ name: mesh.name, rings: ringSummaries.length, maximumCenterError, maximumRadiusMismatch, maximumRingYSpread, pole, poleCurvatureRadiusEstimate: poleRadii, verticalToRadialRatio, sections: ringSummaries.filter((_, i) => i % 10 === 0).concat([last]) });
    assert.ok(maximumCenterError <= POSITION_EPSILON && maximumRadiusMismatch <= SURFACE_EPSILON); assert.equal(maximumRingYSpread, 0);
    assert.equal(pole[2], FRONT_BACK_Z); assert.equal(distance(mesh.normals[cap], [0, 1, 0]), 0); assert.ok(deltaY > 0 && last.radiusZ < previous.radiusZ);
    // A terminal cone has finite nonzero vertical/radial slope. The existing
    // dense sampling must approach the horizontal tangent of an ellipsoid.
    assert.ok(verticalToRadialRatio < 0.1 && poleRadii.every(r => r > 1), JSON.stringify(results.at(-1)));
  }
  report.checks.sectionsAndCrown = results;
});

test('left and right independent legs remain exact x=0 mirrors', () => {
  const right = legs.meshes.find(m => m.name === 'Leg_R'), left = legs.meshes.find(m => m.name === 'Leg_L');
  assert.equal(left.positions.length, right.positions.length); assert.equal(left.indices.length, right.indices.length);
  for (let i = 0; i < right.positions.length; i += 1) {
    assert.deepEqual(left.positions[i], [-right.positions[i][0], right.positions[i][1], right.positions[i][2]]);
    assert.deepEqual(left.normals[i], [-right.normals[i][0], right.normals[i][1], right.normals[i][2]]);
  }
  for (let i = 0; i < right.indices.length; i += 3) assert.deepEqual(left.indices.slice(i, i + 3), [right.indices[i], right.indices[i + 2], right.indices[i + 1]]);
  report.checks.leftRightReflection = { planeX: 0, verticesPerSide: right.positions.length, trianglesPerSide: right.indices.length / 3, exact: true };
});

test('each independent leg and body companion is a finite outward closed manifold', () => {
  report.checks.topology = [...legs.meshes, ...body.meshes].map(topology);
  for (const result of report.checks.topology) {
    for (const field of ['nonfinite', 'degenerateTriangles', 'opposedNormals', 'duplicateFaces', 'nonmanifoldEdges', 'inconsistentWindingEdges']) assert.equal(result[field], 0, JSON.stringify(result));
    assert.equal(result.components, 1, JSON.stringify(result)); assert.equal(result.eulerCharacteristic, 2, JSON.stringify(result)); assert.ok(result.signedVolume > 0);
    assert.ok(Math.abs(result.minimumNormalLength - 1) < 1e-5 && Math.abs(result.maximumNormalLength - 1) < 1e-5);
  }
});

test('the body companion shares the exact accepted ankle boundary positions and normals', () => {
  assert.equal(bodyAudit.caps.length, 2);
  const mesh = body.meshes[0], results = [];
  for (const cap of bodyAudit.caps) {
    assert.equal(cap.boundaryIndices.length, RADIAL); assert.equal(cap.sourceBoundaryStart, FOOT_FIRST_RING);
    const sign = cap.sourceFootSign; assert.ok(sign === 1 || sign === -1);
    const expectedPositions = sourceFoot.positions.slice(FOOT_FIRST_RING, FOOT_COUNT).map(p => [p[0] * sign, p[1], p[2]]);
    const expectedNormals = sourceFoot.normals.slice(FOOT_FIRST_RING, FOOT_COUNT).map(n => [n[0] * sign, n[1], n[2]]);
    assert.deepEqual(bufferFor(cap.boundaryIndices.map(id => mesh.positions[id])), bufferFor(expectedPositions), `${cap.side}: body ankle positions changed`);
    assert.deepEqual(bufferFor(cap.boundaryIndices.map(id => mesh.normals[id])), bufferFor(expectedNormals), `${cap.side}: body ankle normals changed`);
    results.push({ side: cap.side, sharedVertices: RADIAL, positionAndNormalBytesExact: true });
  }
  report.checks.sharedAnkleBoundaries = results;
});

function checkContainment(points, sample, label) {
  const result = { label, samples: 0, missingIntervals: 0, rayCandidates: 0, outsideTolerance: 0, maximumZOverrun: 0, maximumMeasuredSurfaceOverrun: 0, examples: [] };
  for (const point of points) {
    result.samples += 1; const hits = sample(point[0], point[1]); let overrun = Infinity;
    for (let i = 0; i + 1 < hits.length; i += 2) overrun = Math.min(overrun, Math.max(hits[i].point[2] - point[2], point[2] - hits[i + 1].point[2], 0));
    if (!Number.isFinite(overrun)) result.missingIntervals += 1;
    else result.maximumZOverrun = Math.max(result.maximumZOverrun, overrun);
    if (overrun > 0.002) {
      result.rayCandidates += 1;
      // A z-ray gap becomes arbitrarily large near a tangent. Confirm using
      // true Euclidean distance to nearby delivered triangles, without moving
      // the existing 0.002 hidden-surface tolerance.
      const surfaceOverrun = sample.nearestDistance(point); result.maximumMeasuredSurfaceOverrun = Math.max(result.maximumMeasuredSurfaceOverrun, surfaceOverrun);
      if (surfaceOverrun > 0.002) { result.outsideTolerance += 1; if (result.examples.length < 8) result.examples.push({ point, rayHits: hits.map(h => h.point[2]), zOverrun: Number.isFinite(overrun) ? overrun : null, surfaceOverrun }); }
    }
  }
  return result;
}

test('body lower caps remain inside the unchanged feet in the neutral pose', () => {
  const mesh = body.meshes[0], footSampler = surfaceSampler(sourceFoot), results = [];
  for (const cap of bodyAudit.caps) {
    const samples = mesh.positions.slice(cap.firstVertex, cap.firstVertex + cap.vertexCount).map(p => [p[0] * cap.sourceFootSign, p[1], p[2]]);
    for (let face = cap.firstTriangle; face < cap.firstTriangle + cap.triangleCount; face += 1) {
      const ids = mesh.indices.slice(face * 3, face * 3 + 3), p = [0, 1, 2].map(k => ids.reduce((sum, id) => sum + mesh.positions[id][k], 0) / 3); p[0] *= cap.sourceFootSign; samples.push(p);
    }
    results.push(checkContainment(samples, footSampler, cap.side));
  }
  report.checks.hiddenBodyCaps = results;
  for (const result of results) assert.equal(result.outsideTolerance, 0, JSON.stringify(result));
});

test('independent leg tops stay within the body companion without an exposed doubled upper shell', () => {
  const bodySampler = surfaceSampler(body.meshes[0]), results = [];
  for (const mesh of legs.meshes) {
    const samples = mesh.positions.slice(FOOT_COUNT);
    for (let face = FOOT_TRIANGLES; face < mesh.indices.length / 3; face += 1) {
      const ids = mesh.indices.slice(face * 3, face * 3 + 3); samples.push([0, 1, 2].map(k => ids.reduce((sum, id) => sum + mesh.positions[id][k], 0) / 3));
    }
    results.push(checkContainment(samples, bodySampler, mesh.name));
  }
  report.checks.hiddenUpperLegs = results;
  for (const result of results) assert.equal(result.outsideTolerance, 0, JSON.stringify(result));
});

test('approved originals and historical approval evidence remain byte-identical', async () => {
  const approval = await json(new URL('docs/approvals/actions-v1-approved.json', root));
  const entries = [...approval.lockedFileSnapshot, ...approval.implementationSnapshot];
  const locks = await Promise.all(entries.map(async item => { const bytes = await readFile(historicalURL(item.path)); return { path: item.path, unchanged: bytes.byteLength === item.sizeBytes && sha256(bytes) === item.sha256 }; }));
  report.checks.approvedLocks = locks; assert.ok(locks.every(item => item.unchanged));
  const v4 = await readFile(new URL('assets/design/legs-v4/legs.glb', root)), v6 = await readFile(new URL('assets/design/legs-v6/body-legs.glb', root));
  assert.equal(sha256(v4), report.sourceHashes.legsV4); assert.equal(sha256(v6), 'd6304d97b26ddd0745a1907f0d423611f40f2b7949c1d528be97bd9a3ec16edd');
  const fixedV6 = decodeGLB(v6).meshes[0];
  assert.deepEqual(bufferFor(sourceFoot.positions.slice(0, FOOT_COUNT)), bufferFor(fixedV6.positions.slice(0, FOOT_COUNT)));
  assert.deepEqual(bufferFor(sourceFoot.normals.slice(0, FOOT_COUNT)), bufferFor(fixedV6.normals.slice(0, FOOT_COUNT)));
  report.sourceHashes.legsV6 = sha256(v6);
});

// Reuse the established independent v6 section metric on the new delivered
// exterior, so accepting the symmetry repair cannot silently revive its bands.
function measureShadingBands(surface) {
  const { positions: points, normals, indices } = surface;
  const unit = value => mul(value, 1 / length(value));
  const faces = [];
  for (let i = 0; i < indices.length; i += 3) faces.push(indices.slice(i, i + 3));
  const blend = (a, b, t) => a.map((v, i) => v + t * (b[i] - v));
  const bodySections = [];
  for (const x of [0, 8, 13.9215, 18]) {
    const columnFaces = faces.filter(face => x >= Math.min(...face.map(id => points[id][0])) - 1e-7 && x <= Math.max(...face.map(id => points[id][0])) + 1e-7);
    const at = (y, sign) => {
      let result;
      for (const face of columnFaces) {
        const [a, b, c] = face.map(id => points[id]);
        if (y < Math.min(a[1], b[1], c[1]) - 1e-7 || y > Math.max(a[1], b[1], c[1]) + 1e-7) continue;
        const determinant = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        if (Math.abs(determinant) < 1e-12) continue;
        const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / determinant;
        const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / determinant;
        if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
        const weights = [1 - u - v, u, v], z = weights.reduce((sum, weight, i) => sum + weight * points[face[i]][2], 0);
        if (!result || sign * z > sign * result.point[2]) result = {
          point: [x, y, z],
          normal: unit([0, 1, 2].map(axis => weights.reduce((sum, weight, i) => sum + weight * normals[face[i]][axis], 0))),
        };
      }
      assert.ok(result, `Missing body sample at x=${x}, y=${y}, sign=${sign}`);
      return result;
    };
    for (const sign of [1, -1]) {
      const samples = Array.from({ length: 101 }, (_, i) => at(24 + i * 0.1, sign)), rates = [];
      for (let i = 3; i < samples.length - 3; i += 1) {
        const before = samples[i - 1], after = samples[i + 1];
        const incoming = sub(samples[i].point, samples[i - 3].point), outgoing = sub(samples[i + 3].point, samples[i].point);
        rates.push({ y: 24 + i * 0.1, normalRate: angle(before.normal, after.normal) / length(sub(after.point, before.point)), geometryRate: angle(incoming, outgoing) / ((length(incoming) + length(outgoing)) / 2) });
      }
      bodySections.push({ x, sign, normalPeak: rates.reduce((a, b) => a.normalRate > b.normalRate ? a : b), geometryPeak: rates.reduce((a, b) => a.geometryRate > b.geometryRate ? a : b) });
    }
  }
  const footY = 13.447979927062988, delta = 0.12, center = [13.92148186061374, 4];
  const sections = [footY - delta, footY, footY + delta].map(y => {
    const segments = [];
    for (const face of faces) {
      if (y < Math.min(...face.map(id => points[id][1])) - 1e-7 || y > Math.max(...face.map(id => points[id][1])) + 1e-7) continue;
      const intersections = [];
      for (let i = 0; i < 3; i += 1) {
        const a = face[i], b = face[(i + 1) % 3], height = points[b][1] - points[a][1];
        if (Math.abs(height) < 1e-10) continue;
        const t = (y - points[a][1]) / height;
        if (t < -1e-7 || t > 1 + 1e-7) continue;
        const intersection = { point: blend(points[a], points[b], t), normal: blend(normals[a], normals[b], t) };
        if (!intersections.some(other => length(sub(other.point, intersection.point)) < 1e-7)) intersections.push(intersection);
      }
      if (intersections.length === 2) segments.push(intersections);
    }
    return segments;
  });
  const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0], ankleSamples = [];
  for (let sample = 0; sample < 32; sample += 1) {
    const theta = sample * 2 * Math.PI / 32, direction = [Math.cos(theta), Math.sin(theta)];
    const inclinations = sections.map(segments => {
      let closest;
      for (const [a, b] of segments) {
        const offset = [a.point[0] - center[0], a.point[2] - center[1]], edge = [b.point[0] - a.point[0], b.point[2] - a.point[2]], determinant = cross2(direction, edge);
        if (Math.abs(determinant) < 1e-10) continue;
        const radius = cross2(offset, edge) / determinant, t = cross2(offset, direction) / determinant;
        if (radius < 0 || t < -1e-7 || t > 1 + 1e-7) continue;
        if (!closest || radius < closest.radius) closest = { radius, normal: unit(blend(a.normal, b.normal, t)) };
      }
      assert.ok(closest, `Missing ankle sample at angle=${theta}`);
      const n = closest.normal;
      return Math.atan2(n[1], n[0] * direction[0] + n[2] * direction[1]) * 180 / Math.PI;
    });
    const before = (inclinations[1] - inclinations[0]) / delta, after = (inclinations[2] - inclinations[1]) / delta;
    ankleSamples.push({ degrees: theta * 180 / Math.PI, before, after, rateJump: Math.abs(after - before) });
  }
  return {
    bodySections,
    bodyMaximumNormalRate: Math.max(...bodySections.map(section => section.normalPeak.normalRate)),
    bodyMaximumGeometryRate: Math.max(...bodySections.map(section => section.geometryPeak.geometryRate)),
    ankleSamples,
    ankleMaximumRateJump: Math.max(...ankleSamples.map(sample => sample.rateJump)),
    ankleRmsRateJump: Math.sqrt(ankleSamples.reduce((sum, sample) => sum + sample.rateJump ** 2, 0) / ankleSamples.length),
  };
}

test('the assembled exterior retains the previously required body and ankle smoothness limits', () => {
  const combined = { positions: [], normals: [], indices: [] };
  for (const leg of legs.meshes) {
    const offset = combined.positions.length;
    combined.positions.push(...leg.positions.slice(0, FOOT_COUNT)); combined.normals.push(...leg.normals.slice(0, FOOT_COUNT));
    for (let i = 0; i < leg.indices.length; i += 3) if (Math.max(...leg.indices.slice(i, i + 3)) < FOOT_COUNT) combined.indices.push(...leg.indices.slice(i, i + 3).map(id => id + offset));
  }
  const offset = combined.positions.length, torso = body.meshes[0];
  for (const p of torso.positions) combined.positions.push(p);
  for (const n of torso.normals) combined.normals.push(n);
  for (const id of torso.indices.slice(0, bodyAudit.outerTriangleCount * 3)) combined.indices.push(id + offset);
  const result = measureShadingBands(combined); report.checks.shadingBands = result;
  assert.ok(result.bodyMaximumNormalRate < 10, JSON.stringify(result.bodySections));
  assert.ok(result.bodyMaximumGeometryRate < 15, JSON.stringify(result.bodySections));
  assert.ok(result.ankleMaximumRateJump < 3, JSON.stringify(result.ankleSamples));
  assert.ok(result.ankleRmsRateJump < 2, JSON.stringify(result.ankleSamples));
});

test('the v8 exported rig retains geometry, rigid feet, shared ankle seams and all five action clips', async () => {
  const defaultRigDirectory = await access(new URL('assets/design/rig-v8/xiaobai-rig-v8.glb', root)).then(() => 'assets/design/rig-v8').catch(() => 'temp/generated/rig-v8');
  const directory = new URL(`${process.env.RIG_V8_DIRECTORY ?? defaultRigDirectory}/`, root);
  const expected = ['xiaobai_walk_v1', 'xiaobai_run_v1', 'xiaobai_wave_v1', 'xiaobai_thinking_v1', 'xiaobai_sit_v1'];
  const [neutralBytes, actionBytes] = await Promise.all([readFile(new URL('xiaobai-rig-v8.glb', directory)), readFile(new URL('xiaobai-legs-v8-actions-design.glb', directory))]);
  const neutral = decodeGLB(neutralBytes), action = decodeGLB(actionBytes);
  for (const model of [neutral, action]) {
    assert.equal(model.document.skins.length, 5); assert.equal(model.meshes.length, 9);
    assert.equal(new Set(model.document.skins.flatMap(s => s.joints)).size, 20);
    for (const original of [...legs.meshes, ...body.meshes]) assert.deepEqual(meshHashes(model.meshes.find(m => m.name === original.name)), meshHashes(original), `${original.name}: exported geometry changed`);
  }
  assert.equal(neutral.document.animations?.length ?? 0, 0); assert.deepEqual(action.document.animations.map(a => a.name), expected);
  const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
  let loaded;
  try {
    const THREE = await import('three'), { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
    loaded = await new GLTFLoader().parseAsync(actionBytes.buffer.slice(actionBytes.byteOffset, actionBytes.byteOffset + actionBytes.byteLength), '');
    const scene = loaded.scene, torso = scene.getObjectByName('Body_DesignV8'), surfaces = [...legs.meshes.map(m => scene.getObjectByName(m.name)), torso];
    scene.updateMatrixWorld(true); surfaces.forEach(m => m.skeleton.update());
    const weights = (mesh, id) => Array.from({ length: 4 }, (_, c) => ({ bone: mesh.skeleton.bones[mesh.geometry.attributes.skinIndex.array[id * 4 + c]].name, weight: mesh.geometry.attributes.skinWeight.array[id * 4 + c] })).filter(w => w.weight > 0);
    let checkedFootWeights = 0, checkedBoundaryWeights = 0, maximumWeightSumError = 0;
    for (const mesh of surfaces) for (let id = 0; id < mesh.geometry.attributes.position.count; id += 1) {
      const values = Array.from(mesh.geometry.attributes.skinWeight.array.slice(id * 4, id * 4 + 4));
      assert.ok(values.every(w => Number.isFinite(w) && w >= 0 && w <= 1)); maximumWeightSumError = Math.max(maximumWeightSumError, Math.abs(values.reduce((a, b) => a + b) - 1));
    }
    assert.ok(maximumWeightSumError < 2e-7);
    for (const leg of surfaces.slice(0, 2)) {
      const side = leg.name.endsWith('_R') ? 'R' : 'L';
      for (let id = 0; id < FOOT_COUNT; id += 1) { assert.deepEqual(weights(leg, id), [{ bone: `XiaoBai_Rig_ankle${side}`, weight: 1 }]); checkedFootWeights += 1; }
      const cap = bodyAudit.caps.find(c => c.sourceFootSign === (side === 'R' ? 1 : -1));
      for (let i = 0; i < RADIAL; i += 1) { assert.deepEqual(weights(leg, FOOT_FIRST_RING + i), weights(torso, cap.boundaryIndices[i])); checkedBoundaryWeights += 1; }
    }
    // CPU linear skinning uses exported joint matrices directly, rather than
    // the generation or binding helper under test.
    const evaluate = (mesh, ids) => {
      const a = mesh.geometry.attributes;
      const matrices = mesh.skeleton.bones.map((bone, i) => new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).multiply(bone.matrixWorld).multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix).elements);
      return ids.map(id => {
        const p = [a.position.getX(id), a.position.getY(id), a.position.getZ(id)], n = [a.normal.getX(id), a.normal.getY(id), a.normal.getZ(id)], result = [0, 0, 0], normal = [0, 0, 0];
        for (let c = 0; c < 4; c += 1) {
          const w = a.skinWeight.array[id * 4 + c]; if (!w) continue;
          const m = matrices[a.skinIndex.array[id * 4 + c]];
          for (let k = 0; k < 3; k += 1) { result[k] += w * (m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]); normal[k] += w * (m[k] * n[0] + m[4 + k] * n[1] + m[8 + k] * n[2]); }
        }
        assert.ok([...result, ...normal].every(Number.isFinite)); return { position: result, normal: unit(normal) };
      });
    };
    const mixer = new THREE.AnimationMixer(scene), poses = [];
    for (const clip of loaded.animations) {
      mixer.stopAllAction(); const playing = mixer.clipAction(clip); playing.setLoop(THREE.LoopOnce, 1); playing.clampWhenFinished = true; playing.play();
      const phases = ['xiaobai_walk_v1', 'xiaobai_run_v1'].includes(clip.name) ? Array.from({ length: 32 }, (_, i) => i / 32) : [0, 0.25, 0.5, 0.75, 1];
      for (const phase of phases) {
        mixer.setTime(clip.duration * phase); scene.updateMatrixWorld(true); surfaces.forEach(m => m.skeleton.update());
        let maximumSeamPositionError = 0, maximumSeamNormalError = 0, maximumFootEdgeLengthError = 0;
        for (const leg of surfaces.slice(0, 2)) {
          const cap = bodyAudit.caps.find(c => c.sourceFootSign === (leg.name.endsWith('_R') ? 1 : -1)), ids = Array.from({ length: RADIAL }, (_, i) => FOOT_FIRST_RING + i);
          const foot = evaluate(leg, [0, ...ids]), boundary = evaluate(torso, cap.boundaryIndices);
          for (let i = 0; i < RADIAL; i += 1) { maximumSeamPositionError = Math.max(maximumSeamPositionError, distance(foot[i + 1].position, boundary[i].position)); maximumSeamNormalError = Math.max(maximumSeamNormalError, distance(foot[i + 1].normal, boundary[i].normal)); }
          const original = legs.meshes.find(m => m.name === leg.name);
          for (let i = 0; i < RADIAL; i += 1) maximumFootEdgeLengthError = Math.max(maximumFootEdgeLengthError, Math.abs(distance(foot[0].position, foot[i + 1].position) - distance(original.positions[0], original.positions[ids[i]])));
        }
        const entry = { clip: clip.name, phase, maximumSeamPositionError, maximumSeamNormalError, maximumFootEdgeLengthError }; poses.push(entry);
        assert.ok(maximumSeamPositionError < 2e-5 && maximumSeamNormalError < 2e-6 && maximumFootEdgeLengthError < 2e-5, JSON.stringify(entry));
      }
    }
    report.checks.rig = { directory: directory.pathname, neutralSha256: sha256(neutralBytes), actionsSha256: sha256(actionBytes), skins: 5, bones: 20, meshes: 9,
      clips: loaded.animations.map(c => ({ name: c.name, duration: c.duration, tracks: c.tracks.length })), checkedFootWeights, checkedBoundaryWeights, maximumWeightSumError, geometryExact: true, poses };
  } finally {
    loaded?.scene.traverse(n => { n.geometry?.dispose(); if (Array.isArray(n.material)) n.material.forEach(m => m.dispose()); else n.material?.dispose(); }); hook.deregister();
  }
});
