/**
 * @module ol/renderer/webgpu/VectorTileLayer
 */
import EventType from '../../events/EventType.js';
import VectorStyleRenderer from '../../render/webgpu/VectorStyleRenderer.js';
import TileGeometry from '../../webgpu/TileGeometry.js';
import WebGPUBaseTileLayerRenderer from './TileLayerBase.js';

/**
 * @typedef {import("../../layer/BaseTile.js").default} LayerType
 */

/**
 * @typedef {Object} Options
 * @property {import('../../style/flat.js').FlatStyleLike} style Flat vector style (WebGPU subset).
 * @property {import('../../style/flat.js').StyleVariables} [variables] Style variables.
 * @property {boolean} [disableHitDetection=false] Currently a no-op for WebGPU.
 * @property {number} [cacheSize=512] The vector tile cache size.
 */

/**
 * @classdesc
 * WebGPU renderer for vector tile layers. Experimental.
 * @extends {WebGPUBaseTileLayerRenderer<LayerType>}
 */
class WebGPUVectorTileLayerRenderer extends WebGPUBaseTileLayerRenderer {
  /**
   * @param {LayerType} tileLayer Tile layer.
   * @param {Options} options Options.
   */
  constructor(tileLayer, options) {
    super(tileLayer, {
      cacheSize: options.cacheSize,
    });

    /**
     * @private
     * @type {Array<Object>}
     */
    this.styles_ = Array.isArray(options.style)
      ? options.style
      : [options.style];

    /**
     * @private
     * @type {import('../../style/flat.js').StyleVariables}
     */
    this.styleVariables_ = options.variables || {};

    /**
     * @private
     * @type {VectorStyleRenderer|null}
     */
    this.styleRenderer_ = null;

    /**
     * @private
     * @type {boolean}
     */
    this.isFirstPass_ = false;

    /**
     * @private
     * @type {number}
     */
    this.opacity_ = 1;
  }

  /**
   * @override
   */
  afterHelperCreated() {
    // Clear cached tile representations since GPU buffers are device-bound.
    this.clearCache();
    this.styleRenderer_ = new VectorStyleRenderer(
      this.styles_,
      this.styleVariables_,
      this.helper,
    );
  }

  /**
   * @override
   */
  createTileRepresentation(options) {
    const tileRep = new TileGeometry(options, () => this.styleRenderer_);
    const listener = () => {
      if (tileRep.ready) {
        this.getLayer().changed();
        tileRep.removeEventListener(EventType.CHANGE, listener);
      }
    };
    tileRep.addEventListener(EventType.CHANGE, listener);
    return tileRep;
  }

  /**
   * @override
   */
  beforeTilesRender(frameState, tilesWithAlpha, tileCount) {
    const size = frameState.size;
    const pixelRatio = frameState.pixelRatio;
    this.helper.configureContextForFrame(
      frameState.index,
      size[0] * pixelRatio,
      size[1] * pixelRatio,
      pixelRatio,
    );
    this.isFirstPass_ = this.helper.isFirstPass(frameState.index);
    this.opacity_ = this.getLayer().getOpacity();
  }

  /**
   * @override
   */
  renderTile(
    tileRepresentation,
    tileTransform,
    frameState,
    renderExtent,
    tileResolution,
    tileSize,
    tileOrigin,
    tileExtent,
    depth,
    gutter,
    alpha,
    renderIndex,
    renderCount,
  ) {
    if (!this.styleRenderer_) {
      return;
    }
    const buffers = tileRepresentation.buffers;
    if (!tileRepresentation.ready || !buffers) {
      return;
    }

    // Treat each tile as a "world pass" for now so we can:
    // - clear only once at the beginning
    // - composite/blit only once at the end
    const isFirstTile = renderIndex === 0;
    const isLastTile = renderIndex === renderCount - 1;
    this.styleRenderer_.render(
      buffers,
      frameState,
      0,
      this.opacity_,
      isFirstTile,
      isLastTile,
      this.isFirstPass_ && isFirstTile,
    );
  }
}

export default WebGPUVectorTileLayerRenderer;
