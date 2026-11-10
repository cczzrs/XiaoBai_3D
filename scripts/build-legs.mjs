import { registerHooks } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../web/src/config.js';

const hook = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === 'three' ? new URL('../web/vendor/three.module.js', import.meta.url).href : specifier, context);
} });
globalThis.FileReader = class { async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); } };
const { createLegsDraft, sampleLegSections } = await import('../web/src/leg-geometry.js');
const { exportModel, describeObject, disposeObjects } = await import('../web/src/model-io.js');
const root = createLegsDraft(APP_CONFIG);
const info = describeObject(root);
const output = new URL('../temp/generated/legs-v1/', import.meta.url);
await mkdir(output, { recursive: true });
const sourceFit = await readFile(new URL('../assets/design/legs-v1/source-fit.json', import.meta.url));
await writeFile(new URL('source-fit.json', output), sourceFit);
const glb = new Uint8Array(await exportModel(root));
await writeFile(new URL('legs.glb', output), glb);
await writeFile(new URL('parameters.json', output), JSON.stringify(APP_CONFIG.design.legs, null, 2) + '\n');
const fitPath = '/Users/cong/Documents/Codex/2026-09-14/hatch-pet-users-cong-codex-skills/outputs/xiaobai-body-review/analysis/leg-fit.json';
const hash = (value) => createHash('sha256').update(value).digest('hex');
await writeFile(new URL('provenance.json', output), JSON.stringify({
  version: 'legs-v1', approval: 'pending', designOnly: true,
  referenceFit: { path: fitPath, localCopy: 'source-fit.json', sha256: hash(sourceFit), role: 'Historical unapproved continuous silhouette fit; used as design input only' },
  references: ['assets/references/reference-approved.png', 'assets/references/01-standard-views.png', 'assets/references/01-turnaround.png'],
  coordinates: '+Y up, +Z front, floor y=0, original H100 units', mirror: 'X=0',
  method: 'Single cubic profile per leg, elliptical cross sections, average surface arc-length ring sampling, indexed triangles; no ankle stitch',
  targets: APP_CONFIG.design.legs.targetFoot,
  geometry: info, sha256: hash(glb), bytes: glb.length,
  limitations: ['Depth and hidden upper leg remain design estimates.', 'Legs are pending visual approval; no new rig or animation.', 'Approved head, body and v59 arms are not modified.'],
}, null, 2) + '\n');
await writeFile(new URL('sections.json', output), JSON.stringify(sampleLegSections(APP_CONFIG.design.legs)) + '\n');
disposeObjects([root]); hook.deregister();
console.log(JSON.stringify({ output: output.pathname, ...info, sha256: hash(glb) }));
