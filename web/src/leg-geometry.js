import * as THREE from 'three';

// A single closed surface spans sole, instep, ankle and hidden hip cap.
// Historical reference coefficients are design inputs, not an approved leg mesh.
function spline(y, coefficients, degree, knots) {
  const n = coefficients.length - 1;
  let span = n;
  for (let i = degree; i < n; i += 1) {
    if (y < knots[i + 1]) { span = i; break; }
  }
  const values = Array.from({ length: degree + 1 }, (_, j) => coefficients[span - degree + j]);
  for (let level = 1; level <= degree; level += 1) {
    for (let j = degree; j >= level; j -= 1) {
      const i = span - degree + j;
      const weight = (y - knots[i]) / (knots[i + degree - level + 1] - knots[i]);
      values[j] = (1 - weight) * values[j - 1] + weight * values[j];
    }
  }
  return values[degree];
}

export function legSection(y, settings) {
  const [bottom, top] = settings.domain;
  const t = THREE.MathUtils.clamp((y - settings.footHeight) / (top - settings.footHeight), 0, 1);
  const smooth = t * t * t * (10 + t * (-15 + 6 * t));
  const center = spline(y, settings.centerCoefficients, settings.degree, settings.knots);
  const logRadius = spline(y, settings.logRadiusCoefficients, settings.degree, settings.knots);
  const radius = Math.sqrt(Math.max(0, (y - bottom) * (top - y) * Math.exp(logRadius)));
  return {
    y,
    x: settings.centerX + (center - settings.xRawMid) * settings.xScale + settings.upperCenterCorrection * smooth,
    z: settings.footDepthCenterZ * (1 - smooth),
    rx: radius * settings.xScale,
    rz: radius * settings.zScale,
  };
}

// Space rows by average surface-meridian travel, not equal vertical/axial steps.
export function sampleLegSections(settings) {
  const { rings, arcSamples, arcMeridians } = settings.sampling;
  const [bottom, top] = settings.domain;
  const samples = [];
  let distance = 0;
  for (let i = 0; i <= arcSamples; i += 1) {
    const y = bottom + (top - bottom) * (1 - Math.cos(Math.PI * i / arcSamples)) / 2;
    const section = legSection(y, settings);
    if (i > 0) {
      const previous = samples[i - 1].section;
      for (let j = 0; j < arcMeridians; j += 1) {
        const angle = j / arcMeridians * Math.PI * 2;
        distance += Math.hypot(
          section.x - previous.x + (section.rx - previous.rx) * Math.cos(angle),
          section.y - previous.y,
          section.z - previous.z + (section.rz - previous.rz) * Math.sin(angle),
        ) / arcMeridians;
      }
    }
    samples.push({ section, distance });
  }
  const result = [samples[0].section];
  let cursor = 1;
  for (let i = 1; i < rings; i += 1) {
    const target = distance * i / rings;
    while (samples[cursor].distance < target) cursor += 1;
    const a = samples[cursor - 1];
    const b = samples[cursor];
    const fraction = (target - a.distance) / (b.distance - a.distance);
    result.push(legSection(THREE.MathUtils.lerp(a.section.y, b.section.y, fraction), settings));
  }
  result.push(samples.at(-1).section);
  return result;
}

export function createLegGeometry(settings) {
  const sections = sampleLegSections(settings);
  const count = settings.sampling.radial;
  const positions = [sections[0].x, sections[0].y, sections[0].z];
  for (const section of sections.slice(1, -1)) {
    for (let i = 0; i < count; i += 1) {
      const angle = i * Math.PI * 2 / count;
      positions.push(section.x + section.rx * Math.cos(angle), section.y, section.z + section.rz * Math.sin(angle));
    }
  }
  const topIndex = positions.length / 3;
  positions.push(sections.at(-1).x, sections.at(-1).y, sections.at(-1).z);
  const indices = [];
  for (let i = 0; i < count; i += 1) indices.push(0, 1 + i, 1 + (i + 1) % count);
  for (let row = 0; row < sections.length - 3; row += 1) {
    for (let i = 0; i < count; i += 1) {
      const a = 1 + row * count + i;
      const b = 1 + row * count + (i + 1) % count;
      const c = a + count;
      const d = b + count;
      indices.push(a, c, d, a, d, b);
    }
  }
  const lastRow = topIndex - count;
  for (let i = 0; i < count; i += 1) indices.push(lastRow + i, topIndex, lastRow + (i + 1) % count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.attributes.normal.setXYZ(0, 0, -1, 0);
  geometry.attributes.normal.setXYZ(topIndex, 0, 1, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createLegsDraft(config) {
  const root = new THREE.Group();
  root.name = 'XiaoBai_Legs_Reference_V1';
  const sourceAsset = config.assets.legs.versions?.['legs-reference-v1-mirrored'] ?? config.assets.legs.builtin;
  root.userData = { designOnly: true, approval: 'pending', version: sourceAsset.version, mirrorPlane: 'x=0', method: 'continuous-cubic-profile-elliptical-sweep', skinning: false };
  const geometry = createLegGeometry(config.design.legs);
  const material = new THREE.MeshStandardMaterial(config.design.legs.material);
  material.name = 'Legs_Cream_Design_V1';
  for (const sign of [1, -1]) {
    const mesh = new THREE.Mesh(geometry.clone(), material.clone());
    mesh.name = sign > 0 ? 'Leg_R' : 'Leg_L';
    mesh.scale.x = sign;
    mesh.userData = { designOnly: true, approval: 'pending', continuousFootAndLeg: true };
    root.add(mesh);
  }
  geometry.dispose();
  material.dispose();
  return root;
}
