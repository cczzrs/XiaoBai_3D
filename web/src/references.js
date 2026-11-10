/** Reference crops retain original pixels. Canvas places them in the same world projection as the model. */
export async function createReferences({ preview, overlay, studio, config, onCaption }) {
  const response = await fetch('./assets/references/registration.json');
  if (!response.ok) throw new Error('参考配准文件读取失败。');
  const registration = await response.json();
  let selected = config.ui.defaults.reference;
  let opacity = config.ui.defaults.overlay;
  let mode = config.ui.defaults.mode;
  const images = new Map();
  let currentImage = null;
  let current = null;
  let loadGeneration = 0;

  function canvasContext(canvas) {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio, config.viewer.renderer.pixelRatioLimit);
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: bounds.width, height: bounds.height };
  }
  function chooseRegistration() {
    const view = studio.getCameraState().view;
    if (selected === 'head') return registration.head[view] ?? registration.head.front;
    if (selected === 'arms') return registration.arms?.last_action ?? null;
    if (view === 'front' || view === 'perspective') return registration.body.frame_0;
    return registration.body[`turnaround_${view}`] ?? registration.body.frame_0;
  }
  async function refresh() {
    const generation = ++loadGeneration;
    const nextRegistration = chooseRegistration();
    current = null;
    currentImage = null;
    draw();
    if (!nextRegistration) return;
    const imagePath = nextRegistration.image;
    let image = images.get(imagePath);
    if (!image) {
      image = new Image();
      image.src = `./${imagePath}`;
      await image.decode();
      images.set(imagePath, image);
    }
    if (generation !== loadGeneration) return;
    current = nextRegistration;
    currentImage = image;
    draw();
  }
  function draw() {
    const mini = canvasContext(preview);
    const layer = canvasContext(overlay);
    if (!current || !currentImage) return;
    const [sx, sy, sw, sh] = current.crop;
    const fit = Math.min((mini.width - 16) / sw, (mini.height - 12) / sh);
    if (fit > 0) mini.context.drawImage(currentImage, sx, sy, sw, sh, (mini.width - sw * fit) / 2, (mini.height - sh * fit) / 2, sw * fit, sh * fit);
    const camera = studio.getCameraState();
    const yaw = (current.yaw ?? 0) * Math.PI / 180;
    const dx = camera.position[0] - camera.target[0];
    const dy = camera.position[1] - camera.target[1];
    const dz = camera.position[2] - camera.target[2];
    const length = Math.hypot(dx, dy, dz);
    const aligned = camera.orthographic && Math.abs(dy / length) < 0.001 && Math.abs(dx / length - Math.sin(yaw)) < 0.001 && Math.abs(dz / length - Math.cos(yaw)) < 0.001;
    const label = selected === 'body' && camera.view === 'front' ? '身体主要参考 · TIFF 第 1 帧' : current.label ?? '原始参考图';
    const mapped = Number.isFinite(current.scale) && Number.isFinite(current.floorY);
    onCaption({ label, aligned: aligned && mapped, paused: opacity > 0 && (!aligned || !mapped), mapped });
    if (mode !== 'build' || opacity <= 0 || !aligned || !mapped) return;
    const x = (sx - current.centerX) * current.scale;
    const y = (current.floorY - sy) * current.scale;
    const point = studio.projectPoint([x * Math.cos(yaw), y, -x * Math.sin(yaw)]);
    const oppositeX = x + sw * current.scale;
    const opposite = studio.projectPoint([oppositeX * Math.cos(yaw), y - sh * current.scale, -oppositeX * Math.sin(yaw)]);
    layer.context.globalAlpha = opacity / 100;
    layer.context.drawImage(currentImage, sx, sy, sw, sh, point.x, point.y, opposite.x - point.x, opposite.y - point.y);
  }
  const observer = new ResizeObserver(draw);
  observer.observe(preview);
  observer.observe(overlay);
  try { await refresh(); } catch (error) { observer.disconnect(); throw error; }
  return {
    refresh, draw,
    async select(value) { selected = value; await refresh(); },
    setOpacity(value) { opacity = value; draw(); },
    setMode(value) { mode = value; draw(); },
    dispose() { observer.disconnect(); },
  };
}
