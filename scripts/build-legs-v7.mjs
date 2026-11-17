import { registerHooks } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG as config } from '../web/src/config.js';

const hook = registerHooks({ resolve(s, c, next) { return next(s === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : s, c); } });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { exportModel } = await import('../web/src/model-io.js');
const { separateBodyAndLegs } = await import('../web/src/separate-body-legs.js');
const root = new URL('../', import.meta.url), output = new URL('temp/generated/legs-v7/', root), settings = config.design.legSeparationV7;
const hash = b => createHash('sha256').update(b).digest('hex');
const bytes = await readFile(new URL(settings.source, root));
const source = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
let sourceMesh; source.traverse(node => { if (node.isMesh) sourceMesh = node; });
const { parts: separated, cutPointSources } = separateBodyAndLegs(sourceMesh.geometry, settings), objects = {};
for (const [part, { geometry }] of Object.entries(separated)) {
  const mesh = new THREE.Mesh(geometry, sourceMesh.material.clone());
  mesh.name = part === 'body' ? 'Torso_DesignV7' : part === 'left' ? 'Leg_L' : 'Leg_R';
  mesh.userData = { designOnly: true, version: part === 'body' ? 'body-design-v7' : 'legs-v7', part, approval: 'pending', sourceVersion: 'legs-v6', preservedExterior: true, hiddenRoundedCaps: true };
  objects[part] = mesh;
}
const makeRoot = (parts, name) => { const group = new THREE.Group(); group.name = name;
  group.userData = { designOnly: true, version: 'legs-v7', approval: 'pending', sourceVersion: 'legs-v6', method: 'Original exterior preserved; triangles crossing the slanted part boundary subdivided by edge interpolation. Independent closed parts use curvature-matched ellipsoid caps.', skinning: false };
  for (const part of parts) group.add(objects[part].clone()); return group;
};
await mkdir(output, { recursive: true });
const files = {};
for (const [name, parts] of [['legs.glb', ['left', 'right']], ['body.glb', ['body']], ['leg-left.glb', ['left']], ['leg-right.glb', ['right']]]) {
  const data = new Uint8Array(await exportModel(makeRoot(parts, `XiaoBai_Separated_${name.replace('.glb', '')}_V7`)));
  await writeFile(new URL(name, output), data); files[name] = { bytes: data.byteLength, sha256: hash(data), meshes: parts.length };
}
const audit = { schema: 'xiaobai.separated-legs.v1', sourceVertices: sourceMesh.geometry.attributes.position.count, sourceTriangles: sourceMesh.geometry.index.count / 3,
  sourceSha256: hash(bytes), settings, cutPointSources, parts: Object.fromEntries(Object.entries(separated).map(([name, value]) => [name, value.audit])) };
await writeFile(new URL('geometry-audit.json', output), JSON.stringify(audit) + '\n');
await writeFile(new URL('parameters.json', output), JSON.stringify(settings, null, 2) + '\n');
await writeFile(new URL('provenance.json', output), JSON.stringify({ version: 'legs-v7', approval: 'pending', source: settings.source, sourceSha256: hash(bytes), designOnly: true, files,
  exterior: 'Original v6 exterior retained; only triangles crossing the part boundary are subdivided along original edges. Original POSITION and NORMAL values retained; new boundary normals use normalized edge interpolation.', hiddenCaps: 'New closed rounded internal tops/bottoms, pending review.' }, null, 2) + '\n');
console.log(JSON.stringify({ files, parts: Object.fromEntries(Object.entries(separated).map(([name, { audit: a }]) => [name, { vertices: a.vertices, triangles: a.triangles, outerTriangles: a.outerTriangleCount, boundaries: a.caps.map(c => c.verticesPerRing) }])) }, null, 2));
hook.deregister();
