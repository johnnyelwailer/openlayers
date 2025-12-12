/**
 * @module ol/renderer/webgpu/Layer
 */
import LayerProperty from '../../layer/Property.js';
import {create as createTransform} from '../../transform.js';
import WebGPUHelper from '../../webgpu/Helper.js';
import LayerRenderer from '../Layer.js';

/**
 * @classdesc
 * Base WebGPU renderer class.
 * Holds all logic related to data manipulation & some common rendering logic
 * @template {import("../../layer/Layer.js").default} LayerType
 * @extends {LayerRenderer<LayerType>}
 */
class WebGPULayerRenderer extends LayerRenderer {
  /**
   * @param {LayerType} layer Layer.
   * @param {Object} [options] Options.
   */
  constructor(layer, options) {
    super(layer);

    options = options || {};

    /**
     * @private
     * @type {import("../../transform.js").Transform}
     */
    this.inversePixelTransform_ = createTransform();

    /**
     * @type {WebGPUHelper}
     * @protected
     */
    this.helper;

    this.onMapChanged_ = () => {
      this.removeHelper();
    };

    layer.addChangeListener(LayerProperty.MAP, this.onMapChanged_);
  }

  /**
   * @protected
   */
  removeHelper() {
    if (this.helper) {
      this.helper.dispose();
      delete this.helper;
    }
  }

  /**
   * Determine whether renderFrame should be called.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @override
   */
  prepareFrame(frameState) {
    // Simplified cache key logic for prototype
    const canvasCacheKey = 'map/' + frameState.mapId;

    if (!this.helper) {
      this.helper = new WebGPUHelper({
        canvasCacheKey: canvasCacheKey,
      });

      // Wait for device ready
      if (this.helper.ready) {
        this.helper
          .ready()
          .then(() => {
            this.afterHelperCreated();
          })
          .catch((err) => {
            // console.error('WebGPU Init Failed', err);
          });
      }
    }
    return this.prepareFrameInternal(frameState);
  }

  /**
   * @protected
   */
  afterHelperCreated() {}

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @protected
   */
  prepareFrameInternal(frameState) {
    return true;
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    this.removeHelper();
    this.getLayer()?.removeChangeListener(
      LayerProperty.MAP,
      this.onMapChanged_,
    );
    super.disposeInternal();
  }
}

export default WebGPULayerRenderer;
