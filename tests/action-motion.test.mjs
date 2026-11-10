import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG as config } from '../web/src/config.js';
import { createDefaultProject, parseProject, serializeProject, validateActions } from '../web/src/project-state.js';
import { historicalURL, temporaryOutput } from '../scripts/project-paths.mjs';
registerHooks({ resolve(s,c,n) { return n(s === 'three' ? new URL('../web/vendor/three.module.js',import.meta.url).href : s,c); } });
const THREE = await import('three');
const { GLTFLoader } = await import('../web/vendor/addons/loaders/GLTFLoader.js');
const { clone } = await import('../web/vendor/addons/utils/SkeletonUtils.js');
const { sampleAction, applyAction, minimumSkinnedY, actionDuration, captureActionPose, blendActionPose } = await import('../web/src/action-motion.js');
const { createFaceRig } = await import('../web/src/face-rig.js');
const { bakeActionClips } = await import('../web/src/action-export.js');
const { exportModel } = await import('../web/src/model-io.js');
const defaults = () => createDefaultProject().actions;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const attrHash = (a) => hash(new Uint8Array(a.array.buffer,a.array.byteOffset,a.array.byteLength));
const getMeshes = (root) => { const a=[];root.traverse(n=>{if(n.isMesh)a.push(n);});return a; };
let approved, rigRoot;
before(async () => {
 const data = await readFile(new URL('../assets/design/rig-v1/xiaobai-rig-v1.glb', import.meta.url));
 approved = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.length),'');
 rigRoot = approved.scene.getObjectByName('XiaoBai_DesignDraft');
});

test('批准的周期与角度精确沿用，所有数值参数均可验证并保存；旧 rig-v1 项目中立迁移',async()=>{
 const p=createDefaultProject();
 assert.deepEqual([p.actions.parameters.walk.duration,p.actions.parameters.run.duration,p.actions.parameters.wave.duration,p.actions.parameters.thinking.duration],[1.2,.8,2,4]);
 assert.deepEqual([p.actions.parameters.run.armFront,p.actions.parameters.run.elbowFront,p.actions.parameters.run.armRear,p.actions.parameters.run.elbowRear],[45,95,-35,80]);
 assert.equal(p.actions.parameters.transition.duration,.3);
 for(const entry of config.design.actions.parameters){
   const q=createDefaultProject();const [g,k]=entry.path.split('.');
   q.actions.parameters[g][k]+=entry.step * (q.actions.parameters[g][k] === entry.max ? -1 : 1);
   assert.deepEqual(parseProject(serializeProject(q)).actions,q.actions);
   q.actions.parameters[g][k]=entry.max+entry.step;
   assert.throws(()=>validateActions(q.actions));
 }
 const old=JSON.parse(await readFile(new URL('../assets/design/rig-v1/project.json',import.meta.url)));
 const next=parseProject(JSON.stringify(old));assert.equal(next.revision,8);assert.deepEqual(next.binding,old.binding);assert.deepEqual(next.actions,defaults());
 assert.throws(()=>validateActions({...defaults(),injected:true}));
 const bad=defaults();bad.parameters.thinking.minimum=16;assert.throws(()=>validateActions(bad),/鼻宽/);
 const dynamic=defaults();Object.defineProperty(dynamic.parameters.run,'armFront',{get(){throw Error('executed');}});assert.throws(()=>validateActions(dynamic),/动态/);
});

test('半周期换侧、批准端点、闭环与鼻宽五个关键点符合记录',()=>{
 const a=defaults();
 const walk=sampleAction('walk',0,a,config), run=sampleAction('run',0,a,config);
 assert.deepEqual(walk.angles.R,{hip:20,knee:15,shoulder:-15,elbow:0});
 assert.deepEqual(run.angles.L,{hip:45,knee:70,shoulder:-35,elbow:80});
 assert.deepEqual(run.angles.R,{hip:-25,knee:70,shoulder:45,elbow:95});
 assert.deepEqual(sampleAction('run',.5,a,config).angles.R,run.angles.L);
 assert.deepEqual([0,.25,.5,.75,1].map(t=>sampleAction('thinking',t,a,config).noseWidth),[9,13,17,13,9]);
 assert.equal(sampleAction('wave',.25,a,config).angles.wrist,15);
 assert.equal(sampleAction('wave',.75,a,config).angles.wrist,-15);
 for(const name of config.design.actions.names){
  const first=sampleAction(name,0,a,config),last=sampleAction(name,1,a,config);
  assert.deepEqual(first,last);
  for(let i=0;i<=60;i++)for(const q of Object.values(sampleAction(name,i/60,a,config).rotations))assert.ok(Math.abs(q.length()-1)<1e-12);
 }
 assert.equal(actionDuration('run',a,config),.8);
});

test('真实批准绑定：运动保留静止坐标/权重/几何，腿底逐顶点接地且零动作恢复',()=>{
 const copy=clone(rigRoot);const snapshot=JSON.stringify(copy.toJSON());
 const bones=[];copy.traverse(n=>{if(n.isBone)bones.push(n);});
 const rest=bones.map(b=>({p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
 const skin=getMeshes(copy).filter(m=>m.isSkinnedMesh);
 const hashes=skin.map(m=>[attrHash(m.geometry.attributes.position),attrHash(m.geometry.attributes.skinWeight),attrHash(m.geometry.attributes.skinIndex),JSON.stringify(m.skeleton.boneInverses)]);
 const reset=()=>{copy.position.set(0,0,0);bones.forEach((b,i)=>{b.position.copy(rest[i].p);b.quaternion.copy(rest[i].q);b.scale.copy(rest[i].s);});copy.updateMatrixWorld(true);};
 for(const name of ['walk','run','sit'])for(let i=0;i<=24;i++){
  reset();applyAction(copy,sampleAction(name,i/24,defaults(),config),config);
  const min=minimumSkinnedY(skin.filter(m=>/^Leg/.test(m.name)));
  assert.ok(Math.abs(min)<1e-8,`${name} ground ${i}: ${min}`);
  bones.forEach((b,j)=>{assert.deepEqual(b.position,rest[j].p);assert.deepEqual(b.scale,rest[j].s);});
 }
 assert.deepEqual(skin.map(m=>[attrHash(m.geometry.attributes.position),attrHash(m.geometry.attributes.skinWeight),attrHash(m.geometry.attributes.skinIndex),JSON.stringify(m.skeleton.boneInverses)]),hashes);
 reset();applyAction(copy,sampleAction('none',0,defaults(),config),config);assert.equal(JSON.stringify(copy.toJSON()),snapshot);
});

test('思考鼻伸缩保留圆端曲率、高度/中心，并精确恢复批准顶点',()=>{
 const root=clone(rigRoot);const head=root.getObjectByName('Head').parent;
 const rig=createFaceRig(head,config);const nose=root.getObjectByName('Nose');
 const original=nose.geometry.attributes.position.array.slice();
 const bounds=new THREE.Box3().setFromBufferAttribute(nose.geometry.attributes.position);const w=bounds.max.x-bounds.min.x,h=bounds.max.y-bounds.min.y;const cx=(bounds.max.x+bounds.min.x)/2;
 for(const width of [9,13,17]){
  rig.apply(config.design.defaults.eyes,config.design.defaults.nose,config.design.motion.defaults,0,config.design.expression.defaults,width);
  const next=new THREE.Box3().setFromBufferAttribute(nose.geometry.attributes.position);
  assert.ok(Math.abs(next.max.x-next.min.x-width)<3e-6);
  assert.equal(next.max.y,bounds.max.y);assert.equal(next.min.y,bounds.min.y);
  assert.ok(Math.abs((next.max.x+next.min.x)/2-cx)<1e-6);
  const values=nose.geometry.attributes.position.array;
  for(let i=0;i<values.length;i+=3){
    assert.ok(Number.isFinite(values[i+2]));
    if(Math.abs(original[i]-cx)>=(w-h)/2)assert.ok(Math.abs((values[i]-original[i])-Math.sign(original[i]-cx)*(width-w)/2)<2e-6);
  }
 }
 rig.reset();assert.deepEqual(nose.geometry.attributes.position.array,original);
});

test('切换过渡端点和中点连续，不改变目标静止骨骼数据',()=>{
 const root=clone(rigRoot);const before=captureActionPose(root,null);
 applyAction(root,sampleAction('wave',.25,defaults(),config),config);
 const after=captureActionPose(root,17);
 blendActionPose(root,before,0,17,9);assert.deepEqual(captureActionPose(root).rotations,before.rotations);
 root.traverse(n=>{if(n.isBone)n.quaternion.copy(after.rotations[n.name]);});
 const nose=blendActionPose(root,before,.5,17,9);assert.equal(nose,13);
 root.traverse(n=>{if(n.isBone)n.quaternion.copy(after.rotations[n.name]);});
 blendActionPose(root,before,1,17,9);
 for(const [name,q] of Object.entries(after.rotations))assert.ok(root.getObjectByName(name).quaternion.angleTo(q)<1e-7);
});

test('批准原件、rig-v1 文件与绑定实现保持哈希锁定',async()=>{
 const parameters=JSON.parse(await readFile(new URL('../assets/design/rig-v1/parameters.json',import.meta.url)));
 assert.deepEqual(config.design.binding, {...parameters.binding, approval:'approved'});
 const record=JSON.parse(await readFile(new URL('../docs/approvals/rig-v1-approved.json',import.meta.url)));
 for(const entry of record.lockedFileSnapshot){assert.equal(hash(await readFile(historicalURL(entry.path))),entry.sha256,entry.path);}
});

test('五个真实 GLB 动作片段可回读播放，绑定数量/参数/循环端点保留',async()=>{
 globalThis.FileReader=class{async readAsArrayBuffer(blob){this.result=await blob.arrayBuffer();this.onloadend?.();} async readAsDataURL(blob){this.result=`data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;this.onloadend?.();}};
 const original=JSON.stringify(rigRoot.toJSON());
 const {root,clips}=bakeActionClips(rigRoot,defaults(),config);
 const bytes=await exportModel(root,clips);
 const loaded=await new GLTFLoader().parseAsync(bytes,'');
 const motionMetadata=loaded.scene.getObjectByName('XiaoBai_DesignDraft').userData;
 assert.equal(motionMetadata.motionApproval,'approved');
 assert.equal(motionMetadata.motionBaselineApproval,'approved');
 assert.equal(motionMetadata.motionApprovalFile,config.design.actions.approvalFile);
 assert.equal(motionMetadata.motionApprovalScope,'motion-definitions-and-parameters-only');
 assert.equal(loaded.animations.length,5);
 assert.deepEqual(loaded.animations.map(c=>Math.round(c.duration*100)/100),[1.2,.8,2,4,1]);
 assert.equal(getMeshes(loaded.scene).filter(m=>m.isSkinnedMesh).length,4);
 const bones=[];loaded.scene.traverse(n=>{if(n.isBone)bones.push(n);});assert.equal(bones.length,20);
 for(const clip of loaded.animations){
  assert.equal(clip.tracks.length,22);
  for(const track of clip.tracks){assert.ok([...track.values].every(Number.isFinite));const stride=track.getValueSize();const first=track.values.slice(0,stride),last=track.values.slice(-stride);for(let i=0;i<stride;i++)assert.ok(Math.abs(first[i]-last[i])<1e-5);}
  const mixer=new THREE.AnimationMixer(loaded.scene);mixer.clipAction(clip).play();mixer.setTime(clip.duration*.25);loaded.scene.updateMatrixWorld(true);
  if(clip.name.includes('thinking'))assert.ok(loaded.scene.getObjectByName('Nose').morphTargetInfluences.some(x=>x>0));
  mixer.stopAllAction();
 }
 assert.equal(JSON.stringify(rigRoot.toJSON()),original);
 await writeFile(await temporaryOutput('qa/actions-v1-test-export.glb'),Buffer.from(bytes));
 await writeFile(await temporaryOutput('qa/actions-v1-export-check.json'),JSON.stringify({status:'passed',bytes:bytes.byteLength,sha256:hash(new Uint8Array(bytes)),clips:loaded.animations.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.length})),bones:20,skins:4,sourceUnchanged:true},null,2));
});
