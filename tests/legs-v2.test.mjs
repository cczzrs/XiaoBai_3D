import { readFile, writeFile } from 'node:fs/promises';
import { temporaryOutput } from '../scripts/project-paths.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function glb(bytes) {
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  const binary = bytes.subarray(28 + length);
  const width = { SCALAR: 1, VEC3: 3, VEC2: 2, VEC4: 4 };
  const format = { 5126: ['readFloatLE', 4], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4] };
  const accessor = id => {
    const a = json.accessors[id], v = json.bufferViews[a.bufferView], [read, bytes] = format[a.componentType];
    const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), size = width[a.type], stride = v.byteStride ?? bytes * size;
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: size }, (_, j) => binary[read](start + i * stride + j * bytes)));
  };
  return { json, meshes: json.nodes.filter(n => n.mesh !== undefined).map(n => {
    const p = json.meshes[n.mesh].primitives[0];
    return { name: n.name, scale: n.scale ?? [1, 1, 1], translation: n.translation ?? [0, 0, 0], rotation: n.rotation ?? [0, 0, 0, 1], extras: n.extras, p: accessor(p.attributes.POSITION), n: accessor(p.attributes.NORMAL), ids: accessor(p.indices).flat() };
  }) };
}
const add = (a,b) => a.map((v,i)=>v+b[i]);
const sub = (a,b) => a.map((v,i)=>v-b[i]);
const mul = (a,s) => a.map(v=>v*s);
const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm = a => Math.hypot(...a);
const unit = a => mul(a,1/norm(a));
const angle = (a,b) => Math.acos(Math.max(-1,Math.min(1,dot(unit(a),unit(b)))))*180/Math.PI;
function intersections(body) {
  const cell = 2.5, cells = new Map();
  for (let j=0;j<body.ids.length;j+=3) {
    const ids=body.ids.slice(j,j+3), p=ids.map(i=>body.p[i]);
    const a=sub(p[1],p[0]),b=sub(p[2],p[0]); const den=a[0]*b[2]-a[2]*b[0];
    if(Math.abs(den)<1e-12)continue;
    const t={ids,p,a,b,den};
    for(let x=Math.floor(Math.min(...p.map(p=>p[0]))/cell);x<=Math.floor(Math.max(...p.map(p=>p[0]))/cell);x++)
      for(let z=Math.floor(Math.min(...p.map(p=>p[2]))/cell);z<=Math.floor(Math.max(...p.map(p=>p[2]))/cell);z++){
        const k=x+','+z;if(!cells.has(k))cells.set(k,[]);cells.get(k).push(t);
      }
  }
  return p => {
    let best=null;
    for(const t of cells.get(Math.floor(p[0]/cell)+','+Math.floor(p[2]/cell))??[]){
      const dx=p[0]-t.p[0][0], dz=p[2]-t.p[0][2];
      const u=(dx*t.b[2]-dz*t.b[0])/t.den,v=(t.a[0]*dz-t.a[2]*dx)/t.den,w=1-u-v;
      if(Math.min(u,v,w)<-1e-7)continue;
      const y=w*t.p[0][1]+u*t.p[1][1]+v*t.p[2][1];
      if(best&&y>=best.y)continue;
      const n=unit(add(add(mul(body.n[t.ids[0]],w),mul(body.n[t.ids[1]],u)),mul(body.n[t.ids[2]],v)));
      best={y,n};
    }
    return best;
  };
}
const [body, v1, v2] = await Promise.all(['assets/approved/body-v7/xiaobai-torso.glb','assets/design/legs-v1/legs.glb','assets/design/legs-v2/legs.glb'].map(async p=>glb(await readFile(root+p))));
const metadata=JSON.parse(await readFile(root+'assets/design/legs-v2/contact-audit.json','utf8'));
const settings=JSON.parse(await readFile(root+'assets/design/legs-v2/parameters.json','utf8'));
const leg=v2.meshes.find(m=>m.scale[0]>0), prior=v1.meshes.find(m=>m.scale[0]>0), lower=intersections(body.meshes[0]);
const count=160, {firstBlendVertex:start,contactVertex:contact,capVertex:cap}=metadata;
let volume=0,minArea=Infinity,normalOpposed=0,visibleNormalOpposed=0,nonfinite=0,minNormal=Infinity,maxNormal=0;
const edges=new Map(); const opposedGroups={rim:0,buriedRing:0,cap:0,other:0}; const opposedExamples=[];
for(const p of [...leg.p,...leg.n])if(!p.every(Number.isFinite))nonfinite++;
for(const n of leg.n){minNormal=Math.min(minNormal,norm(n));maxNormal=Math.max(maxNormal,norm(n));}
for(let j=0;j<leg.ids.length;j+=3){
  const ids=leg.ids.slice(j,j+3),p=ids.map(i=>leg.p[i]), normal=cross(sub(p[1],p[0]),sub(p[2],p[0]));
  volume+=dot(p[0],cross(p[1],p[2]))/6;minArea=Math.min(minArea,norm(normal)/2);
  for(const id of ids)if(dot(normal,leg.n[id])<=0){normalOpposed++;if(Math.max(...ids)<contact+count)visibleNormalOpposed++; const group=id>=contact&&id<contact+count?"rim":id>=contact+count&&id<cap?"buriedRing":id===cap?"cap":"other";opposedGroups[group]++;if(opposedExamples.length<12)opposedExamples.push({triangle:j/3,vertex:id,group});}
  for(let k=0;k<3;k++){const a=ids[k],b=ids[(k+1)%3],key=Math.min(a,b)+':'+Math.max(a,b);const edge=edges.get(key)??[0,0];edge[0]++;edge[1]+=a<b?1:-1;edges.set(key,edge);}
}
let lowerMismatch=0,mirrorMismatch=0,contactError=0,contactNormalAngle=0,endTangentAngle=0,hiddenMinDepth=Infinity;
const mirror=v2.meshes.find(m=>m.scale[0]<0);
for(let i=0;i<start+count;i++)if(leg.p[i].some((v,j)=>v!==prior.p[i][j]))lowerMismatch++;
for(let i=0;i<leg.p.length;i++)if(leg.p[i].some((v,j)=>v!==mirror.p[i][j]))mirrorMismatch++;
for(let k=0;k<count;k++){
  const p=leg.p[contact+k],hit=lower(p);contactError=Math.max(contactError,Math.abs(p[1]-hit.y));contactNormalAngle=Math.max(contactNormalAngle,angle(leg.n[contact+k],hit.n));
  const tangent=sub(p,leg.p[contact-count+k]);endTangentAngle=Math.max(endTangentAngle,Math.abs(90-angle(tangent,hit.n)));
  const hidden=leg.p[contact+count+k],h=lower(hidden);hiddenMinDepth=Math.min(hiddenMinDepth,hidden[1]-h.y);
}
const bands={}; const samples={vertices:0,midpoints:0,centroids:0};let noHit=0,minClear=Infinity,worst=null,penetrations=0,nearContactMaxFaceAngle=0;
function check(p,kind,triangle,band){samples[kind]++;const h=lower(p);if(!h){noHit++;return;}const clearance=h.y-p[1]; const b=bands[band]??{band,t:band/settings.hipBlend.rings,minClearance:Infinity,count:0,penetrations:0};b.minClearance=Math.min(b.minClearance,clearance);b.count++;if(clearance < -1e-5)b.penetrations++;bands[band]=b;if(clearance<minClear){minClear=clearance;worst={p,triangle,clearance,kind};}if(clearance < -1e-5)penetrations++;}
for(let i=start;i<contact+count;i++)check(leg.p[i],'vertices',i,Math.floor((i-start)/count));
for(let j=0;j<leg.ids.length;j+=3){const ids=leg.ids.slice(j,j+3);if(Math.min(...ids)<start||Math.max(...ids)>=contact+count)continue;const p=ids.map(i=>leg.p[i]);
  const center=mul(add(add(...p.slice(0,2)),p[2]),1/3);check(center,'centroids',j/3,Math.floor((Math.min(...ids)-start)/count));
  for(let k=0;k<3;k++)check(mul(add(p[k],p[(k+1)%3]),.5),'midpoints',j/3,Math.floor((Math.min(...ids)-start)/count));
  if(Math.max(...ids)>=contact){const h=lower(center);if(h)nearContactMaxFaceAngle=Math.max(nearContactMaxFaceAngle,angle(cross(sub(p[1],p[0]),sub(p[2],p[0])),h.n));}
}
const snapshot={
  "schema": "xiaobai.pre-leg-smoothing-snapshot.v1",
  "date": "2026-11-09",
  "timezone": "America/Los_Angeles",
  "root": "/Users/cong/Desktop/VSCode/CODEX/XiaoBai_3D",
  "files": [
    {
      "path": "assets/approved/.DS_Store",
      "sizeBytes": 8196,
      "sha256": "46d31c97d8d14a5814ed68c45b78c601f0a9058019bfc66b8eefea8d99219bff"
    },
    {
      "path": "assets/approved/body-v7/APPROVAL.json",
      "sizeBytes": 7086,
      "sha256": "7c1f4146bcaaa2ea411527bd4a3d8745eedd298f16f8e7d9405e5ba6934aea30"
    },
    {
      "path": "assets/approved/body-v7/xiaobai-torso.glb",
      "sizeBytes": 1322824,
      "sha256": "9a7b08fa9a629f857d26d2fc8c094b95f53e8fbe2c8cf56a4c0ac7e2c529a5b4"
    },
    {
      "path": "assets/approved/head-v1/APPROVAL.json",
      "sizeBytes": 2140,
      "sha256": "ab29e766d9bb084108a6412c52e40e1197e7ff0070c086de909a845f4f001722"
    },
    {
      "path": "assets/approved/head-v1/xiaobai-head.glb",
      "sizeBytes": 4227680,
      "sha256": "2fc19d89fc33f57f46ac7fe716f3ae04e1b8a243b502c0cdf625f60ac4648351"
    },
    {
      "path": "assets/design/arms-v59/SOURCE-APPROVAL.md",
      "sizeBytes": 536,
      "sha256": "0194a9b6c01fc4be6c92edaf6da7416caaa9385bf8e0f97ba5c5cef909770146"
    },
    {
      "path": "assets/design/arms-v59/display-lines.json",
      "sizeBytes": 15318752,
      "sha256": "92bc26b0692742e7c1dacc9baf34e485ca0267c8ee98bce6106b286d5f29717e"
    },
    {
      "path": "assets/design/arms-v59/left-arm.glb",
      "sizeBytes": 3326332,
      "sha256": "c6d26f71133dfddabfd9128e068e229be6b65c001e9a66ff914532b32e5067ee"
    },
    {
      "path": "assets/design/arms-v59/provenance.json",
      "sizeBytes": 1024,
      "sha256": "0421681cccd824e24c60261a1811db3d6decd8c505595f9c1e7c364b6a9c6eeb"
    },
    {
      "path": "assets/design/legs-v1/legs.glb",
      "sizeBytes": 2064676,
      "sha256": "5cb41ba4291cb37e2bdd874ee0ae99be505f8341746194b3915b30e042242cb6"
    },
    {
      "path": "assets/design/legs-v1/parameters.json",
      "sizeBytes": 1774,
      "sha256": "33779619678f37e1304f5744a287b4a7f4b955a24bd6e20376bcaa28580a6d10"
    },
    {
      "path": "assets/design/legs-v1/provenance.json",
      "sizeBytes": 1532,
      "sha256": "c8ace58522f0cab4e432a901d02c1deeb097023df972d4e13c485e8d9301cf17"
    },
    {
      "path": "assets/design/legs-v1/sections.json",
      "sizeBytes": 19323,
      "sha256": "ad889a4d9d7d18fae088a3aad1bdd0ce70b0167c3b831b84f2d81ac26d7167d0"
    },
    {
      "path": "assets/design/legs-v1/source-fit.json",
      "sizeBytes": 66391,
      "sha256": "68d4726aad73d433d98bc2d658b62e722307003453bcd0782b59bc987c89ca25"
    }
  ]
};
const locks=[];
for(const f of snapshot.files){const bytes=await readFile(root+f.path);locks.push({...f,unchanged:bytes.length===f.sizeBytes&&hash(bytes)===f.sha256});}
const result={opposedGroups,opposedExamples,bands:Object.values(bands),independent:true,source:'Direct decoded final GLB accessors; no imports from new geometry generator',topology:{vertices:leg.p.length,triangles:leg.ids.length/3,edges:edges.size,euler:leg.p.length-edges.size+leg.ids.length/3,nonmanifoldEdges:[...edges.values()].filter(x=>x[0]!==2).length,inconsistentEdgeWinding:[...edges.values()].filter(x=>x[1]!==0).length,minTriangleArea:minArea,signedVolume:volume,nonfinite,minNormalLength:minNormal,maxNormalLength:maxNormal,normalOpposed,visibleNormalOpposed},preservation:{retainedVertexCount:start+count,lowerMismatch,mirrorMismatch},contact:{maxRimError:contactError,maxRimNormalAngleDegrees:contactNormalAngle,maxEndTangentAngleDegrees:endTangentAngle,maxLastBandFaceNormalAngleDegrees:nearContactMaxFaceAngle,hiddenMinVerticalDepth:hiddenMinDepth},clearance:{samples,noHit,minClearance:minClear,penetrationsBelowMinus1e5:penetrations,worst},locks};
const checks = {
  finiteManifoldOutward: nonfinite === 0 && result.topology.euler === 2 && result.topology.nonmanifoldEdges === 0 && result.topology.inconsistentEdgeWinding === 0 && minArea > 1e-10 && volume > 0,
  visibleNormalsConsistent: visibleNormalOpposed === 0 && minNormal > 0.9999 && maxNormal < 1.0001,
  lowerVerticesUnchanged: lowerMismatch === 0 && Math.abs(metadata.startY - 13.447979714854908) < 1e-7,
  mirroredCoordinates: mirrorMismatch === 0 && v2.meshes.length === 2,
  contactPositionAndTangency: contactError < 1e-5 && contactNormalAngle < 0.001 && endTangentAngle < 2 && nearContactMaxFaceAngle < 3,
  buriedCapInsideBody: hiddenMinDepth > 0.1,
  nonRimPatchSamplesOutsideBody: Object.values(bands).filter(band => band.t < 0.95).every(band => band.minClearance >= -1e-5),
  finalRimChordOverlapBelow002: Object.values(bands).filter(band => band.t >= 0.95).every(band => band.minClearance >= -0.02),
  opposedNormalsOnlyAtHiddenRim: opposedGroups.other === 0 && opposedGroups.buriedRing === 0 && opposedGroups.cap === 0,
  lockedAssetsAndV1Unchanged: locks.every(record => record.unchanged),
};
await writeFile(await temporaryOutput('qa/legs-v2-geometry-check.json'), JSON.stringify({ ...result, checks, passed: Object.values(checks).every(Boolean), limitations: ['Sampling vertices, edge midpoints and face centroids does not establish an exact global intersection proof.', 'Hidden-cap normals are reported separately; the visible collar is required to have outward normals.', 'This is a separate overlapping leg/body assembly, not a welded single surface. Only the terminal t>=0.95 rim band permits <=0.02 model-unit chord overlap (the full character is about 100 units tall) on the unchanged body triangulation; earlier collar samples retain the strict 1e-5 tolerance. Exact maximum overlap and affected bands remain reported.'] }, null, 2) + '\n');

test('legs-v2 最终 GLB 为有限、闭合流形且绕序朝外的非退化三角面', () => {
  assert.equal(checks.finiteManifoldOutward, true, JSON.stringify(result.topology));
  assert.equal(checks.visibleNormalsConsistent, true, JSON.stringify(result.topology));
});

test('保留 y≤13.4479797 的全部 14561 原始顶点，实际双腿逐点镜像', () => {
  assert.equal(result.preservation.retainedVertexCount, 14561);
  assert.equal(checks.lowerVerticesUnchanged, true, JSON.stringify(result.preservation));
  assert.equal(checks.mirroredCoordinates, true);
  assert.deepEqual(leg.scale, [1, 1, 1]);
  assert.deepEqual(mirror.scale, [-1, 1, 1]);
  assert.deepEqual(leg.translation, [0, 0, 0]);
  assert.deepEqual(mirror.translation, [0, 0, 0]);
  assert.deepEqual(leg.rotation, [0, 0, 0, 1]);
  assert.deepEqual(mirror.rotation, [0, 0, 0, 1]);
});

test('接缝实点贴合批准身体，法线和末行切线连续，封口埋入身体', () => {
  assert.equal(checks.contactPositionAndTangency, true, JSON.stringify(result.contact));
  assert.equal(checks.buriedCapInsideBody, true, JSON.stringify(result.contact));
});

test('非接缝过渡补片严格在体外；末端接缝三角弦重叠限于 0.02 模型单位', () => {
  assert.equal(checks.nonRimPatchSamplesOutsideBody, true, JSON.stringify(result.bands.filter(band => band.t < 0.95 && band.minClearance < -1e-5)));
  assert.equal(checks.finalRimChordOverlapBelow002, true, JSON.stringify(result.clearance));
  assert.equal(checks.opposedNormalsOnlyAtHiddenRim, true, JSON.stringify(result.opposedGroups));
});

test('已批准头身臂与完整 legs-v1 的 14 个文件大小和 SHA-256 保持不变', () => {
  assert.equal(checks.lockedAssetsAndV1Unchanged, true, JSON.stringify(locks.filter(record => !record.unchanged)));
});
