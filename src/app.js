import { APP_CONFIG as config } from './config.js';
import { createStudio } from './scene.js';
import { createReferences } from './references.js';
import { createDefaultProject, parseProject, serializeProject, encodePart, decodePart } from './project-state.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let project = createDefaultProject();
let studio;
let references;
let mode = config.ui.defaults.mode;
let selectedPart = config.ui.defaults.selectedPart;
let light = { ...config.viewer.lighting.directional };
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
function setBusy(value) {
  busy = value;
  $$('[data-needs-model]').forEach((button) => { button.disabled = value || !studio; });
  $('#load-project').disabled = value;
  $('#remove-part').disabled = value;
  $('#save-project').disabled = value;
}
function updateStats() {
  if (!studio) return;
  const stats = studio.getStats();
  $('#geometry-stats').textContent = `${stats.meshes} 个网格 · ${Math.round(stats.triangles).toLocaleString()} 个三角形`;
  for (const slot of ['arms', 'legs']) {
    const part = project.parts[slot];
    $(`#${slot}-file`).textContent = part?.name ?? '等待导入模型';
    $(`#${slot}-badge`).textContent = part ? '候选' : '待构建';
  }
}
function renderTimeline() {
  $('#timeline').value = project.motion.progress;
  $('#timeline-time').textContent = `${(project.motion.progress * config.design.motion.durationSeconds).toFixed(2)} / ${config.design.motion.durationSeconds.toFixed(2)} 秒`;
  $('#play-motion').textContent = project.motion.playing ? 'Ⅱ' : '▶';
  $('#play-motion').setAttribute('aria-label', project.motion.playing ? '暂停动作' : '播放动作');
}
function updateDesignControls() {
  $$('[data-design]').forEach((input) => {
    const [group, key] = input.dataset.design.split('.');
    input.value = project.design[group][key];
    const suffix = group === 'shape' ? '×' : group === 'pose' ? '°' : '';
    const digits = group === 'shape' ? 2 : group === 'rig' ? 1 : 0;
    $(`[data-output="${input.dataset.design}"]`).textContent = project.design[group][key].toFixed(digits) + suffix;
  });
  $('#motion-preset').value = project.motion.preset;
  $('#motion-speed').value = project.motion.speed;
  $('#motion-amplitude').value = project.motion.amplitude;
  $('#speed-value').textContent = project.motion.speed.toFixed(2) + '×';
  $('#amplitude-value').textContent = project.motion.amplitude.toFixed(1);
  $('#motion-label').textContent = $('#motion-preset').selectedOptions[0].textContent;
  renderTimeline();
}
function selectPart(part) {
  selectedPart = part;
  $$('[data-part]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.part === part));
  const asset = config.assets[part];
  const imported = project.parts[part];
  $('#selected-name').textContent = asset.label;
  $('#selected-version').textContent = asset.version ?? (imported ? '导入候选' : '尚未构建');
  $('#selected-status').textContent = asset.approved ? '已批准 · 锁定' : imported ? '候选 · 待批准' : '等待构建';
  $('#selected-status').className = asset.approved ? 'approved-badge' : 'draft-badge';
  $('#selected-description').textContent = part === 'head' ? '保留已批准的头部、眼睛与鼻子，以及原始材质和比例。' : part === 'body' ? '身体 v7 左右、前后对称，主要依据 TIFF 第 1 帧；已批准并锁定。' : imported ? `${imported.name} 已加入装配，尚未批准。导入模型沿用文件中的原始坐标和单位。` : `可导入后续${asset.label}模型，与已批准部件装配、叠图核对。`;
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
}
function setView(value) {
  studio?.setView(value);
  $$('[data-view]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.view === value));
  $('#camera-label').textContent = `${value.toUpperCase()} / ${value === 'perspective' ? '透视' : '正交'}`;
  references?.refresh().catch(showError);
}
function setPanel(panel) {
  $$('[data-panel]').forEach((item) => item.setAttribute('aria-selected', item.dataset.panel === panel));
  $$('[data-design-panel]').forEach((section) => { section.hidden = section.dataset.designPanel !== panel; });
}
function applyMotion() { studio?.setMotion(project.motion); updateDesignControls(); dirty(); }
function applyDesign() { studio?.setDesign(project.design); updateDesignControls(); dirty(); }
function applyLight() {
  for (const key of ['azimuth', 'elevation', 'intensity']) {
    $(`#light-${key}`).value = light[key];
    $(`#light-${key}-value`).textContent = light[key] + (key === 'intensity' ? '' : '°');
  }
  $('#light-enabled').checked = light.enabled;
  studio?.setLight(light);
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
  // Both files must parse and pass mesh validation before either current candidate is replaced.
  await studio.replaceCandidates({ arms: next.parts.arms ? decodePart(next.parts.arms) : null, legs: next.parts.legs ? decodePart(next.parts.legs) : null });
  project = next;
  studio.setDesign(project.design);
  studio.setMotion(project.motion);
  updateDesignControls();
  updateStats();
  selectPart(selectedPart);
}
function saveLocal() {
  if (busy) return;
  try {
    localStorage.setItem(config.project.storageKey, serializeProject(project));
    $('#save-state').textContent = '草稿已保存在此浏览器';
    toast('草稿已保存；重新打开页面可恢复。');
  } catch (error) {
    toast(error.name === 'QuotaExceededError' ? '浏览器空间不足，请使用「导出 → 项目 JSON」保存完整草稿。' : `保存失败：${error.message}`);
  }
}

// Initialize all editable defaults and ranges from the config tree.
$$('[data-design]').forEach((input) => {
  const [group, key] = input.dataset.design.split('.');
  Object.assign(input, config.design.limits[group][key]);
  input.addEventListener('input', () => { project.design[group][key] = Number(input.value); applyDesign(); });
});
Object.assign($('#motion-speed'), config.design.motion.speed);
Object.assign($('#motion-amplitude'), config.design.motion.amplitude);
Object.assign($('#overlay-opacity'), config.ui.overlay, { value: config.ui.defaults.overlay });
$('#overlay-value').textContent = config.ui.defaults.overlay + '%';
Object.assign($('#timeline'), config.design.motion.timeline);
for (const key of ['azimuth', 'elevation', 'intensity']) Object.assign($(`#light-${key}`), config.viewer.lighting.limits[key]);
$$('[data-visible]').forEach((input) => {
  input.checked = config.viewer.defaults.visibility[input.dataset.visible];
  input.addEventListener('change', () => { studio?.setVisibility(input.dataset.visible, input.checked); updateStats(); });
});
$$('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#enter-design').addEventListener('click', () => setMode('design'));
$$('[data-part]').forEach((button) => button.addEventListener('click', () => selectPart(button.dataset.part)));
$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-panel]').forEach((button) => button.addEventListener('click', () => {
  setPanel(button.dataset.panel);
}));
for (const [id, method, initial] of [['toggle-grid', 'setGrid', config.viewer.defaults.grid], ['toggle-wireframe', 'setWireframe', config.viewer.defaults.wireframe]]) {
  const button = $(`#${id}`);
  button.setAttribute('aria-pressed', initial);
  button.addEventListener('click', () => { const enabled = button.getAttribute('aria-pressed') !== 'true'; button.setAttribute('aria-pressed', enabled); studio?.[method](enabled); });
}
$('#reset-camera').addEventListener('click', () => setView(config.viewer.defaults.view));
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
$('#reset-pose').addEventListener('click', () => {
  project.design.pose = structuredClone(config.design.defaults.pose);
  project.motion = structuredClone(config.design.motion.defaults);
  studio?.setMotion(project.motion); applyDesign();
});
$('#motion-preset').addEventListener('change', (event) => {
  project.motion.preset = event.target.value; project.motion.progress = 0;
  if (project.motion.preset === 'none') project.motion.playing = false;
  applyMotion();
});
$('#motion-speed').addEventListener('input', (event) => { project.motion.speed = Number(event.target.value); applyMotion(); });
$('#motion-amplitude').addEventListener('input', (event) => { project.motion.amplitude = Number(event.target.value); applyMotion(); });
$('#play-motion').addEventListener('click', () => {
  if (project.motion.preset === 'none') { project.motion.preset = 'nod'; }
  project.motion.playing = !project.motion.playing; applyMotion();
});
$('#timeline').addEventListener('input', (event) => {
  project.motion.playing = false; project.motion.progress = Number(event.target.value);
  studio?.setMotion(project.motion); studio?.setTimeline(project.motion.progress); renderTimeline(); dirty();
});
$('#light-enabled').addEventListener('change', (event) => { light.enabled = event.target.checked; applyLight(); });
for (const key of ['azimuth', 'elevation', 'intensity']) $(`#light-${key}`).addEventListener('input', (event) => { light[key] = Number(event.target.value); applyLight(); });
$('#reset-light').addEventListener('click', () => { light = { ...config.viewer.lighting.directional }; applyLight(); });
$('#save-project').addEventListener('click', saveLocal);
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveLocal(); } });
$('#load-project').addEventListener('click', () => $('#project-file').click());
$('#project-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || busy || !studio) return;
  setBusy(true);
  try {
    if (file.size > Math.ceil(config.assets.import.maximumBytes * 8 / 3) + 65536) throw new Error('项目文件超过允许大小。');
    const next = parseProject(await file.text());
    await restoreProject(next); dirty(); setMode('design'); toast('项目已恢复，批准基线保持锁定。');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#export-project').addEventListener('click', () => {
  if (busy) return;
  try { download(serializeProject(project), `${config.project.downloadName}.json`, 'application/json'); toast('项目 JSON 已导出，包含设计参数和候选部件。'); } catch (error) { showError(error); }
  $('.export-menu').open = false;
});
$('#export-model').addEventListener('click', async () => {
  if (busy || !studio) return;
  $('.export-menu').open = false; setBusy(true);
  try { const bytes = await studio.exportGLB(); download(bytes, `${config.project.downloadName}-${mode}.glb`, 'model/gltf-binary'); toast('已导出当前可见模型和姿态；动作参数请保存到项目 JSON。'); } catch (error) { showError(error); }
  finally { setBusy(false); }
});
$('#export-image').addEventListener('click', () => {
  if (!studio) return;
  const link = $('#download-link'); link.href = studio.capture(); link.download = 'xiaobai-viewport.png'; link.click();
  $('.export-menu').open = false; toast('3D 视口截图已导出。');
});

updateDesignControls(); applyLight(); selectPart(selectedPart); setPanel(config.ui.defaults.panel); setMode(mode); setBusy(true);
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
  studio.setMode(mode); studio.setDesign(project.design); studio.setMotion(project.motion);
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
