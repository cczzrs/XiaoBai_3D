import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferences } from '../src/references.js';
import { APP_CONFIG } from '../src/config.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function harness(t, { initialFailure = false } = {}) {
  const registrationEntry = (image, crop, scale) => ({ image, crop, scale, centerX: 10, floorY: 100, yaw: 0, label: image });
  const registration = {
    body: { frame_0: registrationEntry('body.png', [0, 0, 50, 50], 1) },
    head: { front: registrationEntry('head.png', [20, 30, 40, 50], 2) },
    arms: { last_action: registrationEntry('arms.png', [60, 70, 30, 40], 3) },
  };
  const expectedCrops = new Map([
    ['./body.png', registration.body.frame_0.crop],
    ['./head.png', registration.head.front.crop],
    ['./arms.png', registration.arms.last_action.crop],
  ]);
  const gates = new Map();
  const drawings = [];
  const observers = [];
  const globals = {
    fetch: async () => ({ ok: true, json: async () => registration }),
    Image: class {
      decode() {
        if (this.src === './body.png') return initialFailure ? Promise.reject(new Error('initial image failed')) : Promise.resolve();
        const gate = deferred();
        gates.set(this.src, gate);
        return gate.promise;
      }
    },
    ResizeObserver: class {
      disconnected = false;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    devicePixelRatio: 1,
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  function canvas(name) {
    const surface = {
      lastDraw: null,
      // A real canvas clears its bitmap whenever its dimensions are assigned.
      set width(value) { this.lastDraw = null; },
      set height(value) { this.lastDraw = null; },
      getBoundingClientRect: () => ({ width: 240, height: 200 }),
    };
    const context = {
      setTransform() {},
      drawImage(image, ...coordinates) {
        surface.lastDraw = { surface: name, image: image.src, crop: coordinates.slice(0, 4) };
        drawings.push(surface.lastDraw);
      },
    };
    surface.getContext = () => context;
    return surface;
  }
  const preview = canvas('preview');
  const overlay = canvas('overlay');
  const config = structuredClone(APP_CONFIG);
  config.ui.defaults.reference = 'body';
  config.ui.defaults.overlay = 50;
  config.ui.defaults.mode = 'build';
  return {
    preview, overlay, drawings, observers, gates,
    create: () => createReferences({
      preview, overlay, config,
      studio: {
        getCameraState: () => ({ view: 'front', position: [0, 0, 10], target: [0, 0, 0], orthographic: true }),
        projectPoint: ([x, y]) => ({ x, y }),
      },
      onCaption() {},
    }),
    assertPaired() {
      for (const drawing of drawings) assert.deepEqual(drawing.crop, expectedCrops.get(drawing.image), `${drawing.surface}: ${drawing.image} must use its own registration`);
    },
  };
}

test('参考图加载失败清空旧图和配准，重试后成对恢复', async (t) => {
  const h = harness(t);
  const references = await h.create();
  assert.equal(h.preview.lastDraw.image, './body.png');
  assert.equal(h.overlay.lastDraw.image, './body.png');
  const pending = references.select('head');
  assert.equal(h.preview.lastDraw, null);
  assert.equal(h.overlay.lastDraw, null);
  references.draw();
  assert.equal(h.preview.lastDraw, null);
  const failure = assert.rejects(pending, /head image failed/);
  h.gates.get('./head.png').reject(new Error('head image failed'));
  await failure;
  references.draw();
  assert.equal(h.preview.lastDraw, null);
  assert.equal(h.overlay.lastDraw, null);
  const retry = references.select('head');
  h.gates.get('./head.png').resolve();
  await retry;
  assert.equal(h.preview.lastDraw.image, './head.png');
  assert.equal(h.overlay.lastDraw.image, './head.png');
  h.assertPaired();
  references.dispose();
});

test('较早 decode 在新图片之后完成时不会覆盖最新选择', async (t) => {
  const h = harness(t);
  const references = await h.create();
  const older = references.select('head');
  const newer = references.select('arms');
  h.gates.get('./arms.png').resolve();
  await newer;
  assert.equal(h.preview.lastDraw.image, './arms.png');
  const drawCount = h.drawings.length;
  h.gates.get('./head.png').resolve();
  await older;
  assert.equal(h.drawings.length, drawCount);
  references.draw();
  assert.equal(h.preview.lastDraw.image, './arms.png');
  assert.equal(h.overlay.lastDraw.image, './arms.png');
  h.assertPaired();
  references.dispose();
});

test('最新图片仍在等待 decode 时，较早 decode 完成保持画布清空', async (t) => {
  const h = harness(t);
  const references = await h.create();
  const older = references.select('head');
  const newer = references.select('arms');
  h.gates.get('./head.png').resolve();
  await older;
  references.draw();
  assert.equal(h.preview.lastDraw, null);
  assert.equal(h.overlay.lastDraw, null);
  h.gates.get('./arms.png').resolve();
  await newer;
  assert.equal(h.preview.lastDraw.image, './arms.png');
  assert.equal(h.overlay.lastDraw.image, './arms.png');
  h.assertPaired();
  references.dispose();
});

test('初始化参考图 decode 失败时释放 ResizeObserver', async (t) => {
  const h = harness(t, { initialFailure: true });
  await assert.rejects(h.create(), /initial image failed/);
  assert.equal(h.observers.length, 1);
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.drawings.length, 0);
});
