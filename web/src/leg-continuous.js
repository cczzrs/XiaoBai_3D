import * as THREE from 'three';
import { createRefinedSection, sampleSurface } from './leg-refinement.js';

// A single elliptical sweep replaces both the flared body-contact collar and
// the separate cap. Only a short, decaying correction matches the foot's C2 jet;
// carrying that positive curvature over the full upper length creates a bulge.
export function createContinuousUpperProfile(legs, previousRefinement, refinement, startY) {
  const { section } = createRefinedSection(legs, previousRefinement, startY);
  const upper = refinement.upper, height = upper.crownY - startY;
  const delta = upper.derivativeStep;
  const jets = Object.fromEntries(['x', 'z', 'rx', 'rz'].map(key => {
    const a = section(startY - delta)[key], b = section(startY)[key], c = section(startY + delta)[key];
    return [key, { value: b, first: (c - a) / (2 * delta), second: (c - 2 * b + a) / (delta * delta) }];
  }));
  const at = t => {
    const angle = t * Math.PI / 2, u = Math.sin(angle), s = height * u;
    const j = jets.x, length = upper.centerXRelaxation;
    const x = j.value + j.first * length * (1 - Math.exp(-s / length))
      + (j.second + j.first / length) * s * s * Math.exp(-s / upper.centerCurvatureDecay) / 2;
    const smooth = u ** 3 * (10 + u * (-15 + 6 * u));
    const radii = Object.fromEntries(['rx', 'rz'].map(key => {
      const jet = jets[key];
      // Relax the initial taper before the crown. This keeps the tip round
      // instead of accumulating a linear taper into a pointed cone.
      const taper = upper.radiusTaperRelaxation;
      const value = jet.value + jet.first * taper * (1 - Math.exp(-s / taper))
        + (jet.second + jet.first / taper + jet.value / (height * height)) * s * s * Math.exp(-s / upper.radiusCurvatureDecay) / 2;
      return [key, t === 1 ? 0 : Math.cos(angle) * value];
    }));
    return { y: startY + s, x, z: jets.z.value + (upper.crownCenterZ - jets.z.value) * smooth, ...radii };
  };
  return { at, jets };
}

export function createContinuousLegGeometry(sourceGeometry, sourceAudit, legs, previousRefinement, refinement) {
  const count = refinement.sampling.radial;
  if (count !== sourceAudit.radial) throw new Error('v4 must retain the v3 foot ring layout.');
  const { firstBlendVertex, startY } = sourceAudit;
  const preservedVertexCount = firstBlendVertex + count;
  const { at, jets } = createContinuousUpperProfile(legs, previousRefinement, refinement, startY);
  const upper = sampleSurface((t, i) => {
    const s = at(t), angle = i * 2 * Math.PI / count;
    return new THREE.Vector3(s.x + s.rx * Math.cos(angle), s.y, s.z + s.rz * Math.sin(angle));
  }, count, refinement.sampling);
  const positions = Array.from(sourceGeometry.attributes.position.array.slice(0, preservedVertexCount * 3));
  for (const row of upper.rows.slice(1, -1)) for (const point of row) positions.push(...point);
  const capVertex = positions.length / 3;
  const crown = upper.rows.at(-1)[0]; positions.push(...crown);
  const sourceIds = sourceGeometry.index.array, indices = [];
  for (let i = 0; i < sourceIds.length; i += 3) {
    if (Math.max(sourceIds[i], sourceIds[i + 1], sourceIds[i + 2]) < preservedVertexCount) indices.push(sourceIds[i], sourceIds[i + 1], sourceIds[i + 2]);
  }
  const preservedTriangleCount = indices.length / 3;
  for (let row = firstBlendVertex; row < capVertex - count; row += count) {
    for (let i = 0; i < count; i += 1) {
      const a = row + i, b = row + (i + 1) % count;
      indices.push(a, a + count, b + count, a, b + count, b);
    }
  }
  for (let i = 0; i < count; i += 1) indices.push(capVertex - count + i, capVertex, capVertex - count + (i + 1) % count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  // Preserve foot shading below the join. The join row uses the new adjacent
  // faces so normals from the old flared collar cannot leave a faint ring.
  geometry.attributes.normal.array.set(sourceGeometry.attributes.normal.array.slice(0, firstBlendVertex * 3));
  geometry.attributes.normal.setXYZ(capVertex, 0, 1, 0);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, report: { version: 'legs-v4', source: 'legs-v3', startY, radial: count, firstBlendVertex, preservedVertexCount, preservedNormalCount: firstBlendVertex, preservedTriangleCount, capVertex, crown: crown.toArray(), boundaryJet: jets, regions: { foot: sourceAudit.regions.foot, upper: upper.report }, method: 'single-monotone-elliptical-upper-sweep-no-contact-ring' } };
}
