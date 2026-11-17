import { registerHooks } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../web/src/config.js';

const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { createSymmetricLegGeometry } = await import('../web/src/symmetric-leg.js');
const { exportModel, describeObject, disposeObjects } = await import('../web/src/model-io.js');
const hash = b => createHash('sha256').update(b).digest('hex');
const read = path => readFile(new URL(path, import.meta.url));
const json = async path => JSON.parse(await read(path));
const sourcePath = 'assets/design/legs-v6/body-legs.glb';
const sourceBytes = await read(`../${sourcePath}`);
const source = (await new GLTFLoader().parseAsync(sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength), '')).scene;
let sourceMesh;
source.traverse(node => { if (node.isMesh) sourceMesh = node; });
const sourceAudit = await json('../assets/design/legs-v4/geometry-audit.json');
const baseline = await json('../assets/design/legs-v2/parameters.json');
const sourceParameters = await json('../assets/design/legs-v3/parameters.json');
const refinement = APP_CONFIG.design.legRefinementV8;
if (!refinement) throw new Error('APP_CONFIG.design.legRefinementV8 is required.');
const { geometry, report } = createSymmetricLegGeometry(sourceMesh.geometry, sourceAudit, baseline.legs, sourceParameters.refinement, refinement);
const makeRoot = (signs, name) => {
  const root = new THREE.Group(); root.name = name;
  root.userData = { version: 'legs-v8', designOnly: true, approval: 'pending', mirrorPlane: 'x=0', frontBackPlane: `z=${report.frontBackPlaneZ}`, skinning: false, method: report.method };
  for (const sign of signs) {
    const mesh = new THREE.Mesh(geometry.clone(), sourceMesh.material.clone());
    mesh.name = sign > 0 ? 'Leg_R' : 'Leg_L'; mesh.scale.x = sign;
    mesh.userData = { version: 'legs-v8', designOnly: true, approval: 'pending', part: sign > 0 ? 'right' : 'left', frontBackPlaneZ: report.frontBackPlaneZ };
    root.add(mesh);
  }
  return root;
};
const output = new URL('../temp/generated/legs-v8/', import.meta.url);
await mkdir(output, { recursive: true });
const files = {}, roots = [];
for (const [name, signs] of [['legs.glb', [1, -1]], ['leg-left.glb', [-1]], ['leg-right.glb', [1]]]) {
  const root = makeRoot(signs, `XiaoBai_${name.replace('.glb', '')}_Symmetric_V8`); roots.push(root);
  const glb = new Uint8Array(await exportModel(root));
  await writeFile(new URL(name, output), glb);
  files[name] = { bytes: glb.length, sha256: hash(glb), meshes: signs.length };
}
await writeFile(new URL('parameters.json', output), JSON.stringify({ source: sourcePath, footProfile: 'assets/design/legs-v3/parameters.json', refinement }, null, 2) + '\n');
await writeFile(new URL('geometry-audit.json', output), JSON.stringify({ ...report, sourceSha256: hash(sourceBytes) }, null, 2) + '\n');
const info = describeObject(roots[0]);
await writeFile(new URL('provenance.json', output), JSON.stringify({
  version: 'legs-v8', approval: 'pending', designOnly: true, source: sourcePath, sourceSha256: hash(sourceBytes),
  method: report.method, geometry: info, files, frontBackPlaneZ: report.frontBackPlaneZ,
  preservedFoot: { vertexCount: report.preservedVertexCount, normalCount: report.preservedNormalCount, triangleCount: report.preservedTriangleCount, positionAndNormalBytes: 'unchanged', triangleOrder: 'unchanged' },
  binding: 'not-bound; independent left and right design meshes require new skin weights',
}, null, 2) + '\n');
console.log(JSON.stringify({ files, geometry: info, ...report }, null, 2));
geometry.dispose(); disposeObjects([...roots, source]); hook.deregister();
