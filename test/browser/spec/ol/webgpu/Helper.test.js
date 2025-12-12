import expect from 'expect.js';
import WebGPUHelper from '../../../../../src/ol/webgpu/Helper.js';

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

describe('ol/webgpu/Helper', function () {
  let helper;
  let originalNavigatorGpu;

  beforeEach(function () {
    originalNavigatorGpu = navigator.gpu;
    // Mock WebGPU environment
    navigator.gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          destroy: () => {},
        }),
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  });

  afterEach(function () {
    if (helper) {
      helper.dispose();
    }
    navigator.gpu = originalNavigatorGpu;
  });

  it('initializes the device and adapter', async function () {
    helper = new WebGPUHelper();
    await helper.ready();
    expect(helper.getAdapter()).to.be.ok();
    expect(helper.getDevice()).to.be.ok();
  });

  it('creates its own canvas if none provided', async function () {
    // Stub createElement to return a mock canvas with webgpu context support
    const originalCreateElement = document.createElement;
    document.createElement = (tagName) => {
      if (tagName === 'canvas') {
        return {
          getContext: (type) => {
            if (type === 'webgpu') {
              return {
                configure: () => {},
              };
            }
            return null;
          },
          style: {},
        };
      }
      return originalCreateElement(tagName);
    };

    helper = new WebGPUHelper();
    await helper.ready();
    expect(helper.getCanvas()).to.be.ok();
    expect(helper.getContext()).to.be.ok();

    document.createElement = originalCreateElement;
  });

  it('configures the context', async function () {
    let configured = false;
    const originalCreateElement = document.createElement;
    document.createElement = (tagName) => {
      if (tagName === 'canvas') {
        return {
          getContext: (type) => {
            if (type === 'webgpu') {
              return {
                configure: (config) => {
                  configured = true;
                  expect(config.device).to.be.ok();
                  expect(config.format).to.be('bgra8unorm');
                },
              };
            }
            return null;
          },
          style: {},
        };
      }
      return originalCreateElement(tagName);
    };

    helper = new WebGPUHelper();
    await helper.ready();
    helper.configureContext(100, 100);
    expect(configured).to.be(true);
    expect(helper.getCanvas().width).to.be(100);
    expect(helper.getCanvas().height).to.be(100);

    document.createElement = originalCreateElement;
  });
});
