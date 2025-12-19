/**
 * @module ol/layer/WebGPUVectorTile
 */
import WebGPUVectorTileLayerRenderer from '../renderer/webgpu/VectorTileLayer.js';
import BaseTileLayer from './BaseTile.js';

/***
 * @template T
 * @typedef {T extends import("../source/Vector.js").default<infer U extends import("../Feature.js").FeatureLike> ? U : never} ExtractedFeatureType
 */

/**
 * @template {import("../source/VectorTile.js").default<FeatureType>} [VectorTileSourceType=import("../source/VectorTile.js").default<*>]
 * @template {import('../Feature.js').FeatureLike} [FeatureType=ExtractedFeatureType<VectorTileSourceType>]
 * @typedef {Object} Options
 * @property {string} [className='ol-layer'] A CSS class name to set to the layer element.
 * @property {number} [opacity=1] Opacity (0, 1).
 * @property {boolean} [visible=true] Visibility.
 * @property {import("../extent.js").Extent} [extent] The bounding extent for layer rendering. The layer will not be rendered outside of this extent.
 * @property {number} [zIndex] The z-index for layer rendering.
 * @property {number} [minResolution] The minimum resolution (inclusive) at which this layer will be visible.
 * @property {number} [maxResolution] The maximum resolution (exclusive) below which this layer will be visible.
 * @property {number} [minZoom] The minimum view zoom level (exclusive) above which this layer will be visible.
 * @property {number} [maxZoom] The maximum view zoom level (inclusive) at which this layer will be visible.
 * @property {VectorTileSourceType} [source] Source.
 * @property {import('../style/flat.js').FlatStyleLike} style Layer style.
 * @property {import('../style/flat.js').StyleVariables} [variables] Style variables.
 * @property {import("./Base.js").BackgroundColor} [background] Background color for the layer.
 * @property {boolean} [disableHitDetection=false] Currently a no-op for WebGPU.
 * @property {Object<string, *>} [properties] Arbitrary observable properties.
 */

/**
 * @classdesc
 * Layer that renders vector tiles using WebGPU. Experimental.
 *
 * @template {import("../source/VectorTile.js").default<FeatureType>} [VectorTileSourceType=import("../source/VectorTile.js").default<*>]
 * @template {import('../Feature.js').FeatureLike} [FeatureType=ExtractedFeatureType<VectorTileSourceType>]
 * @extends {BaseTileLayer<VectorTileSourceType, WebGPUVectorTileLayerRenderer>}
 */
class WebGPUVectorTileLayer extends BaseTileLayer {
  /**
   * @param {Options<VectorTileSourceType, FeatureType>} [options] Options.
   */
  constructor(options) {
    const baseOptions = Object.assign({}, options);
    super(baseOptions);

    validateWebGPUStyle_(options.style);

    /**
     * @type {import('../style/flat.js').StyleVariables}
     * @private
     */
    this.styleVariables_ = options.variables || {};

    /**
     * @private
     */
    this.style_ = options.style;

    /**
     * @private
     */
    this.hitDetectionDisabled_ = !!options.disableHitDetection;
  }

  /**
   * @override
   */
  createRenderer() {
    return new WebGPUVectorTileLayerRenderer(this, {
      style: this.style_,
      variables: this.styleVariables_,
      disableHitDetection: this.hitDetectionDisabled_,
      cacheSize: this.getCacheSize(),
    });
  }

  /**
   * Update any variables used by the layer style and trigger a re-render.
   * @param {import('../style/flat.js').StyleVariables} variables Variables to update.
   */
  updateStyleVariables(variables) {
    Object.assign(this.styleVariables_, variables);
    this.changed();
  }

  /**
   * Set the layer style.
   * @param {import('../style/flat.js').FlatStyleLike} style Layer style.
   */
  setStyle(style) {
    validateWebGPUStyle_(style);
    this.style_ = style;
    this.clearRenderer();
    this.changed();
  }
}

export default WebGPUVectorTileLayer;

/**
 * @param {import('../style/flat.js').FlatStyleLike} style Layer style.
 * @private
 */
function validateWebGPUStyle_(style) {
  if (!style) {
    return;
  }
  const entries = Array.isArray(style) ? style : [style];
  for (const entry of entries) {
    const flatStyle =
      entry && typeof entry === 'object' && 'style' in entry
        ? entry.style
        : entry;
    if (!flatStyle) {
      continue;
    }
    for (const name of ['icon-src', 'fill-pattern-src', 'stroke-pattern-src']) {
      const value = flatStyle[name];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new Error(
          `WebGPU layers do not support expressions for the ${name} style property`,
        );
      }
    }
  }
}
