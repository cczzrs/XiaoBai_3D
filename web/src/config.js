function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeTree(child);
  }
  return Object.freeze(value);
}

/** 页面、模型和交互默认值的唯一入口。HTML 定义结构，CSS 定义外观。 */
export const APP_CONFIG = freezeTree({
  project: {
    name: '小白 3D', schema: 'xiaobai.studio.v1', revision: 8,
    sourceThread: '01a0a7ff-ce82-70e2-8bf4-07b424928450',
    storageKey: 'xiaobai-studio-design-v1', downloadName: 'xiaobai-design',
  },
  assets: {
    head: { url: './assets/approved/head-v1/xiaobai-head.glb', version: 'head-v1', label: '头部', approved: true },
    body: { url: './assets/approved/body-v7/xiaobai-torso.glb', version: 'body-v7', label: '身体', approved: true },
    arms: {
      label: '手臂', approved: false,
      builtin: {
        version: 'v59', label: 'v59 · 左右镜像双臂', sourceApproved: true, approved: true,
        approvalFile: './docs/approvals/v59-assembly-approved.json',
        projectRecord: { kind: 'builtin', id: 'left-arm-v59-mirrored' },
        url: './assets/design/arms-v59/left-arm.glb', linesUrl: './assets/design/arms-v59/display-lines.json',
        mirrorScale: [-1, 1, 1], sourceScale: [1, 1, 1], position: [0, 0, 0],
      },
    },
    legs: {
      label: '腿脚', approved: false,
      builtin: {
        version: 'legs-v2', label: 'legs-v2 · 平滑腿根', approved: true,
        approvalFile: './docs/approvals/legs-v2-approved.json',
        projectRecord: { kind: 'builtin', id: 'legs-smooth-v2-mirrored' },
        url: './assets/design/legs-v2/legs.glb',
      },
      versions: {
        'body-legs-fair-v6': {
          version: 'legs-v6', label: 'v6 · 身体与脚腕圆润过渡', approved: false,
          projectRecord: { kind: 'builtin', id: 'body-legs-fair-v6' },
          url: './assets/design/legs-v6/body-legs.glb', replacesBodyInDesign: true,
          review: { view: 'front', skeleton: false },
        },
        'body-legs-fused-v5': {
          version: 'legs-v5', label: 'v5 · 身体与腿连续融合', approved: false,
          projectRecord: { kind: 'builtin', id: 'body-legs-fused-v5' },
          url: './assets/design/legs-v5/body-legs.glb', replacesBodyInDesign: true,
          review: { view: 'front', skeleton: false },
        },
        'legs-continuous-v4-mirrored': {
          version: 'legs-v4', label: 'legs-v4 · 连续圆润腿脚', approved: false,
          projectRecord: { kind: 'builtin', id: 'legs-continuous-v4-mirrored' },
          url: './assets/design/legs-v4/legs.glb',
          review: { view: 'right', skeleton: false },
        },
        'legs-rounded-v3-mirrored': {
          version: 'legs-v3', label: 'legs-v3 · 圆弧腿脚优化', approved: false,
          projectRecord: { kind: 'builtin', id: 'legs-rounded-v3-mirrored' },
          url: './assets/design/legs-v3/legs.glb',
          review: { view: 'right', skeleton: false },
        },
        'legs-reference-v1-mirrored': {
          version: 'legs-v1', label: 'legs-v1 · 圆润腿脚', approved: false,
          projectRecord: { kind: 'builtin', id: 'legs-reference-v1-mirrored' },
          url: './assets/design/legs-v1/legs.glb',
        },
      },
    },
    manifest: './assets/manifest.json',
    import: { maximumBytes: 50 * 1024 * 1024, maximumVertices: 2000000, maximumMeshes: 256, maximumExtent: 1000, extensions: ['glb', 'obj'] },
  },
  viewer: {
    camera: {
      distance: 260, span: 122, target: [0, 54, 0], minZoom: 0.5, maxZoom: 4,
      near: 0.1, far: 2000, fov: 30,
      faceFocus: { target: [0, 70.1, 0], span: 82 },
      legsFocus: { target: [0, 16, 4], span: 46 },
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
    defaults: { view: 'front', wireframe: false, grid: false, skeleton: true, visibility: { head: true, body: true, arms: true, legs: true } },
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
    binding: {
      version: 'rig-v1', approval: 'approved', selectedJoint: 'shoulderL', mirrorEdits: true,
      joints: {
        shoulderL: { label: '左肩', parent: 'body', position: [-18, 43.5, 0], slot: 'arms', side: 'L' },
        elbowL: { label: '左肘', parent: 'shoulderL', position: [-31, 43, 0], slot: 'arms', side: 'L' },
        wristL: { label: '左腕', parent: 'elbowL', position: [-42, 43, 0], slot: 'arms', side: 'L' },
        handTipL: { label: '左掌端', parent: 'wristL', position: [-49, 43, 0], slot: 'arms', side: 'L' },
        hipL: { label: '左髋', parent: 'root', position: [-10.5, 22, 0], slot: 'legs', side: 'L' },
        kneeL: { label: '左膝', parent: 'hipL', position: [-13.5, 13, 2], slot: 'legs', side: 'L' },
        ankleL: { label: '左踝', parent: 'kneeL', position: [-16, 7, 4], slot: 'legs', side: 'L' },
        toeTipL: { label: '左脚尖', parent: 'ankleL', position: [-16, 4, 13], slot: 'legs', side: 'L' },
        shoulderR: { label: '右肩', parent: 'body', position: [18, 43.5, 0], slot: 'arms', side: 'R' },
        elbowR: { label: '右肘', parent: 'shoulderR', position: [31, 43, 0], slot: 'arms', side: 'R' },
        wristR: { label: '右腕', parent: 'elbowR', position: [42, 43, 0], slot: 'arms', side: 'R' },
        handTipR: { label: '右掌端', parent: 'wristR', position: [49, 43, 0], slot: 'arms', side: 'R' },
        hipR: { label: '右髋', parent: 'root', position: [10.5, 22, 0], slot: 'legs', side: 'R' },
        kneeR: { label: '右膝', parent: 'hipR', position: [13.5, 13, 2], slot: 'legs', side: 'R' },
        ankleR: { label: '右踝', parent: 'kneeR', position: [16, 7, 4], slot: 'legs', side: 'R' },
        toeTipR: { label: '右脚尖', parent: 'ankleR', position: [16, 4, 13], slot: 'legs', side: 'R' },
      },
      defaults: {
        offsets: { shoulderL: [0, 0, 0], elbowL: [0, 0, 0], wristL: [0, 0, 0], handTipL: [0, 0, 0], hipL: [0, 0, 0], kneeL: [0, 0, 0], ankleL: [0, 0, 0], toeTipL: [0, 0, 0], shoulderR: [0, 0, 0], elbowR: [0, 0, 0], wristR: [0, 0, 0], handTipR: [0, 0, 0], hipR: [0, 0, 0], kneeR: [0, 0, 0], ankleR: [0, 0, 0], toeTipR: [0, 0, 0] },
        rotations: { shoulderL: [0, 0, 0], elbowL: [0, 0, 0], wristL: [0, 0, 0], handTipL: [0, 0, 0], hipL: [0, 0, 0], kneeL: [0, 0, 0], ankleL: [0, 0, 0], toeTipL: [0, 0, 0], shoulderR: [0, 0, 0], elbowR: [0, 0, 0], wristR: [0, 0, 0], handTipR: [0, 0, 0], hipR: [0, 0, 0], kneeR: [0, 0, 0], ankleR: [0, 0, 0], toeTipR: [0, 0, 0] },
      },
      limits: { offsets: { min: -5, max: 5, step: 0.1 }, rotations: { min: -60, max: 60, step: 1 } },
      weights: {
        armAnchor: { fullAt: 13, freeAt: 22 }, armElbow: { width: 8 }, armWrist: { width: 7 },
        legKnee: { width: 8 }, legAnkle: { width: 6 },
        legCollar: { firstBlendVertex: 14401, contactVertex: 25921, radial: 160, anchorStart: 0.65 },
      },
    },
    legs: {
      sourceFit: 'xiaobai-body-review/analysis/leg-fit.json',
      domain: [0, 30], degree: 3,
      knots: [0, 0, 0, 0, 0.4, 1.2, 2.5, 4.5, 7, 9, 10.5, 12, 13.5, 15, 17, 20, 23, 26, 28, 30, 30, 30, 30],
      centerCoefficients: [17.517277066007562, 17.509653326816565, 17.492668031963102, 17.41200144763939, 17.19255142878809, 17.21740928078125, 17.093855907541343, 16.783140196767697, 16.32782195688074, 14.813296681564827, 13.735279509482226, 13.326144134925212, 12.03919740984115, 12.244483539872313, 11.166341720543537, 10.32644404193901, 10.553234013622273, 10.49995534542338, 10.499991382665538],
      logRadiusCoefficients: [0.731716990271017, 0.7470558954156801, 0.6835568455078771, 0.37759518809213977, 0.10203261238293147, -0.1693537635001985, -0.4023301998251091, -0.6685099869897072, -0.8049123685547209, -1.0789048093546356, -1.257644037611737, -1.2020885215412995, -1.0652246712245512, -1.2358350650622334, -1.015574725480946, -1.1640490037459206, -0.8769269289089835, -1.225729775619056, -0.5540943315598453],
      centerX: 16, xRawMid: 15.969673157107726, xScale: 0.9942248773296323, zScale: 1.1206031645115189,
      footDepthCenterZ: 4, footHeight: 15.8, upperCenterCorrection: -0.061906308773089336,
      targetFoot: { width: 22.7, height: 15.8, depth: 23 },
      sampling: { rings: 180, radial: 160, arcSamples: 4096, arcMeridians: 16 },
      material: { color: '#FFF1D9', roughness: 0.7, metalness: 0 },
    },
    legHipBlend: {
      preserveBelowY: 13.5, contactSpread: 2, contactSteps: 20,
      minimumCenterGap: 3, startTangentScale: 0.9, endTangentScale: 0.8,
      rings: 72, hiddenInset: 0.12, capLift: 5,
    },
    legRefinementV3: {
      version: 'legs-v3',
      // Continue the sole's curvature through the widest toe row into the instep.
      foot: { peakSearch: [5, 8], derivativeStep: 0.002 },
      // One surface-distance target for the foot, knee, collar and buried dome.
      sampling: { ringSpacing: 0.24, radial: 160, denseSteps: 2048 },
      dome: { rise: 8, startTangentLength: 4, crownRadiusScale: 0.65 },
    },
    legRefinementV4: {
      version: 'legs-v4',
      sampling: { ringSpacing: 0.24, radial: 160, denseSteps: 2048 },
      upper: {
        crownY: 33.02327303808032, crownCenterZ: 2.836507261896921,
        radiusCurvatureDecay: 0.6, radiusTaperRelaxation: 3, centerCurvatureDecay: 0.6,
        centerXRelaxation: 5.5, derivativeStep: 0.002,
      },
    },
    bodyLegBlendV5: {
      version: 'legs-v5',
      field: { cellSize: 0.35, halfWidth: 29.4, halfDepth: 22.4, blendRadius: 4.5 },
      transition: { footFadeEndY: 17, bodyFadeStartY: 26, bodyFadeEndY: 29, bodyPreserveAboveY: 30, boundaryGap: 0.25 },
      projection: { iterations: 3, derivativeStep: 0.002, relaxationPasses: 3, relaxationWeight: 0.4 },
    },
    bodyLegBlendV6: {
      version: 'legs-v6',
      field: { cellSize: 0.35, halfWidth: 29.4, halfDepth: 22.4, blendRadius: 4.5, stableLegDistance: true, distanceSamples: 2048 },
      upper: { radiusCurvatureDecay: 1.2, centerCurvatureDecay: 1.2 },
      transition: { footFadeEndY: 17, naturalBodyFade: true, bodyPreserveAboveY: 32.5, boundaryGap: 0.25 },
      projection: { iterations: 3, derivativeStep: 0.002, relaxationPasses: 3, relaxationWeight: 0.4 },
    },
    armGuides: {
      enabled: false,
      groups: { rings: true, straight: false, frontDiagonal: false, backDiagonal: false },
      color: '#466C5E', opacity: 0.52, polygonOffsetFactor: 1, polygonOffsetUnits: 1, renderOrder: 3,
    },
    rigVisual: { bodyCenterY: 36.224963, headCenterY: 70.1, jointRadius: 0.85, color: '#B8762B', lineColor: '#38685B' },
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
    actions: {
      "version": "actions-v1",
      "approval": "approved",
      "approvalFile": "./docs/approvals/actions-v1-approved.json",
      "bindingApproval": "./docs/approvals/rig-v1-approved.json",
      "names": [
        "walk",
        "run",
        "wave",
        "thinking",
        "sit"
      ],
      "defaults": {
        "transition": {
          "duration": 0.3
        },
        "walk": {
          "duration": 1.2,
          "hipFront": 20,
          "hipRear": -20,
          "kneeFront": 15,
          "kneeRear": 30,
          "armSwing": 15
        },
        "run": {
          "duration": 0.8,
          "hipFront": 45,
          "hipRear": -25,
          "knee": 70,
          "forwardLean": 8,
          "armFront": 45,
          "armRear": -35,
          "elbowFront": 95,
          "elbowRear": 80,
          "rearTwist": 180
        },
        "wave": {
          "duration": 2,
          "upperArmElevation": 70,
          "elbowFlexion": 80,
          "wristAmplitude": 15
        },
        "thinking": {
          "duration": 4,
          "minimum": 9,
          "middle": 13,
          "maximum": 17
        },
        "sit": {
          "hip": 80,
          "knee": 60
        }
      },
      "parameters": [
        {
          "path": "transition.duration",
          "label": "动作过渡",
          "min": 0,
          "max": 2,
          "step": 0.01,
          "unit": "秒",
          "group": "transition"
        },
        {
          "path": "walk.duration",
          "label": "步行周期",
          "min": 0.3,
          "max": 5,
          "step": 0.05,
          "unit": "秒",
          "group": "walk"
        },
        {
          "path": "walk.hipFront",
          "label": "前髋屈曲",
          "min": 0,
          "max": 60,
          "step": 1,
          "unit": "°",
          "group": "walk"
        },
        {
          "path": "walk.hipRear",
          "label": "后髋后摆",
          "min": -60,
          "max": 0,
          "step": 1,
          "unit": "°",
          "group": "walk"
        },
        {
          "path": "walk.kneeFront",
          "label": "前膝屈曲",
          "min": 0,
          "max": 90,
          "step": 1,
          "unit": "°",
          "group": "walk"
        },
        {
          "path": "walk.kneeRear",
          "label": "后膝屈曲",
          "min": 0,
          "max": 90,
          "step": 1,
          "unit": "°",
          "group": "walk"
        },
        {
          "path": "walk.armSwing",
          "label": "对侧臂摆幅",
          "min": 0,
          "max": 70,
          "step": 1,
          "unit": "°",
          "group": "walk"
        },
        {
          "path": "run.duration",
          "label": "小跑周期",
          "min": 0.2,
          "max": 4,
          "step": 0.05,
          "unit": "秒",
          "group": "run"
        },
        {
          "path": "run.hipFront",
          "label": "前髋屈曲",
          "min": 0,
          "max": 80,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.hipRear",
          "label": "后髋后摆",
          "min": -60,
          "max": 0,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.knee",
          "label": "膝屈曲峰值",
          "min": 0,
          "max": 120,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.forwardLean",
          "label": "上身前倾",
          "min": 0,
          "max": 25,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.armFront",
          "label": "前肩前摆",
          "min": 0,
          "max": 90,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.armRear",
          "label": "后肩后摆",
          "min": -90,
          "max": 0,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.elbowFront",
          "label": "前肘屈曲",
          "min": 0,
          "max": 140,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "run.elbowRear",
          "label": "后肘屈曲",
          "min": 0,
          "max": 140,
          "step": 1,
          "unit": "°",
          "group": "run"
        },
        {
          "path": "wave.duration",
          "label": "招手周期",
          "min": 0.3,
          "max": 10,
          "step": 0.1,
          "unit": "秒",
          "group": "wave"
        },
        {
          "path": "wave.upperArmElevation",
          "label": "上臂抬起",
          "min": 0,
          "max": 160,
          "step": 1,
          "unit": "°",
          "group": "wave"
        },
        {
          "path": "wave.elbowFlexion",
          "label": "肘屈曲",
          "min": 0,
          "max": 140,
          "step": 1,
          "unit": "°",
          "group": "wave"
        },
        {
          "path": "wave.wristAmplitude",
          "label": "手腕摆幅",
          "min": 0,
          "max": 45,
          "step": 1,
          "unit": "°",
          "group": "wave"
        },
        {
          "path": "thinking.duration",
          "label": "思考周期",
          "min": 0.5,
          "max": 20,
          "step": 0.1,
          "unit": "秒",
          "group": "thinking"
        },
        {
          "path": "thinking.minimum",
          "label": "鼻宽下限",
          "min": 9,
          "max": 17,
          "step": 0.1,
          "unit": "H100",
          "group": "thinking"
        },
        {
          "path": "thinking.middle",
          "label": "鼻宽中值",
          "min": 9,
          "max": 17,
          "step": 0.1,
          "unit": "H100",
          "group": "thinking"
        },
        {
          "path": "thinking.maximum",
          "label": "鼻宽上限",
          "min": 9,
          "max": 17,
          "step": 0.1,
          "unit": "H100",
          "group": "thinking"
        },
        {
          "path": "sit.hip",
          "label": "坐姿髋屈曲",
          "min": 0,
          "max": 110,
          "step": 1,
          "unit": "°",
          "group": "sit"
        },
        {
          "path": "sit.knee",
          "label": "坐姿膝屈曲",
          "min": 0,
          "max": 130,
          "step": 1,
          "unit": "°",
          "group": "sit"
        },
        {
          "path": "run.rearTwist",
          "label": "后臂弯曲平面",
          "min": 0,
          "max": 180,
          "step": 1,
          "unit": "°",
          "group": "run"
        }
      ],
      "waveSide": "L",
      "export": {
        "fps": 480,
        "noseMorphStep": 0.5,
        "holdSeconds": 1
      },
      "ground": {
        "level": 0
      },
      "conventions": {
        "forward": "+Z",
        "up": "+Y",
        "walkForwardSide": "R",
        "runForwardSide": "L",
        "arms": "Swing measured from vertical down; mirrored local elbow flexion.",
        "nose": "Absolute width H100; preserve capsule ends, height, centre and relief."
      }
    },
    motion: {
      defaults: { preset: 'none', playing: false, speed: 1, amplitude: 10, progress: 0, eyesPreset: 'none', nosePreset: 'none', eyeAmplitude: 1, noseAmplitude: 1 },
      presets: ['none', 'walk', 'run', 'wave', 'thinking', 'sit', 'nod', 'sway', 'breathe'],
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
    defaults: { mode: 'design', panel: 'motion', facePanel: 'eyes', materialTarget: 'head', selectedPart: 'legs', reference: 'body', overlay: 0 },
    overlay: { min: 0, max: 100, step: 1 },
    toastDuration: 4200,
  },
});
