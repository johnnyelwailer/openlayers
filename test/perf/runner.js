const ol = globalThis.ol;

const ALL_RENDERERS = /** @type {const} */ (['webgl', 'webgpu']);

/**
 * @param {Array<number>} values Values.
 * @return {{count: number, mean: number, median: number, p95: number, max: number, over16ms: number, over33ms: number, over100ms: number, over250ms: number}} Stats summary.
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
      over100ms: 0,
      over250ms: 0,
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
  let over100ms = 0;
  let over250ms = 0;
  for (const v of values) {
    if (v > 16.67) {
      over16ms++;
    }
    if (v > 33.34) {
      over33ms++;
    }
    if (v > 100) {
      over100ms++;
    }
    if (v > 250) {
      over250ms++;
    }
  }
  return {
    count,
    mean,
    median,
    p95,
    max,
    over16ms,
    over33ms,
    over100ms,
    over250ms,
  };
}

/**
 * @return {{durations: Array<number>, stop: () => void}} Recorder.
 */
function startLongTaskRecorder() {
  /** @type {Array<number>} */
  const durations = [];
  let observer = null;
  if ('PerformanceObserver' in globalThis) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const d = entry?.duration;
          if (typeof d === 'number') {
            durations.push(d);
          }
        }
      });
      observer.observe({type: 'longtask', buffered: true});
    } catch {
      observer = null;
    }
  }
  return {
    durations,
    stop: () => {
      try {
        observer?.disconnect();
      } catch {
        // ignore
      }
    },
  };
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
 * @param {Array<any>} features Features.
 * @return {{map: any, layer: any, view: any, source: any, features: Array<any>}} Map context.
 */
function createMap(renderer, target, source, features) {
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
  return {map, layer, view, source, features};
}

/**
 * @param {'webgl'|'webgpu'} renderer Renderer.
 * @param {any} target Target element.
 * @return {{map: any, layer: any, view: any, source: any}} Map context.
 */
function createVectorTileMap(renderer, target) {
  const {Map, View} = ol;
  const {
    WebGLVectorTile: WebGLVectorTileLayer,
    WebGPUVectorTile: WebGPUVectorTileLayer,
  } = ol.layer;
  const {VectorTile: VectorTileSource} = ol.source;
  const {MVT} = ol.format;
  const {createXYZ} = ol.tilegrid;
  const {createEmpty, extend} = ol.extent;

  const style = [
    {
      filter: ['==', ['get', 'layer'], 'water'],
      style: {'fill-color': '#a0c8f0'},
    },
    {
      filter: [
        'all',
        ['==', ['get', 'layer'], 'landuse'],
        ['==', ['get', 'class'], 'park'],
      ],
      style: {'fill-color': '#d8e8c8'},
    },
    {
      filter: ['==', ['get', 'layer'], 'building'],
      style: {
        'fill-color': '#f2eae2',
        'stroke-color': '#dfdbd7',
        'stroke-width': 1,
      },
    },
    {
      filter: ['==', ['get', 'layer'], 'road'],
      style: {'stroke-color': '#cfcdca', 'stroke-width': 1},
    },
    {
      filter: ['==', ['get', 'layer'], 'place_label'],
      style: {'circle-radius': 3, 'circle-fill-color': '#707070'},
    },
  ];

  // Restrict requests to the local 3x3 tile fixture coverage (z=14).
  const tempGrid = createXYZ({minZoom: 14, maxZoom: 14});
  const fixtureExtent = createEmpty();
  for (let x = 8937; x <= 8939; x++) {
    for (let y = 5679; y <= 5681; y++) {
      extend(fixtureExtent, tempGrid.getTileCoordExtent([14, x, y]));
    }
  }
  const tileGrid = createXYZ({minZoom: 14, maxZoom: 14, extent: fixtureExtent});

  /** @type {import('../../src/ol/Tile.js').UrlFunction} */
  const tileUrlFunction = (tileCoord) => {
    if (!tileCoord) {
      return undefined;
    }
    const x = Math.min(8939, Math.max(8937, tileCoord[1]));
    const y = Math.min(5681, Math.max(5679, tileCoord[2]));
    return `/data/tiles/mapbox-streets-v6/14/${x}/${y}.vector.pbf`;
  };

  const source = new VectorTileSource({
    format: new MVT({properties: ['layer', 'class']}),
    tileGrid,
    tileUrlFunction,
    transition: 0,
  });

  const layer =
    renderer === 'webgl'
      ? new WebGLVectorTileLayer({source, style})
      : new WebGPUVectorTileLayer({source, style});

  const view = new View({
    center: [1825927.7316762917, 6143091.089223046],
    zoom: 14,
    extent: fixtureExtent,
  });

  const map = new Map({
    target,
    layers: [layer],
    controls: [],
    interactions: [],
    view,
  });

  map.updateSize();
  return {map, layer, view, source, tileUrlFunction};
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

  return env;
}

/**
 * @typedef {{id: string, warmup: number, frames: number, reset?: (runCtx: any) => void, step: (i: number, runCtx: any) => void}} Scenario
 */

/**
 * Controlled runner state used by Puppeteer-driven stepping.
 * @typedef {Object} PerfState
 * @property {any} env Env info.
 * @property {number} frames Frames per scenario.
 * @property {number} warmup Warmup frames.
 * @property {number} featureCount Feature count.
 * @property {Array<'webgl'|'webgpu'>} renderers Renderers to run.
 * @property {Array<Scenario>} vectorScenarios Vector scenarios.
 * @property {Array<Scenario>} vectorTileScenarios Vector tile scenarios.
 * @property {Array<any>} results Results.
 * @property {number} groupIndex 0=vector,1=vectortile.
 * @property {number} scenarioIndex Current scenario index.
 * @property {number} rendererIndex Current renderer index.
 * @property {number} frameIndex Current frame index.
 * @property {number|null} lastAdvanceTime Last advance timestamp.
 * @property {any} contexts Active contexts.
 * @property {Array<number>} frameTimes Current run frame times.
 * @property {Array<number>} workTimes Current run work times.
 * @property {ReturnType<typeof startLongTaskRecorder>|null} longTaskRecorder Longtask recorder.
 */

/** @type {PerfState|null} */
let PERF_STATE = null;

/**
 * @param {URL} url URL.
 * @return {Array<'webgl'|'webgpu'>} Renderers.
 */
function getRenderers(url) {
  const rendererParam = url.searchParams.get('renderer');
  if (
    rendererParam &&
    ALL_RENDERERS.includes(/** @type {any} */ (rendererParam))
  ) {
    return /** @type {Array<'webgl'|'webgpu'>} */ ([rendererParam]);
  }
  return /** @type {Array<'webgl'|'webgpu'>} */ (ALL_RENDERERS.slice());
}

/**
 * @param {Array<'webgl'|'webgpu'>} renderers Renderers.
 * @param {(renderer: 'webgl'|'webgpu', target: HTMLElement) => any} createFn Factory.
 * @return {Record<string, any>} Contexts.
 */
function createContexts(renderers, createFn) {
  /** @type {Record<string, any>} */
  const contexts = {};
  for (const renderer of renderers) {
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
    contexts[renderer] = createFn(renderer, target);
  }
  return contexts;
}

/**
 * Initialize the controlled runner state and expose an `__olPerfAdvance()` function.
 * This avoids relying on page timers/rAF in headless mode by letting Puppeteer
 * drive the progression.
 * @param {URL} url URL.
 */
async function initControlledRunner(url) {
  globalThis.__olPerfDone = false;
  globalThis.__olPerfResult = null;
  globalThis.__olPerfStatus = {stage: 'collecting-env'};

  const renderers = getRenderers(url);
  const frames = Number(url.searchParams.get('frames') || 240);
  const warmup = Number(url.searchParams.get('warmup') || 60);
  const featureCount = Number(url.searchParams.get('features') || 2000);
  const includeVectorTiles = url.searchParams.get('vectortiles') !== '0';
  const scenariosParam = url.searchParams.get('scenarios');
  const allowedScenarios = scenariosParam
    ? new Set(scenariosParam.split(',').filter(Boolean))
    : null;
  const env = await collectEnv();

  /** @type {Array<Scenario>} */
  const allVectorScenarios = [
    {
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
    },
    {
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
    },
    {
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
    },
    {
      id: 'geometry-churn',
      warmup,
      frames,
      reset: (runCtx) => {
        runCtx.layer.setOpacity(1);
        runCtx.view.setCenter([0, 0]);
      },
      step: (i, runCtx) => {
        if (i % 10 !== 0) {
          return;
        }
        const features = runCtx.features || [];
        const total = features.length || 1;
        const updateCount = Math.min(400, total);
        const t = i * 0.02;
        for (let j = 0; j < updateCount; j++) {
          const idx = (i * updateCount + j) % total;
          const f = features[idx];
          const geom = f?.getGeometry?.();
          if (!geom?.setCoordinates) {
            continue;
          }
          const x = (idx % 128) * 2000 + 20000 * Math.sin(t + idx * 0.01);
          const y =
            Math.floor(idx / 128) * 2000 + 20000 * Math.cos(t + idx * 0.01);
          geom.setCoordinates([x, y]);
        }
      },
    },
  ];
  const vectorScenarios = allowedScenarios
    ? allVectorScenarios.filter((s) => allowedScenarios.has(s.id))
    : allVectorScenarios.filter((s) => s.id !== 'geometry-churn');

  /** @type {Array<Scenario>} */
  const vectorTileScenarios = [
    {
      id: 'vectortile-cold-zoom-pan',
      warmup: 0,
      frames,
      reset: (runCtx) => {
        runCtx.view.setCenter([1825927.7316762917, 6143091.089223046]);
        runCtx.view.setZoom(14);
        if (runCtx.tileUrlFunction && runCtx.source?.setTileUrlFunction) {
          runCtx.source.setTileUrlFunction(
            runCtx.tileUrlFunction,
            `reset-${Date.now()}`,
          );
        } else if (runCtx.source?.refresh) {
          runCtx.source.refresh();
        }
      },
      step: (i, runCtx) => {
        const t = i * 0.25;
        const e = runCtx.view.get('extent');
        const width = e ? e[2] - e[0] : 0;
        const height = e ? e[3] - e[1] : 0;
        const dx = 0.25 * width * Math.sin(t * 0.7);
        const dy = 0.25 * height * Math.cos(t * 0.6);
        runCtx.view.setCenter([
          1825927.7316762917 + dx,
          6143091.089223046 + dy,
        ]);
      },
    },
  ];

  /** @type {PerfState} */
  const state = {
    env,
    frames,
    warmup,
    featureCount,
    renderers,
    vectorScenarios,
    vectorTileScenarios,
    results: [],
    groupIndex: 0,
    scenarioIndex: 0,
    rendererIndex: 0,
    frameIndex: -1,
    lastAdvanceTime: null,
    contexts: null,
    frameTimes: [],
    workTimes: [],
    longTaskRecorder: null,
  };
  PERF_STATE = state;

  // Create initial contexts for the vector group.
  globalThis.__olPerfStatus = {stage: 'vector:init'};
  const {Vector: VectorSource} = ol.source;
  const features = createPointFeatures(featureCount);
  state.contexts = createContexts(renderers, (renderer, target) => {
    const source = new VectorSource({features});
    return createMap(renderer, target, source, features);
  });
  globalThis.__olPerfStatus = {stage: 'ready'};

  globalThis.__olPerfAdvance = () => {
    if (!PERF_STATE) {
      return {done: true};
    }

    const st = PERF_STATE;
    const groups = [
      {id: 'vector', scenarios: st.vectorScenarios, createContexts: null},
      ...(includeVectorTiles
        ? [
            {
              id: 'vectortile',
              scenarios: st.vectorTileScenarios,
              createContexts: () =>
                createContexts(st.renderers, (renderer, target) =>
                  createVectorTileMap(renderer, target),
                ),
            },
          ]
        : []),
    ];

    const group = groups[st.groupIndex];
    if (!group) {
      const payload = {
        meta: {
          date: new Date().toISOString(),
          env: st.env,
          frames: st.frames,
          warmup: st.warmup,
          featureCount: st.featureCount,
        },
        results: st.results,
      };
      globalThis.__olPerfStatus = {stage: 'reporting'};
      globalThis.__olPerfResult = payload;
      globalThis.__olPerfDone = true;
      globalThis.reportDone?.(payload);
      PERF_STATE = null;
      return {done: true};
    }

    // Move to the next scenario/renderer when needed.
    const scenario = group.scenarios[st.scenarioIndex];
    if (!scenario) {
      // Cleanup contexts for this group.
      if (st.contexts) {
        for (const r of st.renderers) {
          const ctx = st.contexts[r];
          if (ctx?.map) {
            ctx.map.setTarget(null);
          }
        }
      }
      st.groupIndex++;
      st.scenarioIndex = 0;
      st.rendererIndex = 0;
      st.frameIndex = -1;
      st.lastAdvanceTime = null;
      st.frameTimes = [];
      st.workTimes = [];
      st.longTaskRecorder?.stop();
      st.longTaskRecorder = null;

      const nextGroup = groups[st.groupIndex];
      if (nextGroup?.id === 'vectortile') {
        globalThis.__olPerfStatus = {stage: 'vectortile:init'};
        st.contexts = nextGroup.createContexts
          ? nextGroup.createContexts()
          : null;
      }
      return {done: false};
    }

    const renderer = st.renderers[st.rendererIndex];
    if (!renderer) {
      st.scenarioIndex++;
      st.rendererIndex = 0;
      st.frameIndex = -1;
      st.lastAdvanceTime = null;
      st.frameTimes = [];
      st.workTimes = [];
      st.longTaskRecorder?.stop();
      st.longTaskRecorder = null;
      return {done: false};
    }

    const runCtx = st.contexts?.[renderer];
    /** @type {any} */
    const entry = {renderer, scenario: scenario.id, status: 'ok'};

    if (!runCtx?.map || !runCtx?.layer) {
      entry.status = 'unavailable';
      entry.message = runCtx?.message || `${renderer} unavailable`;
      st.results.push(entry);
      st.rendererIndex++;
      return {done: false};
    }

    // Scenario init for this renderer.
    if (st.frameIndex === -1) {
      globalThis.__olPerfStatus = {
        stage: 'setup',
        group: group.id,
        renderer,
        scenario: scenario.id,
      };
      try {
        scenario.reset?.(runCtx);
        runCtx.map.renderSync();
      } catch (err) {
        entry.status = 'error';
        entry.message = String(err?.message || err);
        st.results.push(entry);
        st.rendererIndex++;
        return {done: false};
      }
      st.longTaskRecorder = startLongTaskRecorder();
      st.frameTimes = [];
      st.workTimes = [];
      st.lastAdvanceTime = null;
      st.frameIndex = 0;
      return {done: false};
    }

    const now = performance.now();
    const frameTime =
      st.lastAdvanceTime !== null ? now - st.lastAdvanceTime : null;
    st.lastAdvanceTime = now;

    globalThis.__olPerfStatus = {
      stage: 'frame',
      group: group.id,
      renderer,
      scenario: scenario.id,
      i: st.frameIndex,
    };

    const start = performance.now();
    try {
      scenario.step(st.frameIndex, runCtx);
      runCtx.map.renderSync();
    } catch (err) {
      entry.status = 'error';
      entry.message = String(err?.message || err);
      st.results.push(entry);
      st.rendererIndex++;
      st.frameIndex = -1;
      st.longTaskRecorder?.stop();
      st.longTaskRecorder = null;
      return {done: false};
    }
    const workTime = performance.now() - start;

    if (st.frameIndex >= scenario.warmup) {
      if (frameTime !== null) {
        st.frameTimes.push(frameTime);
      }
      st.workTimes.push(workTime);
    }

    st.frameIndex++;
    if (st.frameIndex >= scenario.warmup + scenario.frames) {
      st.longTaskRecorder?.stop();
      entry.frameTimes = stats(st.frameTimes);
      entry.workTimes = stats(st.workTimes);
      entry.longTasks = stats(st.longTaskRecorder?.durations || []);
      st.results.push(entry);
      st.longTaskRecorder = null;
      st.frameIndex = -1;
      st.rendererIndex++;
    }
    return {done: false};
  };
}

// Entry point: always run in controlled mode (driven by Puppeteer).
{
  const url = new URL(location.href);
  globalThis.__olPerfStatus = {stage: 'start'};
  initControlledRunner(url).catch((err) => {
    const payload = {
      meta: {date: new Date().toISOString()},
      results: [{status: 'error', message: String(err?.message || err)}],
    };
    globalThis.__olPerfResult = payload;
    globalThis.__olPerfDone = true;
    globalThis.reportDone?.(payload);
  });
}
