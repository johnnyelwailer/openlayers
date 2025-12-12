import expect from 'expect.js';
import VectorLayer from '../../../../../../src/ol/layer/Vector.js';
import WebGPUVectorLayerRenderer from '../../../../../../src/ol/renderer/webgpu/VectorLayer.js';
import VectorSource from '../../../../../../src/ol/source/Vector.js';

// Mock globals for Node environment
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

describe('ol/renderer/webgpu/VectorLayer', function () {
  let renderer;
  let layer;

  beforeEach(function () {
    // Mock navigator.gpu
    navigator.gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          createBuffer: () => ({}),
          queue: {writeBuffer: () => {}},
          destroy: () => {},
        }),
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    layer = new VectorLayer({
      source: new VectorSource(),
    });
    renderer = new WebGPUVectorLayerRenderer(layer, {
      style: [],
    });
  });

  afterEach(function () {
    renderer.dispose();
  });

  it('can be instantiated', function () {
    expect(renderer).to.be.ok();
  });

  it('initializes style renderer after helper creation', async function () {
    // Trigger prepareFrame which initializes helper
    const frameState = {mapId: '1', layerStatesArray: []};
    renderer.prepareFrame(frameState);

    // We need to wait for helper.ready() which is async
    await renderer.helper.ready();

    // Since afterHelperCreated is called in the then() block, we might need a small delay or check
    // However, for this text, we can manually call it to verify the logic *inside* it works
    renderer.afterHelperCreated();

    expect(renderer.styleRenderer_).to.be.ok();
  });

  it('renders frame using style renderer', async function () {
    // Setup helper and style renderer
    const frameState = {
      size: [100, 100],
      viewState: {center: [0, 0], resolution: 1, rotation: 0},
      mapId: '1',
      layerStatesArray: [],
    };

    // Trigger helper creation
    renderer.prepareFrame(frameState);
    await renderer.helper.ready();

    // Manually trigger callback since we are mocking
    renderer.afterHelperCreated();

    const styleRenderer = renderer.styleRenderer_;

    // Mock generateBuffers to resolve immediately with dummy buffers
    const buffers = {pointBuffers: []};
    styleRenderer.generateBuffers = async () => buffers;

    // Spy on render
    let renderCalled = false;
    styleRenderer.render = () => {
      renderCalled = true;
    };

    // Mock helper context
    renderer.helper.configureContext = () => {};

    // Trigger generation now that style renderer is ready
    renderer.prepareFrame(frameState);

    // Wait for the async generation (microtask)
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Call renderFrame should use the buffers
    renderer.renderFrame(frameState);

    expect(renderCalled).to.be(true);
  });
});
