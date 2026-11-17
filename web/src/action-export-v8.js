import { bakeActionClips as bakePreviousClips } from './action-export-v7.js';

/** Separate v8 objects keep one shared hierarchy and the existing action definitions. */
export function bakeActionClips(source, actions, config) {
  const result = bakePreviousClips(source, actions, config);
  let separatedBinding = false;
  result.root.traverse(node => { if (node.isSkinnedMesh && node.userData.bindingVersion === config.design.bindingV8.version) separatedBinding = true; });
  if (separatedBinding) result.root.userData = {
    ...result.root.userData, rigType: config.design.bindingV8.version,
    rigApproval: 'pending', rigApprovalFile: null, deformationApproval: 'pending',
    rigBaselineApprovalFile: config.design.actions.bindingApproval,
    description: 'Front-back symmetric independent legs preserve the accepted feet. The paired body design and spatial binding remain pending review.',
  };
  return result;
}
