import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG as config } from '../web/src/config.js';
import { createDefaultProject, serializeProject } from '../web/src/project-state.js';

const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { clonePart, exportModel, disposeObjects } = await import('../web/src/model-io.js');
const { createMirroredArms } = await import('../web/src/arm-v59.js');
const { createLimbRig } = await import('../web/src/limb-rig-v7.js');
const { bakeActionClips } = await import('../web/src/action-export-v7.js');
const projectRoot = new URL('../', import.meta.url), output = new URL('temp/generated/rig-v7/', projectRoot);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = config.assets.legs.versions['legs-separated-v7'];
const sources = {}, sourceHashes = {};
for (const [slot, url] of Object.entries({ head: config.assets.head.url, arms: config.assets.arms.builtin.url, legs: asset.url, body: asset.companionBody.url })) {
  const bytes = await readFile(new URL(url, projectRoot)); sourceHashes[slot] = digest(bytes);
  sources[slot] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
}
const guides = JSON.parse(await readFile(new URL(config.assets.arms.builtin.linesUrl, projectRoot), 'utf8'));
const armPair = createMirroredArms(sources.arms, guides, config);
const root = new THREE.Group(); root.name = 'XiaoBai_DesignDraft';
root.userData = { designOnly: true, rigType: config.design.bindingV7.version, rigApproval: 'pending', deformationApproval: 'pending', skinning: true,
  approvedSources: { head: config.assets.head.version, arms: config.assets.arms.builtin.version },
  designSources: {
    body: { version: asset.companionBody.version, file: asset.companionBody.url, approval: 'pending', independentMesh: true },
    legs: { version: asset.version, file: asset.url, approval: 'pending', independentMeshes: 2, bindingVersion: asset.binding.version, bindingApproval: 'pending' },
  },
  preservedApprovedBaselines: { body: { version: config.assets.body.version, file: config.assets.body.url } },
};
const rootBone = new THREE.Bone(), bodyBone = new THREE.Bone(), neckBone = new THREE.Bone(), headBone = new THREE.Bone();
[rootBone.name, bodyBone.name, neckBone.name, headBone.name] = ['XiaoBai_RigRoot', 'XiaoBai_RigBody', 'XiaoBai_RigNeck', 'XiaoBai_RigHead'];
root.add(rootBone); rootBone.add(bodyBone); bodyBone.add(neckBone); neckBone.add(headBone);
const { rootY, neckY } = config.design.defaults.rig, { bodyCenterY, headCenterY } = config.design.rigVisual;
rootBone.position.y = rootY; bodyBone.position.y = bodyCenterY - rootY;
neckBone.position.y = neckY - bodyCenterY; headBone.position.y = headCenterY - neckY;
const rig = createLimbRig({ draftRoot: root, rootBone, bodyBone, config });
for (const slot of ['head', 'arms', 'body', 'legs']) {
  const source = slot === 'arms' ? armPair : sources[slot], draft = clonePart(source);
  const wrapper = new THREE.Group(), offset = new THREE.Group();
  wrapper.name = `${slot}_ShapePivot`; offset.name = `${slot}_WorldOffset`;
  const pivot = slot === 'head' ? headCenterY : slot === 'legs' ? rootY : bodyCenterY;
  wrapper.add(offset); offset.position.y = -pivot; offset.add(draft);
  (slot === 'head' ? headBone : slot === 'legs' ? rootBone : bodyBone).add(wrapper);
  root.updateMatrixWorld(true);
  const definition = slot === 'legs' ? asset : slot === 'body' ? asset.companionBody : config.assets[slot].builtin;
  rig.bindPart({ source, draft, wrapper, offset, metadata: { builtin: slot === 'body' ? 'body-companion-v7' : definition?.projectRecord.id, sourceVersion: definition?.version, format: 'glb', designOnly: true } }, slot);
}
rig.apply(config.design.binding.defaults); root.updateMatrixWorld(true);
const project = createDefaultProject(); project.parts.legs = structuredClone(asset.projectRecord);
const { root: animated, clips } = bakeActionClips(root, project.actions, config);
await mkdir(output, { recursive: true });
const files = {};
for (const [name, object, animations] of [['xiaobai-rig-v7.glb', root, []], ['xiaobai-legs-v7-actions-design.glb', animated, clips]]) {
  const bytes = new Uint8Array(await exportModel(object, animations));
  await writeFile(new URL(name, output), bytes); files[name] = { bytes: bytes.byteLength, sha256: digest(bytes) };
}
await writeFile(new URL('project.json', output), serializeProject(project));
await writeFile(new URL('parameters.json', output), JSON.stringify({ bindingVersion: asset.binding.version, bindingApproval: 'pending', binding: project.binding, weights: config.design.bindingV7.weights, actions: project.actions }, null, 2) + '\n');
const report = { version: asset.binding.version, approval: 'pending', visibleShapeReference: './docs/approvals/legs-v6-shape-approved.json', independentStructureApproval: 'pending', sourceHashes, files, stats: rig.getStats(), clips: clips.map(c => ({ name: c.name, duration: c.duration, tracks: c.tracks.length })) };
await writeFile(new URL('provenance.json', output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
rig.dispose(); disposeObjects([root, animated, armPair, ...Object.values(sources)]); hook.deregister();
