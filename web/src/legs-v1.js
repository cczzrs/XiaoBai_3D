import { describeObject, disposeObjects, loadApproved } from './model-io.js';
import { getBuiltinPartAsset } from './builtin-parts.js';

export async function loadBuiltinLegs(config, record = config.assets.legs.builtin.projectRecord) {
  const asset = getBuiltinPartAsset(config, 'legs', record);
  if (!asset) throw new Error('未知的内置腿脚版本。');
  const results = await Promise.allSettled([loadApproved(asset.url), asset.companionBody ? loadApproved(asset.companionBody.url) : null]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) {
    disposeObjects(results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value));
    throw failure.reason;
  }
  const root = results[0].value, body = results[1].value;
  const bodyCompanion = body ? { root: body, ...describeObject(body), name: asset.companionBody.label, format: 'glb', warnings: [], designOnly: true, sourceVersion: asset.companionBody.version, builtin: asset.companionBody.projectRecord.id, approved: asset.companionBody.approved } : null;
  return { root, bodyCompanion, ...describeObject(root), name: asset.label, format: 'glb', warnings: [], designOnly: true, sourceVersion: asset.version, builtin: asset.projectRecord.id };
}
