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

    /**
     * @private
     * @type {boolean}
     */
    this.helperReady_ = false;

    /**
     * @private
     * @type {Promise<void>|null}
     */
    this.helperReadyPromise_ = null;

    /**
     * @private
     * @type {string|null}
     */
    this.canvasCacheKey_ = null;

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
    this.helperReady_ = false;
    this.helperReadyPromise_ = null;
  }

  /**
   * Determine whether renderFrame should be called.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @override
   */
  prepareFrame(frameState) {
    // Use the same grouping logic as WebGL: consecutive WebGPU layers share a canvas,
    // but groups are split by non-WebGPU layers and by className changes.
    let groupNumber = 0;
    if (
      frameState &&
      Array.isArray(frameState.layerStatesArray) &&
      Number.isInteger(frameState.layerIndex)
    ) {
      let currentGroup = -1;
      let inGroup = false;
      let lastClassName = '';
      for (let i = 0; i < frameState.layerStatesArray.length; i++) {
        const layerState = frameState.layerStatesArray[i];
        const layer = layerState.layer;
        const renderer = layer.getRenderer();
        if (!(renderer instanceof WebGPULayerRenderer)) {
          inGroup = false;
          lastClassName = '';
        } else {
          const className = layer.getClassName();
          if (!inGroup || className !== lastClassName) {
            currentGroup += 1;
            inGroup = true;
            lastClassName = className;
          }
          if (renderer === this) {
            break;
          }
        }
      }
      groupNumber = Math.max(0, currentGroup);
    }

    const canvasCacheKey = 'map/' + frameState.mapId + '/group/' + groupNumber;

    if (!this.helper || this.canvasCacheKey_ !== canvasCacheKey) {
      this.removeHelper();
      this.canvasCacheKey_ = canvasCacheKey;
      this.helper = new WebGPUHelper({
        canvasCacheKey: canvasCacheKey,
      });
      const className = this.getLayer().getClassName();
      if (className) {
        this.helper.getCanvas().className = className;
      }

      this.helperReadyPromise_ = this.helper
        .ready()
        .then(() => {
          this.helperReady_ = true;
          this.afterHelperCreated();
          // Make sure we render again once WebGPU is ready.
          this.getLayer().changed();
        })
        .catch(() => {
          // WebGPU init errors are handled by consumers (or fallbacks).
        });
    }
    if (!this.helperReady_) {
      frameState.animate = true;
      return true;
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
