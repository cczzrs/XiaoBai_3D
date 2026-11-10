/** Resolve an explicit saved part id; older ids never fall back to the current model. */
export function getBuiltinPartAsset(config, slot, part) {
  if (!['arms', 'legs'].includes(slot) || part?.kind !== 'builtin') return null;
  const { builtin, versions = {} } = config.assets[slot];
  return [builtin, ...Object.values(versions)].find((asset) => asset?.projectRecord.id === part.id) ?? null;
}
