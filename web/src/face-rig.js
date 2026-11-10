import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;

/** Additive gaze/nose motion, multiplicative eyelid openness; both loop ends are neutral. */
export function sampleFaceMotion(motion, progress, config) {
  const result = { eyes: { leftOpen: 1, rightOpen: 1, gazeX: 0, gazeY: 0 }, nose: { width: 0, tilt: 0 } };
  const t = clamp(progress, 0, 1);
  if (t === 0 || t === 1) return result;
  const settings = config.design.face.animation;
  const eyeAmplitude = clamp(motion.eyeAmplitude, 0, 1);
  const noseAmplitude = clamp(motion.noseAmplitude, 0, 1);
  const phase = t * Math.PI * 2;
  if (['blink', 'winkLeft', 'winkRight'].includes(motion.eyesPreset)) {
    const distance = Math.abs(t - settings.blinkCenter);
    const closure = distance < settings.blinkHalfWidth
      ? (Math.cos(distance / settings.blinkHalfWidth * Math.PI) + 1) / 2 * eyeAmplitude : 0;
    if (motion.eyesPreset !== 'winkRight') result.eyes.leftOpen = 1 - closure;
    if (motion.eyesPreset !== 'winkLeft') result.eyes.rightOpen = 1 - closure;
  } else if (motion.eyesPreset === 'lookAround') {
    result.eyes.gazeX = Math.sin(phase) * settings.gazeX * eyeAmplitude;
    result.eyes.gazeY = Math.sin(phase * 2) * settings.gazeY * eyeAmplitude;
  }
  if (motion.nosePreset === 'twitch') result.nose.tilt = Math.sin(phase * 2) * settings.noseTilt * noseAmplitude;
  if (motion.nosePreset === 'stretch') result.nose.width = (1 - Math.cos(phase)) / 2 * settings.noseStretch * noseAmplitude;
  return result;
}

/**
 * Rasterize the existing head's front (+Z) triangles once. Bilinear depth lookup keeps
 * every frame linear in the 19k face vertices, without raycasting the 146k head faces.
 * This is a sampled attachment surface, not replacement head geometry.
 */
function createSurface(geometry, { columns, rows }) {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const bounds = new THREE.Box3().setFromBufferAttribute(position);
  const stepX = (bounds.max.x - bounds.min.x) / (columns - 1);
  const stepY = (bounds.max.y - bounds.min.y) / (rows - 1);
  const depths = new Float64Array(columns * rows).fill(-Infinity);
  const count = index?.count ?? position.count;
  const vertex = (offset) => index ? index.getX(offset) : offset;
  for (let offset = 0; offset < count; offset += 3) {
    const a = vertex(offset), b = vertex(offset + 1), c = vertex(offset + 2);
    const ax = (position.getX(a) - bounds.min.x) / stepX, ay = (position.getY(a) - bounds.min.y) / stepY;
    const bx = (position.getX(b) - bounds.min.x) / stepX, by = (position.getY(b) - bounds.min.y) / stepY;
    const cx = (position.getX(c) - bounds.min.x) / stepX, cy = (position.getY(c) - bounds.min.y) / stepY;
    const az = position.getZ(a), bz = position.getZ(b), cz = position.getZ(c);
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < Number.EPSILON) continue;
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
    const maxX = Math.min(columns - 1, Math.floor(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
    const maxY = Math.min(rows - 1, Math.floor(Math.max(ay, by, cy)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w = 1 - u - v;
        if (Math.min(u, v, w) < -1e-8) continue;
        const cell = y * columns + x;
        depths[cell] = Math.max(depths[cell], u * az + v * bz + w * cz);
      }
    }
  }

  // At extreme combined settings the features may meet the silhouette. Restrict the
  // query to the intersection of its two raster rows, retaining attachment there.
  const rowLeft = new Int32Array(rows);
  const rowRight = new Int32Array(rows);
  for (let y = 0; y < rows; y += 1) {
    let left = 0, right = columns - 1;
    while (left < columns && !Number.isFinite(depths[y * columns + left])) left += 1;
    while (right >= 0 && !Number.isFinite(depths[y * columns + right])) right -= 1;
    rowLeft[y] = left;
    rowRight[y] = right;
  }

  const output = { x: 0, y: 0, z: 0 };
  return (x, y) => {
    const gy = clamp((y - bounds.min.y) / stepY, 1, rows - 2);
    const lowY = Math.min(rows - 2, Math.floor(gy));
    const highY = lowY + 1;
    const minX = Math.max(rowLeft[lowY], rowLeft[highY]);
    const maxX = Math.min(rowRight[lowY], rowRight[highY]);
    const gx = clamp((x - bounds.min.x) / stepX, minX, maxX);
    const lowX = Math.max(minX, Math.min(maxX - 1, Math.floor(gx)));
    const highX = Math.min(maxX, lowX + 1);
    const fx = gx - lowX, fy = gy - lowY;
    const bottom = depths[lowY * columns + lowX] * (1 - fx) + depths[lowY * columns + highX] * fx;
    const top = depths[highY * columns + lowX] * (1 - fx) + depths[highY * columns + highX] * fx;
    output.x = bounds.min.x + gx * stepX;
    output.y = bounds.min.y + gy * stepY;
    output.z = bottom * (1 - fy) + top * fy;
    return output;
  };
}

function constrained(values, limits) {
  return Object.fromEntries(Object.entries(limits).map(([key, range]) => [key, clamp(values[key], range.min, range.max)]));
}

function rayEdge(ux, uy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const denominator = ux * ey - uy * ex;
  if (Math.abs(denominator) < Number.EPSILON) return Infinity;
  const alongEdge = (ax * uy - ay * ux) / denominator;
  if (alongEdge < -1e-8 || alongEdge > 1 + 1e-8) return Infinity;
  const radius = (ax * ey - ay * ex) / denominator;
  return radius >= 0 ? radius : Infinity;
}

/** Original projected outer convex hull and the actual projected inner aperture. */
function apertureCoordinates(geometry, center, settings) {
  const position = geometry.getAttribute('position');
  const points = Array.from({ length: position.count }, (_, i) => ({ x: position.getX(i) - center.x, y: position.getY(i) - center.y }));
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const halfHull = (ordered) => {
    const result = [];
    for (const point of ordered) {
      while (result.length > 1 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = halfHull(sorted), upper = halfHull(sorted.slice().reverse());
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const outerRadius = (ux, uy) => {
    let radius = Infinity;
    for (let i = 0; i < hull.length; i += 1) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      radius = Math.min(radius, rayEdge(ux, uy, a.x, a.y, b.x, b.y));
    }
    return radius;
  };

  // The original aperture is not a perfect ellipse. Trace it through actual
  // projected triangles once, so its near edge receives the full interior morph.
  const samples = settings.angularSamples;
  const innerRadii = new Float64Array(samples).fill(Infinity);
  const index = geometry.index;
  const count = index?.count ?? position.count;
  for (let sample = 0; sample < samples; sample += 1) {
    const angle = sample / samples * Math.PI * 2;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    for (let triangle = 0; triangle < count; triangle += 3) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = points[index ? index.getX(triangle + edge) : triangle + edge];
        const next = triangle + (edge + 1) % 3;
        const b = points[index ? index.getX(next) : next];
        innerRadii[sample] = Math.min(innerRadii[sample], rayEdge(ux, uy, a.x, a.y, b.x, b.y));
      }
    }
  }
  const weights = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const { x, y } = points[i];
    const radius = Math.hypot(x, y);
    const outer = outerRadius(x / radius, y / radius);
    if (outer - radius <= settings.boundaryTolerance) {
      weights[i] = 0;
      continue;
    }
    const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
    const phase = angle / (Math.PI * 2) * samples;
    const low = Math.floor(phase), fraction = phase - low;
    const inner = innerRadii[low] * (1 - fraction) + innerRadii[(low + 1) % samples] * fraction;
    const t = clamp((outer - radius) / (outer - inner), 0, 1);
    weights[i] = t * t * (3 - 2 * t);
  }
  return { weights, outerRadius, halfWidth: (innerRadii[0] + innerRadii[samples / 2]) / 2 };
}

function expressionProfiles(expression, config) {
  const presets = config.design.expression.presets;
  const selected = presets[expression.preset] ?? presets.neutral;
  const intensity = clamp(expression.intensity, config.design.expression.intensity.min, config.design.expression.intensity.max);
  return Object.fromEntries(['left', 'right'].map((side) => [side, Object.fromEntries(Object.entries(presets.neutral[side]).map(([key, baseline]) => [key, baseline + (selected[side][key] - baseline) * intensity]))]));
}

/**
 * Only call on the design clone. The approved head's named meshes share coordinates.
 * Clone the three feature geometries; Head and the build assembly stay byte-identical.
 */
export function createFaceRig(root, config) {
  const settings = config.design.face;
  const nodes = Object.fromEntries(Object.entries(settings.nodes).map(([key, name]) => [key, root.getObjectByName(name)]));
  if (Object.values(nodes).some((mesh) => !mesh?.isMesh)) throw new Error('批准头部缺少眼睛或鼻子的独立网格。');
  const surface = createSurface(nodes.head.geometry, settings.surface);
  const entries = {};
  for (const key of ['leftEye', 'rightEye', 'nose']) {
    const mesh = nodes[key];
    const geometry = mesh.geometry.clone();
    const positions = geometry.getAttribute('position').array.slice();
    const normals = geometry.getAttribute('normal').array.slice();
    const bounds = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const relief = new Float64Array(positions.length / 3);
    let minRelief = Infinity, maxRelief = -Infinity;
    for (let i = 0; i < relief.length; i += 1) {
      relief[i] = positions[i * 3 + 2] - surface(positions[i * 3], positions[i * 3 + 1]).z;
      minRelief = Math.min(minRelief, relief[i]);
      maxRelief = Math.max(maxRelief, relief[i]);
    }
    mesh.geometry = geometry;
    const aperture = key === 'nose' ? null : apertureCoordinates(geometry, center, settings.aperture);
    entries[key] = { mesh, geometry, positions, normals, center, size, relief, minRelief, maxRelief, aperture, last: null };
  }

  function update(entry, values, defaults, transform) {
    if (entry.last && values.every((value, index) => value === entry.last[index])) return;
    const attribute = entry.geometry.getAttribute('position');
    if (values.every((value, index) => value === defaults[index])) {
      attribute.array.set(entry.positions);
      entry.geometry.getAttribute('normal').array.set(entry.normals);
      entry.geometry.getAttribute('normal').needsUpdate = true;
    } else {
      for (let i = 0; i < attribute.count; i += 1) transform(entry, attribute, i);
      entry.geometry.computeVertexNormals();
    }
    attribute.needsUpdate = true;
    entry.geometry.computeBoundingBox();
    entry.geometry.computeBoundingSphere();
    entry.last = values;
  }

  function apply(eyes, nose, motion, progress, expression = config.design.expression.defaults, actionNoseWidth = null) {
    const sampled = sampleFaceMotion(motion, progress, config);
    const effectiveEyes = constrained({
      ...eyes, gazeX: eyes.gazeX + sampled.eyes.gazeX, gazeY: eyes.gazeY + sampled.eyes.gazeY,
      leftOpen: eyes.leftOpen * sampled.eyes.leftOpen, rightOpen: eyes.rightOpen * sampled.eyes.rightOpen,
    }, config.design.limits.eyes);
    const effectiveNose = constrained({ ...nose, width: nose.width + sampled.nose.width, tilt: nose.tilt + sampled.nose.tilt }, config.design.limits.nose);
    const eyeKeys = ['width', 'height', 'spacing', 'offsetY', 'gazeX', 'gazeY'];
    const eyeDefaults = eyeKeys.map((key) => config.design.defaults.eyes[key]);
    const profiles = expressionProfiles(expression, config);
    for (const [key, openness, side] of [['leftEye', 'leftOpen', 'left'], ['rightEye', 'rightOpen', 'right']]) {
      const open = effectiveEyes[openness];
      const profile = profiles[side];
      const values = [...eyeKeys.map((name) => effectiveEyes[name]), open, ...Object.values(profile)];
      const baseline = [...eyeDefaults, config.design.defaults.eyes[openness], ...Object.values(config.design.expression.presets.neutral[side])];
      const gazeX = clamp(effectiveEyes.gazeX + profile.gazeX, config.design.limits.eyes.gazeX.min, config.design.limits.eyes.gazeX.max);
      const gazeY = clamp(effectiveEyes.gazeY + profile.gazeY, config.design.limits.eyes.gazeY.min, config.design.limits.eyes.gazeY.max);
      const apertureWidth = profile.width * open + settings.aperture.closed.width * (1 - open);
      const apertureHeight = profile.height * open + settings.aperture.closed.height * (1 - open);
      const apertureCurve = profile.curve * open + settings.aperture.closed.curve * (1 - open);
      const shapeDefault = ['width', 'height', 'spacing', 'offsetY'].every((name) => effectiveEyes[name] === config.design.defaults.eyes[name]);
      update(entries[key], values, baseline, (entry, attribute, i) => {
        const dx = entry.positions[i * 3] - entry.center.x;
        const dy = entry.positions[i * 3 + 1] - entry.center.y;
        const weight = entry.aperture.weights[i];
        if (weight === 0 && shapeDefault) {
          attribute.setXYZ(i, entry.positions[i * 3], entry.positions[i * 3 + 1], entry.positions[i * 3 + 2]);
          return;
        }
        const curve = apertureCurve * Math.max(0, 1 - (dx / entry.aperture.halfWidth) ** 2);
        let localX = dx + weight * (dx * (apertureWidth - 1) + gazeX);
        let localY = dy + weight * (dy * (apertureHeight - 1) + curve + profile.slant * dx + gazeY);
        const radius = Math.hypot(localX, localY);
        if (radius > 0 && weight > 0) {
          const maximum = entry.aperture.outerRadius(localX / radius, localY / radius) - settings.aperture.inset * weight;
          if (radius > maximum) { localX *= maximum / radius; localY *= maximum / radius; }
        }
        const x = entry.center.x * effectiveEyes.spacing + localX * effectiveEyes.width;
        const y = entry.center.y + localY * effectiveEyes.height + effectiveEyes.offsetY;
        const attached = surface(x, y);
        attribute.setXYZ(i, attached.x, attached.y, attached.z + entry.relief[i]);
      });
    }
    const noseKeys = Object.keys(config.design.limits.nose);
    const angle = THREE.MathUtils.degToRad(effectiveNose.tilt);
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    update(entries.nose, [...noseKeys.map((key) => effectiveNose[key]), actionNoseWidth], [...noseKeys.map((key) => config.design.defaults.nose[key]), null], (entry, attribute, i) => {
      const originalX = entry.positions[i * 3] - entry.center.x;
      // Translate both rounded ends; distribute length change through the bar.
      // This keeps cap radius, height, centre and surface relief unchanged.
      const halfBar = Math.max(1e-6, (entry.size.x - entry.size.y) / 2);
      const extension = actionNoseWidth === null ? 0 : (actionNoseWidth - entry.size.x) / 2;
      const dx = actionNoseWidth === null ? originalX * effectiveNose.width
        : originalX + extension * THREE.MathUtils.clamp(originalX / halfBar, -1, 1);
      const dy = (entry.positions[i * 3 + 1] - entry.center.y) * effectiveNose.height;
      const x = entry.center.x + dx * cosine - dy * sine;
      const y = entry.center.y + dx * sine + dy * cosine + effectiveNose.offsetY;
      const attached = surface(x, y);
      const tipWeight = (entry.relief[i] - entry.minRelief) / (entry.maxRelief - entry.minRelief);
      attribute.setXYZ(i, attached.x, attached.y, attached.z + entry.relief[i] + effectiveNose.protrusion * tipWeight);
    });
    return { eyes: effectiveEyes, nose: effectiveNose };
  }

  return {
    apply,
    get neutralNoseWidth() { return entries.nose.size.x; },
    reset() { return apply(config.design.defaults.eyes, config.design.defaults.nose, config.design.motion.defaults, 0); },
    // Geometry is owned by the design meshes; normal studio disposeObjects releases it.
  };
}
