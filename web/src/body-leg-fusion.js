import * as THREE from 'three';
import { createContinuousUpperProfile } from './leg-continuous.js';
import { createRefinedSection } from './leg-refinement.js';

function spline(x, profile) {
  const { degree, knots, logSquaredRadiusCoefficients: coefficients } = profile;
  const n = coefficients.length - 1;
  let span = n;
  for (let i = degree; i < n; i += 1) if (x < knots[i + 1]) { span = i; break; }
  const values = Array.from({ length: degree + 1 }, (_, j) => coefficients[span - degree + j]);
  for (let level = 1; level <= degree; level += 1) {
    for (let j = degree; j >= level; j -= 1) {
      const i = span - degree + j;
      const w = (x - knots[i]) / (knots[i + degree - level + 1] - knots[i]);
      values[j] = (1 - w) * values[j - 1] + w * values[j];
    }
  }
  return values[degree];
}
const smooth = x => { const t = Math.max(0, Math.min(1, x)); return t ** 3 * (10 + t * (-15 + 6 * t)); };
const mix = (a, b, t) => a + (b - a) * t;
function smoothMin(a, b, width) {
  if (width <= 1e-8) return Math.min(a, b);
  const h = Math.max(1 - Math.abs(a - b) / width, 0);
  return Math.min(a, b) - width * h ** 3 / 6;
}

export function createBodyLegField(bodyParameters, legSettings, v3, v4, startY, config) {
  const { at } = createContinuousUpperProfile(legSettings, v3, v4, startY);
  const bodyHeight = bodyParameters.size[1], bodyBottom = bodyParameters.center[1] - bodyHeight / 2;
  const delta = config.projection.derivativeStep;
  // Distance to the body's radial meridian stays well behaved at its bottom
  // pole. Dividing a global implicit function by its gradient far from that
  // pole can incorrectly turn distant points into a second zero surface.
  const bodySamples = 2048;
  const bodyCurve = Array.from({ length: bodySamples + 1 }, (_, i) => {
    const t = (1 - Math.cos(Math.PI * i / bodySamples)) / 2;
    return [bodyBottom + bodyHeight * t, t * (1 - t), Math.exp(-spline(t, bodyParameters.profiles.front)), Math.exp(-spline(t, bodyParameters.profiles.side))];
  });
  const bodyDistance = (x, y, z) => {
    const rho = Math.hypot(x, z), cx = rho > 1e-12 ? x * x / (rho * rho) : 1, cz = 1 - cx;
    const distance2 = theta => {
      const u = Math.max(0, Math.min(bodySamples - 1e-9, theta * bodySamples)), i = Math.floor(u), w = u - i;
      const a = bodyCurve[i], b = bodyCurve[i + 1];
      const radius = Math.sqrt(Math.max(0, mix(a[1], b[1], w)) / (cx * mix(a[2], b[2], w) + cz * mix(a[3], b[3], w)));
      return (rho - radius) ** 2 + (y - mix(a[0], b[0], w)) ** 2;
    };
    const coarse = 32; let best = Infinity, bestIndex = 0;
    for (let i = 0; i <= coarse; i += 1) { const d = distance2(i / coarse); if (d < best) { best = d; bestIndex = i; } }
    let lo = Math.max(0, (bestIndex - 1) / coarse), hi = Math.min(1, (bestIndex + 1) / coarse);
    const ratio = (Math.sqrt(5) - 1) / 2;
    let a = hi - ratio * (hi - lo), b = lo + ratio * (hi - lo), da = distance2(a), db = distance2(b);
    for (let i = 0; i < 20; i += 1) {
      if (da < db) { hi = b; b = a; db = da; a = hi - ratio * (hi - lo); da = distance2(a); }
      else { lo = a; a = b; da = db; b = lo + ratio * (hi - lo); db = distance2(b); }
    }
    const t = (y - bodyBottom) / bodyHeight;
    let inside = false;
    if (t > 0 && t < 1) {
      const u = Math.acos(1 - 2 * t) / Math.PI * bodySamples, i = Math.min(bodySamples - 1, Math.floor(u)), w = u - i;
      const p = bodyCurve[i], q = bodyCurve[i + 1];
      inside = x * x * mix(p[2], q[2], w) + z * z * mix(p[3], q[3], w) < t * (1 - t);
    }
    return Math.sqrt(Math.min(best, da, db)) * (inside ? -1 : 1);
  };
  let stableLegDistance;
  if (config.field.stableLegDistance) {
    const { section } = createRefinedSection(legSettings, v3, startY);
    const top = v4.upper.crownY, samples = config.field.distanceSamples;
    const curve = Array.from({ length: samples + 1 }, (_, i) => {
      const y = top * i / samples;
      const p = y < startY ? section(y) : at(Math.asin(Math.min(1, (y - startY) / (top - startY))) * 2 / Math.PI);
      return [p.y, p.x, p.z, p.rx, p.rz];
    });
    stableLegDistance = (x, y, z) => {
      const distance2 = t => {
        const u = Math.max(0, Math.min(samples - 1e-9, t * samples)), i = Math.floor(u), w = u - i, p = curve[i], q = curve[i + 1];
        const dx = Math.abs(x) - mix(p[1], q[1], w), dz = z - mix(p[2], q[2], w), rho = Math.hypot(dx, dz);
        const rx = mix(p[3], q[3], w), rz = mix(p[4], q[4], w);
        const radius = rho > 1e-12 && rx > 1e-9 && rz > 1e-9 ? rho / Math.hypot(dx / rx, dz / rz) : Math.min(rx, rz);
        return (rho - radius) ** 2 + (y - mix(p[0], q[0], w)) ** 2;
      };
      const coarse = 32; let best = Infinity, bestIndex = 0;
      for (let i = 0; i <= coarse; i += 1) { const d = distance2(i / coarse); if (d < best) { best = d; bestIndex = i; } }
      let lo = Math.max(0, (bestIndex - 1) / coarse), hi = Math.min(1, (bestIndex + 1) / coarse);
      const ratio = (Math.sqrt(5) - 1) / 2;
      let a = hi - ratio * (hi - lo), b = lo + ratio * (hi - lo), da = distance2(a), db = distance2(b);
      for (let i = 0; i < 20; i += 1) {
        if (da < db) { hi = b; b = a; db = da; a = hi - ratio * (hi - lo); da = distance2(a); }
        else { lo = a; a = b; da = db; b = lo + ratio * (hi - lo); db = distance2(b); }
      }
      const u = Math.max(0, Math.min(samples - 1e-9, y / top * samples)), i = Math.floor(u), w = u - i, p = curve[i], q = curve[i + 1];
      const inside = y > 0 && y < top && ((Math.abs(x) - mix(p[1], q[1], w)) / mix(p[3], q[3], w)) ** 2 + ((z - mix(p[2], q[2], w)) / mix(p[4], q[4], w)) ** 2 < 1;
      return Math.sqrt(Math.min(best, da, db)) * (inside ? -1 : 1);
    };
  }
  const paramsAt = y => {
    const t = (y - bodyBottom) / bodyHeight, clamped = Math.max(0, Math.min(1, t));
    const front = Math.exp(-spline(clamped, bodyParameters.profiles.front));
    const side = Math.exp(-spline(clamped, bodyParameters.profiles.side));
    const u = Math.max(0, Math.min(1, (y - startY) / (v4.upper.crownY - startY)));
    const leg = at(Math.asin(u) * 2 / Math.PI);
    return [front, side, t * (1 - t), leg.x, leg.z, leg.rx * leg.rx, leg.rz * leg.rz];
  };
  // Vertical lookup keeps grid extraction inexpensive; analytic values and
  // derivatives are sampled far more finely than the final surface grid.
  const tableStep = 0.01, tableBottom = startY - 1, tableTop = config.transition.bodyPreserveAboveY + 2;
  const table = [];
  for (let y = tableBottom; y <= tableTop + tableStep; y += tableStep) {
    const a = paramsAt(y - delta), b = paramsAt(y), c = paramsAt(y + delta);
    table.push([...b, ...b.map((_, j) => (c[j] - a[j]) / (2 * delta))]);
  }
  const field = (x, y, z) => {
    const u = Math.max(0, Math.min(table.length - 1.000001, (y - tableBottom) / tableStep));
    const i = Math.floor(u), w = u - i, a = table[i], b = table[i + 1];
    const q = a.map((v, j) => mix(v, b[j], w));
    const body = bodyDistance(x, y, z);
    const dx = Math.abs(x) - q[3], dz = z - q[4];
    const lf = dx * dx / q[5] + dz * dz / q[6] - 1;
    const ly = -2 * dx * q[10] / q[5] - dx * dx * q[12] / (q[5] ** 2)
      - 2 * dz * q[11] / q[6] - dz * dz * q[13] / (q[6] ** 2);
    const leg = stableLegDistance ? stableLegDistance(x, y, z) : lf / Math.max(Math.hypot(2 * dx / q[5], 2 * dz / q[6], ly), 1e-9);
    const transition = config.transition;
    const width = config.field.blendRadius * smooth((y - startY) / (transition.footFadeEndY - startY))
      * (transition.naturalBodyFade ? 1 : 1 - smooth((y - transition.bodyFadeStartY) / (transition.bodyFadeEndY - transition.bodyFadeStartY)));
    return smoothMin(body, leg, width);
  };
  return field;
}

function extractHalfSurface(field, lowerY, upperY, config) {
  const step = config.field.cellSize;
  const nx = Math.ceil(config.field.halfWidth / step), nz = Math.ceil(config.field.halfDepth * 2 / step), ny = Math.ceil((upperY - lowerY) / step);
  const sx = config.field.halfWidth / nx, sz = config.field.halfDepth * 2 / nz, sy = (upperY - lowerY) / ny;
  const layer = (nx + 1) * (nz + 1), values = new Float64Array(layer * (ny + 1));
  const id = (x, y, z) => y * layer + z * (nx + 1) + x;
  const coordinates = key => { const y = Math.floor(key / layer), rest = key - y * layer, z = Math.floor(rest / (nx + 1)), x = rest - z * (nx + 1); return [x * sx, lowerY + y * sy, -config.field.halfDepth + z * sz]; };
  for (let y = 0; y <= ny; y += 1) for (let z = 0; z <= nz; z += 1) for (let x = 0; x <= nx; x += 1) values[id(x, y, z)] = field(x * sx, lowerY + y * sy, -config.field.halfDepth + z * sz);
  const vertices = [], faces = [], edges = new Map();
  const crossing = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edges.has(key)) return edges.get(key);
    const t = values[a] / (values[a] - values[b]), p = coordinates(a), q = coordinates(b);
    const index = vertices.length; vertices.push(p.map((v, j) => mix(v, q[j], t))); edges.set(key, index); return index;
  };
  const tri = (ids, direction) => {
    const a = new THREE.Vector3(...vertices[ids[0]]), b = new THREE.Vector3(...vertices[ids[1]]), c = new THREE.Vector3(...vertices[ids[2]]);
    if (b.sub(a).cross(c.sub(a)).dot(direction) < 0) [ids[1], ids[2]] = [ids[2], ids[1]];
    faces.push(ids);
  };
  const tets = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
  for (let y = 0; y < ny; y += 1) for (let z = 0; z < nz; z += 1) for (let x = 0; x < nx; x += 1) {
    const corners = [id(x, y, z), id(x + 1, y, z), id(x + 1, y + 1, z), id(x, y + 1, z), id(x, y, z + 1), id(x + 1, y, z + 1), id(x + 1, y + 1, z + 1), id(x, y + 1, z + 1)];
    if (corners.every(i => values[i] >= 0) || corners.every(i => values[i] < 0)) continue;
    for (const tet of tets) {
      const inside = tet.map(i => corners[i]).filter(i => values[i] < 0), outside = tet.map(i => corners[i]).filter(i => values[i] >= 0);
      if (!inside.length || !outside.length) continue;
      const avg = ids => ids.reduce((sum, i) => sum.add(new THREE.Vector3(...coordinates(i))), new THREE.Vector3()).divideScalar(ids.length);
      const direction = avg(outside).sub(avg(inside));
      if (inside.length === 1) tri(outside.map(i => crossing(inside[0], i)), direction);
      else if (outside.length === 1) tri(inside.map(i => crossing(i, outside[0])), direction);
      else {
        const [a, b, c, d] = [crossing(inside[0], outside[0]), crossing(inside[0], outside[1]), crossing(inside[1], outside[0]), crossing(inside[1], outside[1])];
        tri([a, b, d], direction); tri([a, d, c], direction);
      }
    }
  }
  // Project to the smooth implicit surface while retaining the three cut planes.
  const d = config.projection.derivativeStep;
  const project = point => {
    const lockX = Math.abs(point[0]) < 1e-9;
    const lockY = Math.abs(point[1] - lowerY) < 1e-9 || Math.abs(point[1] - upperY) < 1e-9;
    for (let pass = 0; pass < config.projection.iterations; pass += 1) {
      const [x, y, z] = point, f = field(x, y, z);
      const gradient = [lockX ? 0 : (field(x + d, y, z) - field(x - d, y, z)) / (2 * d), lockY ? 0 : (field(x, y + d, z) - field(x, y - d, z)) / (2 * d), (field(x, y, z + d) - field(x, y, z - d)) / (2 * d)];
      const length2 = gradient.reduce((sum, v) => sum + v * v, 0);
      if (length2 < 1e-12) break;
      for (let j = 0; j < 3; j += 1) point[j] -= f * gradient[j] / length2;
    }
  };
  for (const point of vertices) project(point);
  // Marching tetrahedra can place two vertices almost on the same grid
  // corner. Redistribute interior vertices tangentially before projecting
  // again, so tiny sliver triangles cannot introduce isolated hard facets.
  // Keep both cut rings fixed; reflect only after relaxation for exact symmetry.
  const neighbors = vertices.map(() => new Set());
  for (const face of faces) for (let i = 0; i < 3; i += 1) {
    neighbors[face[i]].add(face[(i + 1) % 3]);
    neighbors[face[i]].add(face[(i + 2) % 3]);
  }
  for (let pass = 0; pass < config.projection.relaxationPasses; pass += 1) {
    const next = vertices.map((point, i) => {
      const [x, y, z] = point;
      if (Math.abs(y - lowerY) < 1e-9 || Math.abs(y - upperY) < 1e-9) return point;
      const mean = [0, 0, 0];
      for (const j of neighbors[i]) for (let axis = 0; axis < 3; axis += 1) mean[axis] += vertices[j][axis] / neighbors[i].size;
      const normal = [field(x + d, y, z) - field(x - d, y, z), field(x, y + d, z) - field(x, y - d, z), field(x, y, z + d) - field(x, y, z - d)];
      if (Math.abs(x) < 1e-9) { mean[0] = 0; normal[0] = 0; }
      const displacement = mean.map((v, axis) => v - point[axis]);
      const normalLength2 = normal.reduce((sum, v) => sum + v * v, 0);
      const alongNormal = displacement.reduce((sum, v, axis) => sum + v * normal[axis], 0) / normalLength2;
      const result = point.map((v, axis) => v + config.projection.relaxationWeight * (displacement[axis] - alongNormal * normal[axis]));
      project(result);
      return result;
    });
    for (let i = 0; i < vertices.length; i += 1) vertices[i] = next[i];
  }
  const full = vertices.slice(), mirrored = vertices.map((p, i) => { if (Math.abs(p[0]) < 1e-9) return i; const index = full.length; full.push([-p[0], p[1], p[2]]); return index; });
  return { vertices: full, faces: [...faces, ...faces.map(([a, b, c]) => [mirrored[a], mirrored[c], mirrored[b]])], grid: { nx, ny, nz, sx, sy, sz } };
}

function boundaryLoops(faces) {
  const edges = new Map();
  for (const face of faces) for (let i = 0; i < 3; i += 1) {
    const a = face[i], b = face[(i + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const edge = edges.get(key); if (edge) edge.count += 1; else edges.set(key, { a, b, count: 1 });
  }
  const neighbors = new Map();
  for (const { a, b, count } of edges.values()) if (count === 1) {
    if (!neighbors.has(a)) neighbors.set(a, []); if (!neighbors.has(b)) neighbors.set(b, []);
    neighbors.get(a).push(b); neighbors.get(b).push(a);
  }
  for (const [id, next] of neighbors) if (next.length !== 2) throw new Error(`Non-loop boundary at ${id}: ${next.length}`);
  const visited = new Set(), loops = [];
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const loop = []; let previous = -1, current = start;
    do { loop.push(current); visited.add(current); const next = neighbors.get(current).find(i => i !== previous); previous = current; current = next; } while (current !== start);
    loops.push(loop);
  }
  return loops;
}

export function createFusedBodyLegGeometry(body, bodyParameters, leg, audit, legSettings, v3, v4, config) {
  const bodyRadial = bodyParameters.radialSegments, footRadial = audit.radial;
  let bodyStart = 1;
  while (body.attributes.position.getY(bodyStart) < config.transition.bodyPreserveAboveY) bodyStart += bodyRadial;
  const bodyY = body.attributes.position.getY(bodyStart), footY = audit.startY;
  const field = createBodyLegField(bodyParameters, legSettings, v3, v4, footY, config);
  const patch = extractHalfSurface(field, footY + config.transition.boundaryGap, bodyY - config.transition.boundaryGap, config);
  const positions = [], indices = [], normals = [];
  const footCount = audit.preservedVertexCount;
  for (const sign of [1, -1]) {
    for (let i = 0; i < footCount; i += 1) {
      positions.push(sign * leg.attributes.position.getX(i), leg.attributes.position.getY(i), leg.attributes.position.getZ(i));
      normals.push(sign * leg.attributes.normal.getX(i), leg.attributes.normal.getY(i), leg.attributes.normal.getZ(i));
    }
    const offset = sign > 0 ? 0 : footCount;
    for (let i = 0; i < leg.index.count; i += 3) {
      const face = [leg.index.getX(i), leg.index.getX(i + 1), leg.index.getX(i + 2)];
      if (Math.max(...face) >= footCount) continue;
      if (sign < 0) [face[1], face[2]] = [face[2], face[1]];
      indices.push(...face.map(i => i + offset));
    }
  }
  const bodyOffset = positions.length / 3;
  for (let i = bodyStart; i < body.attributes.position.count; i += 1) {
    positions.push(body.attributes.position.getX(i), body.attributes.position.getY(i), body.attributes.position.getZ(i));
    normals.push(body.attributes.normal.getX(i), body.attributes.normal.getY(i), body.attributes.normal.getZ(i));
  }
  for (let i = 0; i < body.index.count; i += 3) {
    const face = [body.index.getX(i), body.index.getX(i + 1), body.index.getX(i + 2)];
    if (Math.min(...face) >= bodyStart) indices.push(...face.map(i => i - bodyStart + bodyOffset));
  }
  const patchOffset = positions.length / 3;
  for (const p of patch.vertices) positions.push(...p);
  for (const face of patch.faces) indices.push(...face.map(i => i + patchOffset));
  const loops = boundaryLoops(patch.faces);
  if (loops.length !== 3) throw new Error(`Expected two foot loops and one body loop, got ${loops.length}`);
  const point = i => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const sortLoop = (loop, center) => loop.map(id => ({ id, angle: (Math.atan2(positions[id * 3 + 2] - center.z, positions[id * 3] - center.x) + 2 * Math.PI) % (2 * Math.PI) })).sort((a, b) => a.angle - b.angle);
  const stitch = (lower, upper) => {
    let i = 0, j = 0;
    while (i < lower.length || j < upper.length) {
      const a = lower[i % lower.length].id, b = upper[j % upper.length].id;
      const nextLower = i < lower.length ? lower[(i + 1) % lower.length].angle + (i + 1 === lower.length ? 2 * Math.PI : 0) : Infinity;
      const nextUpper = j < upper.length ? upper[(j + 1) % upper.length].angle + (j + 1 === upper.length ? 2 * Math.PI : 0) : Infinity;
      if (nextLower < nextUpper) { indices.push(a, b, lower[(i + 1) % lower.length].id); i += 1; }
      else { indices.push(a, b, upper[(j + 1) % upper.length].id); j += 1; }
    }
  };
  const loopReports = [];
  for (const raw of loops) {
    const loop = raw.map(i => i + patchOffset), avg = loop.reduce((sum, i) => sum.add(point(i)), new THREE.Vector3()).divideScalar(loop.length);
    if (avg.y > (footY + bodyY) / 2) {
      stitch(sortLoop(loop, new THREE.Vector3()), sortLoop(Array.from({ length: bodyRadial }, (_, i) => bodyOffset + i), new THREE.Vector3()));
      loopReports.push({ kind: 'body', count: loop.length, y: avg.y });
    } else {
      const offset = avg.x > 0 ? 0 : footCount;
      const ring = Array.from({ length: footRadial }, (_, i) => offset + audit.firstBlendVertex + i);
      const center = ring.reduce((sum, i) => sum.add(point(i)), new THREE.Vector3()).divideScalar(footRadial);
      stitch(sortLoop(ring, center), sortLoop(loop, center));
      loopReports.push({ kind: avg.x > 0 ? 'right-foot' : 'left-foot', count: loop.length, y: avg.y });
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  // Use the continuous field gradient for the remeshed patch; preserve source
  // shading outside the edit region. Shared indexed joins remove split normals.
  const d = config.projection.derivativeStep;
  for (let i = patchOffset; i < positions.length / 3; i += 1) {
    const [x, y, z] = positions.slice(i * 3, i * 3 + 3);
    const normal = new THREE.Vector3(field(x + d, y, z) - field(x - d, y, z), field(x, y + d, z) - field(x, y - d, z), field(x, y, z + d) - field(x, y, z - d)).normalize();
    geometry.attributes.normal.setXYZ(i, ...normal);
  }
  geometry.attributes.normal.array.set(normals);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, report: { version: config.version, method: config.field.stableLegDistance ? 'stable-distance-natural-union-shared-indexed-surface' : 'local-C2-smooth-union-shared-indexed-surface', footY, footCount, footRadial, preservedFootTrianglesPerSide: audit.preservedTriangleCount, bodyY, bodyStart, bodyOffset, bodyPreservedCount: body.attributes.position.count - bodyStart, patchOffset, patchVertices: patch.vertices.length, patchTriangles: patch.faces.length, grid: patch.grid, boundaryLoops: loopReports } };
}
