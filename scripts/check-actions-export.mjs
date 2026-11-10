import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import assert from 'node:assert/strict';
import { historicalURL, temporaryOutput } from './project-paths.mjs';
registerHooks({resolve(s,c,n){return n(s==='three'?new URL('../web/vendor/three.module.js',import.meta.url).href:s,c);}});
const THREE=await import('three');
const {GLTFLoader}=await import('../web/vendor/addons/loaders/GLTFLoader.js');
const hash=b=>createHash('sha256').update(b).digest('hex');
const input=process.argv[2];if(!input)throw Error('Pass the exported GLB path.');
async function load(path){const b=await readFile(path);return {bytes:b,gltf:await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.length),'')};}
const candidate=await load(input),approved=await load(new URL('../assets/design/rig-v1/xiaobai-rig-v1.glb',import.meta.url));
function meshes(root){const a=[];root.traverse(n=>{if(n.isMesh)a.push(n);});return a;}
const key=n=>`${n.name.replace(/_\d+$/,'')}:${n.userData.bindingSide??''}`;
const original=new Map(meshes(approved.gltf.scene).map(n=>[key(n),n]));
const attr=a=>hash(new Uint8Array(a.array.buffer,a.array.byteOffset,a.array.byteLength));
const materials=m=>(Array.isArray(m.material)?m.material:[m.material]).map(v=>[v.color.toArray(),v.roughness,v.metalness,v.opacity,v.side]);
for(const mesh of meshes(candidate.gltf.scene)){
 const base=original.get(key(mesh));assert.ok(base,key(mesh));
 for(const name of ['position','normal','skinWeight','skinIndex'])if(base.geometry.attributes[name])assert.equal(attr(mesh.geometry.attributes[name]),attr(base.geometry.attributes[name]),`${key(mesh)}.${name}`);
 assert.equal(attr(mesh.geometry.index),attr(base.geometry.index));assert.deepEqual(materials(mesh),materials(base));
}
assert.equal(candidate.gltf.animations.length,5);
assert.deepEqual(candidate.gltf.animations.map(c=>Math.round(c.duration*100)/100),[1.2,.8,2,4,1]);
const bones=[];candidate.gltf.scene.traverse(n=>{if(n.isBone)bones.push(n);});assert.equal(bones.length,20);
const skins=meshes(candidate.gltf.scene).filter(n=>n.isSkinnedMesh);assert.equal(skins.length,4);
// Independent skin evaluator using Three's public vertex-transform API.
const feet=skins.filter(n=>n.name.startsWith('Leg'));
const point=new THREE.Vector3();
const report=[];
for(const clip of candidate.gltf.animations){
 const mixer=new THREE.AnimationMixer(candidate.gltf.scene);mixer.clipAction(clip).play();
 let maxGroundError=0;
 for(let frame=0;frame<=97;frame++){
  mixer.setTime(clip.duration*frame/97);candidate.gltf.scene.updateMatrixWorld(true);
  if(/walk|run|sit/.test(clip.name)){
   let low=Infinity;
   for(const mesh of feet){const pos=mesh.geometry.attributes.position;for(let i=0;i<pos.count;i++){point.fromBufferAttribute(pos,i);mesh.applyBoneTransform(i,point);point.applyMatrix4(mesh.matrixWorld);low=Math.min(low,point.y);}}
   maxGroundError=Math.max(maxGroundError,Math.abs(low));
  }
  assert.ok(bones.every(b=>[...b.quaternion,...b.position].every(Number.isFinite)));
 }
 mixer.stopAllAction();
 assert.ok(maxGroundError < 0.04, `${clip.name}: export ground error ${maxGroundError}`);
 report.push({name:clip.name,duration:clip.duration,tracks:clip.tracks.length,maxSampledGroundError:maxGroundError});
}
const approval=JSON.parse(await readFile(new URL('../docs/approvals/actions-v1-approved.json',import.meta.url)));
for(const f of approval.lockedFileSnapshot)assert.equal(hash(await readFile(historicalURL(f.path))),f.sha256,f.path);
const result={status:'passed',source:input.includes('/Downloads/')?'actual-Chrome-export':'generated-artifact',input,bytes:candidate.bytes.length,sha256:hash(candidate.bytes),clips:report,originalAttributesAndMaterialsUnchanged:true,lockedFilesUnchanged:approval.lockedFileSnapshot.length,bones:20,skins:4};
// Verification never promotes an export into the approved asset directory.
await writeFile(await temporaryOutput('qa/actions-v1-approved-export-check.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
