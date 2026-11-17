import { bakeActionClips as bakePreviousClips } from './action-export-v6.js';

/** Separate v7 objects keep one shared hierarchy and the existing action definitions. */
export function bakeActionClips(source, actions, config) {
  const result = bakePreviousClips(source, actions, config);
  let separatedBinding = false;
  result.root.traverse(node => { if (node.isSkinnedMesh && node.userData.bindingVersion === config.design.bindingV7.version) separatedBinding = true; });
  if (separatedBinding) result.root.userData = {
    ...result.root.userData, rigType: config.design.bindingV7.version,
    rigApproval: 'pending', rigApprovalFile: null, deformationApproval: 'pending',
    rigBaselineApprovalFile: config.design.actions.bindingApproval,
    description: 'Separate left leg, right leg and body design meshes preserve the reviewed v6 visible surface. Their component structure and shared spatial binding remain pending review.',
  };
  return result;
}
