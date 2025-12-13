/**
 * @module ol/webgpu/Helper
 */
import Disposable from '../Disposable.js';

/**
 * @typedef {Object} CanvasCacheItem
 * @property {GPUCanvasContext} context The context of this canvas.
 * @property {number} users The count of users of this canvas.
 * @property {number} lastFrameIndex The last rendered frame index.
 * @property {GPUDevice|null} device The shared device (per canvas).
 * @property {GPUAdapter|null} adapter The shared adapter (per canvas).
 * @property {Promise<void>|null} readyPromise Device init promise.
 * @property {number} configuredFrameIndex The last frame index used to configure the context.
 * @property {number} configuredWidth The last configured canvas width.
 * @property {number} configuredHeight The last configured canvas height.
 * @property {number} configuredPixelRatio The last configured pixel ratio.
 * @property {number} currentTextureFrameIndex The frame index of the cached current texture view.
 * @property {GPUTextureView|null} currentTextureView Cached current texture view.
 * @property {GPUTexture|null} frameTexture Persistent per-canvas render target.
 * @property {GPUTextureFormat|null} frameTextureFormat Format for frameTexture.
 * @property {number} frameTextureWidth Width in pixels.
 * @property {number} frameTextureHeight Height in pixels.
 */

/**
 * @type {Object<string,CanvasCacheItem>}
 */
const canvasCache = {};

/**
 * @param {string} key The cache key for the canvas.
 * @return {string} The shared cache key.
 */
function getSharedCanvasCacheKey(key) {
  return 'shared/' + key;
}

let uniqueCanvasCacheKeyCount = 0;

/**
 * @return {string} The unique cache key.
 */
function getUniqueCanvasCacheKey() {
  const key = 'unique/' + uniqueCanvasCacheKeyCount;
  uniqueCanvasCacheKeyCount += 1;
  return key;
}

/**
 * @param {string} key The cache key for the canvas.
 * @return {CanvasCacheItem} The cache item.
 */
function getOrCreateCanvasCacheItem(key) {
  let cacheItem = canvasCache[key];
  if (!cacheItem) {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    const context = canvas.getContext('webgpu');
    cacheItem = {
      users: 0,
      context,
      lastFrameIndex: -1,
      device: null,
      adapter: null,
      readyPromise: null,
      configuredFrameIndex: -1,
      configuredWidth: 0,
      configuredHeight: 0,
      configuredPixelRatio: 0,
      currentTextureFrameIndex: -1,
      currentTextureView: null,
      frameTexture: null,
      frameTextureFormat: null,
      frameTextureWidth: 0,
      frameTextureHeight: 0,
    };
    canvasCache[key] = cacheItem;
  }

  cacheItem.users += 1;
  return cacheItem;
}

/**
 * @param {string} key The cache key for the canvas.
 */
function releaseCanvas(key) {
  const cacheItem = canvasCache[key];
  if (!cacheItem) {
    return;
  }

  cacheItem.users -= 1;
  if (cacheItem.users > 0) {
    return;
  }

  if (cacheItem.device) {
    if (cacheItem.frameTexture) {
      cacheItem.frameTexture.destroy();
      cacheItem.frameTexture = null;
    }
    cacheItem.device.destroy();
  }

  // WebGPU doesn't have a direct "loseContext" extension equivalent that is standard/required here,
  // but we can at least remove it from the cache and resize it down.
  const context = cacheItem.context;
  const canvas = context.canvas;
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.display = 'none';

  delete canvasCache[key];
}

export const ShaderType = {
  FRAGMENT_SHADER: 'fragment',
  VERTEX_SHADER: 'vertex',
  COMPUTE_SHADER: 'compute',
};

/**
 * @typedef {Object} Options
 * @property {string} [canvasCacheKey] The request cache key for the canvas.
 */

/**
 * @typedef {Object} GPUCanvasContext
 * @property {HTMLCanvasElement} canvas Canvas.
 * @property {function(Object): void} configure Configure the canvas context.
 * @property {function(): string} getCurrentTexture Get the current texture.
 * @property {function(): void} unconfigure Unconfigure the context.
 */

/**
 * @classdesc
 * This class is strictly a helper for WebGPU rendering.
 * It manages the WebGPU Device, Adapter, and Canvas Context.
 * Unlike WebGLHelper, it deals with BindGroups, Pipelines, and Encoders.
 */
class WebGPUHelper extends Disposable {
  /**
   * @param {Options} [options] Options.
   */
  constructor(options) {
    super();
    options = options || {};

    /**
     * @private
     * @type {string}
     */
    this.canvasCacheKey_ = options.canvasCacheKey
      ? getSharedCanvasCacheKey(options.canvasCacheKey)
      : getUniqueCanvasCacheKey();

    /**
     * @private
     * @type {GPUDevice|null}
     */
    this.device_ = null;

    /**
     * @private
     * @type {GPUAdapter|null}
     */
    this.adapter_ = null;

    /**
     * @private
     * @type {GPUCanvasContext}
     */
    this.cacheItem_ = getOrCreateCanvasCacheItem(this.canvasCacheKey_);

    /**
     * @private
     * @type {GPUCanvasContext}
     */
    this.context_ = this.cacheItem_.context;

    /**
     * @private
     * @type {HTMLCanvasElement}
     */
    this.canvas_ = this.context_.canvas;

    /**
     * @private
     * @type {Promise<void>}
     */
    this.ready_ = this.init_();

    /**
     * @private
     * @type {Map<string, GPURenderPipeline>}
     */
    this.pipelineCache_ = new Map();
  }

  /**
   * @private
   * @return {Promise<void>} Promise that resolves when the device is ready.
   */
  async init_() {
    if (this.cacheItem_.readyPromise) {
      await this.cacheItem_.readyPromise;
      this.device_ = this.cacheItem_.device;
      this.adapter_ = this.cacheItem_.adapter;
      return;
    }

    this.cacheItem_.readyPromise = (async () => {
      if (!navigator.gpu) {
        throw new Error('WebGPU not supported');
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No WebGPU adapter found');
      }

      const device = await adapter.requestDevice();
      this.cacheItem_.adapter = adapter;
      this.cacheItem_.device = device;
    })();

    await this.cacheItem_.readyPromise;
    this.device_ = this.cacheItem_.device;
    this.adapter_ = this.cacheItem_.adapter;
  }

  /**
   * @return {Promise<void>} Ready promise.
   */
  ready() {
    return this.ready_;
  }

  /**
   * @return {GPUDevice} The WebGPU device.
   */
  getDevice() {
    return this.device_;
  }

  /**
   * @return {GPUAdapter} The WebGPU adapter.
   */
  getAdapter() {
    return this.adapter_;
  }

  /**
   * @return {HTMLCanvasElement} The canvas.
   */
  getCanvas() {
    return this.canvas_;
  }

  /**
   * @return {GPUCanvasContext} The canvas context.
   */
  getContext() {
    return this.context_;
  }

  /**
   * Returns the current swap chain texture view for a given frame.
   * Ensures that `getCurrentTexture()` is called once per frame for shared canvases.
   * @param {number} frameIndex Frame index.
   * @return {GPUTextureView} Texture view.
   */
  getCurrentTextureView(frameIndex) {
    const cacheItem = canvasCache[this.canvasCacheKey_];
    if (!cacheItem) {
      return this.context_.getCurrentTexture().createView();
    }
    if (
      cacheItem.currentTextureFrameIndex !== frameIndex ||
      !cacheItem.currentTextureView
    ) {
      cacheItem.currentTextureFrameIndex = frameIndex;
      cacheItem.currentTextureView = this.context_
        .getCurrentTexture()
        .createView();
    }
    return cacheItem.currentTextureView;
  }

  /**
   * Returns a persistent per-canvas render target view that can be used across multiple
   * submissions in the same frame (unlike the swap chain texture).
   * @param {number} frameIndex Frame index (unused but kept for symmetry with other helpers).
   * @param {GPUTextureFormat} format Texture format.
   * @param {number} widthPx Width in physical pixels.
   * @param {number} heightPx Height in physical pixels.
   * @return {GPUTextureView} Texture view.
   */
  getFrameTextureView(frameIndex, format, widthPx, heightPx) {
    const cacheItem = canvasCache[this.canvasCacheKey_];
    if (!cacheItem) {
      throw new Error('Missing canvas cache item');
    }
    const needsRecreate =
      !cacheItem.frameTexture ||
      cacheItem.frameTextureFormat !== format ||
      cacheItem.frameTextureWidth !== widthPx ||
      cacheItem.frameTextureHeight !== heightPx;
    if (needsRecreate) {
      if (cacheItem.frameTexture) {
        cacheItem.frameTexture.destroy();
      }
      cacheItem.frameTexture = this.device_.createTexture({
        size: {width: widthPx, height: heightPx},
        format,
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      cacheItem.frameTextureFormat = format;
      cacheItem.frameTextureWidth = widthPx;
      cacheItem.frameTextureHeight = heightPx;
    }
    return cacheItem.frameTexture.createView();
  }

  /**
   * Returns true if this is the first WebGPU render pass for the given frame.
   * This is used to decide whether the shared canvas should be cleared or loaded.
   * @param {number} frameIndex Frame index.
   * @return {boolean} Whether this is the first pass.
   */
  isFirstPass(frameIndex) {
    const cacheItem = canvasCache[this.canvasCacheKey_];
    if (!cacheItem) {
      return true;
    }
    if (cacheItem.lastFrameIndex !== frameIndex) {
      cacheItem.lastFrameIndex = frameIndex;
      cacheItem.currentTextureFrameIndex = -1;
      cacheItem.currentTextureView = null;
      return true;
    }
    return false;
  }

  /**
   * Configures the canvas context once per frame for shared canvases.
   * This avoids resetting the swap chain multiple times when several WebGPU layers
   * share the same canvas.
   * @param {number} frameIndex Frame index.
   * @param {number} width Width.
   * @param {number} height Height.
   * @param {number} [pixelRatio] Pixel ratio.
   */
  configureContextForFrame(frameIndex, width, height, pixelRatio) {
    const cacheItem = canvasCache[this.canvasCacheKey_];
    if (!cacheItem) {
      this.configureContext(width, height, pixelRatio);
      return;
    }

    const dpr = pixelRatio || window.devicePixelRatio || 1;
    const alreadyConfigured =
      cacheItem.configuredFrameIndex === frameIndex &&
      cacheItem.configuredWidth === width &&
      cacheItem.configuredHeight === height &&
      cacheItem.configuredPixelRatio === dpr;

    if (alreadyConfigured) {
      return;
    }

    cacheItem.configuredFrameIndex = frameIndex;
    cacheItem.configuredWidth = width;
    cacheItem.configuredHeight = height;
    cacheItem.configuredPixelRatio = dpr;
    this.configureContext(width, height, dpr);
  }

  /**
   * Configures the canvas context.
   * @param {number} width Width.
   * @param {number} height Height.
   * @param {number} [pixelRatio] Pixel ratio.
   */
  configureContext(width, height, pixelRatio) {
    if (!this.device_ || !this.context_) {
      return;
    }

    const dpr = pixelRatio || window.devicePixelRatio || 1;

    // Resize canvas if needed
    if (this.canvas_.width !== width || this.canvas_.height !== height) {
      this.canvas_.width = width;
      this.canvas_.height = height;
      this.canvas_.style.width = width / dpr + 'px';
      this.canvas_.style.height = height / dpr + 'px';
    }

    this.context_.configure({
      device: this.device_,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
    });
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    releaseCanvas(this.canvasCacheKey_);
    super.disposeInternal();
  }
}

export default WebGPUHelper;
