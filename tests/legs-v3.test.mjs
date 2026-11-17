import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalURL } from '../scripts/project-paths.mjs';

const root = new URL('../', import.meta.url);
const candidate = new URL(`${process.env.LEGS_V3_DIRECTORY ?? 'assets/design/legs-v3'}/`, root);
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

// Independent Cox–de Boor basis evaluation of the preserved v2 section data.
function referenceSection(y, settings) {
  const basis = (i, degree) => {
    const k = settings.knots;
    if (degree === 0) return y >= k[i] && y < k[i + 1] ? 1 : 0;
    const a = k[i + degree] - k[i], b = k[i + degree + 1] - k[i + 1];
    return (a ? (y - k[i]) / a * basis(i, degree - 1) : 0) + (b ? (k[i + degree + 1] - y) / b * basis(i + 1, degree - 1) : 0);
  };
  const spline = coefficients => coefficients.reduce((sum, value, i) => sum + value * basis(i, settings.degree), 0);
  const radius = Math.sqrt((y - settings.domain[0]) * (settings.domain[1] - y) * Math.exp(spline(settings.logRadiusCoefficients)));
  return { x: settings.centerX + (spline(settings.centerCoefficients) - settings.xRawMid) * settings.xScale, z: settings.footDepthCenterZ, rx: radius * settings.xScale, rz: radius * settings.zScale };
}

const [model, body, audit, baseline, oldContact, parameters] = await Promise.all([
  readFile(new URL('legs.glb', candidate)).then(decodeGLB),
  readFile(new URL('assets/approved/body-v7/xiaobai-torso.glb', root)).then(decodeGLB),
  json(new URL('geometry-audit.json', candidate)),
  json(new URL('assets/design/legs-v2/parameters.json', root)),
  json(new URL('assets/design/legs-v2/contact-audit.json', root)),
  json(new URL('parameters.json', candidate)),
]);
const leg = model.meshes.find(mesh => (mesh.scale?.[0] ?? 1) > 0);
const mirror = model.meshes.find(mesh => mesh.scale?.[0] < 0);
const { radial, firstBlendVertex, contactVertex, capVertex, toeY } = audit;
const hits = bodyIntersections(body.meshes[0]);
const topology = { vertices: leg.positions.length, triangles: leg.indices.length / 3, signedVolume: 0, minimumTriangleArea: Infinity, nonfinite: 0, opposedNormals: 0, visibleOpposedNormals: 0, minimumNormalLength: Infinity, maximumNormalLength: 0 };
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
    if (Math.max(...ids) < contactVertex + radial) topology.visibleOpposedNormals += 1;
    if (opposedExamples.length < 8) opposedExamples.push({ triangle: i / 3, vertex: id, position: leg.positions[id] });
  }
  for (let j = 0; j < 3; j += 1) {
    const a = ids[j], b = ids[(j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`, edge = edges.get(key) ?? [0, 0];
    edge[0] += 1; edge[1] += a < b ? 1 : -1; edges.set(key, edge);
  }
}
topology.nonmanifoldEdges = [...edges.values()].filter(v => v[0] !== 2).length;
topology.inconsistentWindingEdges = [...edges.values()].filter(v => v[1] !== 0).length;
topology.eulerCharacteristic = topology.vertices - edges.size + topology.triangles;

let preservedSamples = 0, maximumSoleContourError = 0, maximumContactError = 0;
for (let row = 1; row <= firstBlendVertex; row += radial) {
  const y = leg.positions[row][1];
  if (y > toeY) break;
  const s = referenceSection(y, baseline.legs);
  for (let j = 0; j < radial; j += 1) {
    const theta = 2 * Math.PI * j / radial;
    const expected = [s.x + s.rx * Math.cos(theta), y, s.z + s.rz * Math.sin(theta)];
    maximumSoleContourError = Math.max(maximumSoleContourError, length(sub(expected, leg.positions[row + j]))); preservedSamples += 1;
  }
}
for (let j = 0; j < radial; j += 1) maximumContactError = Math.max(maximumContactError, length(sub(leg.positions[contactVertex + j], oldContact.contactPoints[j].point)));

const spacing = { foot: [], collar: [], dome: [] };
let previous = Array.from({ length: radial }, () => leg.positions[0]);
for (let row = 1; row < capVertex; row += radial) {
  const points = leg.positions.slice(row, row + radial), distance = points.reduce((sum, p, j) => sum + length(sub(p, previous[j])), 0) / radial;
  const region = row <= firstBlendVertex ? 'foot' : row <= contactVertex ? 'collar' : 'dome';
  spacing[region].push(distance); previous = points;
}
spacing.dome.push(previous.reduce((sum, p) => sum + length(sub(leg.positions[capVertex], p)), 0) / radial);
const spacingSummary = Object.fromEntries(Object.entries(spacing).map(([name, values]) => [name, { intervals: values.length, minimum: Math.min(...values), maximum: Math.max(...values), average: values.reduce((sum, v) => sum + v, 0) / values.length }]));
const surface = { collar: { samples: 0, noHit: 0, minimumOutsideClearance: Infinity, worst: null }, dome: { samples: 0, noHit: 0, minimumInsideDepth: Infinity, worst: null }, terminalCollar: { samples: 0, minimumOutsideClearance: Infinity, worst: null }, sharedContactEdge: { samples: 0, noHit: 0, minimumInsideDepth: Infinity, worst: null } };
function inspectSurface(point, region, context) {
  const result = surface[region], hit = hits(point); result.samples += 1;
  if (!hit) { result.noHit = (result.noHit ?? 0) + 1; return; }
  const inside = region === 'dome' || region === 'sharedContactEdge';
  const value = inside ? Math.min(point[1] - hit.lower, hit.upper - point[1]) : hit.lower - point[1];
  const key = inside ? 'minimumInsideDepth' : 'minimumOutsideClearance';
  if (value < result[key]) { result[key] = value; result.worst = { point, ...context }; }
}
const collarIntervals = (contactVertex - firstBlendVertex) / radial;
for (let i = firstBlendVertex; i <= capVertex; i += 1) {
  const row = (i - firstBlendVertex) / radial;
  const region = i > contactVertex + radial - 1 ? 'dome' : row >= collarIntervals - 2 ? 'terminalCollar' : 'collar';
  inspectSurface(leg.positions[i], region, { vertex: i });
}
for (let i = 0; i < leg.indices.length; i += 3) {
  const ids = leg.indices.slice(i, i + 3);
  if (Math.min(...ids) < firstBlendVertex) continue;
  const p = ids.map(id => leg.positions[id]);
  const region = Math.min(...ids) >= contactVertex ? 'dome' : Math.min(...ids) >= contactVertex - 2 * radial ? 'terminalCollar' : 'collar';
  inspectSurface(mul(p.reduce(add), 1 / 3), region, { triangle: i / 3, kind: 'centroid' });
  for (let j = 0; j < 3; j += 1) {
    const k = (j + 1) % 3;
    const sharedContactEdge = region === 'dome' && ids[j] < contactVertex + radial && ids[k] < contactVertex + radial;
    inspectSurface(mul(add(p[j], p[k]), 0.5), sharedContactEdge ? 'sharedContactEdge' : region, { triangle: i / 3, kind: 'edge-midpoint' });
  }
}

const approval = await json(new URL('docs/approvals/actions-v1-approved.json', root));
const locks = await Promise.all(approval.lockedFileSnapshot.filter(file => !file.path.endsWith('.DS_Store')).map(async file => {
  const bytes = await readFile(historicalURL(file.path));
  return { path: file.path, unchanged: bytes.length === file.sizeBytes && sha256(bytes) === file.sha256 };
}));
const report = { candidate: candidate.pathname, topology, opposedExamples, contours: { preservedSamples, maximumSoleContourError, maximumContactError }, spacing: spacingSummary, surface, locks, limitations: ['Surface containment is sampled at vertices, edge midpoints and triangle centroids; this is not an exact global intersection proof.', 'The unchanged body contact uses independently triangulated components. Terminal collar chord overlap is reported and limited to 0.02 model units.', 'The shared contact polygon edge is retained from v2; its small chord deviation from the body surface is reported separately from the new buried dome.'] };
await mkdir(new URL('temp/legs-v3/', root), { recursive: true });
await writeFile(new URL('temp/legs-v3/independent-geometry-check.json', root), JSON.stringify(report, null, 2) + '\n');

test('v3 final GLB is finite, closed, consistently wound and nondegenerate', () => {
  assert.equal(topology.nonfinite, 0); assert.equal(topology.eulerCharacteristic, 2);
  assert.equal(topology.nonmanifoldEdges, 0); assert.equal(topology.inconsistentWindingEdges, 0);
  assert.ok(topology.minimumTriangleArea > 1e-10); assert.ok(topology.signedVolume > 0);
  assert.equal(topology.opposedNormals, 0, JSON.stringify(opposedExamples));
  assert.ok(topology.minimumNormalLength > 0.9999 && topology.maximumNormalLength < 1.0001);
});
test('v3 is an exact mirrored pair without hidden transforms or animation', () => {
  assert.equal(model.meshes.length, 2); assert.ok(mirror);
  assert.deepEqual(leg.positions, mirror.positions); assert.deepEqual(leg.indices, mirror.indices); assert.deepEqual(leg.normals, mirror.normals);
  assert.deepEqual(leg.scale ?? [1, 1, 1], [1, 1, 1]); assert.deepEqual(mirror.scale, [-1, 1, 1]);
  for (const mesh of model.meshes) { assert.deepEqual(mesh.translation ?? [0, 0, 0], [0, 0, 0]); assert.deepEqual(mesh.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]); }
  assert.equal(model.document.skins?.length ?? 0, 0); assert.equal(model.document.animations?.length ?? 0, 0);
});
test('sole-to-toe contour and approved body contact are retained', () => {
  assert.ok(preservedSamples > 1000); assert.ok(maximumSoleContourError < 1e-4, String(maximumSoleContourError));
  assert.ok(maximumContactError < 1e-5, String(maximumContactError));
});
test('foot, knee/collar and rounded crown have one consistent ring-spacing target', () => {
  const target = parameters.refinement.sampling.ringSpacing;
  for (const region of Object.values(spacingSummary)) { assert.ok(region.minimum > target * 0.98, JSON.stringify(spacingSummary)); assert.ok(region.maximum < target * 1.02, JSON.stringify(spacingSummary)); }
  assert.ok(spacing.dome.length > 10); assert.deepEqual(leg.normals[capVertex], [0, 1, 0]);
});
test('rounded buried crown stays inside actual torso and collar overlap remains localized', () => {
  assert.equal(surface.dome.noHit, 0); assert.ok(surface.dome.minimumInsideDepth >= -1e-5, JSON.stringify(surface.dome));
  assert.equal(surface.sharedContactEdge.noHit, 0); assert.ok(surface.sharedContactEdge.minimumInsideDepth >= -0.001, JSON.stringify(surface.sharedContactEdge));
  assert.ok(surface.collar.minimumOutsideClearance >= -1e-5, JSON.stringify(surface.collar));
  assert.ok(surface.terminalCollar.minimumOutsideClearance >= -0.02, JSON.stringify(surface.terminalCollar));
});
test('all locked approved asset files remain byte-identical', () => {
  assert.ok(locks.length >= 20); assert.deepEqual(locks.filter(file => !file.unchanged), []);
});
