/**
 * @module ol/webgpu/TileGeometry
 */

import MixedGeometryBatch from '../render/webgl/MixedGeometryBatch.js';
import {create as createTransform} from '../transform.js';
import BaseTileRepresentation from './BaseTileRepresentation.js';

/**
 * @typedef {import("../VectorRenderTile").default} TileType
 */

/**
 * @typedef {import("../render/webgpu/VectorStyleRenderer.js").default} VectorStyleRenderer
 */

/**
 * @extends {BaseTileRepresentation<TileType>}
 */
class TileGeometry extends BaseTileRepresentation {
  /**
   * @param {import("./BaseTileRepresentation.js").TileRepresentationOptions<TileType>} options Options.
   * @param {() => VectorStyleRenderer|null} getStyleRenderer Returns the current style renderer.
   */
  constructor(options, getStyleRenderer) {
    super(options);

    /**
     * @private
     */
    this.getStyleRenderer_ = getStyleRenderer;

    /**
     * @private
     */
    this.batch_ = new MixedGeometryBatch();

    /**
     * @typedef {Object} WebGPUTileBuffers
     * @property {Array<Object>|null} [polygonBuffers] Polygon buffer sets.
     * @property {Array<Object>|null} [lineStringBuffers] Line buffer sets.
     * @property {Array<Object>|null} [pointBuffers] Point buffer sets.
     * @property {{buffer: Object}|null} [featureProperties] Feature properties buffer wrapper.
     */

    /**
     * @type {WebGPUTileBuffers|null}
     */
    this.buffers = null;

    this.setTile(options.tile);
  }

  /**
   * @override
   */
  uploadTile() {
    const styleRenderer = this.getStyleRenderer_();
    if (!styleRenderer) {
      return;
    }

    this.ready = false;
    this.buffers = null;

    this.batch_.clear();
    const sourceTiles = this.tile.getSourceTiles();
    /** @type {Array<import("../Feature.js").FeatureLike>} */
    const features = [];
    for (const sourceTile of sourceTiles) {
      const tileFeatures = sourceTile.getFeatures();
      if (tileFeatures && tileFeatures.length) {
        features.push(...tileFeatures);
      }
    }
    this.batch_.addFeatures(features);

    const transform = createTransform(); // Currently unused by WebGPU VectorStyleRenderer.
    styleRenderer
      .generateBuffers(this.batch_, transform)
      .then((buffers) => {
        this.buffers = buffers;
        this.setReady();
      })
      .catch(() => {
        // Keep the tile non-ready to allow for retries on the next frame/helper recreation.
        this.buffers = null;
      });
  }

  /**
   * @param {any} buffer Wrapper buffer.
   * @private
   */
  destroyBuffer_(buffer) {
    const gpuBuffer = buffer && buffer.getBuffer ? buffer.getBuffer() : null;
    if (gpuBuffer && gpuBuffer.destroy) {
      try {
        gpuBuffer.destroy();
      } catch {
        // Ignore double-destroy or device-loss related errors.
      }
    }
  }

  /**
   * @override
   */
  disposeInternal() {
    const buffers = this.buffers;
    if (buffers) {
      /** @param {Array<Object>|null|undefined} sets Buffer sets. */
      const destroySets = (sets) => {
        if (!sets) {
          return;
        }
        for (const set of sets) {
          this.destroyBuffer_(set.vertex);
          this.destroyBuffer_(set.style);
        }
      };
      destroySets(buffers.polygonBuffers);
      destroySets(buffers.lineStringBuffers);
      destroySets(buffers.pointBuffers);
      if (buffers.featureProperties && buffers.featureProperties.buffer) {
        this.destroyBuffer_(buffers.featureProperties.buffer);
      }
    }
    this.buffers = null;
    super.disposeInternal();
  }
}

export default TileGeometry;
