import { registerHooks } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../web/src/config.js';

const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { createContinuousLegGeometry } = await import('../web/src/leg-continuous.js');
const { exportModel, describeObject, disposeObjects } = await import('../web/src/model-io.js');
const hash = b => createHash('sha256').update(b).digest('hex');
const sourceBytes = await readFile(new URL('../assets/design/legs-v3/legs.glb', import.meta.url));
const source = (await new GLTFLoader().parseAsync(sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength), '')).scene;
let sourceMesh; source.traverse(node => { if (node.isMesh && node.scale.x > 0) sourceMesh = node; });
const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const sourceAudit = await json('../assets/design/legs-v3/geometry-audit.json');
const baseline = await json('../assets/design/legs-v2/parameters.json');
const sourceParameters = await json('../assets/design/legs-v3/parameters.json');
const { geometry, report } = createContinuousLegGeometry(sourceMesh.geometry, sourceAudit, baseline.legs, sourceParameters.refinement, APP_CONFIG.design.legRefinementV4);
const root = new THREE.Group(); root.name = 'XiaoBai_Legs_Continuous_V4';
root.userData = { version: 'legs-v4', designOnly: true, approval: 'pending', mirrorPlane: 'x=0', skinning: false, method: report.method };
for (const sign of [1, -1]) {
  const mesh = new THREE.Mesh(geometry.clone(), sourceMesh.material.clone());
  mesh.name = sign > 0 ? 'Leg_R' : 'Leg_L'; mesh.scale.x = sign;
  mesh.userData = { version: 'legs-v4', designOnly: true, approval: 'pending' }; root.add(mesh);
}
const output = new URL('../temp/generated/legs-v4/', import.meta.url); await mkdir(output, { recursive: true });
const glb = new Uint8Array(await exportModel(root));
await writeFile(new URL('legs.glb', output), glb);
await writeFile(new URL('parameters.json', output), JSON.stringify({ source: 'assets/design/legs-v3/legs.glb', refinement: APP_CONFIG.design.legRefinementV4 }, null, 2) + '\n');
await writeFile(new URL('geometry-audit.json', output), JSON.stringify(report, null, 2) + '\n');
const info = describeObject(root);
await writeFile(new URL('provenance.json', output), JSON.stringify({ version: 'legs-v4', approval: 'pending', designOnly: true, previous: 'assets/design/legs-v3/legs.glb', previousSha256: hash(sourceBytes), method: report.method, geometry: info, sha256: hash(glb), bytes: glb.length, binding: 'not-bound; v2 vertex-index weights must not be reused' }, null, 2) + '\n');
console.log(JSON.stringify({ ...info, ...report, sha256: hash(glb) }, null, 2));
geometry.dispose(); disposeObjects([root, source]); hook.deregister();
