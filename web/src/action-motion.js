import * as THREE from 'three';

const TAU = Math.PI * 2;
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const turn = (axis, degrees) => new THREE.Quaternion().setFromAxisAngle(AXES[axis], THREE.MathUtils.degToRad(degrees));
const lerp = THREE.MathUtils.lerp;
const smooth = (t) => t * t * (3 - 2 * t);

export function actionDuration(name, actions, config) {
  return actions.parameters[name]?.duration ?? (name === 'sit' ? config.design.actions.export.holdSeconds : config.design.motion.durationSeconds);
}

/** Parameterized poses only. Never changes geometry, binding data or rest positions. */
export function sampleAction(name, phase, actions, config) {
  if (!Number.isFinite(phase)) throw new Error('动作相位必须是有限数字。');
  const progress = ((phase % 1) + 1) % 1;
  const cfg = actions.parameters[name];
  const result = { rotations: {}, lean: 0, noseWidth: null, grounded: false, angles: {} };
  const rotate = (key, axis, degrees) => { result.rotations[key] = turn(axis, degrees); };
  const down = (side) => rotate(`shoulder${side}`, 'z', side === 'R' ? -90 : 90);
  if (name === 'walk' || name === 'run') {
    result.grounded = true;
    result.lean = name === 'run' ? cfg.forwardLean : 0;
    for (const side of ['L', 'R']) {
      const sign = side === 'R' ? 1 : -1;
      const forwardSide = config.design.actions.conventions[`${name}ForwardSide`];
      const cosine = Math.cos(TAU * (progress + (side === forwardSide ? 0 : 0.5)));
      const front = (cosine + 1) / 2;
      const hip = lerp(cfg.hipRear, cfg.hipFront, front);
      const knee = name === 'walk' ? lerp(cfg.kneeRear, cfg.kneeFront, front) : cfg.knee * cosine * cosine;
      const shoulder = name === 'walk' ? -cfg.armSwing * cosine : lerp(cfg.armFront, cfg.armRear, front);
      const elbow = name === 'walk' ? 0 : lerp(cfg.elbowFront, cfg.elbowRear, front);
      rotate(`hip${side}`, 'x', -hip);
      rotate(`knee${side}`, 'x', knee);
      rotate(`ankle${side}`, 'x', hip - knee - result.lean);
      down(side);
      result.rotations[`shoulder${side}`].premultiply(turn('x', -shoulder));
      if (name === 'run') result.rotations[`shoulder${side}`].multiply(turn('x', sign * cfg.rearTwist * front));
      rotate(`elbow${side}`, 'y', -sign * elbow);
      result.angles[side] = { hip, knee, shoulder, elbow };
    }
  } else if (name === 'wave') {
    for (const side of ['L', 'R']) down(side);
    const side = actions.waveSide, sign = side === 'R' ? 1 : -1;
    rotate(`shoulder${side}`, 'z', sign * (cfg.upperArmElevation - 90));
    rotate(`elbow${side}`, 'z', sign * cfg.elbowFlexion);
    rotate(`wrist${side}`, 'z', sign * cfg.wristAmplitude * Math.sin(TAU * progress));
    result.angles = { side, wrist: cfg.wristAmplitude * Math.sin(TAU * progress) };
  } else if (name === 'thinking') {
    const values = [cfg.minimum, cfg.middle, cfg.maximum, cfg.middle, cfg.minimum];
    const segment = Math.floor(progress * 4);
    result.noseWidth = lerp(values[segment], values[segment + 1], smooth(progress * 4 - segment));
  } else if (name === 'sit') {
    result.grounded = true;
    for (const side of ['L', 'R']) {
      rotate(`hip${side}`, 'x', -cfg.hip);
      rotate(`knee${side}`, 'x', cfg.knee);
      rotate(`ankle${side}`, 'x', cfg.hip - cfg.knee);
      // Open arms are kept clear of the short legs; no new hand-placement IK.
    }
  }
  return result;
}

/** Evaluate every skinned vertex for exact current ground contact, not a rigid box. */
export function minimumSkinnedY(meshes) {
  let minimum = Infinity;
  const combined = new THREE.Matrix4(), transform = new THREE.Matrix4();
  for (const mesh of meshes) {
    mesh.skeleton.update();
    combined.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
    const rows = mesh.skeleton.bones.map((bone, i) => {
      transform.copy(combined).multiply(bone.matrixWorld).multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix);
      const e = transform.elements;
      return [e[1], e[5], e[9], e[13]];
    });
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      let y = 0;
      const x0 = position.getX(i), y0 = position.getY(i), z0 = position.getZ(i);
      for (let j = 0; j < 4; j++) {
        const w = skinWeight.array[i * 4 + j];
        if (!w) continue;
        const row = rows[skinIndex.array[i * 4 + j]];
        y += w * (row[0] * x0 + row[1] * y0 + row[2] * z0 + row[3]);
      }
      minimum = Math.min(minimum, y);
    }
  }
  return minimum;
}

/** Called after applying the unchanged neutral binding / static design pose. */
export function applyAction(root, sample, config) {
  for (const [key, rotation] of Object.entries(sample.rotations)) {
    const bone = root.getObjectByName(`XiaoBai_Rig_${key}`);
    if (bone) bone.quaternion.multiply(rotation);
  }
  const pelvis = root.getObjectByName('XiaoBai_RigRoot');
  if (pelvis) pelvis.quaternion.premultiply(turn('x', sample.lean));
  root.updateMatrixWorld(true);
  if (sample.grounded) {
    const legs = [];
    root.traverse((node) => { if (node.isSkinnedMesh && node.userData.sourceVersion === 'legs-v2') legs.push(node); });
    // The approved v1 skin records the limb slot on the bones, not every mesh.
    if (!legs.length) root.traverse((node) => {
      if (node.isSkinnedMesh && /leg/i.test(node.name)) legs.push(node);
    });
    const minimum = minimumSkinnedY(legs);
    if (Number.isFinite(minimum)) root.position.y += config.design.actions.ground.level - minimum;
    root.updateMatrixWorld(true);
  }
}

export function captureActionPose(root, noseWidth = null) {
  const rotations = {};
  root.traverse((node) => { if (node.isBone) rotations[node.name] = node.quaternion.clone(); });
  return { rotations, position: root.position.clone(), noseWidth };
}

export function blendActionPose(root, previous, alpha, targetNoseWidth, neutralNoseWidth) {
  const t = smooth(THREE.MathUtils.clamp(alpha, 0, 1));
  root.traverse((node) => {
    const from = previous.rotations[node.name];
    if (node.isBone && from) node.quaternion.copy(from.clone().slerp(node.quaternion, t));
  });
  root.position.lerpVectors(previous.position, root.position.clone(), t);
  root.updateMatrixWorld(true);
  const fromNose = previous.noseWidth ?? neutralNoseWidth;
  const toNose = targetNoseWidth ?? neutralNoseWidth;
  return alpha >= 1 ? targetNoseWidth : lerp(fromNose, toNose, t);
}
