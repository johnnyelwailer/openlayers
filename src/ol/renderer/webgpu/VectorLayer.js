/**
 * @module ol/renderer/webgpu/VectorLayer
 */
import MixedGeometryBatch from '../../render/webgl/MixedGeometryBatch.js';
import VectorStyleRenderer from '../../render/webgpu/VectorStyleRenderer.js';
import {create as createTransform} from '../../transform.js';
import WebGPULayerRenderer from './Layer.js';

/**
 * @classdesc
 * WebGPU vector renderer.
 * @extends {WebGPULayerRenderer<import("../../layer/Vector.js").default>}
 */
class WebGPUVectorLayerRenderer extends WebGPULayerRenderer {
  /**
   * @param {import("../../layer/Vector.js").default} layer Layer.
   * @param {Object} options Options.
   */
  constructor(layer, options) {
    super(layer, options);

    /**
     * @private
     * @type {MixedGeometryBatch}
     */
    this.batch_ = new MixedGeometryBatch();

    /**
     * @private
     * @type {VectorStyleRenderer}
     */
    this.styleRenderer_ = null;

    /**
     * @private
     * @type {Object}
     */
    this.styles_ = options.style;

    /**
     * @private
     * @type {Object}
     */
    this.currentBuffers_ = null;
  }

  /**
   * @inheritDoc
   */
  afterHelperCreated() {
    this.styleRenderer_ = new VectorStyleRenderer(
      this.styles_,
      {},
      this.helper,
    );
  }

  /**
   * @inheritDoc
   */
  prepareFrameInternal(frameState) {
    if (!this.styleRenderer_) {
      return false;
    }
    // TODO: Load features from source and update batch
    // For now, we assume batch is populated or empty

    // Trigger buffer generation
    // In real implementation, we would check for changes
    const transform = createTransform(); // Placeholder transform

    // Optimization: Don't regenerate if not needed (TODO)
    this.styleRenderer_
      .generateBuffers(this.batch_, transform)
      .then((buffers) => {
        this.currentBuffers_ = buffers;
        // Trigger re-render if needed? Only if frame is still valid?
        // For now, simple storage.
      });

    return true;
  }

  /**
   * @inheritDoc
   */
  renderFrame(frameState) {
    if (!this.styleRenderer_) {
      return;
    }

    const size = frameState.size;
    this.helper.configureContext(size[0], size[1]);

    // In a real implementation we would have logic to determine if buffers need regeneration
    // For this prototype, we'll assume they are ready or generated in prepareFrame
    // But since generateBuffers is async, we need to handle that.
    // For now, let's assume prepareFrame has triggered it and we have access to buffers.
    // We need to store buffers in the class.

    if (this.currentBuffers_) {
      this.styleRenderer_.render(this.currentBuffers_, frameState);
    }
  }
}

export default WebGPUVectorLayerRenderer;
