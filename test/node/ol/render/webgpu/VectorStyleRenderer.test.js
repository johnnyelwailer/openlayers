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
