import * as THREE from 'three';

// Subdivide only triangles crossing the part boundary, keeping the accepted
// exterior surface and every original vertex/normal. New boundary points use
// original-edge interpolation; caps are separate internal design surfaces.
function boundaryLoops(faces) {
  const edges = new Map();
  for (const face of faces) for (let j = 0; j < 3; j += 1) {
    const a = face[j], b = face[(j + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edges.has(key)) edges.delete(key); else edges.set(key, [a, b]);
  }
  const next = new Map();
  for (const [a, b] of edges.values()) {
    if (next.has(a)) throw new Error('The partition has a branched boundary.');
    next.set(a, b);
  }
  const visited = new Set(), loops = [];
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop = []; let current = start;
    do {
      if (visited.has(current) || !next.has(current)) throw new Error('The partition boundary is not a closed loop.');
      loop.push(current); visited.add(current); current = next.get(current);
    } while (current !== start);
    loops.push(loop);
  }
  return loops;
}

function makePart(source, sourceFaces, sourceFaceIds, name, settings, curvatureAt) {
  const sourcePosition = source.attributes.position, sourceNormal = source.attributes.normal;
  const sourceVertexIds = [...new Set(sourceFaces.flat())].sort((a, b) => a - b);
  const local = new Map(sourceVertexIds.map((id, i) => [id, i]));
  const positions = [], normals = [], indices = [];
  for (const id of sourceVertexIds) {
    positions.push(sourcePosition.getX(id), sourcePosition.getY(id), sourcePosition.getZ(id));
    normals.push(sourceNormal.getX(id), sourceNormal.getY(id), sourceNormal.getZ(id));
  }
  for (const face of sourceFaces) indices.push(...face.map(id => local.get(id)));
  const capVertexStart = positions.length / 3, capTriangleStart = indices.length / 3;
  const loops = boundaryLoops(sourceFaces), capReports = [];
  for (const originalLoop of loops) {
    // Start both mirrored loops at the same physical extremum. This makes the
    // arc-length parameter independent of original triangle insertion order.
    let anchor = 0;
    for (let j = 1; j < originalLoop.length; j += 1) {
      const a = originalLoop[j], b = originalLoop[anchor];
      if (Math.abs(sourcePosition.getX(a)) > Math.abs(sourcePosition.getX(b)) || (Math.abs(sourcePosition.getX(a)) === Math.abs(sourcePosition.getX(b)) && sourcePosition.getZ(a) > sourcePosition.getZ(b))) anchor = j;
    }
    const loop = [...originalLoop.slice(anchor), ...originalLoop.slice(0, anchor)];
    const sign = sourcePosition.getX(loop[0]) < 0 ? -1 : 1;
    const points = loop.map(id => new THREE.Vector3().fromBufferAttribute(sourcePosition, id));
    const minY = Math.min(...points.map(p => p.y));
    const apex = name === 'body'
      ? new THREE.Vector3(sign * settings.caps.legCenterX, minY - settings.caps.bodyInsetDepth, settings.caps.legCenterZ)
      : new THREE.Vector3(sign * settings.caps.legCenterX, settings.caps.legTopY, settings.caps.legCenterZ);
    const start = positions.length / 3, count = loop.length;
    const sourceNormals = loop.map(id => new THREE.Vector3().fromBufferAttribute(sourceNormal, id).normalize());
    const outwardCut = new THREE.Vector3(-sign * settings.cut.slope, 1, 0).multiplyScalar(name === 'body' ? -1 : 1);
    const tangents = points.map((p, j) => { const d = outwardCut.clone(); return d.addScaledVector(sourceNormals[j], -d.dot(sourceNormals[j])).normalize().multiplyScalar(p.distanceTo(apex) * settings.caps.tangentScale); });
    const centre = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(count);
    const radiusX = Math.sqrt(points.reduce((sum, p) => sum + (p.x - centre.x) ** 2, 0) * 2 / count);
    const radiusZ = Math.sqrt(points.reduce((sum, p) => sum + (p.z - centre.z) ** 2, 0) * 2 / count);
    const angleStart = Math.atan2((points[0].z - centre.z) / radiusZ, (points[0].x - centre.x) / radiusX);
    const circumference = [0];
    for (let j = 1; j <= count; j += 1) circumference.push(circumference.at(-1) + points[j % count].distanceTo(points[j - 1]));
    let signedArea = 0;
    for (let j = 0; j < count; j += 1) signedArea += points[j].x * points[(j + 1) % count].z - points[(j + 1) % count].x * points[j].z;
    const angles = points.map((_, j) => angleStart + Math.sign(signedArea) * Math.PI * 2 * circumference[j] / circumference.at(-1));
    const radial = angles.map(a => new THREE.Vector3(radiusX * Math.cos(a), 0, radiusZ * Math.sin(a)));
    const rise = apex.clone().sub(centre), canonicalStartDerivative = rise.clone().multiplyScalar(Math.PI / 2);
    const rawCurvatures = loop.map((id, j) => curvatureAt(id, tangents[j], sourceNormals[j]).dot(sourceNormals[j]) / tangents[j].lengthSq());
    const arcWeights = points.map((p, j) => (p.distanceTo(points[(j + 1) % count]) + p.distanceTo(points[(j + count - 1) % count])) / 2);
    const curvatureScale = settings.caps.targetSpacing * 3;
    // The source has irregular micro-triangles. Fit their curvature over a
    // local arc-length neighbourhood instead of amplifying Float32 face noise.
    const startAccelerations = points.map((p, j) => {
      let sum = 0, weight = 0;
      for (let k = 0; k < count; k += 1) {
        const distance2 = p.distanceToSquared(points[k]);
        if (distance2 > 9 * curvatureScale ** 2) continue;
        const w = Math.exp(-distance2 / (2 * curvatureScale ** 2)) * arcWeights[k];
        sum += rawCurvatures[k] * w; weight += w;
      }
      return sourceNormals[j].clone().multiplyScalar(sum / weight * tangents[j].lengthSq());
    });
    const at = (j, t) => {
      const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
      // Corrections vanish through second derivative at the pole, so the
      // actual top is an ellipsoid dome rather than a perturbed cone or dimple.
      const h00 = 1 - 10 * t3 + 15 * t4 - 6 * t5, h10 = t - 6 * t3 + 8 * t4 - 3 * t5;
      const theta = t * Math.PI / 2;
      const canonicalStart = centre.clone().add(radial[j]);
      const canonicalAcceleration = radial[j].clone().multiplyScalar(-(Math.PI ** 2) / 4);
      const h20 = 0.5 * t2 * (1 - t) ** 3;
      const inwardBias = name === 'body' ? settings.caps.bodyInwardBias : settings.caps.inwardBias;
      return centre.clone().addScaledVector(rise, Math.sin(theta)).addScaledVector(radial[j], Math.cos(theta))
        .addScaledVector(points[j].clone().sub(canonicalStart), h00)
        .addScaledVector(tangents[j].clone().sub(canonicalStartDerivative), h10)
        .addScaledVector(startAccelerations[j].clone().sub(canonicalAcceleration), h20)
        .addScaledVector(sourceNormals[j], -inwardBias * 64 * t3 * (1 - t) ** 3);
    };
    // A common arc-length parameter keeps complete rings, while avoiding a
    // sparse upper cap or a new density band at the inherited leg boundary.
    const cumulative = [0]; let previous = points;
    for (let sample = 1; sample <= settings.caps.arcSamples; sample += 1) {
      const current = points.map((_, j) => at(j, sample / settings.caps.arcSamples));
      cumulative.push(cumulative.at(-1) + current.reduce((sum, p, j) => sum + p.distanceTo(previous[j]) / count, 0));
      previous = current;
    }
    const meanArcLength = cumulative.at(-1), ringCount = Math.max(settings.caps.rings, Math.ceil(meanArcLength / settings.caps.targetSpacing));
    const ringFractions = Array.from({ length: ringCount }, (_, ring) => {
      if (ring === 0) return 0;
      const length = meanArcLength * ring / ringCount;
      const hi = cumulative.findIndex(value => value >= length), lo = hi - 1;
      return (lo + (length - cumulative[lo]) / (cumulative[hi] - cumulative[lo])) / settings.caps.arcSamples;
    });
    for (let ring = 0; ring < ringCount; ring += 1) {
      const t = ringFractions[ring];
      for (let j = 0; j < count; j += 1) {
        const p = points[j], n = sourceNormals[j], q = at(j, t);
        // Exact boundary copies are required, including Float32 signed zero.
        positions.push(...(ring === 0 ? p.toArray() : q.toArray()));
        normals.push(...n.toArray());
      }
    }
    const pole = positions.length / 3; positions.push(...apex.toArray()); normals.push(0, name === 'body' ? -1 : 1, 0);
    for (let ring = 0; ring < ringCount - 1; ring += 1) for (let j = 0; j < count; j += 1) {
      const a = start + ring * count + j, b = start + ring * count + (j + 1) % count, c = a + count, d = b + count;
      if (sign > 0) indices.push(b, a, c, b, c, d);
      else indices.push(b, a, d, a, c, d);
    }
    for (let j = 0; j < count; j += 1) indices.push(start + (ringCount - 1) * count + (j + 1) % count, start + (ringCount - 1) * count + j, pole);
    capReports.push({ boundaryLoopSourceIds: loop, vertexStart: start, ringCount, ringFractions, meanArcLength, meanRingSpacing: meanArcLength / ringCount,
      ellipseRadii: [radiusX, Math.abs(apex.y - centre.y), radiusZ], polePrincipalRadii: [radiusX ** 2 / Math.abs(apex.y - centre.y), radiusZ ** 2 / Math.abs(apex.y - centre.y)],
      boundaryContinuity: { position: 'original-edge interpolation', tangent: 'projected cut-plane co-normal', normalCurvature: 'source normal-gradient fitted by arc length', fitRadius: curvatureScale, inwardBiasEndpointOrder: 3 },
      verticesPerRing: count, poleVertex: pole, apex: apex.toArray(), minBoundaryY: minY });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const targetNormal = geometry.attributes.normal;
  for (let i = 0; i < capVertexStart; i += 1) targetNormal.setXYZ(i, normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  for (const cap of capReports) for (let j = 0; j < cap.verticesPerRing; j += 1) {
    const id = cap.boundaryLoopSourceIds[j];
    targetNormal.setXYZ(cap.vertexStart + j, sourceNormal.getX(id), sourceNormal.getY(id), sourceNormal.getZ(id));
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData = { designOnly: true, sourceVersion: 'legs-v6', partition: name, outerVertexCount: capVertexStart, outerTriangleCount: capTriangleStart, hiddenCaps: true };
  return { geometry, audit: { name, vertices: geometry.attributes.position.count, triangles: geometry.index.count / 3, outerVertexCount: capVertexStart, outerTriangleCount: capTriangleStart,
    capVertexStart, capTriangleStart, sourceVertexIds, sourceFaceIds, caps: capReports } };
}

export function separateBodyAndLegs(source, settings) {
  const faceIds = { body: [], left: [], right: [] }, faces = { body: [], left: [], right: [] }, p = source.attributes.position, n = source.attributes.normal;
  const positions = Array.from(p.array), normals = Array.from(n.array), cutPoints = new Map(), cutPointSources = [];
  const value = id => positions[id * 3 + 1] - settings.cut.slope * Math.abs(positions[id * 3]) - settings.cut.intercept;
  const crossing = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (cutPoints.has(key)) return cutPoints.get(key);
    if (a > b) [a, b] = [b, a];
    const va = value(a), vb = value(b), t = va / (va - vb), globalId = positions.length / 3;
    for (let axis = 0; axis < 3; axis += 1) positions.push(Math.fround(positions[a * 3 + axis] + t * (positions[b * 3 + axis] - positions[a * 3 + axis])));
    const normal = new THREE.Vector3(...[0, 1, 2].map(axis => normals[a * 3 + axis] + t * (normals[b * 3 + axis] - normals[a * 3 + axis]))).normalize();
    normals.push(...normal.toArray().map(Math.fround));
    cutPoints.set(key, globalId); cutPointSources.push({ globalId, a, b, t }); return globalId;
  };
  const clip = (polygon, positive) => {
    const out = [];
    for (let j = 0; j < polygon.length; j += 1) {
      const a = polygon[j], b = polygon[(j + 1) % polygon.length], insideA = positive ? value(a) >= 0 : value(a) <= 0, insideB = positive ? value(b) >= 0 : value(b) <= 0;
      if (insideA) out.push(a);
      if (insideA !== insideB) out.push(crossing(a, b));
    }
    return [...new Set(out)];
  };
  const append = (part, polygon, id) => {
    for (let j = 1; j < polygon.length - 1; j += 1) { faces[part].push([polygon[0], polygon[j], polygon[j + 1]]); faceIds[part].push(id); }
  };
  for (let i = 0; i < source.index.count; i += 3) {
    const a = source.index.getX(i), b = source.index.getX(i + 1), c = source.index.getX(i + 2);
    const face = [a, b, c], side = p.getX(a) + p.getX(b) + p.getX(c) < 0 ? 'left' : 'right';
    if (face.every(id => value(id) >= 0)) append('body', face, i / 3);
    else if (face.every(id => value(id) <= 0)) append(side, face, i / 3);
    else { append('body', clip(face, true), i / 3); append(side, clip(face, false), i / 3); }
  }
  const augmented = new THREE.BufferGeometry();
  augmented.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  augmented.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const cutById = new Map(cutPointSources.map(point => [point.globalId, point]));
  const edgeFaces = new Map([...cutPoints.keys()].map(key => [key, []]));
  for (let i = 0; i < source.index.count; i += 3) {
    const face = [0, 1, 2].map(j => source.index.getX(i + j));
    for (let j = 0; j < 3; j += 1) { const a = face[j], b = face[(j + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`; edgeFaces.get(key)?.push(face); }
  }
  const curvatureAt = (id, direction, normal) => {
    const cut = cutById.get(id);
    if (!cut) throw new Error('A cap boundary needs an edge interpolation record for curvature continuity.');
    const adjacent = edgeFaces.get(`${cut.a}:${cut.b}`), derivative = new THREE.Vector3();
    const rawLength = new THREE.Vector3().fromBufferAttribute(n, cut.a).lerp(new THREE.Vector3().fromBufferAttribute(n, cut.b), cut.t).length();
    for (const [a, b, c] of adjacent) {
      const pa = new THREE.Vector3().fromBufferAttribute(p, a), e1 = new THREE.Vector3().fromBufferAttribute(p, b).sub(pa), e2 = new THREE.Vector3().fromBufferAttribute(p, c).sub(pa);
      const aa = e1.lengthSq(), ab = e1.dot(e2), bb = e2.lengthSq(), determinant = aa * bb - ab * ab;
      const u = (direction.dot(e1) * bb - direction.dot(e2) * ab) / determinant;
      const v = (direction.dot(e2) * aa - direction.dot(e1) * ab) / determinant;
      const na = new THREE.Vector3().fromBufferAttribute(n, a);
      const dn = new THREE.Vector3().fromBufferAttribute(n, b).sub(na).multiplyScalar(u).addScaledVector(new THREE.Vector3().fromBufferAttribute(n, c).sub(na), v);
      dn.addScaledVector(normal, -dn.dot(normal)).divideScalar(rawLength);
      derivative.addScaledVector(dn, 1 / adjacent.length);
    }
    return normal.clone().multiplyScalar(-derivative.dot(direction));
  };
  return { parts: Object.fromEntries(Object.entries(faceIds).map(([name, ids]) => [name, makePart(augmented, faces[name], ids, name, settings, curvatureAt)])), cutPointSources };
}
