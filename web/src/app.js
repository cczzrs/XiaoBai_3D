import { APP_CONFIG as config } from './config.js';
import { createStudio } from './scene.js';
import { createReferences } from './references.js';
import { createDefaultProject, parseProject, serializeProject, encodePart, decodePart } from './project-state.js';
import { encodeImage } from './image-io.js';
import { actionDuration } from './action-motion.js';
import { describeActionApproval } from './action-approval.js';
import { getBuiltinPartAsset } from './builtin-parts.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let project = createDefaultProject();
let studio;
let references;
let mode = config.ui.defaults.mode;
let selectedPart = config.ui.defaults.selectedPart;
let selectedPanel = config.ui.defaults.panel;
let selectedFacePanel = config.ui.defaults.facePanel;
let selectedJoint = config.design.binding.selectedJoint;
let materialTarget = config.ui.defaults.materialTarget;
let skinImportTarget = materialTarget;
let appliedAppearance = structuredClone(project.appearance);
let appearanceTask = Promise.resolve(true);
let appearanceRequest = 0;
const previewSources = new Map();
let busy = false;
let toastTimer;
let pendingCameraFrame;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, config.ui.toastDuration);
}
function dirty() { $('#save-state').textContent = '草稿有未保存修改'; }
function showError(error) { toast(error.message || '操作失败，请重试。'); }
function fusedBodyReview() { return Boolean(getBuiltinPartAsset(config, 'legs', project.parts.legs)?.replacesBodyInDesign); }
function normalizeFusedProject() {
  if (!fusedBodyReview()) return;
  for (const key of ['bodyWidth', 'bodyHeight', 'bodyDepth']) project.design.shape[key] = config.design.defaults.shape[key];
  project.design.pose.bodyLean = config.design.defaults.pose.bodyLean;
  project.motion.preset = config.design.motion.defaults.preset;
  if (project.motion.eyesPreset === 'none' && project.motion.nosePreset === 'none') project.motion.playing = false;
}
function updateFusedControls() {
  const fused = fusedBodyReview();
  $('#fused-shape-note').hidden = !fused;
  for (const id of ['body-width', 'body-height', 'body-depth', 'body-lean', 'motion-preset']) $(`#${id}`).disabled = fused || busy;
  $$('[data-action]').forEach(button => { button.disabled = fused || busy; });
  $('#export-actions').disabled = fused || busy || !studio;
  $('#play-motion').disabled = busy || !studio || (fused && selectedPanel !== 'face');
  $('#design-legs-visible-label').textContent = fused ? '显示身体与腿' : '显示腿脚';
}
function setBusy(value) {
  busy = value;
  $$('[data-needs-model]').forEach((button) => { button.disabled = value || !studio; });
  $('#load-project').disabled = value;
  $('#remove-part').disabled = value;
  $('#save-project').disabled = value;
  $$('[data-appearance-fields]').forEach((fieldset) => { fieldset.disabled = value || !studio; });
  updateFusedControls();
}
function updateStats() {
  if (!studio) return;
  const stats = studio.getStats();
  $('#geometry-stats').textContent = `${stats.meshes} 个网格 · ${Math.round(stats.triangles).toLocaleString()} 个三角形`;
  for (const slot of ['arms', 'legs']) {
    const part = project.parts[slot];
    const builtin = part?.kind === 'builtin';
    const builtinAsset = getBuiltinPartAsset(config, slot, part);
    const approved = builtinAsset?.approved;
    $(`#${slot}-file`).textContent = builtinAsset ? builtinAsset.label : part?.name ?? '等待导入模型';
    $(`#${slot}-badge`).textContent = approved ? '已批准组合' : builtin ? '待确认' : part ? '候选' : '待构建';
    $(`#${slot}-badge`).className = approved ? 'approved-badge' : 'draft-badge';
  }
  const approvedCount = Object.values(stats.parts).filter((part) => part?.approved).length;
  $('#approved-count').textContent = String(approvedCount).padStart(2, '0');
  $$('.progress-track i').forEach((item, i) => item.classList.toggle('is-approved', i < approvedCount));
  $('#body-version').textContent = stats.fusedBody ? `${stats.parts.body.version} · 身体融合副本` : config.assets.body.version;
  $('#body-badge').textContent = stats.fusedBody ? '设计副本' : '已批准';
  $('#body-badge').className = stats.fusedBody ? 'draft-badge' : 'approved-badge';
  $('#v59-state').textContent = project.parts.arms?.kind === 'builtin' ? stats.fusedBody ? 'v59 双臂沿用批准基线，身体使用融合设计副本' : '头部、身体与 v59 双臂组合已批准' : '可将已批准 v59 作为镜像双臂加入设计副本';
  $('#design-arms-visible').checked = $('[data-visible="arms"]').checked;
  const legsAsset = getBuiltinPartAsset(config, 'legs', project.parts.legs);
  $('#legs-state').textContent = legsAsset ? `${legsAsset.version} · ${legsAsset.approved ? '外形已批准 · 绑定在设计副本中进行' : legsAsset.replacesBodyInDesign ? '身体与双腿融合副本 · 脚部保留 · 待确认 · 尚未绑定' : legsAsset.version === 'legs-v4' ? '沿用 v3 脚部 · 膝盖至腿顶连续弧面 · 待确认 · 尚未绑定' : legsAsset.version === 'legs-v3' ? '上一版圆弧副本 · 静态外形待确认 · 尚未绑定' : '外形待你确认'}` : '可查看身体与腿 v6 圆润副本，或加入已批准的 v2';
  $('#design-legs-visible').checked = $('[data-visible="legs"]').checked;
  $('#binding-summary').textContent = `${stats.bones} 个骨骼节点 · ${stats.skinnedMeshes} 个蒙皮网格。${legsAsset?.review ? `当前 ${legsAsset.version} 腿脚为静态形体副本，尚未绑定。原绑定与动作基线保留。` : '绑定 v1 与动作 v1 基线已批准。'}`;
  updateAppearanceControls();
  updateFusedControls();
}

function updateBindingControls() {
  const definition = config.design.binding.joints[selectedJoint];
  const terminal = selectedJoint.includes('Tip');
  $('#binding-joint').value = selectedJoint;
  $('#binding-position').textContent = '中立位置：' + definition.position.map((value, axis) => `${'XYZ'[axis]} ${(value + project.binding.offsets[selectedJoint][axis]).toFixed(1)}`).join(' · ');
  $$('[data-binding]').forEach((input) => {
    const value = project.binding[input.dataset.binding][selectedJoint][Number(input.dataset.axis)];
    input.value = value;
    input.disabled = input.dataset.binding === 'rotations' && terminal;
    $(`#${input.id}-value`).textContent = value.toFixed(input.dataset.binding === 'rotations' ? 0 : 1) + (input.dataset.binding === 'rotations' ? '°' : '');
  });
  $('#binding-joint-note').textContent = terminal ? '末端定位点用于表示骨段方向，由腕或踝带动，不单独驱动表面。' : '拖动转角检查蒙皮，回到中立即恢复批准外形。';
}

function applyBinding() {
  studio?.setBinding(project.binding);
  updateBindingControls();
  dirty();
}
function renderTimeline() {
  $('#timeline').value = project.motion.progress;
  const duration = actionDuration(project.motion.preset, project.actions, config);
  $('#timeline-time').textContent = `${(project.motion.progress * duration).toFixed(2)} / ${duration.toFixed(2)} 秒`;
  $$('.timeline-ticks span').forEach((node, i) => { node.textContent = (duration * i / 4).toFixed(2) + ' s'; });
  $('#play-motion').textContent = project.motion.playing ? 'Ⅱ' : '▶';
  $('#play-motion').setAttribute('aria-label', project.motion.playing ? '暂停动作' : '播放动作');
}
function updateDesignControls() {
  $$('[data-design]').forEach((input) => {
    const [group, key] = input.dataset.design.split('.');
    input.value = project.design[group][key];
    const format = config.ui.parameterFormats.fields[input.dataset.design] ?? config.ui.parameterFormats[group];
    $(`[data-output="${input.dataset.design}"]`).textContent = (project.design[group][key] * (format.multiplier ?? 1)).toFixed(format.digits) + format.suffix;
  });
  $('#motion-preset').value = project.motion.preset;
  $('#motion-speed').value = project.motion.speed;
  $('#motion-amplitude').value = project.motion.amplitude;
  $('#speed-value').textContent = project.motion.speed.toFixed(2) + '×';
  $('#amplitude-value').textContent = project.motion.amplitude.toFixed(1);
  $('#eyes-preset').value = project.motion.eyesPreset;
  $('#nose-preset').value = project.motion.nosePreset;
  $$('[data-expression]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.expression === project.expression.preset));
  $('#expression-intensity').value = project.expression.intensity;
  $('#expression-intensity-value').textContent = Math.round(project.expression.intensity * 100) + '%';
  $('#expression-description').textContent = config.design.expression.presets[project.expression.preset].description;
  $('#face-motion-speed').value = project.motion.speed;
  $('#face-speed-value').textContent = project.motion.speed.toFixed(2) + '×';
  for (const part of ['eye', 'nose']) {
    $(`#${part}-amplitude`).value = project.motion[`${part}Amplitude`];
    $(`#${part}-amplitude-value`).textContent = Math.round(project.motion[`${part}Amplitude`] * 100) + '%';
  }
  const motionLabels = [['preset', '#motion-preset'], ['eyesPreset', '#eyes-preset'], ['nosePreset', '#nose-preset']]
    .filter(([key]) => project.motion[key] !== 'none')
    .map(([, selector]) => $(selector).selectedOptions[0].textContent);
  $('#motion-label').textContent = motionLabels.join(' + ') || $('#motion-preset').selectedOptions[0].textContent;
  updateActionControls();
  renderTimeline();
  updateFusedControls();
}
function selectPart(part) {
  selectedPart = part;
  $$('[data-part]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.part === part));
  const asset = config.assets[part];
  const imported = project.parts[part];
  const builtin = imported?.kind === 'builtin';
  const builtinAsset = getBuiltinPartAsset(config, part, imported);
  const fusedAsset = getBuiltinPartAsset(config, 'legs', project.parts.legs);
  const fusedBody = part === 'body' && mode === 'design' && fusedBodyReview();
  const approved = !fusedBody && (asset.approved || builtinAsset?.approved);
  $('#selected-name').textContent = asset.label;
  $('#selected-version').textContent = fusedBody ? `${fusedAsset.version} · 联合身体副本` : builtinAsset ? builtinAsset.version : asset.version ?? (imported ? '导入候选' : '尚未构建');
  $('#selected-status').textContent = approved ? '已批准 · 基线保留' : builtin || fusedBody ? '设计副本 · 外形待确认' : imported ? '候选 · 待批准' : '等待构建';
  $('#selected-status').className = approved ? 'approved-badge' : 'draft-badge';
  $('#selected-description').textContent = fusedBody ? `当前设计视图使用 ${fusedAsset.version} 身体与双腿融合副本，共用腿脚显示开关；批准 body-v7 原件保留，构建模式仍显示原件。` : part === 'head' ? '保留已批准的头部、眼睛与鼻子，以及原始材质和比例。' : part === 'body' ? '身体 v7 左右、前后对称，主要依据 TIFF 第 1 帧；已批准并锁定。' : builtin && part === 'arms' ? '已批准的 v59 双臂组合，原曲面、显示线、材质及镜像位置保持不变。' : builtin && approved ? '腿脚 v2 外形及衔接已批准并锁定。绑定与动作沿用已批准版本，调整作用于设计副本。' : builtinAsset?.replacesBodyInDesign ? `${builtinAsset.version} 身体与双腿融合设计副本：保留脚部，${builtinAsset.version === 'legs-v6' ? '继续优化身体接缝与脚腕处的明暗过渡' : '身体连接处已融合，可与 v6 对比'}。当前静态外形待确认，尚未绑定；批准身体原件未覆盖。` : builtinAsset?.version === 'legs-v4' ? '腿脚 v4 独立设计副本：脚部沿用已认可的 v3，膝盖至腿顶调整为连续、圆润的弧面过渡。当前外形待确认，尚未绑定。' : builtinAsset?.version === 'legs-v3' ? '腿脚 v3 上一版设计副本：保留已认可的脚部圆弧，腿顶凸圈与折痕待改进。可与 v4 对比，尚未绑定。' : builtin ? '参考正面轮廓及标准侧视图制作的连续腿脚，左右镜像。当前为历史设计副本，尚未批准。' : imported ? `${imported.name} 已加入装配，尚未批准。导入模型沿用文件中的原始坐标和单位。` : `可导入后续${asset.label}模型，与已批准部件装配、叠图核对。`;
  $('#remove-part').hidden = !imported;
  if (part === 'arms' || part === 'legs') $('#import-slot').value = part;
}
function setMode(value) {
  mode = value;
  document.body.dataset.mode = mode;
  $$('[data-mode]').forEach((button) => button.setAttribute('aria-selected', button.dataset.mode === mode));
  $$('[data-mode-section]').forEach((section) => { section.hidden = section.dataset.modeSection !== mode; });
  const designMode = mode === 'design';
  $('#viewport-title').textContent = designMode ? '设计副本 · 形体与动作草稿' : '批准模型 · 装配预览';
  $('#inspector-title').textContent = designMode ? '设计参数' : '构建检查';
  $('#mode-status').textContent = designMode ? '设计模式 · 独立草稿' : '构建模式 · 批准原件';
  if (!designMode) { project.motion.playing = false; studio?.setMotion(project.motion); renderTimeline(); }
  studio?.setMode(mode);
  references?.setMode(mode);
  updateStats();
  selectPart(selectedPart);
}
function setView(value) {
  studio?.setView(value);
  $$('[data-view]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.view === value));
  $('#camera-label').textContent = `${value.toUpperCase()} / ${value === 'perspective' ? '透视' : '正交'}`;
  references?.refresh().catch(showError);
}
function setPanel(panel) {
  selectedPanel = panel;
  $$('[data-panel]').forEach((item) => item.setAttribute('aria-selected', item.dataset.panel === panel));
  $$('[data-design-panel]').forEach((section) => { section.hidden = section.dataset.designPanel !== panel; });
  updateFusedControls();
}
function setFacePanel(panel) {
  selectedFacePanel = panel;
  $$('[data-face-panel]').forEach((item) => item.setAttribute('aria-selected', item.dataset.facePanel === panel));
  $$('[data-face-section]').forEach((section) => { section.hidden = section.dataset.faceSection !== panel; });
}
function hasMotion() { return [project.motion.preset, project.motion.eyesPreset, project.motion.nosePreset].some((preset) => preset !== 'none'); }
function applyMotion() { normalizeFusedProject(); studio?.setMotion(project.motion); updateDesignControls(); dirty(); }
function applyDesign() { normalizeFusedProject(); studio?.setDesign(project.design); updateDesignControls(); dirty(); }
function applyExpression() { studio?.setExpression(project.expression); updateDesignControls(); dirty(); }
function updateImagePreview(kind, record) {
  const img = $(`#${kind}-image-preview`);
  $(`#${kind}-preview`).hidden = !record;
  $(`#${kind}-image-name`).textContent = record ? `${record.name} · ${record.width} × ${record.height}` : kind === 'material' ? '尚未导入皮肤图片' : '尚未导入背景图片';
  if (previewSources.get(kind) !== record?.data) {
    if (record) img.src = `data:${record.mime};base64,${record.data}`;
    else img.removeAttribute('src');
    previewSources.set(kind, record?.data);
  }
}
function updateAppearanceControls() {
  const { materials, background, lighting: light } = project.appearance;
  const material = materials[materialTarget];
  $('#material-target').value = materialTarget;
  $('#material-enabled').checked = material.enabled;
  $('#material-color').value = material.color;
  $('#material-color-value').textContent = material.color.toUpperCase();
  $('#material-roughness').value = material.roughness;
  $('#material-roughness-value').textContent = material.roughness.toFixed(2);
  $('#material-presence').textContent = fusedBodyReview() && materialTarget === 'body' ? '融合副本的身体与腿共用“腿脚皮肤”。此处设置保留给独立身体设计副本。' : fusedBodyReview() && materialTarget === 'legs' ? '当前设置应用于联合身体与双腿设计副本。修改颜色或图片后自动启用自定义材质。' : ['arms', 'legs'].includes(materialTarget) && !project.parts[materialTarget] ? '此部件尚未导入。可先保存外观设置，导入后自动应用。' : '修改颜色或图片后自动启用自定义材质。';
  updateImagePreview('material', material.image);
  $('#remove-skin').disabled = !material.image;
  $('#background-color').value = background.color;
  $('#background-color-value').textContent = background.color.toUpperCase();
  $('#background-fit').value = background.fit;
  $('#background-fit').disabled = !background.image;
  $('#remove-background').disabled = !background.image;
  updateImagePreview('background', background.image);
  for (const key of ['azimuth', 'elevation', 'intensity', 'exposure']) {
    $(`#light-${key}`).value = light[key];
    $(`#light-${key}-value`).textContent = light[key] + (['azimuth', 'elevation'].includes(key) ? '°' : '');
    $(`#light-${key}`).disabled = key !== 'exposure' && !light.enabled;
  }
  $('#light-enabled').checked = light.enabled;
  $('#light-mode').textContent = light.enabled ? '定向柔光 · 补光 · 轮廓光' : '均匀环境光';
}
function changeAppearance(update) {
  const next = structuredClone(project.appearance);
  update(next);
  project.appearance = next;
  updateAppearanceControls(); dirty();
  const request = ++appearanceRequest;
  const operation = studio.setAppearance(next).then(() => {
    if (request === appearanceRequest) appliedAppearance = next;
    return true;
  }).catch((error) => {
    if (request === appearanceRequest) {
      project.appearance = structuredClone(appliedAppearance);
      updateAppearanceControls(); showError(error);
    }
    return false;
  });
  // Failure restores the last valid state; that state can still be saved or exported.
  // Keep the import's success result separate from the shared stability barrier.
  appearanceTask = operation.then(() => true);
  return operation;
}
function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = $('#download-link');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function restoreProject(next) {
  await appearanceTask;
  // Decode all images first; no current model, image or parameter is replaced on failure.
  const prepared = await studio.prepareAppearance(next.appearance);
  let committed = false;
  try {
    await studio.replaceCandidates({ arms: next.parts.arms ? decodePart(next.parts.arms, 'arms') : null, legs: next.parts.legs ? decodePart(next.parts.legs, 'legs') : null });
    studio.commitAppearance(prepared);
    committed = true;
  } finally { if (!committed) prepared.dispose(); }
  project = next;
  normalizeFusedProject();
  appliedAppearance = structuredClone(next.appearance);
  appearanceTask = Promise.resolve(true);
  studio.setDesign(project.design);
  studio.setExpression(project.expression);
  studio.setActions(project.actions);
  studio.setMotion(project.motion, { immediate: true });
  studio.setBinding(project.binding);
  updateBindingControls();
  updateDesignControls();
  updateAppearanceControls();
  updateStats();
  selectPart(selectedPart);
}
async function saveLocal() {
  if (busy) return;
  if (!await appearanceTask) return;
  try {
    localStorage.setItem(config.project.storageKey, serializeProject(project));
    $('#save-state').textContent = '草稿已保存在此浏览器';
    toast('草稿已保存；重新打开页面可恢复。');
  } catch (error) {
    toast(error.name === 'QuotaExceededError' ? '浏览器空间不足，请使用「导出 → 项目 JSON」保存完整草稿。' : `保存失败：${error.message}`);
  }
}

// Initialize all editable defaults and ranges from the config tree.
$('#binding-mirror').checked = config.design.binding.mirrorEdits;
$('#binding-joint').addEventListener('change', (event) => {
  selectedJoint = event.target.value;
  updateBindingControls();
});
$$('[data-binding]').forEach((input) => {
  const group = input.dataset.binding;
  const axis = Number(input.dataset.axis);
  Object.assign(input, config.design.binding.limits[group]);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    project.binding[group][selectedJoint][axis] = value;
    if ($('#binding-mirror').checked) {
      const other = selectedJoint.slice(0, -1) + (selectedJoint.endsWith('L') ? 'R' : 'L');
      const factor = group === 'offsets' ? (axis === 0 ? -1 : 1) : (axis === 0 ? 1 : -1);
      project.binding[group][other][axis] = value * factor;
    }
    applyBinding();
  });
});
$('#binding-neutral').addEventListener('click', () => {
  project.binding.rotations = structuredClone(config.design.binding.defaults.rotations);
  project.design.pose = structuredClone(config.design.defaults.pose);
  project.motion = structuredClone(config.design.motion.defaults);
  studio?.setMotion(project.motion);
  applyDesign(); applyBinding();
});
$('#binding-reset').addEventListener('click', () => {
  project.binding = structuredClone(config.design.binding.defaults);
  applyBinding();
});
$$('[data-design]').forEach((input) => {
  const [group, key] = input.dataset.design.split('.');
  Object.assign(input, config.design.limits[group][key]);
  input.addEventListener('input', () => { project.design[group][key] = Number(input.value); applyDesign(); });
});
Object.assign($('#motion-speed'), config.design.motion.speed);
Object.assign($('#motion-amplitude'), config.design.motion.amplitude);
Object.assign($('#face-motion-speed'), config.design.motion.speed);
Object.assign($('#eye-amplitude'), config.design.motion.eyeAmplitude);
Object.assign($('#nose-amplitude'), config.design.motion.noseAmplitude);
Object.assign($('#expression-intensity'), config.design.expression.intensity);
Object.assign($('#overlay-opacity'), config.ui.overlay, { value: config.ui.defaults.overlay });
$('#overlay-value').textContent = config.ui.defaults.overlay + '%';
Object.assign($('#timeline'), config.design.motion.timeline);
for (const key of ['azimuth', 'elevation', 'intensity', 'exposure']) Object.assign($(`#light-${key}`), config.viewer.lighting.limits[key]);
Object.assign($('#material-roughness'), config.appearance.limits.roughness);
$$('[data-visible]').forEach((input) => {
  input.checked = config.viewer.defaults.visibility[input.dataset.visible];
  input.addEventListener('change', () => { studio?.setVisibility(input.dataset.visible, input.checked); updateStats(); });
});
$$('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#enter-design').addEventListener('click', () => setMode('design'));
$('#use-v59-arms').addEventListener('click', async () => {
  if (!studio || busy) return;
  setBusy(true);
  try {
    const record = structuredClone(config.assets.arms.builtin.projectRecord);
    await studio.importPart(record, 'arms');
    project.parts.arms = record;
    studio.setVisibility('arms', true);
    $$('[data-visible="arms"]').forEach((input) => { input.checked = true; });
    setMode('design'); updateStats(); selectPart('arms'); dirty();
    toast('v59 镜像双臂已加入设计副本，头部和身体原件保持锁定。');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#v59-guides').checked = config.design.armGuides.enabled;
$('#v59-guides').addEventListener('change', (event) => studio?.setArmGuideOptions({ enabled: event.target.checked }));
$$('[data-arm-guide]').forEach((input) => {
  input.checked = config.design.armGuides.groups[input.dataset.armGuide];
  input.addEventListener('change', () => studio?.setArmGuideOptions({ groups: { [input.dataset.armGuide]: input.checked } }));
});
$('#design-arms-visible').checked = config.viewer.defaults.visibility.arms;
$('#design-arms-visible').addEventListener('change', (event) => {
  studio?.setVisibility('arms', event.target.checked);
  $('[data-visible="arms"]').checked = event.target.checked;
  updateStats();
});
for (const [buttonId, versionId] of [['#use-legs-v6', 'body-legs-fair-v6'], ['#use-legs-v5', 'body-legs-fused-v5'], ['#use-legs-v4', 'legs-continuous-v4-mirrored'], ['#use-legs-v3', 'legs-rounded-v3-mirrored']]) $(buttonId).addEventListener('click', async () => {
  if (!studio || busy) return;
  setBusy(true);
  try {
    const asset = config.assets.legs.versions[versionId];
    const record = structuredClone(asset.projectRecord);
    await studio.importPart(record, 'legs');
    project.parts.legs = record;
    project.binding.rotations = structuredClone(config.design.binding.defaults.rotations);
    project.design.pose = structuredClone(config.design.defaults.pose);
    project.motion = structuredClone(config.design.motion.defaults);
    if (asset.replacesBodyInDesign) project.design.shape = structuredClone(config.design.defaults.shape);
    normalizeFusedProject();
    studio.setMotion(project.motion, { immediate: true });
    studio.setDesign(project.design);
    studio.setBinding(project.binding);
    studio.setVisibility('legs', true);
    $('[data-visible="legs"]').checked = true;
    $('#show-skeleton').checked = asset.review.skeleton;
    studio.setSkeleton(asset.review.skeleton);
    setMode('design'); updateDesignControls(); updateBindingControls(); selectPart('legs');
    setView(asset.review.view);
    studio.focusLegs(asset.review.view);
    $('#camera-label').textContent = `LEGS / ${asset.review.view === 'front' ? '正面' : '侧面'}特写`;
    dirty();
    toast(`${asset.version} 已载入中立静态视图，外形待你确认。`);
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#use-legs-v2').addEventListener('click', async () => {
  if (!studio || busy) return;
  setBusy(true);
  try {
    const record = structuredClone(config.assets.legs.builtin.projectRecord);
    await studio.importPart(record, 'legs');
    project.parts.legs = record;
    studio.setVisibility('legs', true);
    $('[data-visible="legs"]').checked = true;
    setMode('design'); updateStats(); selectPart('legs'); dirty();
    toast(`已批准的 ${config.assets.legs.builtin.version} 已加入绑定设计副本。`);
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#design-legs-visible').checked = config.viewer.defaults.visibility.legs;
$('#design-legs-visible').addEventListener('change', (event) => {
  studio?.setVisibility('legs', event.target.checked);
  $('[data-visible="legs"]').checked = event.target.checked;
  updateStats();
});
$$('[data-leg-focus]').forEach((button) => button.addEventListener('click', () => {
  setView(button.dataset.legFocus);
  studio?.focusLegs(button.dataset.legFocus);
  $('#camera-label').textContent = button.dataset.legFocus === 'front' ? 'LEGS / 正面特写' : 'LEGS / 侧面特写';
}));
$$('[data-part]').forEach((button) => button.addEventListener('click', () => selectPart(button.dataset.part)));
$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-panel]').forEach((button) => button.addEventListener('click', () => {
  setPanel(button.dataset.panel);
}));
$$('[data-face-panel]').forEach((button) => button.addEventListener('click', () => setFacePanel(button.dataset.facePanel)));
for (const [id, method, initial] of [['toggle-grid', 'setGrid', config.viewer.defaults.grid], ['toggle-wireframe', 'setWireframe', config.viewer.defaults.wireframe]]) {
  const button = $(`#${id}`);
  button.setAttribute('aria-pressed', initial);
  button.addEventListener('click', () => { const enabled = button.getAttribute('aria-pressed') !== 'true'; button.setAttribute('aria-pressed', enabled); studio?.[method](enabled); });
}
$('#reset-camera').addEventListener('click', () => setView(config.viewer.defaults.view));
$('#focus-face').addEventListener('click', () => {
  setView('front'); studio?.focusFace(); $('#camera-label').textContent = 'FACE / 面部特写';
});
$('#show-all').addEventListener('click', () => {
  $$('[data-visible]').forEach((input) => { input.checked = true; studio.setVisibility(input.dataset.visible, true); }); updateStats();
});
$('#isolate-part').addEventListener('click', () => {
  if (!studio.getStats().parts[selectedPart]) return toast('这个部件尚未导入。');
  $$('[data-visible]').forEach((input) => { input.checked = input.dataset.visible === selectedPart; studio.setVisibility(input.dataset.visible, input.checked); }); updateStats();
});
$('#import-model').addEventListener('click', () => $('#model-file').click());
$('#model-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || busy) return;
  setBusy(true);
  const slot = $('#import-slot').value;
  try {
    const stored = await encodePart(file);
    const result = await studio.importPart(file, slot);
    project.parts[slot] = stored;
    studio.setVisibility(slot, true);
    $(`[data-visible="${slot}"]`).checked = true;
    updateStats(); selectPart(slot); dirty();
    toast(result.warnings.length ? result.warnings.join(' ') : `${config.assets[slot].label}候选已导入，等待外形确认。`);
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#remove-part').addEventListener('click', () => {
  if (busy || !project.parts[selectedPart]) return;
  studio.removePart(selectedPart); project.parts[selectedPart] = null; updateStats(); selectPart(selectedPart); dirty(); toast('候选已从当前装配移除，源文件保留。');
  $('#app-status').textContent = '模型就绪 · 本地运行';
});
$('#reference-select').value = config.ui.defaults.reference;
$('#reference-select').addEventListener('change', async (event) => {
  try { setView('front'); await references?.select(event.target.value); } catch (error) { showError(error); }
});
$('#overlay-opacity').addEventListener('input', (event) => {
  const opacity = Number(event.target.value);
  $('#overlay-value').textContent = opacity + '%';
  if (opacity > 0 && studio && !studio.getCameraState().orthographic) setView('front');
  references?.setOpacity(opacity);
});
$('#show-skeleton').checked = config.viewer.defaults.skeleton;
$('#show-skeleton').addEventListener('change', (event) => studio?.setSkeleton(event.target.checked));
for (const group of ['shape', 'rig']) $(`#reset-${group}`).addEventListener('click', () => { project.design[group] = structuredClone(config.design.defaults[group]); applyDesign(); });
for (const group of ['eyes', 'nose']) $(`#reset-${group}`).addEventListener('click', () => {
  project.design[group] = structuredClone(config.design.defaults[group]);
  if (group === 'eyes') {
    project.expression = structuredClone(config.design.expression.defaults);
    studio?.setExpression(project.expression);
  }
  const amplitudeKey = group === 'eyes' ? 'eyeAmplitude' : 'noseAmplitude';
  project.motion[`${group}Preset`] = config.design.motion.defaults[`${group}Preset`];
  project.motion[amplitudeKey] = config.design.motion.defaults[amplitudeKey];
  if (!hasMotion()) project.motion.playing = false;
  studio?.setMotion(project.motion); applyDesign();
});
$('#reset-pose').addEventListener('click', () => {
  project.design.pose = structuredClone(config.design.defaults.pose);
  for (const [group, keys] of Object.entries(config.design.face.expressionKeys)) {
    for (const key of keys) project.design[group][key] = config.design.defaults[group][key];
  }
  project.motion = structuredClone(config.design.motion.defaults);
  project.expression = structuredClone(config.design.expression.defaults);
  studio?.setExpression(project.expression);
  studio?.setMotion(project.motion); applyDesign();
});
$$('[data-expression]').forEach((button) => button.addEventListener('click', () => {
  project.expression.preset = button.dataset.expression;
  applyExpression();
}));
$('#expression-intensity').addEventListener('input', (event) => {
  project.expression.intensity = Number(event.target.value); applyExpression();
});
$('#reset-expression').addEventListener('click', () => {
  project.expression = structuredClone(config.design.expression.defaults); applyExpression();
});
function updateActionControls() {
  const name = project.motion.preset;
  const approval = describeActionApproval(project.actions, config);
  $('#action-approval-state').textContent = approval.motionApproval === 'approved'
    ? '当前动作参数与已批准默认值一致。'
    : '当前动作参数已调整，保存为独立设计副本。';
  $$('[data-action]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.action === name));
  $$('[data-action-group]').forEach((node) => { node.hidden = ![name, 'transition'].includes(node.dataset.actionGroup); });
  $$('[data-action-param]').forEach((input) => {
    const [group, key] = input.dataset.actionParam.split('.');
    const definition = config.design.actions.parameters.find((entry) => entry.path === input.dataset.actionParam);
    const value = project.actions.parameters[group][key];
    input.value = value;
    $(`[data-action-output="${definition.path}"]`).textContent = `${value.toFixed(definition.step < 1 ? 2 : 0)} ${definition.unit}`;
  });
  $('#action-wave-side').value = project.actions.waveSide;
  const captions = {
    none: '中立姿态 · 保持已批准外形', walk: '原地循环 · 左右相差半周期 · 对侧摆臂',
    run: '原地循环 · 沿用已批准的跑步手臂角度', wave: '单侧招手 · 手腕往复摆动',
    thinking: '鼻宽下限 → 中值 → 上限 → 中值 → 下限', sit: '保持姿态 · 髋与膝屈曲可调',
  };
  $('#action-status').textContent = captions[name] ?? '旧版动作预览';
}
function chooseAction(name) {
  project.motion.preset = name; project.motion.progress = 0;
  if (!hasMotion()) project.motion.playing = false;
  applyMotion();
}
$$('[data-action]').forEach((button) => button.addEventListener('click', () => chooseAction(button.dataset.action)));
$$('[data-action-param]').forEach((input) => {
  const definition = config.design.actions.parameters.find((entry) => entry.path === input.dataset.actionParam);
  Object.assign(input, { min: definition.min, max: definition.max, step: definition.step });
  input.addEventListener('input', () => {
    const next = structuredClone(project.actions);
    const [group, key] = definition.path.split('.');
    next.parameters[group][key] = Number(input.value);
    try { studio?.setActions(next); project.actions = next; updateActionControls(); renderTimeline(); dirty(); }
    catch (error) { showError(error); updateActionControls(); }
  });
});
$('#action-wave-side').addEventListener('change', (event) => {
  project.actions.waveSide = event.target.value; studio?.setActions(project.actions); updateActionControls(); dirty();
});
$('#reset-action-parameters').addEventListener('click', () => {
  const name = project.motion.preset;
  if (config.design.actions.names.includes(name)) project.actions.parameters[name] = structuredClone(config.design.actions.defaults[name]);
  project.actions.parameters.transition = structuredClone(config.design.actions.defaults.transition);
  if (name === 'wave') project.actions.waveSide = config.design.actions.waveSide;
  studio?.setActions(project.actions); updateActionControls(); renderTimeline(); dirty();
});
$('#export-actions').addEventListener('click', async () => {
  if (!studio || busy) return;
  setBusy(true);
  // Paint the busy state before the synchronous keyframe bake.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    if (!await appearanceTask) return;
    const bytes = await studio.exportActionsGLB();
    download(bytes, 'xiaobai-actions-v1.glb', 'model/gltf-binary');
    toast('五个动作片段已导出；可调参数请同时保存项目 JSON。');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});

$('#motion-preset').addEventListener('change', (event) => {
  chooseAction(event.target.value);
});
$('#motion-speed').addEventListener('input', (event) => { project.motion.speed = Number(event.target.value); applyMotion(); });
$('#motion-amplitude').addEventListener('input', (event) => { project.motion.amplitude = Number(event.target.value); applyMotion(); });
$('#face-motion-speed').addEventListener('input', (event) => { project.motion.speed = Number(event.target.value); applyMotion(); });
for (const group of ['eyes', 'nose']) $(`#${group}-preset`).addEventListener('change', (event) => {
  project.motion[`${group}Preset`] = event.target.value;
  project.motion.progress = 0;
  if (!hasMotion()) project.motion.playing = false;
  applyMotion();
});
for (const group of ['eye', 'nose']) $(`#${group}-amplitude`).addEventListener('input', (event) => {
  project.motion[`${group}Amplitude`] = Number(event.target.value); applyMotion();
});
$('#play-motion').addEventListener('click', () => {
  if (!hasMotion()) {
    if (selectedPanel === 'face') {
      const channel = selectedFacePanel === 'expression' ? 'eyes' : selectedFacePanel;
      project.motion[`${channel}Preset`] = config.design.motion.quickPlay[channel];
    }
    else project.motion.preset = config.design.motion.quickPlay.body;
  }
  project.motion.playing = !project.motion.playing; applyMotion();
});
$('#timeline').addEventListener('input', (event) => {
  project.motion.playing = false; project.motion.progress = Number(event.target.value);
  studio?.setMotion(project.motion, { immediate: true }); studio?.setTimeline(project.motion.progress); renderTimeline(); dirty();
});
$('#material-target').addEventListener('change', (event) => { materialTarget = event.target.value; updateAppearanceControls(); });
$('#material-enabled').addEventListener('change', (event) => { changeAppearance((next) => { next.materials[materialTarget].enabled = event.target.checked; }); });
$('#material-color').addEventListener('input', (event) => { changeAppearance((next) => { Object.assign(next.materials[materialTarget], { color: event.target.value, enabled: true }); }); });
$('#material-roughness').addEventListener('input', (event) => { changeAppearance((next) => { Object.assign(next.materials[materialTarget], { roughness: Number(event.target.value), enabled: true }); }); });
$('#reset-material').addEventListener('click', () => { changeAppearance((next) => { next.materials[materialTarget] = structuredClone(config.appearance.defaults.materials[materialTarget]); }); });
$('#remove-skin').addEventListener('click', () => { changeAppearance((next) => { next.materials[materialTarget].image = null; }); });
$('#import-skin').addEventListener('click', () => { skinImportTarget = materialTarget; $('#skin-file').click(); });
$('#import-background').addEventListener('click', () => $('#background-file').click());
for (const kind of ['skin', 'background']) $(`#${kind}-file`).addEventListener('change', async (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || busy || !studio) return;
  const target = skinImportTarget;
  setBusy(true);
  try {
    const image = await encodeImage(file);
    const applied = await changeAppearance((next) => {
      if (kind === 'skin') Object.assign(next.materials[target], { image, enabled: true, color: config.appearance.images.textureTint });
      else next.background.image = image;
    });
    if (applied) toast(kind === 'skin' ? '皮肤图片已应用到设计副本，可继续调整颜色。' : '背景图片已导入，可切换铺满或完整显示。');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#background-color').addEventListener('input', (event) => { changeAppearance((next) => { next.background.color = event.target.value; }); });
$('#background-fit').addEventListener('change', (event) => { changeAppearance((next) => { next.background.fit = event.target.value; }); });
$('#remove-background').addEventListener('click', () => { changeAppearance((next) => { next.background.image = null; }); });
$('#reset-background').addEventListener('click', () => { changeAppearance((next) => { next.background = structuredClone(config.appearance.defaults.background); }); });
$('#light-enabled').addEventListener('change', (event) => { changeAppearance((next) => { next.lighting.enabled = event.target.checked; }); });
for (const key of ['azimuth', 'elevation', 'intensity', 'exposure']) $(`#light-${key}`).addEventListener('input', (event) => { changeAppearance((next) => { next.lighting[key] = Number(event.target.value); }); });
$('#reset-light').addEventListener('click', () => { changeAppearance((next) => { next.lighting = structuredClone(config.appearance.defaults.lighting); }); });
$('#save-project').addEventListener('click', saveLocal);
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveLocal(); } });
$('#load-project').addEventListener('click', () => $('#project-file').click());
$('#project-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || busy || !studio) return;
  setBusy(true);
  try {
    if (file.size > config.appearance.images.maximumProjectBytes) throw new Error('项目文件超过允许大小。');
    const next = parseProject(await file.text());
    await restoreProject(next); dirty(); setMode('design'); toast('项目已恢复，批准基线保持锁定。');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#export-project').addEventListener('click', async () => {
  if (busy) return;
  if (!await appearanceTask) return;
  try { download(serializeProject(project), `${config.project.downloadName}.json`, 'application/json'); toast('项目 JSON 已导出，包含设计参数和候选部件。'); } catch (error) { showError(error); }
  $('.export-menu').open = false;
});
$('#export-model').addEventListener('click', async () => {
  if (busy || !studio) return;
  $('.export-menu').open = false; setBusy(true);
  try { if (!await appearanceTask) return; const bytes = await studio.exportGLB(); download(bytes, `${config.project.downloadName}-${mode}.glb`, 'model/gltf-binary'); toast('已导出当前模型、材质和姿态；背景与动作参数请保存到项目 JSON。'); } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#export-image').addEventListener('click', async () => {
  if (!studio || busy || !await appearanceTask) return;
  const link = $('#download-link'); link.href = studio.capture(); link.download = 'xiaobai-viewport.png'; link.click();
  $('.export-menu').open = false; toast('3D 视口截图已导出。');
});

updateDesignControls(); updateBindingControls(); updateAppearanceControls(); selectPart(selectedPart); setPanel(config.ui.defaults.panel); setFacePanel(config.ui.defaults.facePanel); setMode(mode); setBusy(true);
try {
  studio = await createStudio({
    canvas: $('#model-canvas'), config,
    onStatus(event) {
      if (event.type === 'motion') { project.motion.progress = event.progress; renderTimeline(); }
      else if (event.message) $('#app-status').textContent = event.message;
    },
    onCameraChange() {
      cancelAnimationFrame(pendingCameraFrame);
      pendingCameraFrame = requestAnimationFrame(() => references?.draw());
    },
  });
  $('#loading-state').hidden = true;
  studio.setMode(mode); studio.setDesign(project.design); studio.setExpression(project.expression); studio.setActions(project.actions); studio.setMotion(project.motion, { immediate: true }); studio.setBinding(project.binding);
  setView(config.viewer.defaults.view);
  updateStats();
  try {
    references = await createReferences({ preview: $('#reference-preview'), overlay: $('#reference-overlay'), studio, config, onCaption({ label, paused, mapped }) {
      $('#reference-caption').textContent = label;
      $('#overlay-help').textContent = !mapped ? '此动作图仅供参考浏览，尚无可靠配准数据。' : paused ? '自由视角下暂停叠图；点击对应正交视图恢复。' : '沿用原参考图配准；头部和身体使用各自的对齐基准。';
    } });
    references.setMode(mode);
  } catch (error) { toast(`模型已载入，${error.message}`); }
  try {
    const saved = localStorage.getItem(config.project.storageKey);
    if (saved) { await restoreProject(parseProject(saved)); $('#save-state').textContent = '已恢复本地草稿'; }
  } catch (error) { toast(`本地草稿未恢复：${error.message} 当前批准模型可继续使用。`); }
  $('#app-status').textContent = '模型就绪 · 本地运行';
} catch (error) {
  $('#loading-state strong').textContent = '模型载入失败';
  $('#loading-state span:last-child').textContent = error.message;
  $('.loading-orbit').hidden = true;
  $('#app-status').textContent = '请检查模型文件后刷新页面';
} finally { setBusy(false); }
window.addEventListener('beforeunload', () => { references?.dispose(); studio?.dispose(); });
