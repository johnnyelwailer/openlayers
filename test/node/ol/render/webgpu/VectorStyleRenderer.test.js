import {ColorType, NumberType} from '../../../../../src/ol/expr/expression.js';
import {
  UNDEFINED_PROP_VALUE,
  getStringNumberEquivalent,
} from '../../../../../src/ol/expr/gpu.js';
import VectorStyleRenderer from '../../../../../src/ol/render/webgpu/VectorStyleRenderer.js';
import expect from '../../../expect.js';

describe('ol/render/webgpu/VectorStyleRenderer', () => {
  it('caches bind groups across renders', () => {
    if (typeof navigator === 'undefined' || !navigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      });
    }
    navigator.gpu = {
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    let bindGroupsCreated = 0;
    const device = {
      createBuffer: () => ({}),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => {
        bindGroupsCreated++;
        return {};
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: () => {},
        submit: () => {},
      },
    };

    const helper = {
      getDevice: () => device,
      getContext: () => ({getCurrentTexture: () => ({createView: () => ({})})}),
      getFrameTextureView: () => ({}),
      getCurrentTextureView: () => ({}),
      isFirstPass: () => true,
    };

    const renderer = new VectorStyleRenderer(
      [{}],
      {},
      /** @type {*} */ (helper),
    );

    const vertexBuffer = {size: 12};
    const styleBuffer = {};
    const buffers = {
      polygonBuffers: [],
      lineStringBuffers: [],
      pointBuffers: [
        {
          vertex: {
            getBuffer: () => vertexBuffer,
          },
          style: {
            getBuffer: () => styleBuffer,
          },
        },
      ],
    };

    const frameState = {
      index: 0,
      size: [32, 32],
      pixelRatio: 1,
      viewState: {
        center: [0, 0],
        resolution: 1,
        rotation: 0,
        zoom: 0,
      },
    };

    renderer.render(buffers, frameState, 0, 1, true, false, true);
    renderer.render(buffers, frameState, 0, 1, true, false, true);

    expect(bindGroupsCreated).to.be(1);
  });

  it('binds tile mask resources when requested', () => {
    if (typeof navigator === 'undefined' || !navigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      });
    }
    navigator.gpu = {
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    /** @type {Array<any>} */
    const bindGroupArgs = [];
    const device = {
      createBuffer: () => ({}),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: (args) => {
        bindGroupArgs.push(args);
        return {};
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: () => {},
        submit: () => {},
      },
    };

    const helper = {
      getDevice: () => device,
      getContext: () => ({getCurrentTexture: () => ({createView: () => ({})})}),
      getFrameTextureView: () => ({}),
      getCurrentTextureView: () => ({}),
      isFirstPass: () => true,
    };

    const renderer = new VectorStyleRenderer(
      [{}],
      {},
      /** @type {*} */ (helper),
    );
    renderer.setTileMaskEnabled(true);
    const tileMaskSampler = {};
    const tileMaskView = {};
    renderer.setTileMaskResources(
      /** @type {*} */ (tileMaskSampler),
      /** @type {*} */ (tileMaskView),
    );

    const vertexBuffer = {size: 12};
    const styleBuffer = {};
    const buffers = {
      polygonBuffers: [],
      lineStringBuffers: [],
      pointBuffers: [
        {
          vertex: {
            getBuffer: () => vertexBuffer,
          },
          style: {
            getBuffer: () => styleBuffer,
          },
          usesTileMask: true,
        },
      ],
    };

    const frameState = {
      index: 0,
      size: [32, 32],
      pixelRatio: 1,
      viewState: {
        center: [0, 0],
        resolution: 1,
        rotation: 0,
        zoom: 0,
      },
    };

    renderer.render(buffers, frameState, 0, 1, true, false, true, 1, 0);

    const last = bindGroupArgs[bindGroupArgs.length - 1];
    const bindings = last.entries.map((e) => e.binding);
    expect(bindings).to.contain(6);
    expect(bindings).to.contain(7);
  });

  it('does not allocate featureProperties for CPU-only get() usage', async () => {
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'stroke-color': [0, 0, 255, 1],
            'stroke-width': ['get', 'w'],
          },
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: () => 1,
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.be(null);
  });

  it('reuses the featureProperties update scratch buffer', async () => {
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'limit'], 1],
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'limit' ? 1 : 0),
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );
    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );

    const updateWrites = writes.filter((w) => w.data instanceof Float32Array);
    expect(updateWrites.length).to.be.greaterThan(1);
    expect(updateWrites[0].data).to.be(updateWrites[1].data);
  });

  it('packs numeric feature properties into the scalar slot', async () => {
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data: new Float32Array(data)});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'limit'], 5],
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'limit' ? 5 : undefined),
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );

    expect(writes.length).to.be.greaterThan(0);
    // Scalar slot for the only property should get the numeric value.
    expect(writes[writes.length - 1].data[0]).to.be(5);
  });

  it('packs string feature properties as stable numeric ids', async () => {
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data: new Float32Array(data)});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'shape'], 'circle'],
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'shape' ? 'circle' : undefined),
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );

    expect(writes.length).to.be.greaterThan(0);
    expect(writes[writes.length - 1].data[0]).to.be(
      getStringNumberEquivalent('circle'),
    );
  });

  it('packs feature ids and makes them available to filters', async () => {
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data: new Float32Array(data)});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['var', 'highlightedId'], ['id']],
        },
      ],
      {highlightedId: -1},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: () => undefined,
      getId: () => 7,
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    expect(
      buffers.featureProperties.indexByName.get('__ol_feature_id__'),
    ).to.be(0);
    expect(buffers.pointBuffers[0].usesProps).to.be(true);

    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );
    expect(writes.length).to.be.greaterThan(0);
    expect(writes[writes.length - 1].data[0]).to.be(7);
  });

  it('packs string feature ids as stable numeric ids', async () => {
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data: new Float32Array(data)});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['var', 'highlightedId'], ['id']],
        },
      ],
      {highlightedId: 'abc'},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: () => undefined,
      getId: () => 'abc',
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );
    expect(writes.length).to.be.greaterThan(0);
    expect(writes[writes.length - 1].data[0]).to.be(
      getStringNumberEquivalent('abc'),
    );
  });

  it('packs geometry-type() into props as a stable numeric id', async () => {
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data: new Float32Array(data)});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['geometry-type'], 'Polygon'],
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: () => undefined,
      getGeometry: () => ({getType: () => 'MultiPolygon'}),
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    expect(
      buffers.featureProperties.indexByName.get('__ol_geometry_type__'),
    ).to.be(0);

    buffers.featureProperties.update(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );
    expect(writes.length).to.be.greaterThan(0);
    expect(writes[writes.length - 1].data[0]).to.be(
      getStringNumberEquivalent('Polygon'),
    );
  });

  it('packs color feature properties into the color slot', async () => {
    /** @type {ArrayBuffer|null} */
    let propsMapped = null;

    const device = {
      createBuffer: ({size}) => {
        const mapped = new ArrayBuffer(size);
        if (size === 64) {
          propsMapped = mapped;
        }
        return {
          size,
          getMappedRange: () => mapped,
          unmap: () => {},
        };
      },
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'stroke-width': 2,
            'stroke-color': [
              'case',
              ['>', ['line-metric'], 0],
              ['get', 'c'],
              'rgba(0,0,0,0)',
            ],
          },
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'c' ? 'rgb(255,0,0)' : undefined),
    };
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0, 0, 10, 0, 10]],
          },
        },
      },
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.featureProperties).to.not.be(null);
    expect(propsMapped).to.not.be(null);

    const floats = new Float32Array(propsMapped);
    // ref 1 layout is [scalar vec4][color vec4], with a leading ref 0 row.
    expect(floats[8]).to.be(getStringNumberEquivalent('rgb(255,0,0)'));
    expect(floats[12]).to.be(1);
    expect(floats[13]).to.be(0);
    expect(floats[14]).to.be(0);
    expect(floats[15]).to.be(1);
  });

  it('uses a sentinel value for missing feature properties in props packing', async () => {
    /** @type {ArrayBuffer|null} */
    let propsMapped = null;

    const device = {
      createBuffer: ({size}) => {
        const mapped = new ArrayBuffer(size);
        // featureCount=2, propStride=2 => 2*2*16 = 64 bytes
        if (size === 64) {
          propsMapped = mapped;
        }
        return {
          size,
          getMappedRange: () => mapped,
          unmap: () => {},
        };
      },
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'limit'], 1],
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: () => undefined,
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(propsMapped).to.not.be(null);
    const floats = new Float32Array(propsMapped);
    // First property scalar slot for ref 1.
    expect(floats[8]).to.be(UNDEFINED_PROP_VALUE);
  });

  it('compiles fill-color expressions to WGSL for polygons', async () => {
    const writes = [];

    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'fill-color': ['*', ['get', 'COLOR'], [220, 220, 220]],
          },
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'COLOR' ? [255, 0, 0] : undefined),
      getId: () => null,
    };
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {entries: {}},
      polygonBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0, 10, 0, 10, 10, 0, 10]],
            ringsVerticesCounts: [[4]],
          },
        },
      },
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.polygonBuffers.length).to.be(1);
    expect(buffers.polygonBuffers[0].fillShader).to.be.a('string');
    expect(buffers.polygonBuffers[0].fillShader).to.contain('props[');
    expect(buffers.polygonBuffers[0].usesProps).to.be(true);

    writes.length = 0;
    buffers.polygonBuffers[0].updateStyle(
      /** @type {*} */ (device),
      1,
      /** @type {*} */ (feature),
    );
    expect(writes.length).to.be(0);
  });

  it('writes layer opacity to uniform buffer', () => {
    /** @type {number|null} */
    let compositeOpacity = null;

    if (typeof navigator === 'undefined' || !navigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      });
    }
    navigator.gpu = {
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    const device = {
      createBuffer: () => ({}),
      createTexture: () => ({
        createView: () => ({}),
        destroy: () => {},
      }),
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          draw: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          const floats = new Float32Array(data);
          if (floats.length === 8 && floats[0] !== 1) {
            compositeOpacity = floats[0];
          }
        },
        submit: () => {},
      },
    };

    const helper = {
      getDevice: () => device,
      getContext: () => ({getCurrentTexture: () => ({createView: () => ({})})}),
      getCurrentTextureView: () => ({}),
      getFrameTextureView: () => ({}),
      isFirstPass: () => true,
    };

    const renderer = new VectorStyleRenderer(
      [{}],
      {},
      /** @type {*} */ (helper),
    );
    renderer.render(
      {pointBuffers: [], lineStringBuffers: [], polygonBuffers: []},
      {
        index: 0,
        size: [32, 32],
        pixelRatio: 1,
        viewState: {
          center: [0, 0],
          resolution: 1,
          rotation: 0,
          zoom: 0,
        },
      },
      0,
      0.25,
    );

    expect(compositeOpacity).to.be(0.25);
  });

  it('writes time to the uniforms buffer', () => {
    if (typeof navigator === 'undefined' || !navigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      });
    }
    navigator.gpu = {
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    /** @type {number|null} */
    let timeSeconds = null;

    const device = {
      createBuffer: () => ({}),
      createTexture: () => ({
        createView: () => ({}),
        destroy: () => {},
      }),
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          setVertexBuffer: () => {},
          draw: () => {},
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          if (data instanceof Float32Array && data.length === 28) {
            timeSeconds = data[24];
          }
        },
        submit: () => {},
      },
    };

    const helper = {
      getDevice: () => device,
      getContext: () => ({
        getCurrentTexture: () => ({createView: () => ({})}),
      }),
      getCurrentTextureView: () => ({}),
      getFrameTextureView: () => ({}),
      isFirstPass: () => true,
    };

    const renderer = new VectorStyleRenderer(
      [{}],
      {},
      /** @type {*} */ (helper),
    );
    renderer.startTime_ = 1000;

    renderer.render(
      {pointBuffers: [], lineStringBuffers: [], polygonBuffers: []},
      {
        index: 0,
        time: 3500,
        size: [32, 32],
        pixelRatio: 1,
        viewState: {
          center: [0, 0],
          resolution: 1,
          rotation: 0,
          zoom: 0,
        },
      },
      0,
      1,
    );

    expect(timeSeconds).to.be(2.5);
  });

  it('indexes scalar vs color props slots', () => {
    const helper = {getDevice: () => ({})};
    const renderer = new VectorStyleRenderer(
      [{}],
      {},
      /** @type {*} */ (helper),
    );

    const indexByName = new Map([['p', 2]]);
    const propStride = 10;

    const numberExpr = renderer.getFeaturePropExpression_(
      'p',
      NumberType,
      'fi',
      indexByName,
      propStride,
    );
    expect(numberExpr).to.be('props[u32(fi) * 10u + 2u * 2u + 0u].x');

    const colorExpr = renderer.getFeaturePropExpression_(
      'p',
      ColorType,
      'fi',
      indexByName,
      propStride,
    );
    expect(colorExpr).to.be('props[u32(fi) * 10u + 2u * 2u + 1u]');
  });

  it('applies rule else semantics for point symbols', async () => {
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'kind'], 1],
        },
        {
          style: {
            'circle-radius': 10,
            'circle-fill-color': [0, 0, 255, 1],
          },
          else: true,
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'kind' ? 1 : undefined),
    };
    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0]],
          },
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.pointBuffers.length).to.be(2);
    expect(buffers.pointBuffers[1].symbolShader).to.contain('&& (!(');
  });

  it('applies rule else semantics for strokes', async () => {
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'stroke-color': [255, 0, 0, 1],
            'stroke-width': 2,
          },
          filter: ['==', ['get', 'kind'], 1],
        },
        {
          style: {
            'stroke-color': [0, 0, 255, 1],
            'stroke-width': 2,
          },
          else: true,
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'kind' ? 1 : undefined),
    };
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0, 0, 10, 0, 10]],
          },
        },
      },
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.lineStringBuffers.length).to.be(2);
    expect(buffers.lineStringBuffers[1].strokeShader).to.contain('&& (!(');
  });

  it('applies rule else semantics for polygon fills', async () => {
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'kind'], 1],
        },
        {
          style: {
            'fill-color': [0, 0, 255, 1],
          },
          else: true,
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature = {
      get: (name) => (name === 'kind' ? 1 : undefined),
    };
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {entries: {}},
      polygonBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0, 10, 0, 10, 10, 0, 10]],
            ringsVerticesCounts: [[4]],
          },
        },
      },
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    expect(buffers.polygonBuffers.length).to.be(2);
    expect(buffers.polygonBuffers[1].fillShader).to.contain('&& (!(');
  });

  it('updates feature styles for dirty refs', () => {
    const device = {};
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [{}],
      {},
      /** @type {*} */ (helper),
    );

    let pointCalled = null;
    let lineCalled = null;
    let polyCalled = null;
    let propsCalled = null;
    const buffers = {
      pointBuffers: [
        {
          updateStyle: (dev, ref, feature) => {
            pointCalled = {dev, ref, feature};
          },
        },
      ],
      lineStringBuffers: [
        {
          updateStyle: (dev, ref, feature) => {
            lineCalled = {dev, ref, feature};
          },
        },
      ],
      polygonBuffers: [
        {
          updateStyle: (dev, ref, feature) => {
            polyCalled = {dev, ref, feature};
          },
        },
      ],
      featureProperties: {
        update: (dev, ref, feature) => {
          propsCalled = {dev, ref, feature};
        },
      },
    };

    const feature = {foo: 1};
    renderer.updateFeatureStyles(buffers, 7, /** @type {*} */ (feature));

    expect(pointCalled.dev).to.be(device);
    expect(pointCalled.ref).to.be(7);
    expect(pointCalled.feature).to.be(feature);
    expect(lineCalled.dev).to.be(device);
    expect(lineCalled.ref).to.be(7);
    expect(lineCalled.feature).to.be(feature);
    expect(polyCalled.dev).to.be(device);
    expect(polyCalled.ref).to.be(7);
    expect(polyCalled.feature).to.be(feature);
    expect(propsCalled.dev).to.be(device);
    expect(propsCalled.ref).to.be(7);
    expect(propsCalled.feature).to.be(feature);
  });

  it('batches feature style updates for consecutive dirty refs', async () => {
    /** @type {Array<{buffer: *, offset: number, data: *}>} */
    const writes = [];
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push({buffer, offset, data});
        },
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'circle-radius': ['get', 'radius'],
            'circle-fill-color': [255, 0, 0, 1],
          },
          filter: ['==', ['get', 'limit'], 1],
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    const feature1 = {
      get: (name) => (name === 'radius' ? 1 : name === 'limit' ? 1 : 0),
    };
    const feature2 = {
      get: (name) => (name === 'radius' ? 2 : name === 'limit' ? 1 : 0),
    };
    const feature3 = {
      get: (name) => (name === 'radius' ? 3 : name === 'limit' ? 1 : 0),
    };

    const geometryBatch = {
      pointBatch: {
        entries: {
          a: {ref: 1, feature: feature1, flatCoordss: [[0, 0]]},
          b: {ref: 2, feature: feature2, flatCoordss: [[1, 1]]},
          c: {ref: 3, feature: feature3, flatCoordss: [[2, 2]]},
        },
      },
      lineStringBatch: {entries: {}},
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(
      /** @type {*} */ (geometryBatch),
      /** @type {*} */ ([]),
    );

    writes.length = 0;
    renderer.updateFeatureStylesBatch(
      buffers,
      new Map([
        [1, /** @type {*} */ (feature1)],
        [2, /** @type {*} */ (feature2)],
        [3, /** @type {*} */ (feature3)],
      ]),
    );

    const floatWrites = writes.filter((w) => w.data instanceof Float32Array);
    expect(floatWrites.length).to.be(2);
    expect(floatWrites[0].data.length).to.be(60); // 3 refs * 20 floats
    expect(floatWrites[1].data.length).to.be(24); // 3 refs * 8 floats
  });

  it('syncs style variables to the GPU buffer', () => {
    const variables = {
      w: 5,
      enabled: true,
      tint: '#ff0000',
      filterShape: 'all',
    };

    /** @type {Array<Float32Array>} */
    const writes = [];
    const device = {
      createBuffer: () => ({}),
      queue: {
        writeBuffer: (buffer, offset, data) => {
          writes.push(new Float32Array(data));
        },
      },
    };

    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [{}],
      variables,
      /** @type {*} */ (helper),
    );

    renderer.setVariableNames_(['enabled', 'filterShape', 'tint', 'w']);
    renderer.syncVariables_(/** @type {*} */ (device));

    expect(writes.length).to.be.greaterThan(0);
    const last = writes[writes.length - 1];

    // enabled (bool) stored in x component
    expect(last[0]).to.be(1);
    expect(last[1]).to.be(0);
    expect(last[2]).to.be(0);
    expect(last[3]).to.be(0);

    // filterShape stored as a stable numeric id in x component
    expect(last[4]).to.be(getStringNumberEquivalent('all'));
    expect(last[5]).to.be(0);
    expect(last[6]).to.be(0);
    expect(last[7]).to.be(0);

    // tint stored as RGBA in 0..1
    expect(last[8]).to.be(1);
    expect(last[9]).to.be(0);
    expect(last[10]).to.be(0);
    expect(last[11]).to.be(1);

    // w (number) stored in x component
    expect(last[12]).to.be(5);
    expect(last[13]).to.be(0);
    expect(last[14]).to.be(0);
    expect(last[15]).to.be(0);
  });

  it('rejects stroke pattern expression options before loading the pattern texture', async () => {
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'stroke-width': 1,
            'stroke-pattern-src': 'pattern.png',
            'stroke-pattern-size': ['get', 'size'],
          },
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    renderer.getPatternTexture_ = () => {
      throw new Error('pattern texture should not be requested');
    };

    const feature = {
      get: () => 1,
    };
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0, 0, 10, 10, 1]],
          },
        },
      },
      polygonBatch: {entries: {}},
    };

    /** @type {Error|undefined} */
    let error;
    try {
      await renderer.generateBuffers(
        /** @type {*} */ (geometryBatch),
        /** @type {*} */ ([]),
      );
    } catch (err) {
      error = /** @type {Error} */ (err);
    }

    expect(!!error).to.be(true);
    expect(error.message || String(error)).to.contain('stroke-pattern-size');
  });

  it('rejects fill pattern expression options before loading the pattern texture', async () => {
    const device = {
      createBuffer: ({size}) => ({
        size,
        getMappedRange: () => new ArrayBuffer(size),
        unmap: () => {},
      }),
      queue: {
        writeBuffer: () => {},
      },
    };
    const helper = {
      getDevice: () => device,
    };

    const renderer = new VectorStyleRenderer(
      [
        {
          style: {
            'fill-pattern-src': 'pattern.png',
            'fill-pattern-size': ['var', 'size'],
          },
        },
      ],
      {},
      /** @type {*} */ (helper),
    );

    renderer.getPatternTexture_ = () => {
      throw new Error('pattern texture should not be requested');
    };

    const feature = {
      get: () => 1,
    };
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {entries: {}},
      polygonBatch: {
        entries: {
          a: {
            ref: 1,
            feature,
            flatCoordss: [[0, 0, 10, 0, 10, 10, 0, 10]],
            ringsVerticesCounts: [[4]],
          },
        },
      },
    };

    /** @type {Error|undefined} */
    let error;
    try {
      await renderer.generateBuffers(
        /** @type {*} */ (geometryBatch),
        /** @type {*} */ ([]),
      );
    } catch (err) {
      error = /** @type {Error} */ (err);
    }

    expect(!!error).to.be(true);
    expect(error.message || String(error)).to.contain('fill-pattern-size');
  });
});
