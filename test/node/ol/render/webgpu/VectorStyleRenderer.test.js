import VectorStyleRenderer from '../../../../../src/ol/render/webgpu/VectorStyleRenderer.js';
import expect from '../../../expect.js';

describe('ol/render/webgpu/VectorStyleRenderer', () => {
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
    };

    const feature = {foo: 1};
    renderer.updateFeatureStyles(buffers, 7, /** @type {*} */ (feature));

    expect(pointCalled.dev).to.be(device);
    expect(pointCalled.ref).to.be(7);
    expect(pointCalled.feature).to.be(feature);
    expect(lineCalled.dev).to.be(device);
    expect(lineCalled.ref).to.be(7);
    expect(lineCalled.feature).to.be(feature);
  });
});
