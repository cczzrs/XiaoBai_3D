function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeTree(child);
  }
  return Object.freeze(value);
}

/** 页面、模型和交互默认值的唯一入口。HTML 定义结构，CSS 定义外观。 */
export const APP_CONFIG = freezeTree({
  project: {
    name: '小白 3D', schema: 'xiaobai.studio.v1', revision: 4,
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
      faceFocus: { target: [0, 70.1, 0], span: 82 },
      views: { front: { yaw: 0, elevation: 0 }, right: { yaw: -90, elevation: 0 }, back: { yaw: 180, elevation: 0 }, left: { yaw: 90, elevation: 0 }, perspective: { yaw: -28, elevation: 12 } },
    },
    renderer: { pixelRatioLimit: 2 },
    lighting: {
      space: 'camera',
      uniform: { color: '#FFFFFF', intensity: 2.8 },
      ambient: { sky: '#FFFFFF', ground: '#E8DED1', intensity: 0.85 },
      directional: { distance: 280 },
      key: { color: '#FFF6E8', intensity: 5, position: [95, 230, 110], spread: [150, 110, 120], samples: [-1, 0, 1] },
      fill: { color: '#FFF9EF', intensity: 0.6, position: [-100, 30, 160] },
      rim: { color: '#FFFFFF', intensity: 1.5, position: [-60, 100, -100] },
      limits: { azimuth: { min: -180, max: 180, step: 1 }, elevation: { min: -90, max: 90, step: 1 }, intensity: { min: 0, max: 10, step: 0.1 }, exposure: { min: 0.25, max: 4, step: 0.05 } },
    },
    grid: { size: 180, divisions: 18, color: '#303637', centerColor: '#68716a' },
    defaults: { view: 'front', wireframe: false, grid: false, skeleton: false, visibility: { head: true, body: true, arms: true, legs: true } },
  },
  appearance: {
    defaults: {
      materials: {
        head: { enabled: false, color: '#FFF1D9', roughness: 0.7, image: null },
        body: { enabled: false, color: '#FFF1D9', roughness: 0.7, image: null },
        arms: { enabled: false, color: '#FFF1D9', roughness: 0.7, image: null },
        legs: { enabled: false, color: '#FFF1D9', roughness: 0.7, image: null },
        eyes: { enabled: false, color: '#26231F', roughness: 0.62, image: null },
        nose: { enabled: false, color: '#26231F', roughness: 0.62, image: null },
      },
      background: { color: '#000000', image: null, fit: 'cover' },
      lighting: { enabled: false, azimuth: 41, elevation: 58, intensity: 5, exposure: 2.05 },
    },
    images: { maximumBytes: 8 * 1024 * 1024, maximumDimension: 4096, maximumPixels: 16777216, maximumProjectBytes: 256 * 1024 * 1024, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], textureTint: '#FFFFFF' },
    limits: { roughness: { min: 0.05, max: 1, step: 0.01 } },
    backgroundFits: ['cover', 'contain'],
    projection: { axis: 'xy', fit: 'cover' },
  },
  design: {
    rigVisual: { bodyCenterY: 36.224963, headCenterY: 70.1, jointRadius: 0.85, color: '#e8b66d', lineColor: '#f3cb8f' },
    defaults: {
      shape: { headScale: 1, bodyWidth: 1, bodyHeight: 1, bodyDepth: 1 },
      rig: { rootY: 16.5, neckY: 52 },
      pose: { headYaw: 0, headPitch: 0, headRoll: 0, bodyLean: 0 },
      eyes: { width: 1, height: 1, spacing: 1, offsetY: 0, gazeX: 0, gazeY: 0, leftOpen: 1, rightOpen: 1 },
      nose: { width: 1, height: 1, offsetY: 0, protrusion: 0, tilt: 0 },
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
      eyes: {
        width: { min: 0.65, max: 1.35, step: 0.01 },
        height: { min: 0.65, max: 1.35, step: 0.01 },
        spacing: { min: 0.8, max: 1.2, step: 0.01 },
        offsetY: { min: -3, max: 3, step: 0.1 },
        gazeX: { min: -2.5, max: 2.5, step: 0.1 },
        gazeY: { min: -2, max: 2, step: 0.1 },
        leftOpen: { min: 0, max: 1, step: 0.01 },
        rightOpen: { min: 0, max: 1, step: 0.01 },
      },
      nose: {
        width: { min: 0.6, max: 2, step: 0.01 },
        height: { min: 0.6, max: 1.6, step: 0.01 },
        offsetY: { min: -3, max: 3, step: 0.1 },
        protrusion: { min: 0, max: 2, step: 0.1 },
        tilt: { min: -20, max: 20, step: 1 },
      },
    },
    motion: {
      defaults: { preset: 'none', playing: false, speed: 1, amplitude: 10, progress: 0, eyesPreset: 'none', nosePreset: 'none', eyeAmplitude: 1, noseAmplitude: 1 },
      presets: ['none', 'nod', 'sway', 'breathe'],
      eyesPresets: ['none', 'blink', 'winkLeft', 'winkRight', 'lookAround'],
      nosePresets: ['none', 'twitch', 'stretch'],
      quickPlay: { body: 'nod', eyes: 'blink', nose: 'twitch' },
      eyeAmplitude: { min: 0, max: 1, step: 0.05 },
      noseAmplitude: { min: 0, max: 1, step: 0.05 },
      speed: { min: 0.25, max: 2, step: 0.05 },
      amplitude: { min: 0, max: 25, step: 0.5 }, durationSeconds: 4,
      timeline: { min: 0, max: 1, step: 0.001 },
    },
    expression: {
      defaults: { preset: 'neutral', intensity: 1 },
      intensity: { min: 0, max: 1, step: 0.01 },
      presets: {
        neutral: {
          label: '自然', description: '保持批准眼圈与原始眼内开口。',
          left: { width: 1, height: 1, curve: 0, slant: 0, gazeX: 0, gazeY: 0 },
          right: { width: 1, height: 1, curve: 0, slant: 0, gazeX: 0, gazeY: 0 },
        },
        cute: {
          label: '可爱', description: '眼内开口稍放大，目光轻轻向内，外眼圈保持原形。',
          left: { width: 1.2, height: 1.1, curve: 0.1, slant: 0, gazeX: 0.3, gazeY: 0.25 },
          right: { width: 1.2, height: 1.1, curve: 0.1, slant: 0, gazeX: -0.3, gazeY: 0.25 },
        },
        happy: {
          label: '开心', description: '眼内开口变成向上弯的笑眼，保留完整外眼圈。',
          left: { width: 1.2, height: 0.25, curve: 1.8, slant: 0, gazeX: 0, gazeY: 0.25 },
          right: { width: 1.2, height: 0.25, curve: 1.8, slant: 0, gazeX: 0, gazeY: 0.25 },
        },
        angry: {
          label: '愤怒', description: '双眼内部朝鼻侧压低，形成明显的向内斜视。',
          left: { width: 1.15, height: 0.5, curve: 0, slant: -0.65, gazeX: 0.25, gazeY: 0 },
          right: { width: 1.15, height: 0.5, curve: 0, slant: 0.65, gazeX: -0.25, gazeY: 0 },
        },
        thinking: {
          label: '思考', description: '一侧眼内开口收窄，目光抬向画面右上方。',
          left: { width: 1.1, height: 0.85, curve: 0.2, slant: 0.12, gazeX: 1, gazeY: 0.9 },
          right: { width: 1, height: 0.4, curve: 0.4, slant: 0.22, gazeX: 1, gazeY: 0.9 },
        },
        surprised: {
          label: '惊讶', description: '双眼内部开口放大，呈现睁大眼睛的神情。',
          left: { width: 1.35, height: 1.15, curve: 0, slant: 0, gazeX: 0, gazeY: 0.1 },
          right: { width: 1.35, height: 1.15, curve: 0, slant: 0, gazeX: 0, gazeY: 0.1 },
        },
        sleepy: {
          label: '困倦', description: '眼内开口变窄并稍向下垂，外眼圈保持原形。',
          left: { width: 1.1, height: 0.16, curve: -0.6, slant: 0, gazeX: 0, gazeY: -0.6 },
          right: { width: 1.1, height: 0.16, curve: -0.6, slant: 0, gazeX: 0, gazeY: -0.6 },
        },
      },
    },
    face: {
      expressionKeys: { eyes: ['gazeX', 'gazeY', 'leftOpen', 'rightOpen'], nose: ['tilt'] },
      nodes: { head: 'Head', leftEye: 'Eye_L', rightEye: 'Eye_R', nose: 'Nose' },
      animation: { blinkCenter: 0.5, blinkHalfWidth: 0.12, gazeX: 2.5, gazeY: 1, noseTilt: 8, noseStretch: 0.6 },
      surface: { columns: 257, rows: 193 },
      aperture: { angularSamples: 256, boundaryTolerance: 0.00001, inset: 0.1, closed: { width: 1.3, height: 0.045, curve: 1.2 } },
    },
  },
  ui: {
    parameterFormats: {
      shape: { digits: 2, suffix: '×' }, rig: { digits: 1, suffix: '' }, pose: { digits: 0, suffix: '°' },
      eyes: { digits: 1, suffix: '' }, nose: { digits: 1, suffix: '' },
      fields: {
        'eyes.width': { digits: 2, suffix: '×' }, 'eyes.height': { digits: 2, suffix: '×' }, 'eyes.spacing': { digits: 2, suffix: '×' },
        'eyes.leftOpen': { digits: 0, suffix: '%', multiplier: 100 }, 'eyes.rightOpen': { digits: 0, suffix: '%', multiplier: 100 },
        'nose.width': { digits: 2, suffix: '×' }, 'nose.height': { digits: 2, suffix: '×' }, 'nose.tilt': { digits: 0, suffix: '°' },
      },
    },
    defaults: { mode: 'build', panel: 'shape', facePanel: 'eyes', materialTarget: 'head', selectedPart: 'head', reference: 'body', overlay: 0 },
    overlay: { min: 0, max: 100, step: 1 },
    toastDuration: 4200,
  },
});
