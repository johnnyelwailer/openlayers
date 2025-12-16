import {ColorType, NumberType} from '../../../../../src/ol/expr/expression.js';
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

  it('ignores non-color string feature properties in props packing', async () => {
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
      get: (name) => (name === 'limit' ? '5' : undefined),
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
    // Scalar slot for the only property should get the numeric string value.
    expect(writes[writes.length - 1].data[0]).to.be(5);
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
    expect(floats[8]).to.be(0);
    expect(floats[12]).to.be(1);
    expect(floats[13]).to.be(0);
    expect(floats[14]).to.be(0);
    expect(floats[15]).to.be(1);
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

  it('syncs style variables to the GPU buffer', () => {
    const variables = {
      w: 5,
      enabled: true,
      tint: '#ff0000',
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

    renderer.setVariableNames_(['enabled', 'tint', 'w']);
    renderer.syncVariables_(/** @type {*} */ (device));

    expect(writes.length).to.be.greaterThan(0);
    const last = writes[writes.length - 1];

    // enabled (bool) stored in x component
    expect(last[0]).to.be(1);
    expect(last[1]).to.be(0);
    expect(last[2]).to.be(0);
    expect(last[3]).to.be(0);

    // tint stored as RGBA in 0..1
    expect(last[4]).to.be(1);
    expect(last[5]).to.be(0);
    expect(last[6]).to.be(0);
    expect(last[7]).to.be(1);

    // w (number) stored in x component
    expect(last[8]).to.be(5);
    expect(last[9]).to.be(0);
    expect(last[10]).to.be(0);
    expect(last[11]).to.be(0);
  });
});
