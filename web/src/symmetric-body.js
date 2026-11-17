import * as THREE from 'three';
import { createFusedBodyLegGeometry } from './body-leg-fusion.js';

// The body owns its complete smooth hip transition. The paired leg objects
// remain complete, front/back symmetric solids inside this design companion.
export function createSymmetricBodyGeometry(body, bodyParameters, leg, audit, legSettings, previousRefinement, refinement, config) {
  const fused = createFusedBodyLegGeometry(body, bodyParameters, leg, audit, legSettings, previousRefinement, refinement, config);
  const source = fused.geometry, sourcePosition = source.attributes.position;
  // A small C2 envelope covers the chord error between the independently
  // triangulated leg and union surfaces. Its value and first two derivatives
  // vanish at the accepted foot boundary and above the lower transition.
  const clearance = config.surfaceClearance;
  const smooth = t => { const u = THREE.MathUtils.clamp(t, 0, 1); return u ** 3 * (10 - 15 * u + 6 * u * u); };
  const derivative = t => t > 0 && t < 1 ? 30 * t * t * (1 - t) ** 2 : 0;
  let clearanceVertexCount = 0, maximumClearance = 0;
  for (let i = fused.report.patchOffset; i < sourcePosition.count; i += 1) {
    const y = sourcePosition.getY(i), rise = (y - fused.report.footY) / clearance.riseHeight;
    const fade = (y - clearance.fadeStartY) / (clearance.fadeEndY - clearance.fadeStartY);
    const offset = clearance.distance * smooth(rise) * (1 - smooth(fade));
    if (offset === 0) continue;
    const slope = clearance.distance * (derivative(rise) / clearance.riseHeight * (1 - smooth(fade))
      - smooth(rise) * derivative(fade) / (clearance.fadeEndY - clearance.fadeStartY));
    const normal = new THREE.Vector3().fromBufferAttribute(source.attributes.normal, i);
    sourcePosition.setXYZ(i, sourcePosition.getX(i) + offset * normal.x, y + offset * normal.y, sourcePosition.getZ(i) + offset * normal.z);
    // Correct the source smooth normal for the envelope's tangent gradient.
    const corrected = normal.clone().multiplyScalar(1 + slope * normal.y).add(new THREE.Vector3(0, -slope, 0)).normalize();
    source.attributes.normal.setXYZ(i, corrected.x, corrected.y, corrected.z);
    clearanceVertexCount += 1; maximumClearance = Math.max(maximumClearance, offset);
  }
  const footCount = audit.preservedVertexCount, radial = audit.radial;
  const positions = [], normals = [], indices = [], mapping = new Map();
  const use = id => {
    if (!mapping.has(id)) {
      mapping.set(id, positions.length / 3);
      positions.push(sourcePosition.getX(id), sourcePosition.getY(id), sourcePosition.getZ(id));
      normals.push(source.attributes.normal.getX(id), source.attributes.normal.getY(id), source.attributes.normal.getZ(id));
    }
    return mapping.get(id);
  };
  for (let offset = 0; offset < source.index.count; offset += 3) {
    const ids = [source.index.getX(offset), source.index.getX(offset + 1), source.index.getX(offset + 2)];
    if (ids.every(id => id < footCount) || ids.every(id => id >= footCount && id < 2 * footCount)) continue;
    indices.push(...ids.map(use));
  }
  const outerVertexCount = positions.length / 3, outerTriangleCount = indices.length / 3;
  const capSettings = config.internalCaps, caps = [];
  if (!capSettings) throw new Error('bodyLegBlendV8.internalCaps is required.');
  const footRows = [];
  for (let start = 1; start <= audit.firstBlendVertex; start += radial) {
    footRows.push({ start, y: leg.attributes.position.getY(start) });
  }
  const sampleFoot = y => {
    let lower = 0;
    while (lower < footRows.length - 2 && footRows[lower + 1].y < y) lower += 1;
    const a = footRows[lower], b = footRows[lower + 1], t = (y - a.y) / (b.y - a.y);
    return Array.from({ length: radial }, (_, i) => [
      THREE.MathUtils.lerp(leg.attributes.position.getX(a.start + i), leg.attributes.position.getX(b.start + i), t),
      y,
      THREE.MathUtils.lerp(leg.attributes.position.getZ(a.start + i), leg.attributes.position.getZ(b.start + i), t),
    ]);
  };
  for (const sign of [1, -1]) {
    const sourceOffset = sign > 0 ? 0 : footCount;
    const boundaryIndices = Array.from({ length: radial }, (_, i) => mapping.get(sourceOffset + audit.firstBlendVertex + i));
    if (boundaryIndices.some(id => id === undefined)) throw new Error('Missing original foot boundary on body companion.');
    const firstVertex = positions.length / 3, firstTriangle = indices.length / 3;
    let previous = boundaryIndices;
    for (let row = 1; row < capSettings.rings; row += 1) {
      const angle = row / capSettings.rings * Math.PI / 2;
      const y = fused.report.footY - capSettings.depth * Math.sin(angle);
      const ring = sampleFoot(y), centerX = ring.reduce((sum, p) => sum + p[0], 0) / radial;
      const centerZ = ring.reduce((sum, p) => sum + p[2], 0) / radial;
      const scale = Math.cos(angle), current = [];
      for (const p of ring) {
        current.push(positions.length / 3);
        positions.push(sign * (centerX + (p[0] - centerX) * scale), p[1], centerZ + (p[2] - centerZ) * scale);
      }
      for (let i = 0; i < radial; i += 1) {
        const j = (i + 1) % radial;
        const face = [previous[i], previous[j], current[j], previous[i], current[j], current[i]];
        if (sign < 0) { [face[1], face[2]] = [face[2], face[1]]; [face[4], face[5]] = [face[5], face[4]]; }
        indices.push(...face);
      }
      previous = current;
    }
    const bottomY = fused.report.footY - capSettings.depth, bottom = sampleFoot(bottomY);
    const pole = positions.length / 3;
    positions.push(sign * bottom.reduce((sum, p) => sum + p[0], 0) / radial, bottomY, bottom.reduce((sum, p) => sum + p[2], 0) / radial);
    for (let i = 0; i < radial; i += 1) {
      const face = [previous[i], previous[(i + 1) % radial], pole];
      if (sign < 0) [face[1], face[2]] = [face[2], face[1]];
      indices.push(...face);
    }
    caps.push({ side: sign > 0 ? 'right' : 'left', sourceFootSign: sign, boundaryIndices, sourceBoundaryStart: audit.firstBlendVertex,
      firstVertex, vertexCount: positions.length / 3 - firstVertex, firstTriangle, triangleCount: indices.length / 3 - firstTriangle,
      pole, bottomY, depth: capSettings.depth, rings: capSettings.rings, method: 'internal-elliptical-downward-cap-following-original-foot-sections' });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  // Keep the exposed fusion surface and the shared foot boundary shading exact.
  geometry.attributes.normal.array.set(normals);
  for (const cap of caps) geometry.attributes.normal.setXYZ(cap.pole, 0, -1, 0);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const report = { version: 'body-design-v8', method: 'symmetric-legs-with-natural-union-body-companion', designOnly: true,
    approvedBodyUnchanged: true, fusion: fused.report, outerVertexCount, outerTriangleCount, caps,
    surfaceClearance: { ...clearance, displacedVertices: clearanceVertexCount, maximumDistance: maximumClearance, method: 'C2-normal-envelope-with-fixed-accepted-foot-boundary' },
    vertexCount: geometry.attributes.position.count, triangleCount: geometry.index.count / 3,
    sharedFootBoundary: { y: fused.report.footY, radial, positionAndNormal: 'unchanged-from-accepted-foot' } };
  source.dispose();
  return { geometry, report };
}
