/**
 * @module ol/webgpu/Helper
 */
import Disposable from '../Disposable.js';

/**
 * @typedef {Object} CanvasCacheItem
 * @property {GPUCanvasContext} context The context of this canvas.
 * @property {number} users The count of users of this canvas.
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
 * @return {GPUCanvasContext} The canvas.
 */
function getOrCreateContext(key) {
  let cacheItem = canvasCache[key];
  if (!cacheItem) {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.display = 'block';
    const context = canvas.getContext('webgpu');
    cacheItem = {users: 0, context};
    canvasCache[key] = cacheItem;
  }

  cacheItem.users += 1;
  return cacheItem.context;
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
    this.context_ = getOrCreateContext(this.canvasCacheKey_);

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
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    this.adapter_ = await navigator.gpu.requestAdapter();
    if (!this.adapter_) {
      throw new Error('No WebGPU adapter found');
    }

    this.device_ = await this.adapter_.requestDevice();
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
    if (this.device_) {
      this.device_.destroy();
    }
    releaseCanvas(this.canvasCacheKey_);
    super.disposeInternal();
  }
}

export default WebGPUHelper;
