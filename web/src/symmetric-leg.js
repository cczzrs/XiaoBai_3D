import * as THREE from 'three';
import { createContinuousUpperProfile } from './leg-continuous.js';
import { sampleSurface } from './leg-refinement.js';

// The approved foot is centred on z=4. Keep that same plane through every
// upper section; moving the crown towards the body's centre bends the leg.
export function createSymmetricUpperProfile(legs, previousRefinement, refinement, startY) {
  const planeZ = refinement.symmetryCenterZ ?? refinement.upper.crownCenterZ;
  const profile = createContinuousUpperProfile(legs, previousRefinement, refinement, startY);
  if (Math.abs(profile.jets.z.value - planeZ) > 1e-6) throw new Error('The upper symmetry plane must match the preserved foot.');
  return {
    at: t => ({ ...profile.at(t), z: planeZ }),
    jets: { ...profile.jets, z: { value: planeZ, first: 0, second: 0 } },
    planeZ,
  };
}

export function createSymmetricLegGeometry(sourceGeometry, sourceAudit, legs, previousRefinement, refinement) {
  const count = refinement.sampling.radial;
  if (count !== sourceAudit.radial || count % 2 !== 0) throw new Error('The mirrored upper must retain the even foot ring layout.');
  const { firstBlendVertex, startY } = sourceAudit;
  const preservedVertexCount = firstBlendVertex + count;
  const { at, jets, planeZ } = createSymmetricUpperProfile(legs, previousRefinement, refinement, startY);
  const upper = sampleSurface((t, i) => {
    const section = at(t), reflected = i > count / 2;
    const angle = (reflected ? count - i : i) * 2 * Math.PI / count;
    const depth = section.rz * Math.sin(angle);
    return new THREE.Vector3(section.x + section.rx * Math.cos(angle), section.y, planeZ + (reflected ? -depth : depth));
  }, count, refinement.sampling);
  const positions = Array.from(sourceGeometry.attributes.position.array.slice(0, preservedVertexCount * 3));
  for (const row of upper.rows.slice(1, -1)) for (const point of row) positions.push(...point);
  const capVertex = positions.length / 3, crown = upper.rows.at(-1)[0];
  positions.push(...crown);

  const sourceIds = sourceGeometry.index.array, indices = [];
  for (let i = 0; i < sourceIds.length; i += 3) {
    if (Math.max(sourceIds[i], sourceIds[i + 1], sourceIds[i + 2]) < preservedVertexCount) indices.push(sourceIds[i], sourceIds[i + 1], sourceIds[i + 2]);
  }
  const preservedTriangleCount = indices.length / 3;
  const mirrorIndex = index => {
    if (index === capVertex) return index;
    const ring = Math.floor((index - firstBlendVertex) / count), radial = (index - firstBlendVertex) % count;
    return firstBlendVertex + ring * count + (count - radial) % count;
  };
  const appendMirroredTriangle = (a, b, c) => indices.push(a, b, c, mirrorIndex(a), mirrorIndex(c), mirrorIndex(b));
  // Mirror the diagonals as well as the vertices. Using the same diagonal all
  // around a non-planar quad ring would only make its vertices symmetric.
  for (let row = firstBlendVertex; row < capVertex - count; row += count) {
    for (let i = 0; i < count / 2; i += 1) {
      const a = row + i, b = row + i + 1;
      appendMirroredTriangle(a, a + count, b + count);
      appendMirroredTriangle(a, b + count, b);
    }
  }
  for (let i = 0; i < count / 2; i += 1) appendMirroredTriangle(capVertex - count + i, capVertex, capVertex - count + i + 1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal, normal = new THREE.Vector3();
  for (let row = preservedVertexCount; row < capVertex; row += count) {
    for (let i = 0; i <= count / 2; i += 1) {
      const a = row + i, b = row + (count - i) % count;
      normal.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) - normals.getZ(b)).normalize();
      normals.setXYZ(a, normal.x, normal.y, normal.z);
      normals.setXYZ(b, normal.x, normal.y, -normal.z);
    }
  }
  // The complete accepted foot, including its last ring, keeps its exact
  // original normals. Existing tiny normal asymmetry belongs to that baseline.
  normals.array.set(sourceGeometry.attributes.normal.array.slice(0, preservedVertexCount * 3));
  normals.setXYZ(capVertex, 0, 1, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    report: {
      schema: 'xiaobai.symmetric-legs.v1', version: 'legs-v8', source: 'legs-v6',
      frontBackPlaneZ: planeZ, startY, radial: count, firstBlendVertex,
      preservedVertexCount, preservedNormalCount: preservedVertexCount, preservedTriangleCount,
      upperFirstVertex: preservedVertexCount, capVertex, crown: crown.toArray(), boundaryJet: jets,
      regions: { foot: sourceAudit.regions.foot, upper: upper.report },
      method: 'independent-elliptical-leg-sweep-fixed-front-back-plane-mirrored-upper-topology',
    },
  };
}
