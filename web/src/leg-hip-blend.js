import * as THREE from 'three';
import { legSection, sampleLegSections } from './leg-geometry.js';

// Read-only vertical intersection with the approved body. A spatial bucket
// avoids raycasting its entire mesh for every contact-curve sample.
export function bodyLowerSurface(geometry) {
  const p = geometry.attributes.position;
  const n = geometry.attributes.normal;
  const ids = geometry.index;
  const buckets = new Map();
  const cell = 2;
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < ids.count; i += 3) {
    const a = ids.getX(i), b = ids.getX(i + 1), c = ids.getX(i + 2);
    const ax = p.getX(a), az = p.getZ(a), bx = p.getX(b), bz = p.getZ(b), cx = p.getX(c), cz = p.getZ(c);
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const triangle = { a, b, c, ax, az, bx, bz, cx, cz, det };
    for (let x = Math.floor(Math.min(ax, bx, cx) / cell); x <= Math.floor(Math.max(ax, bx, cx) / cell); x += 1) {
      for (let z = Math.floor(Math.min(az, bz, cz) / cell); z <= Math.floor(Math.max(az, bz, cz) / cell); z += 1) {
        const name = `${x},${z}`;
        if (!buckets.has(name)) buckets.set(name, []);
        buckets.get(name).push(triangle);
      }
    }
  }
  return (x, z) => {
    let result = null;
    for (const t of buckets.get(key(x, z)) ?? []) {
      const u = ((t.bz - t.cz) * (x - t.cx) + (t.cx - t.bx) * (z - t.cz)) / t.det;
      const v = ((t.cz - t.az) * (x - t.cx) + (t.ax - t.cx) * (z - t.cz)) / t.det;
      const w = 1 - u - v;
      if (Math.min(u, v, w) < -1e-7) continue;
      const y = u * p.getY(t.a) + v * p.getY(t.b) + w * p.getY(t.c);
      if (result && result.point.y <= y) continue;
      const normal = new THREE.Vector3();
      for (const [id, weight] of [[t.a, u], [t.b, v], [t.c, w]]) normal.addScaledVector(new THREE.Vector3().fromBufferAttribute(n, id), weight);
      result = { point: new THREE.Vector3(x, y, z), normal: normal.normalize() };
    }
    return result;
  };
}

function sectionPoint(settings, y, angle) {
  const s = legSection(y, settings);
  return new THREE.Vector3(s.x + s.rx * Math.cos(angle), y, s.z + s.rz * Math.sin(angle));
}

function legDerivative(settings, y, angle) {
  return sectionPoint(settings, y + 0.001, angle).sub(sectionPoint(settings, y - 0.001, angle)).multiplyScalar(500);
}

function hermite(a, b, da, db, t) {
  const t2 = t * t, t3 = t2 * t;
  return a.clone().multiplyScalar(2 * t3 - 3 * t2 + 1)
    .addScaledVector(da, t3 - 2 * t2 + t)
    .addScaledVector(b, -2 * t3 + 3 * t2)
    .addScaledVector(db, t3 - t2);
}

export function createSmoothLegGeometry(settings, blend, bodyGeometry) {
  const lower = bodyLowerSurface(bodyGeometry);
  const count = settings.sampling.radial;
  const sections = sampleLegSections(settings).filter((s) => s.y <= blend.preserveBelowY);
  const startY = sections.at(-1).y;
  const contacts = [];
  for (let i = 0; i < count; i += 1) {
    const angle = i * 2 * Math.PI / count;
    let lo = startY, hi = settings.domain[1] - 0.01;
    for (let iteration = 0; iteration < 42; iteration += 1) {
      const y = (lo + hi) / 2;
      const point = sectionPoint(settings, y, angle);
      const hit = lower(point.x, point.z);
      if (hit && point.y >= hit.point.y) hi = y;
      else lo = y;
    }
    const intersection = sectionPoint(settings, (lo + hi) / 2, angle);
    let hit = lower(intersection.x, intersection.z);
    if (!hit) throw new Error(`Missing body intersection at ${i}`);
    const dTheta = sectionPoint(settings, intersection.y, angle + 0.001).sub(sectionPoint(settings, intersection.y, angle - 0.001));
    const legNormal = legDerivative(settings, intersection.y, angle).cross(dTheta).normalize();
    for (let step = 0; step < blend.contactSteps; step += 1) {
      const tangent = legNormal.clone().addScaledVector(hit.normal, -legNormal.dot(hit.normal)).normalize();
      const next = hit.point.clone().addScaledVector(tangent, blend.contactSpread / blend.contactSteps);
      const nextHit = lower(next.x, next.z);
      if (!nextHit || next.x <= blend.minimumCenterGap / 2) break;
      hit = nextHit;
    }
    contacts.push({ ...hit, intersection });
  }
  const curves = contacts.map((contact, i) => {
    const angle = i * 2 * Math.PI / count;
    const a = sectionPoint(settings, startY, angle);
    const b = contact.point.clone();
    const crossTangent = contacts[(i + 1) % count].point.clone().sub(contacts[(i + count - 1) % count].point);
    const endDirection = crossTangent.cross(contact.normal).normalize();
    const length = a.distanceTo(b);
    return { a, b, da: legDerivative(settings, startY, angle).normalize().multiplyScalar(length * blend.startTangentScale), db: endDirection.multiplyScalar(length * blend.endTangentScale) };
  });
  // Preserve every original sole/foot vertex below the chosen join row.
  const positions = [sections[0].x, sections[0].y, sections[0].z];
  for (const s of sections.slice(1)) {
    for (let i = 0; i < count; i += 1) positions.push(...sectionPoint(settings, s.y, i * 2 * Math.PI / count));
  }
  const firstBlendVertex = positions.length / 3 - count;
  let minimumClearance = Infinity;
  for (let row = 1; row <= blend.rings; row += 1) {
    const t = row / blend.rings;
    for (let i = 0; i < count; i += 1) {
      const c = curves[i];
      const point = hermite(c.a, c.b, c.da, c.db, t);
      const hit = lower(point.x, point.z);
      if (row < blend.rings && hit) minimumClearance = Math.min(minimumClearance, hit.point.y - point.y);
      positions.push(...point);
    }
  }
  const contactVertex = positions.length / 3 - count;
  // The closure is wholly buried in the unchanged torso. Its normal must not
  // contaminate the visible rim, which inherits the actual body normal below.
  for (const contact of contacts) positions.push(...contact.point.clone().addScaledVector(contact.normal, -blend.hiddenInset));
  const capVertex = positions.length / 3;
  const cap = new THREE.Vector3();
  for (const contact of contacts) cap.add(contact.point);
  cap.divideScalar(count).y += blend.capLift;
  positions.push(...cap);
  const indices = [];
  for (let i = 0; i < count; i += 1) indices.push(0, 1 + i, 1 + (i + 1) % count);
  const rows = (capVertex - 1) / count;
  for (let row = 0; row < rows - 1; row += 1) {
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
  for (let i = 0; i < count; i += 1) geometry.attributes.normal.setXYZ(contactVertex + i, ...contacts[i].normal);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, report: { startY, firstBlendVertex, contactVertex, capVertex, minimumClearance, contactPoints: contacts.map((c) => ({ point: c.point.toArray(), normal: c.normal.toArray(), intersection: c.intersection.toArray() })) } };
}
