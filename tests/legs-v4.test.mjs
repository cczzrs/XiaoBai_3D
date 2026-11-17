import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalURL } from '../scripts/project-paths.mjs';

const root = new URL('../', import.meta.url);
const candidate = new URL(`${process.env.LEGS_V4_DIRECTORY ?? 'assets/design/legs-v4'}/`, root);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);

function decodeGLB(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = bytes.subarray(28 + jsonLength);
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const formats = { 5126: ['readFloatLE', 4], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4] };
  const accessor = id => {
    const a = document.accessors[id], view = document.bufferViews[a.bufferView];
    const [read, bytesPerElement] = formats[a.componentType], width = widths[a.type];
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride ?? bytesPerElement * width;
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, j) => binary[read](start + stride * i + bytesPerElement * j)));
  };
  return { document, meshes: document.nodes.filter(node => node.mesh !== undefined).map(node => {
    const primitive = document.meshes[node.mesh].primitives[0];
    return { ...node, positions: accessor(primitive.attributes.POSITION), normals: accessor(primitive.attributes.NORMAL), indices: accessor(primitive.indices).flat() };
  }) };
}

// Vertical ray intersections with the actual approved triangle surface, both
// entry and exit. No geometry-generator or idealized body approximation is used.
function bodyIntersections(mesh) {
  const cells = new Map(), cellSize = 2;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const p = mesh.indices.slice(i, i + 3).map(id => mesh.positions[id]);
    const a = sub(p[1], p[0]), b = sub(p[2], p[0]), det = a[0] * b[2] - a[2] * b[0];
    if (Math.abs(det) < 1e-12) continue;
    for (let x = Math.floor(Math.min(...p.map(v => v[0])) / cellSize); x <= Math.floor(Math.max(...p.map(v => v[0])) / cellSize); x += 1) {
      for (let z = Math.floor(Math.min(...p.map(v => v[2])) / cellSize); z <= Math.floor(Math.max(...p.map(v => v[2])) / cellSize); z += 1) {
        const key = `${x},${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({ p, a, b, det });
      }
    }
  }
  return point => {
    let lower = Infinity, upper = -Infinity;
    for (const t of cells.get(`${Math.floor(point[0] / cellSize)},${Math.floor(point[2] / cellSize)}`) ?? []) {
      const dx = point[0] - t.p[0][0], dz = point[2] - t.p[0][2];
      const u = (dx * t.b[2] - dz * t.b[0]) / t.det, v = (t.a[0] * dz - t.a[2] * dx) / t.det;
      if (Math.min(u, v, 1 - u - v) < -1e-7) continue;
      const y = t.p[0][1] + u * t.a[1] + v * t.b[1];
      lower = Math.min(lower, y); upper = Math.max(upper, y);
    }
    return Number.isFinite(lower) ? { lower, upper } : null;
  };
}

const [model, previous, body, audit, sourceAudit, parameters] = await Promise.all([
  readFile(new URL('legs.glb', candidate)).then(decodeGLB),
  readFile(new URL('assets/design/legs-v3/legs.glb', root)).then(decodeGLB),
  readFile(new URL('assets/approved/body-v7/xiaobai-torso.glb', root)).then(decodeGLB),
  json(new URL('geometry-audit.json', candidate)),
  json(new URL('assets/design/legs-v3/geometry-audit.json', root)),
  json(new URL('parameters.json', candidate)),
]);
const leg = model.meshes.find(mesh => (mesh.scale?.[0] ?? 1) > 0);
const mirror = model.meshes.find(mesh => mesh.scale?.[0] < 0);
const source = previous.meshes.find(mesh => (mesh.scale?.[0] ?? 1) > 0);
const { radial, firstBlendVertex, capVertex } = audit;
const preservedVertices = sourceAudit.firstBlendVertex + sourceAudit.radial;
// The boundary row shares faces with the new upper and needs recomputed normals;
// every normal strictly below that join remains the accepted v3 value.
const preservedNormals = sourceAudit.firstBlendVertex;
const preservedIds = source.indices.filter((_, i, all) => Math.max(...all.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3)) < preservedVertices);
const foot = {
  vertices: preservedVertices, normals: preservedNormals, triangles: preservedIds.length / 3,
  positionsIdentical: JSON.stringify(leg.positions.slice(0, preservedVertices)) === JSON.stringify(source.positions.slice(0, preservedVertices)),
  normalsIdentical: JSON.stringify(leg.normals.slice(0, preservedNormals)) === JSON.stringify(source.normals.slice(0, preservedNormals)),
  indicesIdentical: JSON.stringify(leg.indices.slice(0, preservedIds.length)) === JSON.stringify(preservedIds),
};
const topology = { vertices: leg.positions.length, triangles: leg.indices.length / 3, signedVolume: 0, minimumTriangleArea: Infinity, nonfinite: 0, opposedNormals: 0, minimumNormalLength: Infinity, maximumNormalLength: 0 };
const edges = new Map(), opposedExamples = [];
for (const point of [...leg.positions, ...leg.normals]) if (!point.every(Number.isFinite)) topology.nonfinite += 1;
for (const normal of leg.normals) { topology.minimumNormalLength = Math.min(topology.minimumNormalLength, length(normal)); topology.maximumNormalLength = Math.max(topology.maximumNormalLength, length(normal)); }
for (let i = 0; i < leg.indices.length; i += 3) {
  const ids = leg.indices.slice(i, i + 3), p = ids.map(id => leg.positions[id]);
  const normal = cross(sub(p[1], p[0]), sub(p[2], p[0]));
  topology.signedVolume += dot(p[0], cross(p[1], p[2])) / 6;
  topology.minimumTriangleArea = Math.min(topology.minimumTriangleArea, length(normal) / 2);
  for (const id of ids) if (dot(normal, leg.normals[id]) <= 0) {
    topology.opposedNormals += 1;
    if (opposedExamples.length < 8) opposedExamples.push({ triangle: i / 3, vertex: id });
  }
  for (let j = 0; j < 3; j += 1) {
    const a = ids[j], b = ids[(j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`, edge = edges.get(key) ?? [0, 0];
    edge[0] += 1; edge[1] += a < b ? 1 : -1; edges.set(key, edge);
  }
}
topology.nonmanifoldEdges = [...edges.values()].filter(v => v[0] !== 2).length;
topology.inconsistentWindingEdges = [...edges.values()].filter(v => v[1] !== 0).length;
topology.eulerCharacteristic = topology.vertices - edges.size + topology.triangles;

const rows = [];
for (let offset = 1; offset < capVertex; offset += radial) rows.push(leg.positions.slice(offset, offset + radial));
const upperStartRow = (firstBlendVertex - 1) / radial;
const upperRows = rows.slice(upperStartRow);
const ringProfile = upperRows.map(points => {
  const low = [0, 1, 2].map(axis => Math.min(...points.map(p => p[axis])));
  const high = [0, 1, 2].map(axis => Math.max(...points.map(p => p[axis])));
  return { y: low[1], planeError: high[1] - low[1], cx: (low[0] + high[0]) / 2, cz: (low[2] + high[2]) / 2, rx: (high[0] - low[0]) / 2, rz: (high[2] - low[2]) / 2 };
});
const shape = { rings: ringProfile.length, nondecreasingRadiusSteps: 0, maximumPlaneError: Math.max(...ringProfile.map(r => r.planeError)), maximumMeridianTurnDegrees: 0, maximumBoundaryTurnDegrees: 0, worstTurn: null, profile: ringProfile };
for (let i = 1; i < ringProfile.length; i += 1) if (ringProfile[i].rx >= ringProfile[i - 1].rx || ringProfile[i].rz >= ringProfile[i - 1].rz) shape.nondecreasingRadiusSteps += 1;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (length(a) * length(b))))) * 180 / Math.PI;
for (let j = 0; j < radial; j += 1) {
  const points = [...rows.slice(upperStartRow - 1).map(row => row[j]), leg.positions[capVertex]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const turn = angle(sub(points[i], points[i - 1]), sub(points[i + 1], points[i]));
    if (turn > shape.maximumMeridianTurnDegrees) { shape.maximumMeridianTurnDegrees = turn; shape.worstTurn = { meridian: j, row: i - 1, point: points[i] }; }
    if (i === 1) shape.maximumBoundaryTurnDegrees = Math.max(shape.maximumBoundaryTurnDegrees, turn);
  }
}
const spacing = { foot: [], upper: [] };
let prior = Array.from({ length: radial }, () => leg.positions[0]);
for (let row = 0; row < rows.length; row += 1) {
  spacing[row <= upperStartRow ? 'foot' : 'upper'].push(rows[row].reduce((sum, p, j) => sum + length(sub(p, prior[j])), 0) / radial);
  prior = rows[row];
}
spacing.upper.push(prior.reduce((sum, p) => sum + length(sub(leg.positions[capVertex], p)), 0) / radial);
const spacingSummary = Object.fromEntries(Object.entries(spacing).map(([name, v]) => [name, { intervals: v.length, minimum: Math.min(...v), maximum: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length }]));

const hits = bodyIntersections(body.meshes[0]);
const depth = point => { const h = hits(point); return h ? Math.min(point[1] - h.lower, h.upper - point[1]) : -Infinity; };
const containment = { meridians: radial, samples: 0, reemergences: 0, failedToEnter: 0, minimumEntryY: Infinity, maximumEntryY: -Infinity, buriedSamples: 0, minimumBuriedDepth: Infinity, crownDepth: depth(leg.positions[capVertex]), worstBuried: null };
for (let j = 0; j < radial; j += 1) {
  const points = [...upperRows.map(row => row[j]), leg.positions[capVertex]];
  let entered = false;
  for (let i = 0; i < points.length - 1; i += 1) {
    for (const t of [0, 0.5, 1]) {
      const point = add(mul(points[i], 1 - t), mul(points[i + 1], t));
      const inside = depth(point) >= -1e-5; containment.samples += 1;
      if (inside && !entered) {
        entered = true;
        containment.minimumEntryY = Math.min(containment.minimumEntryY, point[1]);
        containment.maximumEntryY = Math.max(containment.maximumEntryY, point[1]);
      }
      if (entered && !inside) containment.reemergences += 1;
    }
  }
  if (!entered) containment.failedToEnter += 1;
}
function checkBuried(point, context) {
  const value = depth(point); containment.buriedSamples += 1;
  if (value < containment.minimumBuriedDepth) { containment.minimumBuriedDepth = value; containment.worstBuried = { point, ...context }; }
}
// Above the last meridian entry, inspect actual triangles rather than the ideal
// sweep. The transition band is intentionally an overlap of separate parts.
for (let i = firstBlendVertex; i <= capVertex; i += 1) if (leg.positions[i][1] >= containment.maximumEntryY) checkBuried(leg.positions[i], { vertex: i });
for (let i = 0; i < leg.indices.length; i += 3) {
  const ids = leg.indices.slice(i, i + 3), p = ids.map(id => leg.positions[id]);
  if (Math.min(...p.map(point => point[1])) < containment.maximumEntryY) continue;
  checkBuried(mul(p.reduce(add), 1 / 3), { triangle: i / 3, kind: 'centroid' });
  for (let j = 0; j < 3; j += 1) checkBuried(mul(add(p[j], p[(j + 1) % 3]), 0.5), { triangle: i / 3, kind: 'edge-midpoint' });
}
const approval = await json(new URL('docs/approvals/actions-v1-approved.json', root));
const locks = await Promise.all(approval.lockedFileSnapshot.filter(file => !file.path.endsWith('.DS_Store')).map(async file => {
  const bytes = await readFile(historicalURL(file.path));
  return { path: file.path, unchanged: bytes.length === file.sizeBytes && sha256(bytes) === file.sha256 };
}));
const report = { candidate: candidate.pathname, foot, topology, opposedExamples, shape, spacing: spacingSummary, containment, locks, limitations: ['Checks use actual final GLB vertices, meridian segments, triangle edge midpoints and centroids; this is not a global exact intersection proof.', 'The old flared body-contact ring is intentionally removed. The new rounded upper enters the unchanged torso without imposing the old body-tangent rim.'] };
await mkdir(new URL('temp/legs-v4/', root), { recursive: true });
await writeFile(new URL('temp/legs-v4/independent-geometry-check.json', root), JSON.stringify(report, null, 2) + '\n');

test('v4 preserves the accepted v3 foot positions, normals and triangle indices exactly', () => {
  assert.equal(firstBlendVertex, sourceAudit.firstBlendVertex); assert.equal(radial, sourceAudit.radial);
  assert.equal(audit.preservedNormalCount, preservedNormals);
  assert.ok(foot.vertices > 10000); assert.ok(foot.triangles > 20000);
  assert.ok(foot.positionsIdentical); assert.ok(foot.normalsIdentical); assert.ok(foot.indicesIdentical);
});
test('v4 upper rings continuously narrow without a cap brim or sharp meridian turn', () => {
  assert.equal(shape.maximumPlaneError, 0); assert.equal(shape.nondecreasingRadiusSteps, 0);
  assert.ok(shape.maximumMeridianTurnDegrees < 10, JSON.stringify(shape.worstTurn));
  assert.ok(shape.maximumBoundaryTurnDegrees < 10);
  assert.deepEqual(leg.normals[capVertex], [0, 1, 0]);
  assert.ok(ringProfile.at(-1).rx < 0.3 && ringProfile.at(-1).rz < 0.3);
});
test('v4 is a finite closed surface with consistent winding and outward normals', () => {
  assert.equal(topology.nonfinite, 0); assert.equal(topology.eulerCharacteristic, 2);
  assert.equal(topology.nonmanifoldEdges, 0); assert.equal(topology.inconsistentWindingEdges, 0);
  assert.ok(topology.minimumTriangleArea > 1e-10); assert.ok(topology.signedVolume > 0);
  assert.equal(topology.opposedNormals, 0, JSON.stringify(opposedExamples));
  assert.ok(topology.minimumNormalLength > 0.9999 && topology.maximumNormalLength < 1.0001);
});
test('v4 remains an exact mirrored static pair', () => {
  assert.equal(model.meshes.length, 2); assert.ok(mirror);
  assert.deepEqual(leg.positions, mirror.positions); assert.deepEqual(leg.normals, mirror.normals); assert.deepEqual(leg.indices, mirror.indices);
  assert.deepEqual(leg.scale ?? [1, 1, 1], [1, 1, 1]); assert.deepEqual(mirror.scale, [-1, 1, 1]);
  for (const mesh of model.meshes) { assert.deepEqual(mesh.translation ?? [0, 0, 0], [0, 0, 0]); assert.deepEqual(mesh.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]); }
  assert.equal(model.document.skins?.length ?? 0, 0); assert.equal(model.document.animations?.length ?? 0, 0);
});
test('v4 preserves one average ring-spacing target from foot through crown', () => {
  const target = parameters.refinement.sampling.ringSpacing;
  for (const region of Object.values(spacingSummary)) { assert.ok(region.minimum > target * 0.98, JSON.stringify(spacingSummary)); assert.ok(region.maximum < target * 1.02, JSON.stringify(spacingSummary)); }
});
test('v4 enters the real torso once and its upper crown remains buried', () => {
  assert.equal(containment.failedToEnter, 0); assert.equal(containment.reemergences, 0);
  assert.ok(containment.buriedSamples > 10000); assert.ok(containment.minimumBuriedDepth > -1e-5, JSON.stringify(containment.worstBuried));
  assert.ok(containment.crownDepth > 1);
});
test('v4 leaves all locked approved files byte-identical', () => {
  assert.ok(locks.length >= 20); assert.deepEqual(locks.filter(file => !file.unchanged), []);
});

