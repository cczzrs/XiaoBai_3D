import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { APP_CONFIG } from '../web/src/config.js';
import { validateImage, encodeImage, decodeImage, releaseImage } from '../web/src/image-io.js';

// Small real 3 × 2 images encoded with Pillow, not synthetic successful headers.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGNcsOUEAxgwQSgGBgYAJgwCIOCXehUAAAAASUVORK5CYII=';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDsKKKK7DkP/9k=';
const WEBP = 'UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoDAAIAAUAmJQBOgCgAAP7w8auR2EN2HLri5shvAAA=';
const WEBP_LOSSLESS = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQ2oIWuf+BiOh/AAA=';
const WEBP_EXIF = 'UklGRmQAAABXRUJQVlA4WAoAAAAIAAAAAgAAAQAAVlA4ICQAAABQAQCdASoDAAIAAUAmJQBOgCgAAP7w8auR2EN2HLri5shvAABFWElGGgAAAE1NACoAAAAIAAEBEgADAAAAAQAGAAAAAAAA';
const record = (data = PNG, mime = 'image/png', width = 3, height = 2) => ({ name: '颜色纹理.png', mime, data, width, height });

function pngChunk(type, content) {
  const chunk = Buffer.alloc(content.length + 12);
  chunk.writeUInt32BE(content.length);
  chunk.write(type, 4);
  content.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function pixelPng({ width, height, depth = 8, color = 6, interlace = 0, raw, compressed = deflateSync(raw), split = false }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  const streams = split ? [compressed.subarray(0, 3), compressed.subarray(3, 8), compressed.subarray(8)] : [compressed];
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    ...(color === 3 ? [pngChunk('PLTE', Buffer.from([0, 0, 0]))] : []),
    ...streams.map((stream) => pngChunk('IDAT', stream)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function browserDecoder(t, { width = 3, height = 2, error = null } = {}) {
  const created = [], urls = [], revoked = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  class ControlledImage {
    naturalWidth = width;
    naturalHeight = height;
    released = false;
    constructor() { created.push(this); }
    async decode() { if (error) throw error; }
    removeAttribute(name) { assert.equal(name, 'src'); this.src = undefined; this.released = true; }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: ControlledImage });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'Image', descriptor); else delete globalThis.Image; });
  t.mock.method(URL, 'createObjectURL', (blob) => { urls.push(blob); return `blob:controlled-${urls.length}`; });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  return { created, urls, revoked };
}

test('PNG、JPEG、有损及无损 WebP 文件头尺寸与 MIME 均可验证', () => {
  for (const [data, mime] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp'], [WEBP_LOSSLESS, 'image/webp']]) {
    const input = record(data, mime);
    const result = validateImage(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
  }
});

test('JPEG 和 WebP EXIF 方向按显示尺寸保存，拒绝未交换的尺寸', () => {
  const jpeg = Buffer.from(JPEG, 'base64');
  const exif = Buffer.from('ffe100224578696600004d4d002a00000008000101120003000000010006000000000000', 'hex');
  const rotatedJpeg = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]).toString('base64');
  for (const [data, mime] of [[rotatedJpeg, 'image/jpeg'], [WEBP_EXIF, 'image/webp']]) {
    assert.equal(validateImage(record(data, mime, 2, 3)).width, 2);
    assert.throws(() => validateImage(record(data, mime, 3, 2)), /尺寸声明/);
  }
});

test('字段、类型、base64、尺寸及原型注入严格拒绝', () => {
  for (const input of [null, [], {},
    { ...record(), mime: 'image/svg+xml' }, { ...record(), mime: 'image/jpeg' },
    { ...record(), name: '../image.png' }, { ...record(), name: ' '.repeat(3) }, { ...record(), name: 'a'.repeat(256) },
    { ...record(), width: '3' }, { ...record(), width: NaN }, { ...record(), height: Infinity },
    { ...record(), height: 0 }, { ...record(), width: 4 }, { ...record(), height: 1.5 },
    { ...record(), data: 'Zh==' }, { ...record(), data: PNG + '\n' }, { ...record(), data: '%%%' },
    { ...record(), data: 'A'.repeat(Math.ceil(APP_CONFIG.appearance.images.maximumBytes / 3) * 4 + 4) },
    { ...record(), extra: true },
  ]) assert.throws(() => validateImage(input), Error);
  const missing = record(); delete missing.width;
  assert.throws(() => validateImage(missing), /缺少/);
  const injected = JSON.parse(JSON.stringify(record()).replace('{', '{"__proto__":{"polluted":true},'));
  assert.throws(() => validateImage(injected), /不允许/);
  const inherited = Object.assign(Object.create({ pollute: true }), record());
  assert.throws(() => validateImage(inherited), /对象类型/);
  const dynamic = record();
  Object.defineProperty(dynamic, 'data', { get() { throw new Error('must not execute'); } });
  assert.throws(() => validateImage(dynamic), /动态属性/);
  assert.equal({}.polluted, undefined);
});

test('损坏的 PNG、JPEG、WebP 容器和超大文件头在浏览器解码前拒绝', async (t) => {
  const browser = browserDecoder(t);
  const oversizedPng = Buffer.from(PNG, 'base64'); oversizedPng.writeUInt32BE(4097, 16);
  const oversizedJpeg = Buffer.from(JPEG, 'base64');
  const frame = oversizedJpeg.indexOf(Buffer.from([0xff, 0xc0])); oversizedJpeg.writeUInt16BE(4097, frame + 7);
  const oversizedWebp = Buffer.from(WEBP, 'base64'); oversizedWebp.writeUInt16LE(4097, 26);
  const corruptWebp = Buffer.from(WEBP, 'base64'); corruptWebp.writeUInt32LE(9999, 4);
  for (const [bytes, mime] of [
    [oversizedPng, 'image/png'], [oversizedJpeg, 'image/jpeg'], [oversizedWebp, 'image/webp'],
    [Buffer.from(PNG, 'base64').subarray(0, 40), 'image/png'],
    [Buffer.from(JPEG, 'base64').subarray(0, -2), 'image/jpeg'], [corruptWebp, 'image/webp'],
    [Buffer.from('<svg/>'), 'image/png'],
  ]) await assert.rejects(encodeImage(new File([bytes], 'image', { type: mime })), Error);
  assert.equal(browser.created.length, 0);
  assert.equal(browser.urls.length, 0);
});

test('静态图片入口拒绝动画 PNG 和 WebP', () => {
  const png = Buffer.from(PNG, 'base64');
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
  const apng = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]).toString('base64');
  const webp = Buffer.from(WEBP_EXIF, 'base64'); webp[20] |= 2;
  assert.throws(() => validateImage(record(apng)), /静态/);
  assert.throws(() => validateImage(record(webp.toString('base64'), 'image/webp', 2, 3)), /静态/);
});

test('encodeImage 保留原字节，使用真解码入口且释放临时资源', async (t) => {
  const browser = browserDecoder(t);
  for (const [data, mime] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
    const file = new File([Buffer.from(data, 'base64')], '原图', { type: mime });
    const result = await encodeImage(file);
    assert.deepEqual(result, { name: '原图', mime, data, width: 3, height: 2 });
    assert.equal(browser.created.at(-1).released, true);
    assert.equal(browser.urls.at(-1).type, mime);
  }
  assert.equal(browser.revoked.length, 3);
});

test('decodeImage 返回可使用的图片并撤销临时 URL，调用方可释放', async (t) => {
  const browser = browserDecoder(t);
  const image = await decodeImage(record());
  assert.equal(image.naturalWidth, 3);
  assert.equal(image.released, false);
  assert.deepEqual(browser.revoked, ['blob:controlled-1']);
  assert.deepEqual(Buffer.from(await browser.urls[0].arrayBuffer()), Buffer.from(PNG, 'base64'));
  releaseImage(image);
  assert.equal(image.released, true);
  releaseImage(null);
});

test('浏览器解码失败或返回错误尺寸均拒绝并释放资源', async (t) => {
  for (const options of [{ error: new Error('corrupt image stream') }, { width: 9 }]) {
    await t.test(options.error ? '解码损坏' : '解码尺寸不符', async (t) => {
      const browser = browserDecoder(t, options);
      await assert.rejects(decodeImage(record()), /图片解码失败/);
      assert.equal(browser.created[0].released, true);
      assert.equal(browser.revoked.length, 1);
    });
  }
});

test('空图、MIME 伪装和超限文件在分配图像之前拒绝', async (t) => {
  const browser = browserDecoder(t);
  await assert.rejects(encodeImage(new File([], 'empty.png', { type: 'image/png' })), /非空/);
  await assert.rejects(encodeImage(new File([Buffer.from(PNG, 'base64')], 'wrong.jpg', { type: 'image/jpeg' })), /类型声明/);
  let read = false;
  await assert.rejects(encodeImage({ name: 'huge.png', size: APP_CONFIG.appearance.images.maximumBytes + 1, type: 'image/png', arrayBuffer() { read = true; } }), /文件大小/);
  assert.equal(read, false);
  assert.equal(browser.created.length, 0);
});

test('真实坏压缩 PNG fixture 在宽容的浏览器解码器之前被拒绝', async (t) => {
  const browser = browserDecoder(t, { width: 256, height: 128 });
  const bytes = fs.readFileSync(new URL('./fixtures/appearance/undecodable.png', import.meta.url));
  const image = record(bytes.toString('base64'), 'image/png', 256, 128);
  assert.deepEqual(validateImage(image), image, 'the complete PNG container intentionally passes synchronous header checks');
  await assert.rejects(decodeImage(image), /PNG 像素数据无效/);
  await assert.rejects(encodeImage(new File([bytes], 'bad.png', { type: 'image/png' })), /PNG 像素数据无效/);
  assert.equal(browser.created.length, 0);
  assert.equal(browser.urls.length, 0);
});

test('PNG 流式解压拒绝损坏校验、截断、超长及非法行过滤', async (t) => {
  const valid = deflateSync(Buffer.alloc(5)); // One RGBA pixel plus its filter byte.
  const checksumFailure = Buffer.from(valid); checksumFailure[checksumFailure.length - 1] ^= 1;
  const cases = [
    ['zlib 校验错误', { compressed: checksumFailure }],
    ['zlib 尾部截断', { compressed: valid.subarray(0, -2) }],
    ['像素行截断', { raw: Buffer.alloc(4) }],
    ['解压输出超长', { raw: Buffer.alloc(65536) }],
    ['过滤类型错误', { raw: Buffer.from([5, 0, 0, 0, 0]) }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (t) => {
      const browser = browserDecoder(t, { width: 1, height: 1 });
      const bytes = pixelPng({ width: 1, height: 1, ...options });
      await assert.rejects(decodeImage(record(bytes.toString('base64'), 'image/png', 1, 1)), /PNG 像素数据无效/);
      assert.equal(browser.created.length, 0);
    });
  }
});

test('PNG 正常逐行、位打包、16 位、分块 IDAT 及 Adam7 长度计算通过', async (t) => {
  const cases = [
    ['RGBA16', { width: 2, height: 1, depth: 16, color: 6, raw: Buffer.alloc(17) }],
    ['灰度1位', { width: 9, height: 2, depth: 1, color: 0, raw: Buffer.alloc(6) }],
    ['灰度加透明度', { width: 2, height: 2, color: 4, raw: Buffer.alloc(10) }],
    ['索引色', { width: 3, height: 2, color: 3, raw: Buffer.alloc(8) }],
    // Adam7 5×5 grayscale pass lengths: 2 + 2 + 3 + 4 + 4 + 9 + 12 = 36.
    ['Adam7与分块IDAT', { width: 5, height: 5, color: 0, interlace: 1, raw: Buffer.alloc(36), split: true }],
    ['Adam7空pass', { width: 1, height: 1, depth: 1, color: 0, interlace: 1, raw: Buffer.alloc(2) }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (t) => {
      const browser = browserDecoder(t, options);
      const bytes = pixelPng(options);
      const image = await decodeImage(record(bytes.toString('base64'), 'image/png', options.width, options.height));
      assert.equal(image.naturalWidth, options.width);
      assert.equal(image.naturalHeight, options.height);
      assert.equal(browser.created.length, 1);
      releaseImage(image);
    });
  }
});
