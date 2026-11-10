import { APP_CONFIG } from './config.js';
import { validateImage } from './image-io.js';
import { getBuiltinPartAsset } from './builtin-parts.js';

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const OBJ_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const PART_KEYS = ['name', 'format', 'data'];
// 已发布 revision 1 的存储契约，与当前新建项目默认值分开维护。
const LEGACY_DESIGN_KEYS = {
  shape: ['headScale', 'bodyWidth', 'bodyHeight', 'bodyDepth'],
  rig: ['rootY', 'neckY'],
  pose: ['headYaw', 'headPitch', 'headRoll', 'bodyLean'],
};
const LEGACY_MOTION_KEYS = ['preset', 'playing', 'speed', 'amplitude', 'progress'];

/** 新建可编辑设计。已批准的头、身体始终来自 config 中的固定资源。 */
export function createDefaultProject() {
  return {
    schema: APP_CONFIG.project.schema,
    revision: APP_CONFIG.project.revision,
    design: structuredClone(APP_CONFIG.design.defaults),
    motion: structuredClone(APP_CONFIG.design.motion.defaults),
    parts: {
      arms: structuredClone(APP_CONFIG.assets.arms.builtin.projectRecord),
      legs: structuredClone(APP_CONFIG.assets.legs.builtin.projectRecord),
    },
    appearance: structuredClone(APP_CONFIG.appearance.defaults),
    expression: structuredClone(APP_CONFIG.design.expression.defaults),
    binding: structuredClone(APP_CONFIG.design.binding.defaults),
    actions: { parameters: structuredClone(APP_CONFIG.design.actions.defaults), waveSide: APP_CONFIG.design.actions.waveSide },
  };
}

function fail(message) {
  throw new Error(message);
}

function record(value, keys, label, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}包含不支持的对象类型。`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(`${label}包含不允许的字段：${String(key)}。`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail(`${label}不能包含动态属性。`);
  }
  for (const key of keys) {
    if (!optionalKeys.includes(key) && !Object.hasOwn(value, key)) fail(`${label}缺少字段：${key}。`);
  }
}

function numberInRange(value, range, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}必须是有限数字。`);
  if (value < range.min || value > range.max) fail(`${label}必须在 ${range.min} 到 ${range.max} 之间。`);
  return value;
}

function bytesFromBase64(data) {
  const maximum = APP_CONFIG.assets.import.maximumBytes;
  if (typeof data !== 'string' || !data.length) fail('候选部件的模型数据不能为空。');
  if (data.length > Math.ceil(maximum / 3) * 4) fail('候选部件超过允许的文件大小。');
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) fail('候选部件不是有效的 base64 数据。');
  const decoded = atob(data);
  if (decoded.length > maximum) fail('候选部件超过允许的文件大小。');
  // 排除非规范的补齐位，保证保存、重载具有唯一的二进制表示。
  if (btoa(decoded) !== data) fail('候选部件的 base64 编码不规范。');
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join(''));
}

function validateGlb(bytes) {
  if (bytes.length < 20) fail('GLB 文件不完整。');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2) {
    fail('候选部件必须是 GLB 2.0 文件。');
  }
  if (header.getUint32(8, true) !== bytes.length) fail('GLB 文件长度与头部声明不一致。');
  let offset = 12;
  let gltf = null;
  let binaryChunkSize = 0;
  let binarySeen = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('GLB 数据块头不完整。');
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length % 4 !== 0 || start + length > bytes.length) fail('GLB 数据块长度无效。');
    if (offset === 12 && type !== 0x4e4f534a) fail('GLB 必须以 JSON 数据块开头。');
    if (type === 0x4e4f534a) {
      if (gltf) fail('GLB 包含重复的 JSON 数据块。');
      try {
        gltf = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length)));
      } catch {
        fail('GLB 中的 JSON 数据无效。');
      }
      if (!gltf || Array.isArray(gltf) || typeof gltf !== 'object' || gltf.asset?.version !== '2.0') {
        fail('GLB 缺少有效的 glTF 2.0 资源声明。');
      }
    } else if (type === 0x004e4942) {
      if (binarySeen) fail('GLB 包含重复的二进制数据块。');
      binarySeen = true;
      binaryChunkSize = length;
    }
    offset = start + length;
  }
  // 项目 JSON 必须独立恢复；不允许导入后再依赖磁盘旁的纹理或远程资源。
  for (const collection of ['buffers', 'images']) {
    if (gltf[collection] !== undefined && !Array.isArray(gltf[collection])) fail(`GLB 的 ${collection} 必须是数组。`);
    for (const entry of gltf[collection] || []) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`GLB 的 ${collection} 内容无效。`);
      if (entry.uri !== undefined && (typeof entry.uri !== 'string' || !entry.uri.startsWith('data:'))) {
        fail('GLB 含外部资源，请先将纹理和缓冲区嵌入文件。');
      }
    }
  }
  for (const [index, buffer] of (gltf.buffers || []).entries()) {
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0) fail('GLB 缓冲区长度无效。');
    if (buffer.uri === undefined && (index !== 0 || !binarySeen || buffer.byteLength > binaryChunkSize)) {
      fail('GLB 声明的缓冲区缺少完整二进制数据。');
    }
  }
}

function validateObj(bytes) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('OBJ 文件必须是有效的 UTF-8 文本。');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) fail('OBJ 文件含有无效的二进制内容。');
  const counts = { v: 0, vt: 0, vn: 0 };
  const maximumIndices = { v: 0, vt: 0, vn: 0 };
  let faces = 0;
  for (const line of source.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const content = line.replace(/#.*/, '').trim();
    if (!content) continue;
    const [command, ...values] = content.split(/\s+/);
    if (Object.hasOwn(counts, command)) {
      const minimum = command === 'vt' ? 1 : 3;
      if (values.length < minimum || values.some((value) => !OBJ_NUMBER_PATTERN.test(value) || !Number.isFinite(Number(value)))) {
        fail('OBJ 顶点、纹理或法线坐标无效。');
      }
      counts[command] += 1;
    } else if (command === 'f') {
      if (values.length < 3) fail('OBJ 的面至少需要三个顶点。');
      for (const vertex of values) {
        if (!/^-?\d+(?:\/-?\d+|\/(?:-?\d+)?\/-?\d+)?$/.test(vertex)) fail('OBJ 面索引格式无效。');
        const indexes = vertex.split('/');
        for (let component = 0; component < indexes.length; component += 1) {
          if (!indexes[component]) continue;
          const type = ['v', 'vt', 'vn'][component];
          const index = Number(indexes[component]);
          if (!Number.isSafeInteger(index) || index === 0 || (index < 0 && -index > counts[type])) {
            fail('OBJ 面索引超出已定义的坐标范围。');
          }
          maximumIndices[type] = Math.max(maximumIndices[type], index);
        }
      }
      faces += 1;
    }
  }
  if (counts.v < 3 || faces === 0) fail('OBJ 文件需要至少三个顶点和一个面。');
  for (const type of Object.keys(counts)) {
    if (maximumIndices[type] > counts[type]) fail('OBJ 面引用了不存在的坐标。');
  }
}

function validatePart(part, slot = 'arms', revision = APP_CONFIG.project.revision) {
  if (part && typeof part === 'object' && Object.hasOwn(part, 'kind')) {
    record(part, ['kind', 'id'], '内置部件');
    if (!['arms', 'legs'].includes(slot)) fail('内置部件槽位不受支持。');
    const minimumRevision = slot === 'arms' ? 5 : 6;
    if (revision < minimumRevision) fail('旧版项目不允许该槽位的内置部件记录。');
    const asset = getBuiltinPartAsset(APP_CONFIG, slot, part);
    if (!asset) fail('内置部件与槽位允许的模型不匹配。');
    return { part: structuredClone(asset.projectRecord), builtin: true };
  }
  record(part, PART_KEYS, '候选部件');
  if (typeof part.name !== 'string' || !part.name.trim() || part.name.length > 255 || /[\u0000-\u001f/\\]/.test(part.name)) {
    fail('候选部件文件名无效。');
  }
  if (!APP_CONFIG.assets.import.extensions.includes(part.format)) fail('仅支持 GLB 或 OBJ 候选部件。');
  if (!part.name.toLowerCase().endsWith(`.${part.format}`)) fail('候选部件扩展名与格式不一致。');
  const bytes = bytesFromBase64(part.data);
  if (part.format === 'glb') validateGlb(bytes);
  else validateObj(bytes);
  return { part: { name: part.name, format: part.format, data: part.data }, bytes };
}

function color(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) fail(`${label}必须是 #RRGGBB 颜色。`);
  return value.toUpperCase();
}

/** 同步外观校验；图像真解码和渲染资源准备由视口在提交前完成。 */
export function validateAppearance(value) {
  const defaults = APP_CONFIG.appearance.defaults;
  record(value, Object.keys(defaults), '外观');
  record(value.materials, Object.keys(defaults.materials), '部件材质');
  const materials = {};
  for (const [slot, settings] of Object.entries(defaults.materials)) {
    const material = value.materials[slot];
    record(material, Object.keys(settings), `材质 ${slot}`);
    if (typeof material.enabled !== 'boolean') fail(`材质 ${slot} 的启用状态必须是布尔值。`);
    materials[slot] = {
      enabled: material.enabled,
      color: color(material.color, `材质 ${slot} 颜色`),
      roughness: numberInRange(material.roughness, APP_CONFIG.appearance.limits.roughness, `材质 ${slot} 粗糙度`),
      image: material.image === null ? null : validateImage(material.image),
    };
  }
  record(value.background, Object.keys(defaults.background), '背景');
  if (!APP_CONFIG.appearance.backgroundFits.includes(value.background.fit)) fail('背景图片适配方式不受支持。');
  const background = {
    color: color(value.background.color, '背景颜色'),
    image: value.background.image === null ? null : validateImage(value.background.image),
    fit: value.background.fit,
  };
  record(value.lighting, Object.keys(defaults.lighting), '外观光照');
  if (typeof value.lighting.enabled !== 'boolean') fail('定向光启用状态必须是布尔值。');
  const lighting = { enabled: value.lighting.enabled };
  for (const key of ['azimuth', 'elevation', 'intensity', 'exposure']) {
    lighting[key] = numberInRange(value.lighting[key], APP_CONFIG.viewer.lighting.limits[key], `光照 ${key}`);
  }
  return { materials, background, lighting };
}

function validateExpression(value) {
  record(value, ['preset', 'intensity'], '表情');
  if (typeof value.preset !== 'string' || !Object.hasOwn(APP_CONFIG.design.expression.presets, value.preset)) fail('表情预设不受支持。');
  return {
    preset: value.preset,
    intensity: numberInRange(value.intensity, APP_CONFIG.design.expression.intensity, '表情强度'),
  };
}

function bindingVector(value, range, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3) {
    fail(`${label}必须是三个分量的数组。`);
  }
  const keys = ['0', '1', '2', 'length'];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(`${label}包含不允许的字段：${String(key)}。`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail(`${label}不能包含动态属性。`);
  }
  for (const key of ['0', '1', '2']) {
    if (!Object.hasOwn(value, key)) fail(`${label}缺少分量：${key}。`);
  }
  return [0, 1, 2].map((axis) => numberInRange(value[axis], range, `${label}[${axis}]`));
}

/** 仅保存关节偏移和旋转；不允许从项目文件注入骨骼层级或运行时动作。 */
export function validateBinding(value) {
  const settings = APP_CONFIG.design.binding;
  const groups = ['offsets', 'rotations'];
  const keys = Object.keys(settings.joints);
  record(value, groups, '关节绑定');
  const binding = {};
  for (const group of groups) {
    record(value[group], keys, `关节绑定 ${group}`);
    binding[group] = {};
    for (const key of keys) {
      binding[group][key] = bindingVector(value[group][key], settings.limits[group], `${group}.${key}`);
    }
  }
  return binding;
}

/** Editable motion parameters, independent from approved bind coordinates. */
export function validateActions(value) {
  record(value, ['parameters', 'waveSide'], '动作设计');
  const settings = APP_CONFIG.design.actions;
  const groups = Object.keys(settings.defaults);
  record(value.parameters, groups, '动作参数分组');
  const parameters = {};
  for (const group of groups) {
    const keys = Object.keys(settings.defaults[group]);
    record(value.parameters[group], keys, `动作 ${group}`);
    parameters[group] = {};
    for (const key of keys) {
      const range = settings.parameters.find((entry) => entry.path === `${group}.${key}`);
      parameters[group][key] = numberInRange(value.parameters[group][key], range, `${group}.${key}`);
    }
  }
  const { minimum, middle, maximum } = parameters.thinking;
  if (minimum > middle || middle > maximum) fail('鼻宽必须满足下限 ≤ 中值 ≤ 上限。');
  if (!['L', 'R'].includes(value.waveSide)) fail('招手侧必须是 L 或 R。');
  return { parameters, waveSide: value.waveSide };
}

function checkProjectSize(project) {
  const limit = APP_CONFIG.appearance.images.maximumProjectBytes;
  let base64Bytes = 0;
  // Base64 is ASCII. Count it without duplicating every large embedded resource.
  const structure = JSON.stringify(project, (key, value) => {
    if (key === 'data') {
      base64Bytes += value.length;
      if (base64Bytes > limit) fail('项目文件超过允许的总大小。');
      return '';
    }
    return value;
  }, 2);
  if (base64Bytes + new TextEncoder().encode(structure).byteLength > limit) fail('项目文件超过允许的总大小。');
}

/** 严格校验并返回与输入无共享可变引用的项目；恢复后动作一律暂停。 */
export function validateProject(value) {
  record(value, ['schema', 'revision', 'design', 'motion', 'parts', 'appearance', 'expression', 'binding', 'actions'], '项目', ['appearance', 'expression', 'binding', 'actions']);
  if (value.schema !== APP_CONFIG.project.schema) fail('项目 schema 不受支持。');
  if (![1, 2, 3, 4, 5, 6, 7, APP_CONFIG.project.revision].includes(value.revision)) fail('项目 revision 不受支持。');
  if (value.revision < 3 && Object.hasOwn(value, 'appearance')) fail('旧版项目包含不允许的 appearance 字段。');
  if (value.revision >= 3 && !Object.hasOwn(value, 'appearance')) fail('项目缺少字段：appearance。');
  if (value.revision < 4 && Object.hasOwn(value, 'expression')) fail('旧版项目包含不允许的 expression 字段。');
  if (value.revision >= 4 && !Object.hasOwn(value, 'expression')) fail('项目缺少字段：expression。');
  if (value.revision < 7 && Object.hasOwn(value, 'binding')) fail('旧版项目包含不允许的 binding 字段。');
  if (value.revision >= 7 && !Object.hasOwn(value, 'binding')) fail('项目缺少字段：binding。');
  if (value.revision < 8 && Object.hasOwn(value, 'actions')) fail('旧版项目包含不允许的 actions 字段。');
  if (value.revision >= 8 && !Object.hasOwn(value, 'actions')) fail('项目缺少字段：actions。');
  const legacy = value.revision === 1;
  const designKeys = legacy ? LEGACY_DESIGN_KEYS : Object.fromEntries(
    Object.entries(APP_CONFIG.design.defaults).map(([group, defaults]) => [group, Object.keys(defaults)]),
  );
  const design = {};
  record(value.design, Object.keys(designKeys), '设计参数');
  for (const [group, keys] of Object.entries(designKeys)) {
    record(value.design[group], keys, `设计参数 ${group}`);
    design[group] = {};
    for (const key of keys) {
      design[group][key] = numberInRange(value.design[group][key], APP_CONFIG.design.limits[group][key], `${group}.${key}`);
    }
  }
  record(value.motion, legacy ? LEGACY_MOTION_KEYS : Object.keys(APP_CONFIG.design.motion.defaults), '动作参数');
  if (!APP_CONFIG.design.motion.presets.includes(value.motion.preset)) fail('动作预设不受支持。');
  if (typeof value.motion.playing !== 'boolean') fail('动作播放状态必须是布尔值。');
  const motion = {
    preset: value.motion.preset,
    playing: false,
    speed: numberInRange(value.motion.speed, APP_CONFIG.design.motion.speed, '动作速度'),
    amplitude: numberInRange(value.motion.amplitude, APP_CONFIG.design.motion.amplitude, '动作幅度'),
    progress: numberInRange(value.motion.progress, APP_CONFIG.design.motion.timeline, '动作进度'),
  };
  if (!legacy) {
    if (!APP_CONFIG.design.motion.eyesPresets.includes(value.motion.eyesPreset)) fail('眼睛动作预设不受支持。');
    if (!APP_CONFIG.design.motion.nosePresets.includes(value.motion.nosePreset)) fail('鼻子动作预设不受支持。');
    motion.eyesPreset = value.motion.eyesPreset;
    motion.nosePreset = value.motion.nosePreset;
    motion.eyeAmplitude = numberInRange(value.motion.eyeAmplitude, APP_CONFIG.design.motion.eyeAmplitude, '眼睛动作幅度');
    motion.noseAmplitude = numberInRange(value.motion.noseAmplitude, APP_CONFIG.design.motion.noseAmplitude, '鼻子动作幅度');
  }
  record(value.parts, ['arms', 'legs'], '候选部件列表（已批准的头部和身体不可替换）');
  const parts = {};
  for (const key of ['arms', 'legs']) {
    parts[key] = value.parts[key] === null ? null : validatePart(value.parts[key], key, value.revision).part;
  }
  const appearance = value.revision < 3 ? structuredClone(APP_CONFIG.appearance.defaults) : validateAppearance(value.appearance);
  const expression = value.revision < 4 ? structuredClone(APP_CONFIG.design.expression.defaults) : validateExpression(value.expression);
  const binding = value.revision < 7 ? structuredClone(APP_CONFIG.design.binding.defaults) : validateBinding(value.binding);
  // 旧版完整通过校验后才补入中立眼鼻、外观和表情；原设计逐项保留。
  const defaults = createDefaultProject();
  const output = {
    ...defaults,
    design: { ...defaults.design, ...design },
    motion: { ...defaults.motion, ...motion },
    parts,
    appearance,
    expression,
    binding,
    actions: value.revision < 8 ? defaults.actions : validateActions(value.actions),
  };
  checkProjectSize(output);
  return output;
}

export function parseProject(text) {
  if (typeof text !== 'string') fail('项目内容必须是 JSON 文本。');
  const maximumBytes = APP_CONFIG.appearance.images.maximumProjectBytes;
  if (text.length > maximumBytes) fail('项目文件超过允许的总大小。');
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 8192, text.length);
    // Keep a surrogate pair together when measuring UTF-8 in bounded chunks.
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    bytes += encoder.encode(text.slice(offset, end)).byteLength;
    if (bytes > maximumBytes) fail('项目文件超过允许的总大小。');
    offset = end;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('项目 JSON 格式无效。');
  }
  return validateProject(value);
}

export function serializeProject(project) {
  return JSON.stringify(validateProject(project), null, 2);
}

/** 将用户选择的文件作为可随项目携带的候选部件保存。 */
export async function encodePart(file) {
  if (!file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0) {
    fail('请选择非空的 GLB 或 OBJ 文件。');
  }
  if (file.size > APP_CONFIG.assets.import.maximumBytes) fail('候选部件超过允许的文件大小。');
  const format = file.name.split('.').pop().toLowerCase();
  if (!APP_CONFIG.assets.import.extensions.includes(format)) fail('仅支持 GLB 或 OBJ 候选部件。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) fail('候选部件读取不完整。');
  return validatePart({ name: file.name, format, data: bytesToBase64(bytes) }).part;
}

export function decodePart(part, slot = 'arms') {
  const validated = validatePart(part, slot);
  if (validated.builtin) return structuredClone(validated.part);
  return new File([validated.bytes], validated.part.name, {
    type: validated.part.format === 'glb' ? 'model/gltf-binary' : 'text/plain',
  });
}
