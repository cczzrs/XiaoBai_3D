import * as THREE from 'three';
import { legSection } from './leg-geometry.js';

function hermite(a, b, da, db, t) {
  const t2 = t * t, t3 = t2 * t;
  return a.clone().multiplyScalar(2 * t3 - 3 * t2 + 1)
    .addScaledVector(da, t3 - 2 * t2 + t)
    .addScaledVector(b, -2 * t3 + 3 * t2)
    .addScaledVector(db, t3 - t2);
}

// Quintic Hermite interpolation matches value, tangent and curvature at both ends.
function fairProfile(a, b, da, db, dda, ddb, length, t) {
  const c0 = a, c1 = da * length, c2 = dda * length * length / 2;
  const d = b - c0 - c1 - c2, e = db * length - c1 - 2 * c2;
  const f = ddb * length * length - 2 * c2;
  const c3 = 10 * d - 4 * e + f / 2, c4 = -15 * d + 7 * e - f, c5 = 6 * d - 3 * e + f / 2;
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * c5))));
}

export function createRefinedSection(settings, refinement, joinY) {
  let [lo, hi] = refinement.foot.peakSearch;
  for (let i = 0; i < 64; i += 1) {
    const a = (2 * lo + hi) / 3, b = (lo + 2 * hi) / 3;
    if (legSection(a, settings).rz < legSection(b, settings).rz) lo = a;
    else hi = b;
  }
  const toeY = (lo + hi) / 2, step = refinement.foot.derivativeStep;
  const derivatives = (y, key) => {
    const before = legSection(y - step, settings)[key], value = legSection(y, settings)[key], after = legSection(y + step, settings)[key];
    return { value, first: (after - before) / (2 * step), second: (after - 2 * value + before) / (step * step) };
  };
  const ends = Object.fromEntries(['x', 'rx', 'rz'].map(key => [key, [derivatives(toeY, key), derivatives(joinY, key)]]));
  const section = y => {
    const result = legSection(y, settings);
    if (y <= toeY || y >= joinY) return result;
    const t = (y - toeY) / (joinY - toeY);
    for (const [key, [a, b]] of Object.entries(ends)) {
      result[key] = fairProfile(a.value, b.value, a.first, b.first, a.second, b.second, joinY - toeY, t);
    }
    return result;
  };
  return { section, toeY };
}

// Arc-length sampling is shared by all three regions; each boundary is retained
// exactly so the knee transition and approved torso contact cannot drift.
export function sampleSurface(evaluate, count, settings) {
  const samples = [];
  let distance = 0, previous;
  for (let i = 0; i <= settings.denseSteps; i += 1) {
    const t = (1 - Math.cos(Math.PI * i / settings.denseSteps)) / 2;
    const row = Array.from({ length: count }, (_, j) => evaluate(t, j));
    if (previous) distance += row.reduce((sum, point, j) => sum + point.distanceTo(previous[j]), 0) / count;
    samples.push({ t, distance });
    previous = row;
  }
  const intervals = Math.max(2, Math.round(distance / settings.ringSpacing));
  const rows = [], spacing = [];
  let cursor = 1;
  for (let i = 0; i <= intervals; i += 1) {
    const target = distance * i / intervals;
    while (cursor < samples.length - 1 && samples[cursor].distance < target) cursor += 1;
    const a = samples[cursor - 1], b = samples[cursor];
    const t = i === 0 ? 0 : i === intervals ? 1 : THREE.MathUtils.lerp(a.t, b.t, (target - a.distance) / (b.distance - a.distance));
    const row = Array.from({ length: count }, (_, j) => evaluate(t, j));
    if (rows.length) spacing.push(row.reduce((sum, p, j) => sum + p.distanceTo(rows.at(-1)[j]), 0) / count);
    rows.push(row);
  }
  return { rows, report: { intervals, arcLength: distance, minimumMeanSpacing: Math.min(...spacing), maximumMeanSpacing: Math.max(...spacing) } };
}

export function createRefinedLegGeometry(settings, blend, refinement, contactAudit) {
  const count = refinement.sampling.radial;
  if (count !== contactAudit.contactPoints.length) throw new Error('The v3 radial count must match the approved contact ring.');
  const { startY } = contactAudit;
  const { section, toeY } = createRefinedSection(settings, refinement, startY);
  const pointAt = (y, angle) => {
    const s = section(y);
    return new THREE.Vector3(s.x + s.rx * Math.cos(angle), y, s.z + s.rz * Math.sin(angle));
  };
  const contacts = contactAudit.contactPoints.map(c => ({ point: new THREE.Vector3(...c.point), normal: new THREE.Vector3(...c.normal) }));
  const curves = contacts.map((c, i) => {
    const angle = i * 2 * Math.PI / count;
    const a = pointAt(startY, angle), length = a.distanceTo(c.point);
    const da = pointAt(startY + 0.001, angle).sub(pointAt(startY - 0.001, angle)).normalize().multiplyScalar(length * blend.startTangentScale);
    const direction = contacts[(i + 1) % count].point.clone().sub(contacts[(i + count - 1) % count].point).cross(c.normal).normalize();
    return { a, b: c.point, da, db: direction.clone().multiplyScalar(length * blend.endTangentScale), direction };
  });
  const crown = contacts.reduce((sum, c) => sum.add(c.point), new THREE.Vector3()).divideScalar(count);
  crown.y = Math.max(...contacts.map(c => c.point.y)) + refinement.dome.rise;
  const foot = sampleSurface((t, i) => pointAt(startY * t, i * 2 * Math.PI / count), count, refinement.sampling);
  const collar = sampleSurface((t, i) => { const c = curves[i]; return hermite(c.a, c.b, c.da, c.db, t); }, count, refinement.sampling);
  const dome = sampleSurface((t, i) => {
    const c = curves[i], u = 1 - t;
    const p1 = c.b.clone().addScaledVector(c.direction, refinement.dome.startTangentLength);
    // The final tangent is horizontal and radial: the dome reaches a smooth pole.
    const p2 = crown.clone().add(new THREE.Vector3(c.b.x - crown.x, 0, c.b.z - crown.z).multiplyScalar(refinement.dome.crownRadiusScale));
    return c.b.clone().multiplyScalar(u ** 3).addScaledVector(p1, 3 * u * u * t).addScaledVector(p2, 3 * u * t * t).addScaledVector(crown, t ** 3);
  }, count, refinement.sampling);
  const rows = [...foot.rows.slice(1), ...collar.rows.slice(1), ...dome.rows.slice(1, -1)];
  const positions = [...foot.rows[0][0], ...rows.flatMap(row => row.flatMap(p => p.toArray())), ...crown];
  const capVertex = positions.length / 3 - 1;
  const firstBlendVertex = 1 + (foot.rows.length - 2) * count;
  const contactVertex = firstBlendVertex + (collar.rows.length - 1) * count;
  const indices = [];
  for (let i = 0; i < count; i += 1) indices.push(0, 1 + i, 1 + (i + 1) % count);
  for (let row = 0; row < rows.length - 1; row += 1) {
    for (let i = 0; i < count; i += 1) {
      const a = 1 + row * count + i, b = 1 + row * count + (i + 1) % count;
      indices.push(a, a + count, b + count, a, b + count, b);
    }
  }
  for (let i = 0; i < count; i += 1) indices.push(capVertex - count + i, capVertex, capVertex - count + (i + 1) % count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.attributes.normal.setXYZ(0, 0, -1, 0);
  geometry.attributes.normal.setXYZ(capVertex, 0, 1, 0);
  for (let i = 0; i < count; i += 1) geometry.attributes.normal.setXYZ(contactVertex + i, ...contacts[i].normal);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const report = { toeY, startY, radial: count, firstBlendVertex, contactVertex, capVertex, crown: crown.toArray(), regions: { foot: foot.report, collar: collar.report, dome: dome.report } };
  return { geometry, report };
}
