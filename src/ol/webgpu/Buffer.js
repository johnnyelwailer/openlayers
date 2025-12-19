/**
 * @module ol/webgpu/Buffer
 */

/**
 * @classdesc
 * Wrapper around a WebGPU Buffer.
 */
class WebGPUBuffer {
  /**
   * @param {Object} options Options.
   * @param {number} options.size Size in bytes.
   * @param {GPUBufferUsageFlags} options.usage Usage flags.
   * @param {boolean} [options.mappedAtCreation] Mapped at creation.
   */
  constructor(options) {
    /**
     * @private
     * @type {number}
     */
    this.size_ = options.size;

    /**
     * @private
     * @type {GPUBufferUsageFlags}
     */
    this.usage_ = options.usage;

    /**
     * @private
     * @type {boolean}
     */
    this.mappedAtCreation_ = !!options.mappedAtCreation;

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.buffer_ = null;
  }

  /**
   * @param {import("./Helper.js").default} helper Helper.
   */
  create(helper) {
    if (this.buffer_) {
      return;
    }
    const device = helper.getDevice();
    this.buffer_ = device.createBuffer({
      size: this.size_,
      usage: this.usage_,
      mappedAtCreation: this.mappedAtCreation_,
    });
  }

  /**
   * @return {GPUBuffer} The GPU Buffer.
   */
  getBuffer() {
    return this.buffer_;
  }

  /**
   * @return {number} Size.
   */
  getSize() {
    return this.size_;
  }

  /**
   * @param {ArrayBufferView} data Data to write.
   * @param {import("./Helper.js").default} helper Helper.
   */
  write(data, helper) {
    if (!this.buffer_) {
      this.create(helper);
    }
    const device = helper.getDevice();
    device.queue.writeBuffer(
      this.buffer_,
      0,
      /** @type {GPUAllowSharedBufferSource} */ (data),
    );
  }
}

export default WebGPUBuffer;
