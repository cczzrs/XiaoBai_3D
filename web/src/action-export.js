import * as THREE from 'three';
import { clone as cloneSkeleton } from '../vendor/addons/utils/SkeletonUtils.js';
import { createFaceRig } from './face-rig.js';
import { applyAction, sampleAction, actionDuration } from './action-motion.js';
import { describeActionApproval } from './action-approval.js';

/** Bake approved-binding copies into portable glTF clips. No source mutations. */
export function bakeActionClips(source, actions, config) {
  const root = cloneSkeleton(source);
  // Face rig and morph targets are private to this export copy.
  root.traverse((node) => { if (node.isMesh) node.geometry = node.geometry.clone(); });
  const head = root.getObjectByName(config.design.face.nodes.head)?.parent;
  if (!head) throw new Error('动作导出缺少批准头部。');
  const face = createFaceRig(head, config);
  const nose = root.getObjectByName(config.design.face.nodes.nose);
  const bones = [];
  root.traverse((node) => { if (node.isBone) bones.push(node); });
  const neutral = bones.map((bone) => bone.quaternion.clone());
  const neutralPosition = root.position.clone();
  const baseNose = nose.geometry.attributes.position.clone();
  const baseNormal = nose.geometry.attributes.normal.clone();
  const widths = [];
  const { minimum, middle, maximum } = actions.parameters.thinking;
  const steps = Math.max(1, Math.ceil((maximum - minimum) / config.design.actions.export.noseMorphStep));
  for (let i = 0; i <= steps; i++) widths.push(THREE.MathUtils.lerp(minimum, maximum, i / steps));
  widths.push(middle);
  const targets = [...new Set(widths)].sort((a, b) => a - b);
  const positions = [], normals = [];
  for (const width of targets) {
    face.apply(config.design.defaults.eyes, config.design.defaults.nose, config.design.motion.defaults, 0, config.design.expression.defaults, width);
    positions.push(nose.geometry.attributes.position.clone());
    normals.push(nose.geometry.attributes.normal.clone());
  }
  face.reset();
  nose.geometry.setAttribute('position', baseNose);
  nose.geometry.setAttribute('normal', baseNormal);
  nose.geometry.morphAttributes = { position: positions, normal: normals };
  nose.geometry.morphTargetsRelative = false;
  nose.updateMorphTargets();
  const clips = [];
  for (const name of config.design.actions.names) {
    const duration = actionDuration(name, actions, config);
    const steps = Math.max(1, Math.ceil(duration * config.design.actions.export.fps));
    const times = [], rootPositions = [], weights = [];
    const rotations = bones.map(() => []);
    for (let i = 0; i <= steps; i++) {
      root.position.copy(neutralPosition);
      bones.forEach((bone, j) => bone.quaternion.copy(neutral[j]));
      const sample = sampleAction(name, i / steps, actions, config);
      applyAction(root, sample, config);
      times.push(i / steps * duration);
      rootPositions.push(...root.position);
      bones.forEach((bone, j) => {
        const values = bone.quaternion.toArray();
        // Adjacent quaternion signs must agree for a continuous exported loop.
        const previous = rotations[j].slice(-4);
        if (previous.length && values.reduce((sum, v, k) => sum + v * previous[k], 0) < 0) for (let k = 0; k < 4; k++) values[k] *= -1;
        rotations[j].push(...values);
      });
      const frameWeights = targets.map(() => 0);
      if (sample.noseWidth !== null) {
        const hi = Math.max(0, targets.findIndex((v) => v >= sample.noseWidth - 1e-8));
        const lo = Math.max(0, hi - 1);
        const t = hi === lo ? 1 : THREE.MathUtils.clamp((sample.noseWidth - targets[lo]) / (targets[hi] - targets[lo]), 0, 1);
        frameWeights[lo] += 1 - t; frameWeights[hi] += t;
      }
      weights.push(...frameWeights);
    }
    const tracks = [new THREE.VectorKeyframeTrack(`${root.name}.position`, times, rootPositions),
      ...bones.map((bone, i) => new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, rotations[i])),
      new THREE.NumberKeyframeTrack(`${nose.name}.morphTargetInfluences`, times, weights)];
    clips.push(new THREE.AnimationClip(`xiaobai_${name}_v1`, duration, tracks));
  }
  root.position.copy(neutralPosition);
  bones.forEach((bone, j) => bone.quaternion.copy(neutral[j]));
  root.updateMatrixWorld(true);
  root.userData = { ...root.userData, ...describeActionApproval(actions, config), rigApproval: 'approved', actions: structuredClone(actions), clipNames: clips.map((clip) => clip.name), exportSamplingFPS: config.design.actions.export.fps, noseMorphStep: config.design.actions.export.noseMorphStep };
  return { root, clips };
}
