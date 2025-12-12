/**
 * @module ol/webgpu/Helper
 */
import Disposable from '../Disposable.js';

export const ShaderType = {
  FRAGMENT_SHADER: 'fragment',
  VERTEX_SHADER: 'vertex',
  COMPUTE_SHADER: 'compute',
};

/**
 * @typedef {Object} Options
 * @property {string} [canvasCacheKey] The block cache key for the canvas.
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
     * @type {HTMLCanvasElement|null}
     */
    this.canvas_ = null;

    /**
     * @private
     * @type {GPUCanvasContext|null}
     */
    this.context_ = null;

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

    // Auto-create canvas if not provided (though usually provided by renderer)
    if (!this.canvas_) {
      this.canvas_ = document.createElement('canvas');
      this.context_ = this.canvas_.getContext('webgpu');
    }
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
   */
  configureContext(width, height) {
    if (!this.device_ || !this.context_) {
      return;
    }

    // Resize canvas if needed
    if (this.canvas_.width !== width || this.canvas_.height !== height) {
      this.canvas_.width = width;
      this.canvas_.height = height;
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
    super.disposeInternal();
  }
}

export default WebGPUHelper;
