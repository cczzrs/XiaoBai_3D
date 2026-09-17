import { APP_CONFIG } from './config.js';

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const OBJ_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const PART_KEYS = ['name', 'format', 'data'];

/** 新建可编辑设计。已批准的头、身体始终来自 config 中的固定资源。 */
export function createDefaultProject() {
  return {
    schema: APP_CONFIG.project.schema,
    revision: APP_CONFIG.project.revision,
    design: structuredClone(APP_CONFIG.design.defaults),
    motion: structuredClone(APP_CONFIG.design.motion.defaults),
    parts: { arms: null, legs: null },
  };
}

function fail(message) {
  throw new Error(message);
}

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}包含不支持的对象类型。`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(`${label}包含不允许的字段：${String(key)}。`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail(`${label}不能包含动态属性。`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label}缺少字段：${key}。`);
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

function validatePart(part) {
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

/** 严格校验并返回与输入无共享可变引用的项目；恢复后动作一律暂停。 */
export function validateProject(value) {
  record(value, ['schema', 'revision', 'design', 'motion', 'parts'], '项目');
  if (value.schema !== APP_CONFIG.project.schema) fail('项目 schema 不受支持。');
  if (value.revision !== APP_CONFIG.project.revision) fail('项目 revision 不受支持。');
  const output = createDefaultProject();
  record(value.design, Object.keys(APP_CONFIG.design.defaults), '设计参数');
  for (const [group, defaults] of Object.entries(APP_CONFIG.design.defaults)) {
    record(value.design[group], Object.keys(defaults), `设计参数 ${group}`);
    for (const key of Object.keys(defaults)) {
      output.design[group][key] = numberInRange(value.design[group][key], APP_CONFIG.design.limits[group][key], `${group}.${key}`);
    }
  }
  record(value.motion, Object.keys(APP_CONFIG.design.motion.defaults), '动作参数');
  if (!APP_CONFIG.design.motion.presets.includes(value.motion.preset)) fail('动作预设不受支持。');
  if (typeof value.motion.playing !== 'boolean') fail('动作播放状态必须是布尔值。');
  output.motion = {
    preset: value.motion.preset,
    playing: false,
    speed: numberInRange(value.motion.speed, APP_CONFIG.design.motion.speed, '动作速度'),
    amplitude: numberInRange(value.motion.amplitude, APP_CONFIG.design.motion.amplitude, '动作幅度'),
    progress: numberInRange(value.motion.progress, { min: 0, max: 1 }, '动作进度'),
  };
  record(value.parts, ['arms', 'legs'], '候选部件列表（已批准的头部和身体不可替换）');
  for (const key of ['arms', 'legs']) {
    output.parts[key] = value.parts[key] === null ? null : validatePart(value.parts[key]).part;
  }
  return output;
}

export function parseProject(text) {
  if (typeof text !== 'string') fail('项目内容必须是 JSON 文本。');
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

export function decodePart(part) {
  const validated = validatePart(part);
  return new File([validated.bytes], validated.part.name, {
    type: validated.part.format === 'glb' ? 'model/gltf-binary' : 'text/plain',
  });
}
