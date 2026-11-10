import * as THREE from 'three';
import { clonePart, describeObject, disposeObjects, loadApproved } from './model-io.js';

/** The approved coordinates remain intact. Reflection belongs to the design group. */
export function createMirroredArms(leftSource, displayLines, config) {
  const asset = config.assets.arms.builtin;
  const guides = config.design.armGuides;
  const pair = new THREE.Group();
  pair.name = 'XiaoBai_V59_MirroredArms';
  pair.userData = { designOnly: true, sourceVersion: asset.version, sourceApproval: 'approved', approval: 'pending', mirrorPlane: 'x=0' };
  for (const [name, scale] of [['LeftArm_V59', asset.sourceScale], ['RightArm_V59', asset.mirrorScale]]) {
    const side = new THREE.Group();
    side.name = name;
    side.scale.fromArray(scale);
    side.position.fromArray(asset.position);
    const meshCopy = clonePart(leftSource);
    meshCopy.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry = object.geometry.clone();
      object.userData = { ...object.userData, designOnly: true, sourceVersion: asset.version, sourceApproval: 'approved', approval: 'pending' };
    });
    side.add(meshCopy);
    for (const group of Object.keys(guides.groups)) {
      const positions = displayLines[group];
      if (!Array.isArray(positions) || positions.length % 6 || !positions.every(Number.isFinite)) {
        disposeObjects([pair, side]);
        throw new Error(`v59 ${group} 显示线数据无效。`);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ color: guides.color, transparent: true, opacity: guides.opacity, toneMapped: false, depthWrite: false });
      const line = new THREE.LineSegments(geometry, material);
      line.name = `${name}_${group}`;
      line.userData = { displayGuide: true, guideGroup: group };
      line.renderOrder = guides.renderOrder;
      side.add(line);
    }
    pair.add(side);
  }
  setArmGuides(pair, guides);
  return pair;
}

export function setArmGuides(root, settings) {
  root.traverse((object) => {
    if (object.userData.displayGuide) object.visible = settings.enabled && settings.groups[object.userData.guideGroup];
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material.polygonOffset = settings.enabled;
      material.polygonOffsetFactor = settings.polygonOffsetFactor;
      material.polygonOffsetUnits = settings.polygonOffsetUnits;
    }
  });
}

export async function loadBuiltinArms(config) {
  const asset = config.assets.arms.builtin;
  // All dependencies are local copies; the original approved directory is never loaded for editing.
  const results = await Promise.allSettled([
    loadApproved(asset.url),
    fetch(asset.linesUrl).then((response) => {
      if (!response.ok) throw new Error('无法读取 v59 环线资源。');
      return response.json();
    }),
  ]);
  const source = results[0].status === 'fulfilled' ? results[0].value : null;
  try {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const root = createMirroredArms(source, results[1].value, config);
    return { root, ...describeObject(root), name: asset.label, format: 'glb', warnings: [], designOnly: true, sourceVersion: asset.version, builtin: asset.projectRecord.id };
  } finally {
    if (source) disposeObjects([source]);
  }
}
