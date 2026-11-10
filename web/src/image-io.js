import { APP_CONFIG } from './config.js';

const IMAGE_KEYS = ['name', 'mime', 'data', 'width', 'height'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const fail = (message) => { throw new Error(message); };
const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

function checkRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('图片记录必须是对象。');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('图片记录包含不支持的对象类型。');
  for (const key of Reflect.ownKeys(value)) {
    if (!IMAGE_KEYS.includes(key)) fail(`图片记录包含不允许的字段：${String(key)}。`);
    if (!('value' in Object.getOwnPropertyDescriptor(value, key))) fail('图片记录不能包含动态属性。');
  }
  for (const key of IMAGE_KEYS) if (!Object.hasOwn(value, key)) fail(`图片记录缺少字段：${key}。`);
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\u0000-\u001f/\\]/.test(name)) fail('图片文件名无效。');
}

function checkDimensions(width, height) {
  const limits = APP_CONFIG.appearance.images;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('图片宽高必须是正整数。');
  if (width > limits.maximumDimension || height > limits.maximumDimension || width * height > limits.maximumPixels) {
    fail(`图片尺寸超过限制：单边最多 ${limits.maximumDimension} 像素，总计最多 ${limits.maximumPixels} 像素。`);
  }
}

function fromBase64(data) {
  const maximum = APP_CONFIG.appearance.images.maximumBytes;
  if (typeof data !== 'string' || !data.length) fail('图片数据不能为空。');
  if (data.length > Math.ceil(maximum / 3) * 4) fail('图片超过允许的文件大小。');
  if (data.length % 4 !== 0 || !BASE64.test(data)) fail('图片不是有效的 base64 数据。');
  const binary = atob(data);
  if (binary.length > maximum) fail('图片超过允许的文件大小。');
  if (btoa(binary) !== data) fail('图片的 base64 编码不规范。');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(chunks.join(''));
}

// EXIF only changes displayed orientation. Bounds checks keep malformed metadata
// away from the browser decoder; orientation 5–8 swaps the displayed dimensions.
function exifOrientation(bytes) {
  if (ascii(bytes, 0, 6) === 'Exif\0\0') bytes = bytes.subarray(6);
  if (bytes.length < 8) return 1;
  const order = ascii(bytes, 0, 2);
  if (!['II', 'MM'].includes(order)) return 1;
  const little = order === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return 1;
  const offset = view.getUint32(4, little);
  if (offset + 2 > bytes.length) return 1;
  const count = view.getUint16(offset, little);
  if (offset + 2 + count * 12 > bytes.length) return 1;
  for (let index = 0; index < count; index += 1) {
    const entry = offset + 2 + index * 12;
    if (view.getUint16(entry, little) === 0x0112 && view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) {
      const orientation = view.getUint16(entry + 8, little);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

function pngSize(bytes) {
  if (bytes.length < 33) fail('PNG 文件头不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') fail('PNG 缺少有效的 IHDR 文件头。');
  const width = view.getUint32(16), height = view.getUint32(20);
  checkDimensions(width, height);
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) fail('PNG 图像编码声明无效。');
  let offset = 8, hasData = false, orientation = 1;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) fail('PNG 数据块不完整。');
    if (type === 'IHDR' && offset !== 8) fail('PNG 包含重复的文件头。');
    if (type === 'acTL') fail('请使用静态 PNG 图片。');
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'eXIf') orientation = exifOrientation(bytes.subarray(offset + 8, end - 4));
    if (type === 'IEND') {
      if (length !== 0 || !hasData || end !== bytes.length) fail('PNG 结束块或图像数据无效。');
      return { width, height, orientation };
    }
    offset = end;
  }
  fail('PNG 缺少完整的结束块。');
}

function jpegSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2, width, height, orientation = 1;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail('JPEG 数据段标记无效。');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) fail('JPEG 数据段不完整。');
    if (offset + 2 > bytes.length) fail('JPEG 数据段长度缺失。');
    const length = view.getUint16(offset), start = offset + 2, end = offset + length;
    if (length < 2 || end > bytes.length) fail('JPEG 数据段长度无效。');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (width !== undefined || length < 8) fail('JPEG 图像尺寸声明无效。');
      height = view.getUint16(start + 1); width = view.getUint16(start + 3);
      checkDimensions(width, height);
      if (length !== 8 + 3 * bytes[start + 5]) fail('JPEG 颜色分量声明无效。');
    }
    if (marker === 0xe1 && ascii(bytes, start, 6) === 'Exif\0\0') orientation = exifOrientation(bytes.subarray(start, end));
    if (marker === 0xda) {
      if (!width || length < 6 || end >= bytes.length - 2 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail('JPEG 缺少完整图像数据。');
      return { width, height, orientation };
    }
    offset = end;
  }
  fail('JPEG 缺少图像数据。');
}

function webpSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) fail('WebP 文件长度声明无效。');
  const uint24 = (offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  let offset = 12, width, height, canvasWidth, canvasHeight, orientation = 1;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4), length = view.getUint32(offset + 4, true);
    const start = offset + 8, end = start + length;
    if (end + (length & 1) > bytes.length) fail('WebP 数据块不完整。');
    if (type === 'ANIM' || type === 'ANMF') fail('请使用静态 WebP 图片。');
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[start] & 0xc1)) fail('WebP 扩展文件头无效。');
      if (bytes[start] & 2) fail('请使用静态 WebP 图片。');
      canvasWidth = uint24(start + 4) + 1; canvasHeight = uint24(start + 7) + 1;
      checkDimensions(canvasWidth, canvasHeight);
    }
    if (type === 'VP8 ' || type === 'VP8L') {
      if (width !== undefined) fail('WebP 包含重复图像数据。');
      if (type === 'VP8 ') {
        if (length < 10 || (bytes[start] & 1) || ascii(bytes, start + 3, 3) !== '\x9d\x01\x2a') fail('WebP VP8 文件头无效。');
        width = view.getUint16(start + 6, true) & 0x3fff;
        height = view.getUint16(start + 8, true) & 0x3fff;
      } else {
        if (length < 5 || bytes[start] !== 0x2f) fail('WebP 无损文件头无效。');
        const dimensions = view.getUint32(start + 1, true);
        if (dimensions >>> 29) fail('WebP 无损版本无效。');
        width = (dimensions & 0x3fff) + 1; height = ((dimensions >>> 14) & 0x3fff) + 1;
      }
      checkDimensions(width, height);
    }
    if (type === 'EXIF') orientation = exifOrientation(bytes.subarray(start, end));
    offset = end + (length & 1);
  }
  if (offset !== bytes.length || width === undefined) fail('WebP 缺少完整图像数据。');
  if (canvasWidth !== undefined && (canvasWidth !== width || canvasHeight !== height)) fail('WebP 画布与图像尺寸不一致。');
  return { width, height, orientation };
}

function inspect(bytes) {
  let mime, size;
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') { mime = 'image/png'; size = pngSize(bytes); }
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) { mime = 'image/jpeg'; size = jpegSize(bytes); }
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') { mime = 'image/webp'; size = webpSize(bytes); }
  else fail('仅支持内容有效的 PNG、JPEG 或 WebP 图片。');
  const { width, height, orientation } = size;
  return orientation >= 5 ? { mime, width: height, height: width } : { mime, width, height };
}

function validatedImage(value) {
  checkRecord(value);
  checkName(value.name);
  if (!APP_CONFIG.appearance.images.mimeTypes.includes(value.mime)) fail('图片 MIME 类型不受支持。');
  checkDimensions(value.width, value.height);
  const bytes = fromBase64(value.data);
  const inspected = inspect(bytes);
  if (inspected.mime !== value.mime) fail('图片类型声明与文件内容不一致。');
  if (inspected.width !== value.width || inspected.height !== value.height) fail('图片尺寸声明与文件内容不一致。');
  return { record: { name: value.name, mime: value.mime, data: value.data, width: value.width, height: value.height }, bytes };
}

/** Browsers may recover damaged PNGs while reporting successful Image.decode(). */
async function validatePngPixels(bytes) {
  if (typeof DecompressionStream !== 'function') fail('当前浏览器不支持 PNG 像素完整性检查。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  const bitsPerPixel = bytes[24] * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[bytes[25]]);
  const layout = bytes[28] === 0 ? [[0, 0, 1, 1]] : [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ];
  const passes = layout.flatMap(([x, y, stepX, stepY]) => {
    const columns = Math.max(0, Math.ceil((width - x) / stepX));
    const rows = Math.max(0, Math.ceil((height - y) / stepY));
    return columns && rows ? [{ rows, stride: 1 + Math.ceil(columns * bitsPerPixel / 8) }] : [];
  });
  const expectedBytes = passes.reduce((total, pass) => total + pass.rows * pass.stride, 0);
  let compressedOffset = 8;
  // Yield views of existing compressed bytes, without assembling a second large buffer.
  const compressed = new ReadableStream({
    pull(controller) {
      while (compressedOffset < bytes.length) {
        const offset = compressedOffset;
        const length = view.getUint32(offset);
        compressedOffset += length + 12;
        if (ascii(bytes, offset + 4, 4) === 'IDAT' && length) {
          controller.enqueue(bytes.subarray(offset + 8, offset + 8 + length));
          return;
        }
      }
      controller.close();
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream('deflate')).getReader();
  let total = 0, filterPosition = 0, passIndex = 0, rowIndex = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const end = total + value.byteLength;
      if (end > expectedBytes) fail('PNG 解压像素数据超出文件头声明的长度。');
      // Each nonempty Adam7 pass has its own row stride and one filter byte per row.
      while (filterPosition < end && passIndex < passes.length) {
        if (value[filterPosition - total] > 4) fail('PNG 行过滤类型无效。');
        filterPosition += passes[passIndex].stride;
        rowIndex += 1;
        if (rowIndex === passes[passIndex].rows) { passIndex += 1; rowIndex = 0; }
      }
      total = end;
    }
    if (total !== expectedBytes) fail('PNG 解压像素数据被截断。');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new Error(`PNG 像素数据无效：${error.message || '压缩数据损坏。'}`);
  } finally {
    reader.releaseLock();
  }
}

/** 同步结构校验不替代浏览器真解码；渲染提交前必须 await decodeImage。 */
export function validateImage(value) { return validatedImage(value).record; }

/** 原图字节嵌入项目；先检查文件头的尺寸上限，再允许浏览器解码。 */
export async function encodeImage(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) fail('请选择非空图片文件。');
  checkName(file.name);
  if (file.size > APP_CONFIG.appearance.images.maximumBytes) fail('图片超过允许的文件大小。');
  if (file.type && !APP_CONFIG.appearance.images.mimeTypes.includes(file.type)) fail('图片 MIME 类型不受支持。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) fail('图片文件读取不完整。');
  const inspected = inspect(bytes);
  if (file.type && file.type !== inspected.mime) fail('图片类型声明与文件内容不一致。');
  const record = { name: file.name, ...inspected, data: toBase64(bytes) };
  const image = await decodeImage(record);
  releaseImage(image);
  return record;
}

/** 返回解码后的原图，调用方在纹理或背景不再使用时调用 releaseImage。 */
export async function decodeImage(value) {
  const { record, bytes } = validatedImage(value);
  if (record.mime === 'image/png') await validatePngPixels(bytes);
  if (typeof Image !== 'function') fail('当前环境不支持浏览器图片解码。');
  const url = URL.createObjectURL(new Blob([bytes], { type: record.mime }));
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (image.naturalWidth !== record.width || image.naturalHeight !== record.height) fail('图片解码尺寸与文件头不一致。');
    return image;
  } catch (error) {
    releaseImage(image);
    throw new Error(`图片解码失败：${error.message || '图像数据损坏。'}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function releaseImage(image) { image?.removeAttribute('src'); }
