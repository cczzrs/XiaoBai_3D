/** Approval describes motion definitions and parameters, not edits to the model copy. */
export function describeActionApproval(actions, config) {
  const baseline = config.design.actions;
  const matches = actions.waveSide === baseline.waveSide && baseline.parameters.every(({ path }) => {
    const [group, key] = path.split('.');
    return actions.parameters[group][key] === baseline.defaults[group][key];
  });
  return {
    motionVersion: baseline.version,
    motionApproval: matches ? baseline.approval : 'modified-design-copy',
    motionBaselineApproval: baseline.approval,
    motionApprovalFile: baseline.approvalFile,
    motionApprovalScope: 'motion-definitions-and-parameters-only',
  };
}
