const ol = globalThis.ol;

const RENDERERS = /** @type {const} */ (['webgl', 'webgpu']);

/**
 * @param {Array<number>} values Values.
 * @return {{count: number, mean: number, median: number, p95: number, max: number, over16ms: number, over33ms: number}} Stats summary.
 */
function stats(values) {
  const count = values.length;
  if (count === 0) {
    return {
      count: 0,
      mean: 0,
      median: 0,
      p95: 0,
      max: 0,
      over16ms: 0,
      over33ms: 0,
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;
  const median =
    count % 2
      ? sorted[(count - 1) / 2]
      : 0.5 * (sorted[count / 2 - 1] + sorted[count / 2]);
  const p95 = sorted[Math.min(count - 1, Math.floor(count * 0.95))];
  const max = sorted[count - 1];
  let over16ms = 0;
  let over33ms = 0;
  for (const v of values) {
    if (v > 16.67) {
      over16ms++;
    }
    if (v > 33.34) {
      over33ms++;
    }
  }
  return {count, mean, median, p95, max, over16ms, over33ms};
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * @param {number} count Feature count.
 * @return {Array<any>} Features.
 */
function createPointFeatures(count) {
  const {Feature} = ol;
  const {Point} = ol.geom;
  const features = new Array(count);
  const cols = Math.ceil(Math.sqrt(count));
  const spacing = 2000;
  for (let i = 0; i < count; i++) {
    const x = (i % cols) * spacing;
    const y = Math.floor(i / cols) * spacing;
    const f = new Feature(new Point([x, y]));
    f.setId(i);
    features[i] = f;
  }
  return features;
}

/**
 * @param {'webgl'|'webgpu'} renderer Renderer.
 * @param {any} target Target element.
 * @param {any} source Source.
 * @return {{map: any, layer: any, view: any}} Map context.
 */
function createMap(renderer, target, source) {
  const {Map, View} = ol;
  const {WebGLVector: WebGLVectorLayer, WebGPUVector: WebGPUVectorLayer} =
    ol.layer;

  const style = {
    'circle-radius': ['var', 'radius'],
    'circle-fill-color': ['var', 'color'],
    'circle-stroke-color': [0, 0, 0, 0.5],
    'circle-stroke-width': 1,
  };

  const variables = {
    radius: 6,
    color: [255, 0, 0, 0.6],
  };

  const layer =
    renderer === 'webgl'
      ? new WebGLVectorLayer({source, style, variables})
      : new WebGPUVectorLayer({source, style, variables});

  const view = new View({
    center: [0, 0],
    zoom: 2,
  });

  const map = new Map({
    target,
    layers: [layer],
    controls: [],
    interactions: [],
    view,
  });

  map.updateSize();
  return {map, layer, view};
}

/**
 * @param {any} runCtx Run context.
 * @param {{id: string, warmup: number, frames: number, reset?: (runCtx: any) => void, step: (i: number, runCtx: any) => void}} scenario Scenario.
 * @return {Promise<{frameTimes: Array<number>, workTimes: Array<number>}>} Frame and work timings.
 */
async function runScenario(runCtx, scenario) {
  const {map} = runCtx;
  const total = scenario.warmup + scenario.frames;
  const frameTimes = [];
  const workTimes = [];

  let lastTs = null;
  for (let i = 0; i < total; i++) {
    const ts = await nextFrame();
    if (lastTs !== null && i >= scenario.warmup) {
      frameTimes.push(ts - lastTs);
    }
    lastTs = ts;

    const start = performance.now();
    scenario.step(i, runCtx);
    map.renderSync();
    if (i >= scenario.warmup) {
      workTimes.push(performance.now() - start);
    }
  }
  return {frameTimes, workTimes};
}

/**
 * @return {Promise<any>} Environment info.
 */
async function collectEnv() {
  /** @type {any} */
  const env = {
    userAgent: navigator.userAgent,
    webgpu: !!navigator.gpu,
  };

  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2', {
        antialias: false,
        preserveDrawingBuffer: false,
      }) ||
      canvas.getContext('webgl', {
        antialias: false,
        preserveDrawingBuffer: false,
      });
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        env.webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
        env.webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      }
      env.webglVersion = gl.getParameter(gl.VERSION);
    }
  } catch {
    // ignore
  }

  if (navigator.gpu?.requestAdapter) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter?.requestAdapterInfo) {
        env.webgpuAdapterInfo = await adapter.requestAdapterInfo();
      }
    } catch {
      // ignore
    }
  }

  return env;
}

async function main() {
  const url = new URL(location.href);
  const frames = Number(url.searchParams.get('frames') || 240);
  const warmup = Number(url.searchParams.get('warmup') || 60);
  const featureCount = Number(url.searchParams.get('features') || 2000);

  const {Vector: VectorSource} = ol.source;
  const features = createPointFeatures(featureCount);
  const source = new VectorSource({features});

  const env = await collectEnv();

  /** @type {Record<string, any>} */
  const contexts = {};
  for (const renderer of RENDERERS) {
    const target = document.getElementById(`target-${renderer}`);
    if (!target) {
      contexts[renderer] = {
        status: 'unavailable',
        message: `Missing target for ${renderer}`,
      };
      continue;
    }
    if (renderer === 'webgpu' && !navigator.gpu) {
      contexts[renderer] = {
        status: 'unavailable',
        message: 'WebGPU unavailable',
      };
      continue;
    }
    contexts[renderer] = createMap(renderer, target, source);
  }

  const scenarios = [
    /** @type {const} */ ({
      id: 'style-vars',
      warmup,
      frames,
      reset: (runCtx) => {
        runCtx.layer.setOpacity(1);
        runCtx.view.setCenter([0, 0]);
      },
      step: (i, runCtx) => {
        const t = i * 0.03;
        const radius = 4 + ((i % 12) / 12) * 10;
        const r = Math.floor(128 + 127 * Math.sin(t));
        const g = Math.floor(128 + 127 * Math.sin(t + 1.7));
        const b = Math.floor(128 + 127 * Math.sin(t + 3.4));
        runCtx.layer.updateStyleVariables({
          radius,
          color: [r, g, b, 0.6],
        });
      },
    }),
    /** @type {const} */ ({
      id: 'pan',
      warmup,
      frames,
      reset: (runCtx) => {
        runCtx.layer.setOpacity(1);
        runCtx.view.setCenter([0, 0]);
      },
      step: (i, runCtx) => {
        const dx = Math.sin(i * 0.05) * 10000;
        const dy = Math.cos(i * 0.05) * 10000;
        runCtx.view.setCenter([dx, dy]);
      },
    }),
    /** @type {const} */ ({
      id: 'opacity',
      warmup,
      frames,
      reset: (runCtx) => {
        runCtx.layer.setOpacity(0.7);
        runCtx.view.setCenter([0, 0]);
      },
      step: (i, runCtx) => {
        const t = i * 0.03;
        const opacity = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(t));
        runCtx.layer.setOpacity(opacity);
      },
    }),
  ];

  /** @type {Array<any>} */
  const results = [];
  for (const scenario of scenarios) {
    for (const renderer of RENDERERS) {
      const runCtx = contexts[renderer];
      /** @type {any} */
      const entry = {renderer, scenario: scenario.id, status: 'ok'};
      if (!runCtx?.map || !runCtx?.layer) {
        entry.status = 'unavailable';
        entry.message = runCtx?.message || `${renderer} unavailable`;
        results.push(entry);
        continue;
      }
      try {
        if (scenario.reset) {
          scenario.reset(runCtx);
        }
        // Give the browser one frame for layout and one for initial render/shader compile.
        await nextFrame();
        runCtx.map.renderSync();
        await nextFrame();
        const {frameTimes, workTimes} = await runScenario(runCtx, scenario);
        entry.frameTimes = stats(frameTimes);
        entry.workTimes = stats(workTimes);
      } catch (err) {
        entry.status = 'error';
        entry.message = String(err?.message || err);
      }
      results.push(entry);
    }
  }

  for (const renderer of RENDERERS) {
    const ctx = contexts[renderer];
    if (ctx?.map) {
      ctx.map.setTarget(null);
    }
  }

  globalThis.reportDone?.({
    meta: {
      date: new Date().toISOString(),
      env,
      frames,
      warmup,
      featureCount,
    },
    results,
  });
}

main().catch((err) => {
  globalThis.reportDone?.({
    meta: {date: new Date().toISOString()},
    results: [{status: 'error', message: String(err?.message || err)}],
  });
});
