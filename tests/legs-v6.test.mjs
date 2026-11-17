import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalURL } from '../scripts/project-paths.mjs';

const root = new URL('../', import.meta.url);
const assetDirectory = new URL('assets/design/legs-v6/', root);
const defaultDirectory = await access(new URL('body-legs.glb', assetDirectory)).then(() => 'assets/design/legs-v6').catch(() => 'temp/generated/legs-v6');
const candidate = new URL(`${process.env.LEGS_V6_DIRECTORY ?? defaultDirectory}/`, root);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
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

const [bytes, previousBytes, bodyBytes, audit, sourceAudit] = await Promise.all([
  readFile(new URL('body-legs.glb', candidate)),
  readFile(new URL('assets/design/legs-v4/legs.glb', root)),
  readFile(new URL('assets/approved/body-v7/xiaobai-torso.glb', root)),
  json(new URL('geometry-audit.json', candidate)),
  json(new URL('assets/design/legs-v4/geometry-audit.json', root)),
]);
const model = decodeGLB(bytes), source = decodeGLB(previousBytes).meshes.find(mesh => (mesh.scale?.[0] ?? 1) > 0), body = decodeGLB(bodyBytes).meshes[0];
const mesh = model.meshes[0];
const { footCount, bodyStart, bodyOffset, patchOffset } = audit;
// These edit limits are independently fixed by the accepted v4 feet and the
// agreed local torso boundary; a generated audit cannot move them to pass.
assert.equal(footCount, 15041);
assert.equal(bodyStart, 16129);
assert.equal(bodyOffset, 30082);
assert.equal(patchOffset, 50627);
const sourceFootIndices = [];
for (let i = 0; i < source.indices.length; i += 3) if (Math.max(...source.indices.slice(i, i + 3)) < footCount) sourceFootIndices.push(...source.indices.slice(i, i + 3));
const expectedIndices = [...sourceFootIndices];
for (let i = 0; i < sourceFootIndices.length; i += 3) expectedIndices.push(sourceFootIndices[i] + footCount, sourceFootIndices[i + 2] + footCount, sourceFootIndices[i + 1] + footCount);
const preserved = { footVerticesPerSide: footCount, footTrianglesPerSide: sourceFootIndices.length / 3, positionMismatches: 0, normalMismatches: 0, footIndexMismatches: 0, bodyPositionMismatches: 0, bodyNormalMismatches: 0, bodyIndexMismatches: 0, bodyVertices: body.positions.length - bodyStart };
for (const sign of [1, -1]) {
  const offset = sign > 0 ? 0 : footCount;
  for (let i = 0; i < footCount; i += 1) {
    const p = source.positions[i].map((v, axis) => axis === 0 ? sign * v : v);
    const n = source.normals[i].map((v, axis) => axis === 0 ? sign * v : v);
    if (p.some((v, axis) => v !== mesh.positions[i + offset][axis])) preserved.positionMismatches += 1;
    if (n.some((v, axis) => v !== mesh.normals[i + offset][axis])) preserved.normalMismatches += 1;
  }
}
for (let i = bodyStart; i < body.positions.length; i += 1) {
  if (body.positions[i].some((v, axis) => v !== mesh.positions[i - bodyStart + bodyOffset][axis])) preserved.bodyPositionMismatches += 1;
  if (body.normals[i].some((v, axis) => v !== mesh.normals[i - bodyStart + bodyOffset][axis])) preserved.bodyNormalMismatches += 1;
}
const bodyIndices = [];
for (let i = 0; i < body.indices.length; i += 3) if (Math.min(...body.indices.slice(i, i + 3)) >= bodyStart) bodyIndices.push(...body.indices.slice(i, i + 3).map(id => id - bodyStart + bodyOffset));
for (let i = 0; i < expectedIndices.length; i += 1) if (mesh.indices[i] !== expectedIndices[i]) preserved.footIndexMismatches += 1;
for (let i = 0; i < bodyIndices.length; i += 1) if (mesh.indices[expectedIndices.length + i] !== bodyIndices[i]) preserved.bodyIndexMismatches += 1;

const topology = { vertices: mesh.positions.length, triangles: mesh.indices.length / 3, signedVolume: 0, minimumTriangleArea: Infinity, degenerateTriangles: 0, nonfinite: 0, opposedNormals: 0, duplicateFaces: 0, duplicatePositions: 0, singularVertices: 0, minimumNormalLength: Infinity, maximumNormalLength: 0 };
const edges = new Map(), seenFaces = new Set(), seenPositions = new Set(), faceNormals = [], opposedExamples = [], joinFaces = [];
const incidentFaces = Array.from({ length: mesh.positions.length }, () => []);
const parents = Array.from({ length: mesh.positions.length }, (_, i) => i);
const find = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; } return id; };
for (const point of [...mesh.positions, ...mesh.normals]) if (!point.every(Number.isFinite)) topology.nonfinite += 1;
for (const point of mesh.positions) {
  const key = point.join(':');
  if (seenPositions.has(key)) topology.duplicatePositions += 1;
  seenPositions.add(key);
}
for (const n of mesh.normals) { topology.minimumNormalLength = Math.min(topology.minimumNormalLength, length(n)); topology.maximumNormalLength = Math.max(topology.maximumNormalLength, length(n)); }
for (let i = 0; i < mesh.indices.length; i += 3) {
  const ids = mesh.indices.slice(i, i + 3), p = ids.map(id => mesh.positions[id]);
  joinFaces.push(Math.min(...ids) < patchOffset && Math.max(...ids) >= patchOffset);
  for (const id of ids) incidentFaces[id].push(i / 3);
  const normal = cross(sub(p[1], p[0]), sub(p[2], p[0])), magnitude = length(normal);
  const area = magnitude / 2;
  topology.minimumTriangleArea = Math.min(topology.minimumTriangleArea, area);
  if (area <= 1e-12) topology.degenerateTriangles += 1;
  topology.signedVolume += dot(p[0], cross(p[1], p[2])) / 6;
  faceNormals.push(magnitude ? mul(normal, 1 / magnitude) : [0, 0, 0]);
  const faceKey = ids.slice().sort((a, b) => a - b).join(':');
  if (seenFaces.has(faceKey)) topology.duplicateFaces += 1;
  seenFaces.add(faceKey);
  for (const id of ids) if (dot(normal, mesh.normals[id]) <= 0) {
    topology.opposedNormals += 1;
    if (opposedExamples.length < 12) opposedExamples.push({ triangle: i / 3, vertex: id, position: mesh.positions[id], area });
  }
  for (let j = 0; j < 3; j += 1) {
    const a = ids[j], b = ids[(j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const edge = edges.get(key) ?? { ids: [a, b], winding: 0, faces: [] };
    edge.winding += a < b ? 1 : -1; edge.faces.push(i / 3); edges.set(key, edge);
    parents[find(a)] = find(b);
  }
}
topology.components = new Set(parents.map((_, i) => find(i))).size;
topology.nonmanifoldEdges = [...edges.values()].filter(edge => edge.faces.length !== 2).length;
topology.inconsistentWindingEdges = [...edges.values()].filter(edge => edge.winding !== 0).length;
topology.eulerCharacteristic = topology.vertices - edges.size + topology.triangles;
// Edge incidence alone cannot exclude two closed sheets touching at a vertex.
// Every vertex must have one connected fan of incident faces.
for (let vertex = 0; vertex < incidentFaces.length; vertex += 1) {
  const incident = incidentFaces[vertex], visited = new Set(), pending = incident.slice(0, 1);
  while (pending.length) {
    const face = pending.pop();
    if (visited.has(face)) continue;
    visited.add(face);
    for (const neighbor of mesh.indices.slice(face * 3, face * 3 + 3)) {
      if (neighbor === vertex) continue;
      const edge = edges.get(`${Math.min(vertex, neighbor)}:${Math.max(vertex, neighbor)}`);
      for (const other of edge.faces) if (!visited.has(other)) pending.push(other);
    }
  }
  if (!incident.length || visited.size !== incident.length) topology.singularVertices += 1;
}

const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (length(a) * length(b))))) * 180 / Math.PI;
// Sample the delivered triangles and their interpolated shading normals, not
// the generator's field. This catches the circumferential shading bands that
// the v5 manifold and maximum edge-angle checks did not detect.
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
const shadingBands = measureShadingBands(mesh);
const previousShadingBands = measureShadingBands(decodeGLB(await readFile(new URL('assets/design/legs-v5/body-legs.glb', root))).meshes[0]);
const shape = { patchMaximumFaceAngle: 0, patchMaximumNormalAngle: 0, joinMaximumFaceAngle: 0, joinMaximumNormalAngle: 0, foldedPatchEdges: 0, worstPatchEdge: null, worstJoinEdge: null };
const patchAngles = [], joinAngles = [];
for (const edge of edges.values()) {
  if (edge.faces.length !== 2) continue;
  const faceAngle = angle(...edge.faces.map(id => faceNormals[id])), normalAngle = angle(...edge.ids.map(id => mesh.normals[id]));
  if (Math.min(...edge.ids) >= patchOffset) {
    patchAngles.push(faceAngle);
    if (faceAngle > shape.patchMaximumFaceAngle) { shape.patchMaximumFaceAngle = faceAngle; shape.worstPatchEdge = { vertices: edge.ids, points: edge.ids.map(id => mesh.positions[id]), faces: edge.faces }; }
    shape.patchMaximumNormalAngle = Math.max(shape.patchMaximumNormalAngle, normalAngle);
    if (faceAngle >= 90) shape.foldedPatchEdges += 1;
  }
  // Include circumferential edges at both ends of each stitch band, not only
  // the edges crossing from preserved geometry to the generated patch.
  if (edge.faces.some(face => joinFaces[face])) {
    joinAngles.push(faceAngle);
    if (faceAngle > shape.joinMaximumFaceAngle) { shape.joinMaximumFaceAngle = faceAngle; shape.worstJoinEdge = { vertices: edge.ids, points: edge.ids.map(id => mesh.positions[id]) }; }
    shape.joinMaximumNormalAngle = Math.max(shape.joinMaximumNormalAngle, normalAngle);
  }
}
patchAngles.sort((a, b) => a - b); joinAngles.sort((a, b) => a - b);
shape.patchP99FaceAngle = patchAngles[Math.floor(patchAngles.length * 0.99)];
shape.joinP99FaceAngle = joinAngles[Math.floor(joinAngles.length * 0.99)];

// Exact mirror coordinates in the patch; original torso transcendental samples
// can differ by a few ulps, so key quantization is much finer than the grid.
const key = p => p.map(v => Math.round(v * 100000)).join(':');
const pointMap = new Map(mesh.positions.map((p, i) => [key(p), i]));
const symmetry = { unmatchedVertices: 0, maximumPositionError: 0, maximumNormalError: 0 };
for (let i = 0; i < mesh.positions.length; i += 1) {
  const p = mesh.positions[i], mirror = [-p[0], p[1], p[2]], id = pointMap.get(key(mirror));
  if (id === undefined) { symmetry.unmatchedVertices += 1; continue; }
  symmetry.maximumPositionError = Math.max(symmetry.maximumPositionError, length(sub(mirror, mesh.positions[id])));
  const n = mesh.normals[i]; symmetry.maximumNormalError = Math.max(symmetry.maximumNormalError, length(sub([-n[0], n[1], n[2]], mesh.normals[id])));
}
const approval = await json(new URL('docs/approvals/actions-v1-approved.json', root));
const locks = await Promise.all(approval.lockedFileSnapshot.filter(file => !file.path.endsWith('.DS_Store')).map(async file => {
  const value = await readFile(historicalURL(file.path));
  return { path: file.path, unchanged: value.length === file.sizeBytes && sha256(value) === file.sha256 };
}));
const provenance = await json(new URL('provenance.json', candidate));
const report = { candidate: candidate.pathname, sha256: sha256(bytes), preserved, topology, opposedExamples, shape, shadingBands, previousShadingBands, symmetry, locks, limitations: ['Connectivity and edge-angle checks identify boundary cracks and folded triangles; this is not a global triangle/triangle intersection proof.', 'The unified body/leg design is unbound and has new topology; the original body file and accepted feet are compared independently.', 'Fixed-section geometry and interpolated-normal rates quantify the reported shading bands; visual acceptance still requires multi-angle review.'] };
await mkdir(new URL('temp/legs-v6/', root), { recursive: true });
await writeFile(new URL('temp/legs-v6/independent-geometry-check.json', root), JSON.stringify(report, null, 2) + '\n');

test('v6 preserves both v4 feet exactly, including mirrored indices and shading', () => {
  assert.equal(footCount, sourceAudit.preservedVertexCount);
  for (const name of ['positionMismatches', 'normalMismatches', 'footIndexMismatches']) assert.equal(preserved[name], 0, name);
  assert.equal(preserved.footTrianglesPerSide, sourceAudit.preservedTriangleCount);
  assert.equal(preserved.footTrianglesPerSide, 29920);
});
test('v6 retains the original torso above the local edit boundary exactly', () => {
  for (const name of ['bodyPositionMismatches', 'bodyNormalMismatches', 'bodyIndexMismatches']) assert.equal(preserved[name], 0, name);
  assert.equal(preserved.bodyVertices, audit.bodyPreservedCount);
  assert.equal(mesh.positions[bodyOffset][1], body.positions[bodyStart][1]);
  assert.equal(mesh.positions[bodyOffset][1], 32.684898376464844);
  assert.equal(preserved.bodyVertices, 20545);
});
test('v6 is one closed connected manifold without detached rings or duplicate faces', () => {
  assert.equal(model.meshes.length, 1); assert.equal(topology.components, 1); assert.equal(topology.eulerCharacteristic, 2);
  assert.equal(topology.nonmanifoldEdges, 0); assert.equal(topology.inconsistentWindingEdges, 0); assert.equal(topology.duplicateFaces, 0);
  assert.equal(topology.duplicatePositions, 0); assert.equal(topology.singularVertices, 0);
  assert.equal(topology.nonfinite, 0); assert.equal(topology.degenerateTriangles, 0); assert.ok(topology.signedVolume > 0);
});
test('v6 fusion faces and normals do not fold or flip', () => {
  assert.equal(topology.opposedNormals, 0, JSON.stringify(opposedExamples));
  assert.ok(topology.minimumNormalLength > 0.9999 && topology.maximumNormalLength < 1.0001);
  assert.equal(shape.foldedPatchEdges, 0, JSON.stringify(shape.worstPatchEdge));
  assert.ok(shape.patchMaximumFaceAngle < 30, JSON.stringify(shape));
  assert.ok(shape.patchMaximumNormalAngle < 30, JSON.stringify(shape));
});
test('v6 shared joins transition smoothly without a circumferential crease', () => {
  assert.ok(joinAngles.length > 500);
  assert.ok(shape.joinMaximumFaceAngle < 10, JSON.stringify(shape));
  assert.ok(shape.joinMaximumNormalAngle < 10, JSON.stringify(shape));
});
test('v6 removes the body fade-band curvature spike in both geometry and shading', () => {
  assert.ok(shadingBands.bodyMaximumNormalRate < 10, JSON.stringify(shadingBands.bodySections));
  assert.ok(shadingBands.bodyMaximumGeometryRate < 15, JSON.stringify(shadingBands.bodySections));
  assert.ok(shadingBands.bodyMaximumNormalRate < previousShadingBands.bodyMaximumNormalRate * 0.5);
  assert.ok(shadingBands.bodyMaximumGeometryRate < previousShadingBands.bodyMaximumGeometryRate * 0.5);
});
test('v6 softens the ankle normal-rate discontinuity while preserving the foot', () => {
  assert.ok(shadingBands.ankleMaximumRateJump < 3, JSON.stringify(shadingBands.ankleSamples));
  assert.ok(shadingBands.ankleRmsRateJump < 2, JSON.stringify(shadingBands.ankleSamples));
  assert.ok(shadingBands.ankleRmsRateJump < previousShadingBands.ankleRmsRateJump * 0.6);
});
test('v6 remains a symmetric static design copy', () => {
  assert.equal(symmetry.unmatchedVertices, 0); assert.ok(symmetry.maximumPositionError < 1e-5); assert.ok(symmetry.maximumNormalError < 1e-4, JSON.stringify(symmetry));
  assert.equal(model.document.skins?.length ?? 0, 0); assert.equal(model.document.animations?.length ?? 0, 0);
  assert.equal(model.document.meshes.length, 1);
  assert.equal(model.document.meshes[0].primitives.length, 1);
  assert.equal(model.document.meshes[0].primitives[0].mode ?? 4, 4);
  assert.equal(mesh.positions.length, mesh.normals.length);
  for (const node of model.document.nodes) {
    assert.deepEqual(node.translation ?? [0, 0, 0], [0, 0, 0]);
    assert.deepEqual(node.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]);
    assert.deepEqual(node.scale ?? [1, 1, 1], [1, 1, 1]);
    assert.deepEqual(node.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
});
test('v6 source provenance and every approved baseline file remain exact', () => {
  assert.equal(provenance.sha256, sha256(bytes)); assert.equal(provenance.bodyReferenceSha256, sha256(bodyBytes)); assert.equal(provenance.legsReferenceSha256, sha256(previousBytes));
  assert.ok(locks.length >= 20); assert.deepEqual(locks.filter(file => !file.unchanged), []);
});

