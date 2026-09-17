function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeTree(child);
  }
  return Object.freeze(value);
}

/** 页面、模型和交互默认值的唯一入口。HTML 定义结构，CSS 定义外观。 */
export const APP_CONFIG = freezeTree({
  project: {
    name: '小白 3D', schema: 'xiaobai.studio.v1', revision: 1,
    sourceThread: '01a0a7ff-ce82-70e2-8bf4-07b424928450',
    storageKey: 'xiaobai-studio-design-v1', downloadName: 'xiaobai-design',
  },
  assets: {
    head: { url: './assets/approved/head-v1/xiaobai-head.glb', version: 'head-v1', label: '头部', approved: true },
    body: { url: './assets/approved/body-v7/xiaobai-torso.glb', version: 'body-v7', label: '身体', approved: true },
    arms: { label: '手臂', approved: false },
    legs: { label: '腿脚', approved: false },
    manifest: './assets/manifest.json',
    import: { maximumBytes: 50 * 1024 * 1024, maximumVertices: 2000000, maximumMeshes: 256, maximumExtent: 1000, extensions: ['glb', 'obj'] },
  },
  viewer: {
    camera: {
      distance: 260, span: 122, target: [0, 54, 0], minZoom: 0.5, maxZoom: 4,
      near: 0.1, far: 2000, fov: 30,
      views: { front: { yaw: 0, elevation: 0 }, right: { yaw: -90, elevation: 0 }, back: { yaw: 180, elevation: 0 }, left: { yaw: 90, elevation: 0 }, perspective: { yaw: -28, elevation: 12 } },
    },
    renderer: { background: '#000000', pixelRatioLimit: 2, exposure: 2.05 },
    lighting: {
      space: 'camera',
      uniform: { color: '#FFFFFF', intensity: 2.8 },
      ambient: { sky: '#FFFFFF', ground: '#E8DED1', intensity: 0.85 },
      directional: { color: '#FFF6E8', enabled: false, azimuth: 41, elevation: 58, intensity: 5, distance: 280 },
      limits: { azimuth: { min: -180, max: 180, step: 1 }, elevation: { min: -90, max: 90, step: 1 }, intensity: { min: 0, max: 10, step: 0.1 } },
    },
    grid: { size: 180, divisions: 18, color: '#303637', centerColor: '#68716a' },
    defaults: { view: 'front', wireframe: false, grid: false, skeleton: false, visibility: { head: true, body: true, arms: true, legs: true } },
  },
  design: {
    rigVisual: { bodyCenterY: 36.224963, headCenterY: 70.1, jointRadius: 0.85, color: '#e8b66d', lineColor: '#f3cb8f' },
    defaults: {
      shape: { headScale: 1, bodyWidth: 1, bodyHeight: 1, bodyDepth: 1 },
      rig: { rootY: 16.5, neckY: 52 },
      pose: { headYaw: 0, headPitch: 0, headRoll: 0, bodyLean: 0 },
    },
    limits: {
      shape: {
        headScale: { min: 0.7, max: 1.3, step: 0.01 },
        bodyWidth: { min: 0.7, max: 1.3, step: 0.01 },
        bodyHeight: { min: 0.7, max: 1.3, step: 0.01 },
        bodyDepth: { min: 0.7, max: 1.3, step: 0.01 },
      },
      rig: { rootY: { min: 8, max: 30, step: 0.5 }, neckY: { min: 40, max: 65, step: 0.5 } },
      pose: {
        headYaw: { min: -70, max: 70, step: 1 },
        headPitch: { min: -35, max: 35, step: 1 },
        headRoll: { min: -30, max: 30, step: 1 },
        bodyLean: { min: -20, max: 20, step: 1 },
      },
    },
    motion: {
      defaults: { preset: 'none', playing: false, speed: 1, amplitude: 10, progress: 0 },
      presets: ['none', 'nod', 'sway', 'breathe'],
      speed: { min: 0.25, max: 2, step: 0.05 },
      amplitude: { min: 0, max: 25, step: 0.5 }, durationSeconds: 4,
      timeline: { min: 0, max: 1, step: 0.001 },
    },
  },
  ui: {
    defaults: { mode: 'build', panel: 'shape', selectedPart: 'head', reference: 'body', overlay: 0 },
    overlay: { min: 0, max: 100, step: 1 },
    toastDuration: 4200,
  },
});
