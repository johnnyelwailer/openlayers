import expect from 'expect.js';
import Feature from '../../../../../../src/ol/Feature.js';
import Point from '../../../../../../src/ol/geom/Point.js';
import MixedGeometryBatch from '../../../../../../src/ol/render/webgl/MixedGeometryBatch.js';
import VectorStyleRenderer from '../../../../../../src/ol/render/webgpu/VectorStyleRenderer.js';
import WebGPUHelper from '../../../../../../src/ol/webgpu/Helper.js';

// Mock globals for Node environment since JSDOM is not available
if (typeof navigator === 'undefined') {
  global.navigator = {};
}
if (typeof document === 'undefined') {
  global.document = {
    createElement: (tag) => ({
      getContext: () => null,
      style: {},
    }),
  };
}
if (typeof window === 'undefined') {
  global.window = global;
}

describe('ol/render/webgpu/VectorStyleRenderer', function () {
  let helper;
  let renderer;
  let geometryBatch;

  beforeEach(async function () {
    // Mock navigator.gpu for Helper
    navigator.gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          createBuffer: (desc) => {
            const buffer = new ArrayBuffer(desc.size);
            return {
              getMappedRange: () => buffer,
              unmap: () => {},
              getBuffer: () => ({}),
              // helper for testing to access the buffer content if needed differently
              _content: buffer,
            };
          },
          queue: {writeBuffer: () => {}, submit: () => {}},
          destroy: () => {},
          createCommandEncoder: () => ({
            beginRenderPass: () => ({
              setPipeline: () => {},
              setBindGroup: () => {},
              setVertexBuffer: () => {},
              draw: () => {},
              end: () => {},
            }),
            finish: () => {},
          }),
          createShaderModule: () => ({}),
          createRenderPipeline: () => ({
            getBindGroupLayout: () => {},
          }),
          createBindGroup: () => {},
        }),
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    helper = new WebGPUHelper();
    await helper.ready();

    geometryBatch = new MixedGeometryBatch();
    geometryBatch.addFeatures([
      new Feature({
        geometry: new Point([0, 0]),
      }),
    ]);

    renderer = new VectorStyleRenderer(
      [
        {
          'fill-color': 'vec4f(1.0, 0.0, 0.0, 1.0)',
        },
      ],
      {},
      helper,
    );
  });

  afterEach(function () {
    helper.dispose();
  });

  it('can be instantiated', function () {
    expect(renderer).to.be.ok();
  });

  it('configures the builder with style', function () {
    const builder = renderer.styleShaders_[0].builder;
    expect(builder.getFillColorExpression()).to.eql(
      'vec4f(1.0, 0.0, 0.0, 1.0)',
    );
  });

  it('generates buffers for LineString and calls render', async function () {
    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {
        entries: {
          '1': {
            flatCoordss: [[0, 0, 10, 10, 20, 20]],
            verticesCount: 6,
          },
        },
      },
      polygonBatch: {entries: {}},
    };

    const buffers = await renderer.generateBuffers(geometryBatch, null);

    expect(buffers.lineStringBuffers).to.not.be.empty();
    const vBuffer = buffers.lineStringBuffers[0].vertex.getBuffer();
    // vBuffer._content is the persistent buffer we mocked
    const data = new Float32Array(vBuffer._content);

    // Check first segment
    expect(data[0]).to.be(0);
    expect(data[1]).to.be(0);
    expect(data[2]).to.be(0); // featureIndex

    expect(data[3]).to.be(10);
    expect(data[4]).to.be(10);
    expect(data[5]).to.be(0); // featureIndex

    renderer.helper_.getContext = () => ({
      getCurrentTexture: () => ({
        createView: () => ({}),
      }),
    });

    renderer.render(buffers, {});
  });

  it('generates buffers for Polygon and calls render', async function () {
    const renderer = new VectorStyleRenderer(
      [{'fill-color': 'blue'}],
      {},
      helper,
    );

    const geometryBatch = {
      pointBatch: {entries: {}},
      lineStringBatch: {entries: {}},
      polygonBatch: {
        entries: {
          '1': {
            flatCoordss: [[0, 0, 10, 0, 10, 10, 0, 10, 0, 0]], // Square (closed)
            ringsVerticesCounts: [[5]], // 5 vertices
          },
        },
      },
    };

    const buffers = await renderer.generateBuffers(geometryBatch, null);

    expect(buffers.polygonBuffers).to.not.be.empty();
    const vBuffer = buffers.polygonBuffers[0].vertex.getBuffer();
    const data = new Float32Array(vBuffer._content);

    // Square -> 2 triangles -> 6 vertices * 3 floats = 18 floats
    expect(data.length).to.be.greaterThan(0);
    expect(data[0]).to.be.a('number');

    renderer.helper_.getContext = () => ({
      getCurrentTexture: () => ({
        createView: () => ({}),
      }),
    });

    renderer.render(buffers, {});
  });
});
