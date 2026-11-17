// The fused surface no longer has separate leg meshes or v2 collar indices.
// Evaluate a C2 partition in model space so resampling the surface cannot move
// its attachment. Feet move rigidly with their ankle chains. A broad body/ankle
// transition avoids folding the short, thick legs at the legacy ankle level;
// the centre strip blends both chains continuously instead of pinning a ridge.
const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t ** 3 * (10 + t * (-15 + 6 * t));
};

export function validateFusedLegWeights(settings) {
  const keys = ['bodyFreeY', 'bodyFullY', 'centerHalfWidth', 'kneeContribution'];
  if (!settings || !keys.every(key => Number.isFinite(settings[key]))) throw new Error('缺少联合身体与腿的空间蒙皮配置。');
  if (settings.bodyFullY <= settings.bodyFreeY || settings.centerHalfWidth <= 0 || settings.kneeContribution < 0 || settings.kneeContribution > 1) throw new Error('联合身体与腿的蒙皮过渡范围无效。');
}

export function fusedLegWeights(point, settings) {
  const torso = smooth((point.y - settings.bodyFreeY) / (settings.bodyFullY - settings.bodyFreeY));
  const lateral = smooth(Math.abs(point.x) / settings.centerHalfWidth);
  const right = smooth((point.x + settings.centerHalfWidth) / (2 * settings.centerHalfWidth));
  // Small direct knee support helps the upper leg follow flexion; it vanishes
  // with two derivatives at the rigid foot, upper torso and central side switch.
  const knee = settings.kneeContribution * 4 * torso * (1 - torso) * lateral;
  return [torso, (1 - torso) * (1 - knee) * (1 - right), (1 - torso) * (1 - knee) * right, (1 - torso) * knee];
}
