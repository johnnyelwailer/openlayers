import expect from 'expect.js';
import Feature from '../../../../../../src/ol/Feature.js';
import LineString from '../../../../../../src/ol/geom/LineString.js';
import Point from '../../../../../../src/ol/geom/Point.js';
import Polygon from '../../../../../../src/ol/geom/Polygon.js';
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
  /** @type {null|(() => void)} */
  let restoreNavigatorGpu = null;

  /**
   * @param {*} mockGpu Mock GPU object.
   * @return {() => void} Restore function.
   */
  function stubNavigatorGpu(mockGpu) {
    const originalGpu = navigator.gpu;
    if (originalGpu) {
      const originalRequestAdapter = originalGpu.requestAdapter;
      const originalGetPreferredCanvasFormat =
        originalGpu.getPreferredCanvasFormat;
      Object.defineProperty(originalGpu, 'requestAdapter', {
        value: mockGpu.requestAdapter,
        configurable: true,
      });
      Object.defineProperty(originalGpu, 'getPreferredCanvasFormat', {
        value: mockGpu.getPreferredCanvasFormat,
        configurable: true,
      });
      return () => {
        Object.defineProperty(originalGpu, 'requestAdapter', {
          value: originalRequestAdapter,
          configurable: true,
        });
        Object.defineProperty(originalGpu, 'getPreferredCanvasFormat', {
          value: originalGetPreferredCanvasFormat,
          configurable: true,
        });
      };
    }

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'gpu',
    );
    Object.defineProperty(navigator, 'gpu', {
      value: mockGpu,
      configurable: true,
    });
    return () => {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'gpu', originalDescriptor);
      } else {
        delete navigator.gpu;
      }
    };
  }

  beforeEach(async function () {
    // Mock navigator.gpu for Helper
    restoreNavigatorGpu = stubNavigatorGpu({
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
    });

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
    helper?.dispose?.();
    restoreNavigatorGpu?.();
    restoreNavigatorGpu = null;
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
    const lineBatch = new MixedGeometryBatch();
    lineBatch.addFeatures([
      new Feature({
        geometry: new LineString([
          [0, 0],
          [10, 10],
          [20, 20],
        ]),
      }),
    ]);

    const lineRenderer = new VectorStyleRenderer(
      [
        {
          'stroke-color': '#ff0000',
          'stroke-width': 2,
        },
      ],
      {},
      helper,
    );

    const buffers = await lineRenderer.generateBuffers(lineBatch, null);
    expect(buffers.lineStringBuffers).to.not.be.empty();
  });

  it('generates buffers for Polygon and calls render', async function () {
    const polyBatch = new MixedGeometryBatch();
    polyBatch.addFeatures([
      new Feature({
        geometry: new Polygon([
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ]),
      }),
    ]);

    const polyRenderer = new VectorStyleRenderer(
      [{'fill-color': 'blue'}],
      {},
      helper,
    );

    const buffers = await polyRenderer.generateBuffers(polyBatch, null);
    expect(buffers.polygonBuffers).to.not.be.empty();
  });
});
