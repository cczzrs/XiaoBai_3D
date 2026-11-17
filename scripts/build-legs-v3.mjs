import { registerHooks } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../web/src/config.js';

const hook = registerHooks({ resolve(specifier, context, next) { return next(specifier === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : specifier, context); } });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const THREE = await import('three');
const { createRefinedLegGeometry } = await import('../web/src/leg-refinement.js');
const { exportModel, describeObject, disposeObjects } = await import('../web/src/model-io.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = new URL('../assets/design/legs-v2/', import.meta.url);
const baseline = JSON.parse(await readFile(new URL('parameters.json', previous), 'utf8'));
const contactAudit = JSON.parse(await readFile(new URL('contact-audit.json', previous), 'utf8'));
const { geometry, report } = createRefinedLegGeometry(baseline.legs, baseline.hipBlend, APP_CONFIG.design.legRefinementV3, contactAudit);
const root = new THREE.Group();
root.name = 'XiaoBai_Legs_Rounded_V3';
root.userData = { version: 'legs-v3', designOnly: true, approval: 'pending', mirrorPlane: 'x=0', skinning: false, method: 'curvature-continuous-instep-uniform-arc-rings-rounded-buried-dome' };
for (const sign of [1, -1]) {
  const mesh = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial(baseline.legs.material));
  mesh.name = sign > 0 ? 'Leg_R' : 'Leg_L'; mesh.scale.x = sign;
  mesh.userData = { designOnly: true, approval: 'pending', version: 'legs-v3' };
  root.add(mesh);
}
// Rebuilds always go to temp; promotion to a new design version is explicit.
const output = new URL('../temp/generated/legs-v3/', import.meta.url);
await mkdir(output, { recursive: true });
const glb = new Uint8Array(await exportModel(root));
await writeFile(new URL('legs.glb', output), glb);
await writeFile(new URL('parameters.json', output), JSON.stringify({ source: 'assets/design/legs-v2/parameters.json', refinement: APP_CONFIG.design.legRefinementV3 }, null, 2) + '\n');
await writeFile(new URL('geometry-audit.json', output), JSON.stringify(report, null, 2) + '\n');
const info = describeObject(root);
await writeFile(new URL('provenance.json', output), JSON.stringify({ version: 'legs-v3', approval: 'pending', designOnly: true, previous: 'assets/design/legs-v2/legs.glb', previousSha256: hash(await readFile(new URL('legs.glb', previous))), bodyReference: 'assets/approved/body-v7/xiaobai-torso.glb', method: root.userData.method, geometry: info, sha256: hash(glb), bytes: glb.length, binding: 'not-bound; v2 vertex-index weights must not be reused' }, null, 2) + '\n');
console.log(JSON.stringify({ ...info, ...report, sha256: hash(glb) }, null, 2));
geometry.dispose(); disposeObjects([root]); hook.deregister();
