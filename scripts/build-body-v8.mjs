import { registerHooks } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../web/src/config.js';
const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { exportModel, describeObject, disposeObjects } = await import('../web/src/model-io.js');
const { createSymmetricBodyGeometry } = await import('../web/src/symmetric-body.js');
const read = path => readFile(new URL(path, import.meta.url));
const json = async path => JSON.parse(await read(path));
const hash = b => createHash('sha256').update(b).digest('hex');
const bodyBytes = await read('../assets/approved/body-v7/xiaobai-torso.glb');
const legBytes = await read('../temp/generated/legs-v8/leg-right.glb');
const parse = async bytes => (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
const body = await parse(bodyBytes), legs = await parse(legBytes); let bodyMesh, legMesh;
body.traverse(node => { if (node.isMesh) bodyMesh = node; }); legs.traverse(node => { if (node.isMesh) legMesh = node; });
const bodyJSON = JSON.parse(bodyBytes.subarray(20, 20 + bodyBytes.readUInt32LE(12)));
const audit = await json('../temp/generated/legs-v8/geometry-audit.json');
const old = await json('../assets/design/legs-v2/parameters.json'), v3 = await json('../assets/design/legs-v3/parameters.json');
const { geometry, report } = createSymmetricBodyGeometry(bodyMesh.geometry, bodyJSON.meshes[0].primitives[0].extras.parameters, legMesh.geometry, audit,
  old.legs, v3.refinement, APP_CONFIG.design.legRefinementV8, APP_CONFIG.design.bodyLegBlendV8);
const root = new THREE.Group(); root.name = 'XiaoBai_Body_Companion_V8';
root.userData = { version: 'body-design-v8', designOnly: true, approval: 'pending', companionFor: 'legs-v8', method: report.method };
const mesh = new THREE.Mesh(geometry, bodyMesh.material.clone()); mesh.name = 'Body_DesignV8';
mesh.userData = { version: 'body-design-v8', designOnly: true, approval: 'pending', companionFor: 'legs-v8' }; root.add(mesh);
const output = new URL('../temp/generated/legs-v8/', import.meta.url); await mkdir(output, { recursive: true });
const bytes = new Uint8Array(await exportModel(root)); await writeFile(new URL('body.glb', output), bytes);
await writeFile(new URL('body-audit.json', output), JSON.stringify(report, null, 2) + '\n');
await writeFile(new URL('body-provenance.json', output), JSON.stringify({ version: 'body-design-v8', approval: 'pending', designOnly: true,
  bodyReferenceSha256: hash(bodyBytes), legsReferenceSha256: hash(legBytes), method: report.method, geometry: describeObject(root), sha256: hash(bytes),
  parameters: APP_CONFIG.design.bodyLegBlendV8 }, null, 2) + '\n');
console.log(JSON.stringify({ body: describeObject(root), sha256: hash(bytes), outerTriangleCount: report.outerTriangleCount, caps: report.caps.map(({ boundaryIndices, ...cap }) => cap) }, null, 2));
disposeObjects([root, body, legs]); hook.deregister();
