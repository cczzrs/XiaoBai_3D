import * as THREE from 'three';
import { OrbitControls } from '../vendor/addons/controls/OrbitControls.js';
import { clonePart, describeObject, disposeObjects, exportModel, importCandidate, loadApproved } from './model-io.js';
import { createFaceRig } from './face-rig.js';
import { createAppearanceController, createStudioLighting } from './appearance.js';

const PART_KEYS = ['head', 'body', 'arms', 'legs'];
const toRadians = THREE.MathUtils.degToRad;

/** Model-only renderer: all page structure and visual styles belong to HTML / CSS. */
export async function createStudio({ canvas, config, onStatus = () => {}, onCameraChange = () => {} }) {
  const settings = config.viewer;
  const cameraSettings = settings.camera;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(config.appearance.defaults.background.color);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.renderer.pixelRatioLimit));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = config.appearance.defaults.lighting.exposure;

  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, cameraSettings.near, cameraSettings.far);
  const perspective = new THREE.PerspectiveCamera(cameraSettings.fov, 1, cameraSettings.near, cameraSettings.far);
  let camera = orthographic;
  let width = 1;
  let height = 1;
  let disposed = false;
  let needsRender = true;
  let mode = config.ui.defaults.mode;
  let view = settings.defaults.view;
  let wireframe = settings.defaults.wireframe;
  let skeletonVisible = settings.defaults.skeleton;
  let design = structuredClone(config.design.defaults);
  let faceRig = null;
  let motion = structuredClone(config.design.motion.defaults);
  let expression = structuredClone(config.design.expression.defaults);
  let lightState = { ...config.appearance.defaults.lighting };
  let appearanceGeneration = 0;
  const visibility = { ...settings.defaults.visibility };
  const parts = Object.fromEntries(PART_KEYS.map((key) => [key, null]));
  const importGeneration = { arms: 0, legs: 0 };

  const assembly = new THREE.Group();
  assembly.name = 'XiaoBai_ApprovedAssembly';
  const draft = new THREE.Group();
  draft.name = 'XiaoBai_DesignDraft';
  draft.userData = { rigType: 'rigid-bone-hierarchy', skinning: false, description: 'Rigid head and body pose draft; no vertex skinning or limb rig.' };
  scene.add(assembly, draft);

  // These are real Bone nodes. Meshes follow them as rigid objects; no skin weights are invented.
  const rootBone = new THREE.Bone();
  const bodyBone = new THREE.Bone();
  const neckBone = new THREE.Bone();
  const headBone = new THREE.Bone();
  rootBone.name = 'XiaoBai_RigRoot';
  bodyBone.name = 'XiaoBai_RigBody';
  neckBone.name = 'XiaoBai_RigNeck';
  headBone.name = 'XiaoBai_RigHead';
  draft.add(rootBone);
  rootBone.add(bodyBone);
  bodyBone.add(neckBone);
  neckBone.add(headBone);
  const bones = [rootBone, bodyBone, neckBone, headBone];
  const skeleton = new THREE.SkeletonHelper(rootBone);
  skeleton.material.color.set(config.design.rigVisual.lineColor);
  skeleton.material.depthTest = false;
  skeleton.material.transparent = true;
  skeleton.renderOrder = 10;
  const jointGeometry = new THREE.BufferGeometry();
  jointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bones.length * 3), 3));
  const jointMaterial = new THREE.PointsMaterial({ color: config.design.rigVisual.color, size: config.design.rigVisual.jointRadius * 7, sizeAttenuation: false, depthTest: false });
  const joints = new THREE.Points(jointGeometry, jointMaterial);
  joints.frustumCulled = false;
  joints.renderOrder = 11;
  scene.add(skeleton, joints);

  const grid = new THREE.GridHelper(settings.grid.size, settings.grid.divisions, settings.grid.centerColor, settings.grid.color);
  grid.visible = settings.defaults.grid;
  scene.add(grid);
  const lighting = createStudioLighting(scene, renderer, config);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.minZoom = cameraSettings.minZoom;
  controls.maxZoom = cameraSettings.maxZoom;
  controls.minDistance = cameraSettings.distance / cameraSettings.maxZoom;
  controls.maxDistance = cameraSettings.distance / cameraSettings.minZoom;
  controls.target.fromArray(cameraSettings.target);
  controls.addEventListener('change', handleCameraChange);

  function handleCameraChange() {
    updateLightPosition();
    needsRender = true;
    onCameraChange();
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    renderer.setSize(width, height, false);
    const halfHeight = cameraSettings.span / 2;
    orthographic.left = -halfHeight * width / height;
    orthographic.right = halfHeight * width / height;
    orthographic.top = halfHeight;
    orthographic.bottom = -halfHeight;
    orthographic.updateProjectionMatrix();
    perspective.aspect = width / height;
    perspective.updateProjectionMatrix();
    appearanceController.resize();
    handleCameraChange();
  }

  function setView(nextView) {
    const direction = cameraSettings.views[nextView];
    if (!direction) throw new Error('未知的模型视角。');
    view = nextView;
    camera = nextView === 'perspective' ? perspective : orthographic;
    controls.object = camera;
    const yaw = toRadians(direction.yaw);
    const elevation = toRadians(direction.elevation);
    const distance = cameraSettings.distance;
    controls.target.fromArray(cameraSettings.target);
    camera.position.set(Math.sin(yaw) * Math.cos(elevation) * distance, Math.sin(elevation) * distance, Math.cos(yaw) * Math.cos(elevation) * distance).add(controls.target);
    camera.up.set(0, 1, 0);
    camera.zoom = 1;
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    controls.update();
    handleCameraChange();
  }

  function setLight(update) {
    lightState = { ...lightState, ...update };
    lighting.setState(lightState);
    updateLightPosition();
    needsRender = true;
  }

  function updateLightPosition() {
    lighting.update(camera, controls.target);
  }

  const appearanceController = createAppearanceController({
    scene, renderer, config,
    viewport: () => ({ width, height }),
    onLighting: setLight,
    onChange: () => { needsRender = true; },
  });

  async function prepareAppearance(next) {
    return appearanceController.prepare(next);
  }

  function commitAppearance(prepared) {
    appearanceGeneration += 1;
    appearanceController.commit(prepared);
  }

  async function setAppearance(next) {
    const generation = ++appearanceGeneration;
    const prepared = await prepareAppearance(next);
    if (disposed || generation !== appearanceGeneration) {
      prepared.dispose();
      throw new Error('外观更新已被更新的操作替代。');
    }
    appearanceController.commit(prepared);
  }

  function applyWireframe(root) {
    root.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.wireframe = wireframe;
    });
  }

  function createPart(source, slot, metadata, attach = true) {
    const build = clonePart(source);
    const copy = clonePart(source);
    const wrapper = new THREE.Group();
    wrapper.name = `${slot}_ShapePivot`;
    const offset = new THREE.Group();
    offset.name = `${slot}_WorldOffset`;
    wrapper.add(offset);
    offset.add(copy);
    const sourceData = { ...source.userData, approval: config.assets[slot].approved ? 'approved' : 'pending', version: config.assets[slot].version ?? null, sourceFile: metadata.name };
    build.userData = structuredClone(sourceData);
    copy.userData = structuredClone(sourceData);
    build.visible = visibility[slot];
    wrapper.visible = visibility[slot];
    applyWireframe(build);
    applyWireframe(copy);
    if (slot === 'head') faceRig = createFaceRig(copy, config);
    appearanceController.register(copy, source, slot, metadata.format);
    const part = { source, build, draft: copy, wrapper, offset, metadata };
    if (attach) attachPart(part, slot);
    return part;
  }

  function attachPart(part, slot) {
    assembly.add(part.build);
    if (slot === 'head') headBone.add(part.wrapper);
    else if (slot === 'legs') rootBone.add(part.wrapper);
    else bodyBone.add(part.wrapper);
  }

  function releasePart(part) {
    if (!part) return;
    part.build.removeFromParent();
    part.wrapper.removeFromParent();
    appearanceController.unregister(part.draft);
    disposeObjects([part.source, part.build, part.draft]);
  }

  function applyDesign() {
    const { shape, rig, pose } = design;
    const phase = motion.progress * Math.PI * 2;
    const activeMotion = mode === 'design' ? motion.preset : 'none';
    const wave = Math.sin(phase) * motion.amplitude;
    const nod = activeMotion === 'nod' ? wave : 0;
    const sway = activeMotion === 'sway' ? wave : 0;
    const breathe = activeMotion === 'breathe' ? 1 + Math.sin(phase) * motion.amplitude / 500 : 1;
    const { bodyCenterY, headCenterY } = config.design.rigVisual;
    rootBone.position.set(0, rig.rootY, 0);
    bodyBone.position.set(0, bodyCenterY - rig.rootY, 0);
    neckBone.position.set(0, rig.neckY - bodyCenterY, 0);
    headBone.position.set(0, headCenterY - rig.neckY, 0);
    rootBone.rotation.set(0, 0, toRadians(pose.bodyLean + sway));
    neckBone.rotation.set(toRadians(pose.headPitch + nod), toRadians(pose.headYaw), toRadians(pose.headRoll), 'YXZ');
    for (const slot of PART_KEYS) {
      const part = parts[slot];
      if (!part) continue;
      const pivotY = slot === 'head' ? headCenterY : slot === 'legs' ? rig.rootY : bodyCenterY;
      part.offset.position.set(0, -pivotY, 0);
      if (slot === 'head') part.wrapper.scale.setScalar(shape.headScale);
      else if (slot === 'body') part.wrapper.scale.set(shape.bodyWidth * breathe, shape.bodyHeight, shape.bodyDepth * breathe);
    }
    faceRig?.apply(design.eyes, design.nose, motion, motion.progress, expression);
    draft.updateMatrixWorld(true);
    skeleton.updateMatrixWorld(true);
    const positions = jointGeometry.attributes.position;
    const position = new THREE.Vector3();
    bones.forEach((bone, index) => {
      bone.getWorldPosition(position);
      positions.setXYZ(index, position.x, position.y, position.z);
    });
    positions.needsUpdate = true;
    needsRender = true;
  }

  function setMode(nextMode) {
    if (!['build', 'design'].includes(nextMode)) throw new Error('未知工作模块。');
    mode = nextMode;
    assembly.visible = mode === 'build';
    draft.visible = mode === 'design';
    skeleton.visible = joints.visible = mode === 'design' && skeletonVisible;
    applyDesign();
    onStatus({ type: 'mode', mode });
  }

  function setDesign(nextDesign) {
    const validated = structuredClone(design);
    for (const [group, parameters] of Object.entries(config.design.limits)) {
      for (const [key, range] of Object.entries(parameters)) {
        const value = nextDesign[group]?.[key] ?? validated[group][key];
        if (!Number.isFinite(value) || value < range.min || value > range.max) throw new Error(`参数 ${group}.${key} 超出有效范围。`);
        validated[group][key] = value;
      }
    }
    design = validated;
    applyDesign();
  }

  function setExpression(update) {
    const next = { ...expression, ...update };
    const { presets, intensity } = config.design.expression;
    if (!Object.hasOwn(presets, next.preset)) throw new Error('未知的表情。');
    if (!Number.isFinite(next.intensity) || next.intensity < intensity.min || next.intensity > intensity.max) throw new Error('表情强度超出有效范围。');
    expression = next;
    applyDesign();
  }

  function setMotion(update) {
    const next = { ...motion, ...update };
    for (const [key, choices] of [['preset', config.design.motion.presets], ['eyesPreset', config.design.motion.eyesPresets], ['nosePreset', config.design.motion.nosePresets]]) {
      if (!choices.includes(next[key])) throw new Error('未知的动作草稿。');
    }
    for (const key of ['speed', 'amplitude', 'eyeAmplitude', 'noseAmplitude']) {
      const range = config.design.motion[key];
      if (!Number.isFinite(next[key]) || next[key] < range.min || next[key] > range.max) throw new Error('动作参数超出有效范围。');
    }
    if (!Number.isFinite(next.progress) || next.progress < 0 || next.progress > 1) throw new Error('时间轴参数超出有效范围。');
    next.playing = Boolean(next.playing) && [next.preset, next.eyesPreset, next.nosePreset].some((preset) => preset !== 'none');
    motion = next;
    applyDesign();
  }

  function setTimeline(progress) {
    if (!Number.isFinite(progress)) throw new Error('时间轴参数无效。');
    motion.progress = THREE.MathUtils.clamp(progress, 0, 1);
    applyDesign();
  }

  function getStats() {
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;
    const summary = {};
    for (const slot of PART_KEYS) {
      const part = parts[slot];
      summary[slot] = part ? { ...part.metadata, visible: visibility[slot], approved: Boolean(config.assets[slot].approved), version: config.assets[slot].version ?? null } : null;
      if (!part || !visibility[slot]) continue;
      meshes += part.metadata.meshes;
      vertices += part.metadata.vertices;
      triangles += part.metadata.triangles;
    }
    return { mode, parts: summary, meshes, vertices, triangles, bones: mode === 'design' ? bones.length : 0, skinnedMeshes: 0 };
  }

  async function importPart(file, slot) {
    if (!['arms', 'legs'].includes(slot)) throw new Error('已批准的头部和身体已锁定，请将候选模型导入手臂或腿脚槽位。');
    const generation = ++importGeneration[slot];
    const imported = await importCandidate(file, {
      maxBytes: config.assets.import.maximumBytes,
      maxVertices: config.assets.import.maximumVertices,
      maxMeshes: config.assets.import.maximumMeshes,
      maxExtent: config.assets.import.maximumExtent,
    });
    if (disposed || generation !== importGeneration[slot]) {
      disposeObjects([imported.root]);
      throw new Error('该导入已被更新的操作替代。');
    }
    const { root, ...metadata } = imported;
    const replacement = createPart(root, slot, metadata);
    const previous = parts[slot];
    parts[slot] = replacement;
    releasePart(previous);
    applyDesign();
    onStatus({ type: 'import', slot, message: `${config.assets[slot].label}候选模型已载入。`, stats: getStats() });
    return { slot, ...metadata };
  }

  async function replaceCandidates(files) {
    const slots = ['arms', 'legs'];
    if (!files || slots.some((slot) => !Object.hasOwn(files, slot))) throw new Error('恢复项目需要完整的手臂和腿脚候选槽位。');
    const generations = Object.fromEntries(slots.map((slot) => [slot, ++importGeneration[slot]]));
    const results = await Promise.allSettled(slots.map((slot) => files[slot] === null ? null : importCandidate(files[slot], {
      maxBytes: config.assets.import.maximumBytes,
      maxVertices: config.assets.import.maximumVertices,
      maxMeshes: config.assets.import.maximumMeshes,
      maxExtent: config.assets.import.maximumExtent,
    })));
    const loaded = results.filter((result) => result.status === 'fulfilled' && result.value).map((result) => result.value);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure || disposed || slots.some((slot) => importGeneration[slot] !== generations[slot])) {
      disposeObjects(loaded.map((part) => part.root));
      throw failure?.reason ?? new Error('项目恢复已被更新的操作替代。');
    }
    const replacements = {};
    try {
      slots.forEach((slot, index) => {
        const value = results[index].value;
        if (value) {
          const { root, ...metadata } = value;
          replacements[slot] = createPart(root, slot, metadata, false);
        } else replacements[slot] = null;
      });
    } catch (error) {
      for (const part of Object.values(replacements).filter(Boolean)) appearanceController.unregister(part.draft);
      disposeObjects([...loaded.map((part) => part.root), ...Object.values(replacements).filter(Boolean).flatMap((part) => [part.build, part.draft])]);
      throw error;
    }
    const previous = slots.map((slot) => parts[slot]);
    for (const slot of slots) {
      parts[slot] = replacements[slot];
      if (parts[slot]) attachPart(parts[slot], slot);
    }
    previous.forEach(releasePart);
    applyDesign();
    return { stats: getStats(), warnings: loaded.flatMap((part) => part.warnings) };
  }

  function removePart(slot) {
    if (!['arms', 'legs'].includes(slot)) throw new Error('已批准的头部和身体已锁定。');
    importGeneration[slot] += 1;
    const previous = parts[slot];
    if (!previous) return;
    parts[slot] = null;
    releasePart(previous);
    needsRender = true;
  }

  function render() {
    renderer.render(scene, camera);
    needsRender = false;
  }

  let animationFrame;
  let previousTime = performance.now();
  function frame(time) {
    if (disposed) return;
    const elapsed = Math.min((time - previousTime) / 1000, 0.1);
    previousTime = time;
    if (mode === 'design' && motion.playing && !document.hidden) {
      motion.progress = (motion.progress + elapsed * motion.speed / config.design.motion.durationSeconds) % 1;
      applyDesign();
      // Keep saved state and pause/parameter edits at the pose rendered this frame.
      onStatus({ type: 'motion', progress: motion.progress });
    }
    if (needsRender) render();
    animationFrame = requestAnimationFrame(frame);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    observer.disconnect();
    controls.removeEventListener('change', handleCameraChange);
    controls.dispose();
    const objects = Object.values(parts).filter(Boolean).flatMap((part) => [part.source, part.build, part.draft]);
    appearanceController.dispose();
    lighting.dispose();
    disposeObjects([...objects, grid, skeleton, joints]);
    renderer.dispose();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  setView(view);
  setLight(lightState);

  // A rejected asset load never leaves a half-ready editor running.
  try {
    const results = await Promise.allSettled(['head', 'body'].map(async (slot) => {
      const source = await loadApproved(config.assets[slot].url);
      const info = describeObject(source);
      parts[slot] = createPart(source, slot, { ...info, name: config.assets[slot].version, format: 'glb', warnings: [] });
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    await setAppearance(config.appearance.defaults);
    setMode(mode);
    render();
    animationFrame = requestAnimationFrame(frame);
    onStatus({ type: 'ready', message: '已载入批准的头部与身体。', stats: getStats() });
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    setMode, setView, setLight, setDesign, setExpression, setMotion, setTimeline, importPart, replaceCandidates, removePart, getStats, dispose,
    prepareAppearance, commitAppearance, setAppearance,
    setVisibility(slot, visible) {
      if (!PART_KEYS.includes(slot)) throw new Error('未知模型部件。');
      visibility[slot] = Boolean(visible);
      if (parts[slot]) parts[slot].build.visible = parts[slot].wrapper.visible = visibility[slot];
      needsRender = true;
    },
    setWireframe(enabled) {
      wireframe = Boolean(enabled);
      applyWireframe(assembly);
      applyWireframe(draft);
      needsRender = true;
    },
    setGrid(enabled) { grid.visible = Boolean(enabled); needsRender = true; },
    setSkeleton(enabled) {
      skeletonVisible = Boolean(enabled);
      skeleton.visible = joints.visible = mode === 'design' && skeletonVisible;
      needsRender = true;
    },
    resetCamera() { setView(settings.defaults.view); },
    focusFace() {
      setView('front');
      controls.target.fromArray(cameraSettings.faceFocus.target);
      camera.position.copy(controls.target).add(new THREE.Vector3(0, 0, cameraSettings.distance));
      camera.zoom = cameraSettings.span / cameraSettings.faceFocus.span;
      camera.lookAt(controls.target);
      camera.updateProjectionMatrix();
      controls.update();
      handleCameraChange();
    },
    getCameraState() {
      return {
        position: camera.position.toArray(), target: controls.target.toArray(),
        orthographic: camera.isOrthographicCamera === true,
        span: cameraSettings.span, zoom: camera.zoom, aspect: width / height,
        width, height, view,
      };
    },
    projectPoint(point) {
      camera.updateMatrixWorld(true);
      const projected = new THREE.Vector3(...point).project(camera);
      return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, depth: projected.z };
    },
    async exportGLB() {
      const appearance = appearanceController.getState();
      // Textures are embedded by GLTFExporter. Extras keep descriptions, not duplicate base64.
      for (const setting of [...Object.values(appearance.materials), appearance.background]) {
        if (setting.image) { const { data, ...description } = setting.image; setting.image = description; }
      }
      const source = mode === 'design' ? draft : assembly;
      const copy = source.clone(true);
      copy.visible = true;
      copy.userData = {
        ...copy.userData, project: config.project.name, schema: config.project.schema,
        mode, approvedSources: { head: config.assets.head.version, body: config.assets.body.version },
        designParameters: mode === 'design' ? structuredClone(design) : null,
        expression: mode === 'design' ? { ...expression } : null,
        eyeMotion: mode === 'design' ? { mode: 'interior-aperture', outerSilhouetteLocked: true } : null,
        motion: mode === 'design' ? { ...motion, playing: false, bakedPoseOnly: true } : null,
        appearance: mode === 'design' ? appearance : null,
      };
      return exportModel(copy);
    },
    capture() { render(); return canvas.toDataURL('image/png'); },
  };
}
