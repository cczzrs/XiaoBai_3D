import * as THREE from 'three';
import { decodeImage, releaseImage } from './image-io.js';

/** A centered XY projection uses the source coordinates and crops rather than stretching. */
export function createProjectedUV(position, imageWidth = 1, imageHeight = 1) {
  const bounds = new THREE.Box3().setFromBufferAttribute(position);
  const width = Math.max(bounds.max.x - bounds.min.x, Number.EPSILON);
  const height = Math.max(bounds.max.y - bounds.min.y, Number.EPSILON);
  const aspect = width / height;
  const imageAspect = imageWidth / imageHeight;
  const spanX = Math.min(1, aspect / imageAspect);
  const spanY = Math.min(1, imageAspect / aspect);
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    uv[index * 2] = 0.5 + ((position.getX(index) - bounds.min.x) / width - 0.5) * spanX;
    uv[index * 2 + 1] = 0.5 + ((position.getY(index) - bounds.min.y) / height - 0.5) * spanY;
  }
  return new THREE.BufferAttribute(uv, 2);
}

export function backgroundImageRect(imageWidth, imageHeight, width, height, fit) {
  const scale = (fit === 'contain' ? Math.min : Math.max)(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  return { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

export function materialTarget(slot, name, config) {
  if (slot !== 'head') return slot;
  const nodes = config.design.face.nodes;
  if (name === nodes.leftEye || name === nodes.rightEye) return 'eyes';
  if (name === nodes.nose) return 'nose';
  return 'head';
}

const materialsOf = (mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const recordKey = (record) => record ? `${record.mime}:${record.data}` : null;

/** Owns only draft material overrides, draft UVs and decoded appearance resources. */
export function createAppearanceController({ scene, renderer, config, viewport, onLighting, onChange = () => {}, decode = decodeImage, release = releaseImage }) {
  const entries = new Map();
  const owner = {};
  let active = null;
  let disposed = false;

  function releaseResource(resource) {
    resource.references -= 1;
    if (resource.references === 0) {
      resource.texture.dispose();
      resource.gltfTexture.dispose();
      release(resource.image);
    }
  }

  function drawBackground(prepared) {
    if (!prepared.background) return;
    const background = prepared.background;
    const { width, height } = viewport();
    const limit = renderer.capabilities.maxTextureSize;
    const scale = Math.min(1, limit / Math.max(width, height));
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));
    if (background.canvas?.width === pixelWidth && background.canvas?.height === pixelHeight) return;

    // WebGL's immutable texture storage cannot resize through needsUpdate alone.
    // Draw a fresh offscreen canvas, then replace the texture only after it is ready.
    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法绘制背景图片。');
    context.fillStyle = prepared.state.background.color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const image = background.resource.image;
    const rect = backgroundImageRect(image.naturalWidth, image.naturalHeight, canvas.width, canvas.height, prepared.state.background.fit);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const previous = background.texture;
    background.canvas = canvas;
    background.texture = texture;
    if (prepared === active) scene.background = texture;
    previous?.dispose();
  }

  async function prepare(next) {
    if (disposed) throw new Error('3D 工作区已关闭。');
    const state = structuredClone(next);
    const resources = new Map();
    const prepared = {
      owner, state, resources, background: null, disposed: false,
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.background?.texture?.dispose();
        for (const resource of resources.values()) releaseResource(resource);
        resources.clear();
      },
    };
    try {
      const records = [...Object.values(state.materials).map((value) => value.image), state.background.image].filter(Boolean);
      for (const record of records) {
        const key = recordKey(record);
        if (resources.has(key)) continue;
        const reusable = active?.resources.get(key);
        if (reusable) {
          reusable.references += 1;
          resources.set(key, reusable);
          continue;
        }
        const image = await decode(record);
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate = true;
        const gltfTexture = texture.clone();
        gltfTexture.flipY = false;
        gltfTexture.needsUpdate = true;
        resources.set(key, { image, texture, gltfTexture, references: 1 });
      }
      if (state.background.image) {
        prepared.background = { canvas: null, texture: null, resource: resources.get(recordKey(state.background.image)) };
        drawBackground(prepared);
      }
      if (disposed) throw new Error('3D 工作区已关闭。');
      return prepared;
    } catch (error) {
      prepared.dispose();
      throw error;
    }
  }

  function applyEntry(entry) {
    if (!active) return;
    const setting = active.state.materials[entry.target];
    const resource = setting.image ? active.resources.get(recordKey(setting.image)) : null;
    const texture = resource ? (entry.gltfUV ? resource.gltfTexture : resource.texture) : null;
    const wireframes = materialsOf(entry.mesh).map((material) => material.wireframe);
    const projectionAspect = setting.image ? setting.image.width / setting.image.height : null;
    if (setting.enabled && texture && entry.projection && entry.projectionAspect !== projectionAspect) {
      entry.mesh.geometry.setAttribute('uv', createProjectedUV(entry.projection, setting.image.width, setting.image.height));
      entry.projectionAspect = projectionAspect;
    }
    entry.overrides.forEach((material, index) => {
      const baseline = entry.originals[index];
      material.color.set(setting.color);
      material.roughness = setting.roughness;
      material.map = texture;
      material.transparent = Boolean(texture) || baseline.transparent;
      material.wireframe = wireframes[index];
      material.needsUpdate = true;
      baseline.wireframe = wireframes[index];
    });
    const chosen = setting.enabled ? entry.overrides : entry.originals;
    entry.mesh.material = entry.multiple ? chosen : chosen[0];
  }

  function register(root, source, slot, format) {
    const sourceGeometry = new Set();
    source.traverse((object) => { if (object.geometry) sourceGeometry.add(object.geometry); });
    const registered = [];
    root.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.material) return;
      const originals = materialsOf(mesh);
      const projection = mesh.geometry.hasAttribute('uv') ? null : mesh.geometry.getAttribute('position').clone();
      if (projection) {
        if (sourceGeometry.has(mesh.geometry)) mesh.geometry = mesh.geometry.clone();
        mesh.geometry.setAttribute('uv', createProjectedUV(projection));
      }
      const entry = {
        mesh, target: materialTarget(slot, mesh.name, config), originals, multiple: Array.isArray(mesh.material), projection, gltfUV: !projection && format === 'glb', projectionAspect: null,
        overrides: originals.map((original) => new THREE.MeshStandardMaterial({
          name: `${original.name || mesh.name}_DesignAppearance`,
          side: original.side, opacity: original.opacity, alphaTest: original.alphaTest,
          depthTest: original.depthTest, depthWrite: original.depthWrite,
        })),
      };
      registered.push(entry);
      applyEntry(entry);
    });
    entries.set(root, registered);
  }

  function unregister(root) {
    for (const entry of entries.get(root) ?? []) {
      entry.mesh.material = entry.multiple ? entry.originals : entry.originals[0];
      for (const material of entry.overrides) { material.map = null; material.dispose(); }
    }
    entries.delete(root);
  }

  function commit(prepared) {
    if (disposed || prepared?.owner !== owner || prepared.disposed || prepared === active) throw new Error('外观资源已失效，请重新载入。');
    // The viewport may have changed while a project decoded candidates or images.
    drawBackground(prepared);
    const previous = active;
    active = prepared;
    for (const values of entries.values()) for (const entry of values) applyEntry(entry);
    scene.background = prepared.background?.texture ?? new THREE.Color(prepared.state.background.color);
    onLighting(prepared.state.lighting);
    previous?.dispose();
    onChange();
  }

  return {
    prepare, commit, register, unregister,
    resize() { if (active?.background) { drawBackground(active); onChange(); } },
    getState() { return active ? structuredClone(active.state) : structuredClone(config.appearance.defaults); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const root of entries.keys()) unregister(root);
      active?.dispose();
      active = null;
    },
  };
}

/** Matches the approved head viewer: exclusive uniform / camera-relative soft-light modes. */
export function createStudioLighting(scene, renderer, config) {
  const settings = config.viewer.lighting;
  const uniform = new THREE.AmbientLight(settings.uniform.color, settings.uniform.intensity);
  uniform.name = 'XiaoBai_UniformLight';
  const rig = new THREE.Group();
  rig.name = 'XiaoBai_CameraLightRig';
  const directional = new THREE.Group();
  directional.name = 'XiaoBai_SoftLightGroup';
  rig.add(directional);
  directional.add(new THREE.HemisphereLight(settings.ambient.sky, settings.ambient.ground, settings.ambient.intensity));
  const keyLights = [];
  for (const role of ['key', 'fill', 'rim']) {
    const lightConfig = settings[role];
    const samples = lightConfig.spread ? lightConfig.samples.flatMap((x) => lightConfig.samples.map((y) => [x, y])) : [[0, 0]];
    for (const [x, y] of samples) {
      const light = new THREE.DirectionalLight(lightConfig.color, lightConfig.intensity / samples.length);
      light.name = `XiaoBai_${role}_${x}_${y}`;
      light.position.fromArray(lightConfig.position);
      if (role === 'key') keyLights.push({ light, offset: new THREE.Vector3(x * lightConfig.spread[0], y * lightConfig.spread[1], (x - y) * lightConfig.spread[2] / 2) });
      directional.add(light, light.target);
    }
  }
  scene.add(uniform, rig);
  let state = structuredClone(config.appearance.defaults.lighting);
  function setState(next) {
    state = { ...state, ...next };
    uniform.visible = !state.enabled;
    directional.visible = Boolean(state.enabled);
    const yaw = THREE.MathUtils.degToRad(state.azimuth);
    const elevation = THREE.MathUtils.degToRad(state.elevation);
    const distance = settings.directional.distance;
    const position = new THREE.Vector3(Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation)).multiplyScalar(distance);
    for (const { light, offset } of keyLights) {
      light.position.copy(position).add(offset);
      light.intensity = state.intensity / keyLights.length;
    }
    renderer.toneMappingExposure = state.exposure;
  }
  setState(state);
  return {
    setState,
    update(camera, target) {
      camera.updateMatrixWorld(true);
      rig.position.copy(target);
      if (settings.space === 'camera') rig.quaternion.copy(camera.quaternion);
      else rig.quaternion.identity();
    },
    getState() { return { ...state }; },
    dispose() { uniform.removeFromParent(); rig.removeFromParent(); },
  };
}
