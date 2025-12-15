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

  beforeEach(function () {
    // Mock WebGPU environment
    restoreNavigatorGpu = stubNavigatorGpu({
      requestAdapter: async () => ({
        requestDevice: async () => ({
          destroy: () => {},
        }),
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    });
  });

  afterEach(function () {
    if (helper) {
      helper.dispose();
    }
    restoreNavigatorGpu?.();
    restoreNavigatorGpu = null;
  });

  it('initializes the device and adapter', async function () {
    helper = new WebGPUHelper();
    await helper.ready();
    expect(helper.getAdapter()).to.be.ok();
    expect(helper.getDevice()).to.be.ok();
  });

  it('creates its own canvas if none provided', async function () {
    // Ensure `canvas.getContext('webgpu')` returns a minimal GPUCanvasContext.
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = (tagName) => {
      const element = originalCreateElement(tagName);
      if (tagName === 'canvas') {
        const originalGetContext = element.getContext.bind(element);
        element.getContext = (type) => {
          if (type === 'webgpu') {
            return {
              canvas: element,
              configure: () => {},
              unconfigure: () => {},
              getCurrentTexture: () => ({
                createView: () => ({}),
              }),
            };
          }
          return originalGetContext(type);
        };
      }
      return element;
    };

    helper = new WebGPUHelper();
    await helper.ready();
    expect(helper.getCanvas()).to.be.ok();
    expect(helper.getContext()).to.be.ok();

    document.createElement = originalCreateElement;
  });

  it('configures the context', async function () {
    let configured = false;
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = (tagName) => {
      const element = originalCreateElement(tagName);
      if (tagName === 'canvas') {
        const originalGetContext = element.getContext.bind(element);
        element.getContext = (type) => {
          if (type === 'webgpu') {
            return {
              canvas: element,
              configure: (config) => {
                configured = true;
                expect(config.device).to.be.ok();
                expect(config.format).to.be('bgra8unorm');
              },
              unconfigure: () => {},
              getCurrentTexture: () => ({
                createView: () => ({}),
              }),
            };
          }
          return originalGetContext(type);
        };
      }
      return element;
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
