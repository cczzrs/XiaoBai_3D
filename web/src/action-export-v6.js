import { bakeActionClips as bakeBaselineClips } from './action-export.js';

/** Reuse the immutable v1 action definitions with the new design binding. */
export function bakeActionClips(source, actions, config) {
  const result = bakeBaselineClips(source, actions, config);
  let fusedBinding = false;
  result.root.traverse(node => { if (node.isSkinnedMesh && node.userData.bindingVersion === config.design.bindingV6.version) fusedBinding = true; });
  if (fusedBinding) result.root.userData = {
    ...result.root.userData, rigType: config.design.bindingV6.version,
    rigApproval: 'pending', rigApprovalFile: null, deformationApproval: 'pending',
    rigBaselineApprovalFile: config.design.actions.bindingApproval,
    description: 'Approved v6 neutral shape with new design-only binding; action parameters reuse the approved definitions, while v6 deformations remain pending review.',
  };
  return result;
}
