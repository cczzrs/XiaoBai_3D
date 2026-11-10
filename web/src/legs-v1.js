import { describeObject, loadApproved } from './model-io.js';
import { getBuiltinPartAsset } from './builtin-parts.js';

export async function loadBuiltinLegs(config, record = config.assets.legs.builtin.projectRecord) {
  const asset = getBuiltinPartAsset(config, 'legs', record);
  if (!asset) throw new Error('未知的内置腿脚版本。');
  const root = await loadApproved(asset.url);
  return { root, ...describeObject(root), name: asset.label, format: 'glb', warnings: [], designOnly: true, sourceVersion: asset.version, builtin: asset.projectRecord.id };
}
