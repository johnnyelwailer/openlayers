/**
 * @module ol/renderer/webgpu/TileLayerBase
 */
import TileRange from '../../TileRange.js';
import TileState from '../../TileState.js';
import {descending} from '../../array.js';
import {getIntersection, getRotatedViewport, isEmpty} from '../../extent.js';
import {fromUserExtent} from '../../proj.js';
import {toSize} from '../../size.js';
import LRUCache from '../../structs/LRUCache.js';
import {
  createOrUpdate as createTileCoord,
  getKey as getTileCoordKey,
} from '../../tilecoord.js';
import {
  create as createTransform,
  reset as resetTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from '../../transform.js';
import {abstract, getUid} from '../../util.js';
import WebGPULayerRenderer from './Layer.js';

/**
 * Transform a zoom level into a depth value; zoom level zero has a depth value of 0.5, and increasing values
 * have a depth trending towards 0
 * @param {number} z A zoom level.
 * @return {number} A depth value.
 */
function depthForZ(z) {
  return 1 / (z + 2);
}

/**
 * @typedef {import("../../webgpu/BaseTileRepresentation.js").default<import("../../Tile.js").default>} AbstractTileRepresentation
 */
/**
 * @typedef {Object} TileRepresentationLookup
 * @property {Set<string>} tileIds The set of tile ids in the lookup.
 * @property {Object<number, Set<AbstractTileRepresentation>>} representationsByZ Tile representations by zoom level.
 */

/**
 * @return {TileRepresentationLookup} A new tile representation lookup.
 */
export function newTileRepresentationLookup() {
  return {tileIds: new Set(), representationsByZ: {}};
}

/**
 * Check if a tile is already in the tile representation lookup.
 * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of tile representations by zoom level.
 * @param {import("../../Tile.js").default} tile A tile.
 * @return {boolean} The tile is already in the lookup.
 */
function lookupHasTile(tileRepresentationLookup, tile) {
  return tileRepresentationLookup.tileIds.has(getUid(tile));
}

/**
 * Add a tile representation to the lookup.
 * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of tile representations by zoom level.
 * @param {AbstractTileRepresentation} tileRepresentation A tile representation.
 * @param {number} z The zoom level.
 */
function addTileRepresentationToLookup(
  tileRepresentationLookup,
  tileRepresentation,
  z,
) {
  const representationsByZ = tileRepresentationLookup.representationsByZ;
  if (!(z in representationsByZ)) {
    representationsByZ[z] = new Set();
  }
  representationsByZ[z].add(tileRepresentation);
  tileRepresentationLookup.tileIds.add(getUid(tileRepresentation.tile));
}

/**
 * @param {import("../../Map.js").FrameState} frameState Frame state.
 * @param {import("../../extent.js").Extent} extent The frame extent.
 * @return {import("../../extent.js").Extent} Frame extent intersected with layer extents.
 */
function getRenderExtent(frameState, extent) {
  const layerState = frameState.layerStatesArray[frameState.layerIndex];
  if (layerState.extent) {
    extent = getIntersection(
      extent,
      fromUserExtent(layerState.extent, frameState.viewState.projection),
    );
  }
  const source = /** @type {import("../../source/Tile.js").default} */ (
    layerState.layer.getRenderSource()
  );
  if (!source.getWrapX()) {
    const gridExtent = source
      .getTileGridForProjection(frameState.viewState.projection)
      .getExtent();
    if (gridExtent) {
      extent = getIntersection(extent, gridExtent);
    }
  }
  return extent;
}

/**
 * @param {import("../../source/Tile.js").default} source The source.
 * @param {import('../../tilecoord.js').TileCoord} tileCoord The tile coordinate.
 * @return {string} The cache key.
 */
export function getCacheKey(source, tileCoord) {
  return `${getUid(source)},${source.getKey()},${source.getRevision()},${getTileCoordKey(tileCoord)}`;
}

/**
 * @typedef {Object} Options
 * @property {number} [cacheSize=512] The tile representation cache size.
 */

/**
 * @typedef {import("../../layer/BaseTile.js").default} BaseLayerType
 */

/**
 * @classdesc
 * Base WebGPU renderer for tile layers.
 * @template {BaseLayerType} LayerType
 * @template {import("../../Tile.js").default} TileType
 * @template {import("../../webgpu/BaseTileRepresentation.js").default<TileType>} TileRepresentation
 * @extends {WebGPULayerRenderer<LayerType>}
 */
class WebGPUBaseTileLayerRenderer extends WebGPULayerRenderer {
  /**
   * @param {LayerType} tileLayer Tile layer.
   * @param {Options} options Options.
   */
  constructor(tileLayer, options) {
    super(tileLayer, options);

    /**
     * The last call to `renderFrame` was completed with all tiles loaded
     * @type {boolean}
     */
    this.renderComplete = false;

    /**
     * This transform converts representation coordinates to screen coordinates.
     * @type {import("../../transform.js").Transform}
     * @private
     */
    this.tileTransform_ = createTransform();

    /**
     * @type {import("../../TileRange.js").default}
     * @private
     */
    this.tempTileRange_ = new TileRange(0, 0, 0, 0);

    /**
     * @type {import("../../tilecoord.js").TileCoord}
     * @private
     */
    this.tempTileCoord_ = createTileCoord(0, 0, 0);

    /**
     * @type {import("../../size.js").Size}
     * @private
     */
    this.tempSize_ = [0, 0];

    const cacheSize = options.cacheSize !== undefined ? options.cacheSize : 512;
    /**
     * @type {import("../../structs/LRUCache.js").default<TileRepresentation>}
     * @protected
     */
    this.tileRepresentationCache = new LRUCache(cacheSize);

    /**
     * @protected
     * @type {import("../../Map.js").FrameState|null}
     */
    this.frameState = null;

    /**
     * @private
     * @type {import("../../proj/Projection.js").default}
     */
    this.renderedProjection_ = undefined;
  }

  /**
   * Determine whether renderFrame should be called.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @override
   */
  prepareFrameInternal(frameState) {
    if (!this.renderedProjection_) {
      this.renderedProjection_ = frameState.viewState.projection;
    } else if (frameState.viewState.projection !== this.renderedProjection_) {
      this.clearCache();
      this.renderedProjection_ = frameState.viewState.projection;
    }

    const layer = this.getLayer();
    const source = layer.getRenderSource();
    if (!source) {
      return false;
    }

    if (isEmpty(getRenderExtent(frameState, frameState.extent))) {
      return false;
    }
    return source.getState() === 'ready';
  }

  /**
   * @abstract
   * @param {import("../../webgpu/BaseTileRepresentation.js").TileRepresentationOptions<TileType>} options tile representation options
   * @return {TileRepresentation} A new tile representation
   * @protected
   */
  createTileRepresentation(options) {
    return abstract();
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {import("../../extent.js").Extent} extent The extent to be rendered.
   * @param {number} initialZ The zoom level.
   * @param {TileRepresentationLookup} tileRepresentationLookup The zoom level.
   * @param {number} preload Number of additional levels to load.
   */
  enqueueTiles(
    frameState,
    extent,
    initialZ,
    tileRepresentationLookup,
    preload,
  ) {
    const viewState = frameState.viewState;
    const tileLayer = this.getLayer();
    const tileSource = tileLayer.getRenderSource();
    const tileGrid = tileSource.getTileGridForProjection(viewState.projection);
    const gutter = tileSource.getGutterForProjection(viewState.projection);

    const tileSourceKey = getUid(tileSource);
    if (!(tileSourceKey in frameState.wantedTiles)) {
      frameState.wantedTiles[tileSourceKey] = {};
    }

    const wantedTiles = frameState.wantedTiles[tileSourceKey];
    const tileRepresentationCache = this.tileRepresentationCache;

    const map = tileLayer.getMapInternal();
    const minZ = Math.max(
      initialZ - preload,
      tileGrid.getMinZoom(),
      tileGrid.getZForResolution(
        Math.min(
          tileLayer.getMaxResolution(),
          map
            ? map
                .getView()
                .getResolutionForZoom(Math.max(tileLayer.getMinZoom(), 0))
            : tileGrid.getResolution(0),
        ),
        tileSource.zDirection,
      ),
    );
    const rotation = viewState.rotation;
    const viewport = rotation
      ? getRotatedViewport(
          viewState.center,
          viewState.resolution,
          rotation,
          frameState.size,
        )
      : undefined;
    for (let z = initialZ; z >= minZ; --z) {
      const tileRange = tileGrid.getTileRangeForExtentAndZ(
        extent,
        z,
        this.tempTileRange_,
      );

      const tileResolution = tileGrid.getResolution(z);

      for (let x = tileRange.minX; x <= tileRange.maxX; ++x) {
        for (let y = tileRange.minY; y <= tileRange.maxY; ++y) {
          if (
            rotation &&
            !tileGrid.tileCoordIntersectsViewport([z, x, y], viewport)
          ) {
            continue;
          }
          const tileCoord = createTileCoord(z, x, y, this.tempTileCoord_);
          const cacheKey = getCacheKey(tileSource, tileCoord);

          /** @type {TileRepresentation} */
          let tileRepresentation;

          /** @type {TileType} */
          let tile;

          if (tileRepresentationCache.containsKey(cacheKey)) {
            tileRepresentation = tileRepresentationCache.get(cacheKey);
            tile = tileRepresentation.tile;
          }
          if (
            !tileRepresentation ||
            tileRepresentation.tile.key !== tileSource.getKey()
          ) {
            tile = tileSource.getTile(
              z,
              x,
              y,
              frameState.pixelRatio,
              viewState.projection,
            );
            if (!tile) {
              continue;
            }
          }

          if (lookupHasTile(tileRepresentationLookup, tile)) {
            continue;
          }

          if (!tileRepresentation) {
            tileRepresentation = this.createTileRepresentation({
              tile: tile,
              grid: tileGrid,
              helper: this.helper,
              gutter: gutter,
            });
            tileRepresentationCache.set(cacheKey, tileRepresentation);
          } else {
            tileRepresentation.setTile(tile);
          }

          addTileRepresentationToLookup(
            tileRepresentationLookup,
            tileRepresentation,
            z,
          );

          const tileQueueKey = tile.getKey();
          wantedTiles[tileQueueKey] = true;

          if (tile.getState() === TileState.IDLE) {
            if (!frameState.tileQueue.isKeyQueued(tileQueueKey)) {
              frameState.tileQueue.enqueue([
                tile,
                tileSourceKey,
                tileGrid.getTileCoordCenter(tileCoord),
                tileResolution,
              ]);
            }
          }
        }
      }
    }
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {boolean} tilesWithAlpha True if at least one of the rendered tiles has alpha
   * @param {number} tileCount How many tiles will be rendered
   * @protected
   */
  beforeTilesRender(frameState, tilesWithAlpha, tileCount) {}

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} If returns false, tile mask rendering will be skipped
   * @protected
   */
  beforeTilesMaskRender(frameState) {
    return false;
  }

  /**
   * @param {TileRepresentation} tileRepresentation Tile representation
   * @param {number} tileZ Tile zoom level
   * @param {import("../../extent.js").Extent} extent Tile extent
   * @param {number} depth Tile depth
   * @protected
   */
  renderTileMask(tileRepresentation, tileZ, extent, depth) {}

  /**
   * @param {TileRepresentation} tileRepresentation Tile representation
   * @param {import("../../transform.js").Transform} tileTransform Tile transform
   * @param {import("../../Map.js").FrameState} frameState Frame state
   * @param {import("../../extent.js").Extent} renderExtent Render extent for clipping
   * @param {number} tileResolution Tile resolution
   * @param {import("../../size.js").Size} tileSize Tile size
   * @param {import("../../coordinate.js").Coordinate} tileOrigin Tile origin
   * @param {import("../../extent.js").Extent} tileExtent Tile extent
   * @param {number} depth Tile depth
   * @param {number} gutter Tile gutter
   * @param {number} alpha Tile alpha
   * @param {number} renderIndex Index in current render pass
   * @param {number} renderCount Total tiles in current render pass
   * @protected
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
  ) {}

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {TileRepresentation} tileRepresentation Tile representation.
   * @param {number} tileZ Tile zoom level.
   * @param {number} gutter Tile gutter.
   * @param {import("../../extent.js").Extent} extent Layer extent.
   * @param {Object<string, number>} alphaLookup Alpha lookup.
   * @param {import("../../tilegrid/TileGrid.js").default} tileGrid Tile grid.
   * @param {number} renderIndex Render index.
   * @param {number} renderCount Render count.
   * @private
   */
  drawTile_(
    frameState,
    tileRepresentation,
    tileZ,
    gutter,
    extent,
    alphaLookup,
    tileGrid,
    renderIndex,
    renderCount,
  ) {
    if (!tileRepresentation.ready) {
      return;
    }
    const tile = tileRepresentation.tile;
    const tileCoord = tile.tileCoord;
    const tileCoordKey = getTileCoordKey(tileCoord);
    const alpha = tileCoordKey in alphaLookup ? alphaLookup[tileCoordKey] : 1;

    const tileResolution = tileGrid.getResolution(tileZ);
    const tileSize = toSize(tileGrid.getTileSize(tileZ), this.tempSize_);
    const tileOrigin = tileGrid.getOrigin(tileZ);
    const tileExtent = tileGrid.getTileCoordExtent(tileCoord);
    // tiles with alpha are rendered last to allow blending
    const depth = alpha < 1 ? -1 : depthForZ(tileZ);
    if (alpha < 1) {
      frameState.animate = true;
    }

    const viewState = frameState.viewState;
    const centerX = viewState.center[0];
    const centerY = viewState.center[1];

    const tileWidthWithGutter = tileSize[0] + 2 * gutter;
    const tileHeightWithGutter = tileSize[1] + 2 * gutter;

    const aspectRatio = tileWidthWithGutter / tileHeightWithGutter;

    const centerI = (centerX - tileOrigin[0]) / (tileSize[0] * tileResolution);
    const centerJ = (tileOrigin[1] - centerY) / (tileSize[1] * tileResolution);

    const tileScale = viewState.resolution / tileResolution;

    const tileCenterI = tileCoord[1];
    const tileCenterJ = tileCoord[2];

    resetTransform(this.tileTransform_);
    scaleTransform(
      this.tileTransform_,
      2 / ((frameState.size[0] * tileScale) / tileWidthWithGutter),
      -2 / ((frameState.size[1] * tileScale) / tileWidthWithGutter),
    );
    rotateTransform(this.tileTransform_, viewState.rotation);
    scaleTransform(this.tileTransform_, 1, 1 / aspectRatio);
    translateTransform(
      this.tileTransform_,
      (tileSize[0] * (tileCenterI - centerI) - gutter) / tileWidthWithGutter,
      (tileSize[1] * (tileCenterJ - centerJ) - gutter) / tileHeightWithGutter,
    );

    this.renderTile(
      /** @type {TileRepresentation} */ (tileRepresentation),
      this.tileTransform_,
      frameState,
      extent,
      tileResolution,
      tileSize,
      tileOrigin,
      tileExtent,
      depth,
      gutter,
      alpha,
      renderIndex,
      renderCount,
    );
  }

  /**
   * Render the layer.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {HTMLElement} The rendered element.
   * @override
   */
  renderFrame(frameState) {
    this.frameState = frameState;
    this.renderComplete = true;

    const viewState = frameState.viewState;
    const tileLayer = this.getLayer();
    const tileSource = tileLayer.getRenderSource();
    const tileGrid = tileSource.getTileGridForProjection(viewState.projection);
    const gutter = tileSource.getGutterForProjection(viewState.projection);
    const extent = getRenderExtent(frameState, frameState.extent);
    const z = tileGrid.getZForResolution(
      viewState.resolution,
      tileSource.zDirection,
    );

    /**
     * @type {TileRepresentationLookup}
     */
    const tileRepresentationLookup = newTileRepresentationLookup();

    const preload = tileLayer.getPreload();
    if (frameState.nextExtent) {
      const targetZ = tileGrid.getZForResolution(
        viewState.nextResolution,
        tileSource.zDirection,
      );
      const nextExtent = getRenderExtent(frameState, frameState.nextExtent);
      this.enqueueTiles(
        frameState,
        nextExtent,
        targetZ,
        tileRepresentationLookup,
        preload,
      );
    }

    this.enqueueTiles(frameState, extent, z, tileRepresentationLookup, 0);
    if (preload > 0) {
      setTimeout(() => {
        this.enqueueTiles(
          frameState,
          extent,
          z - 1,
          tileRepresentationLookup,
          preload - 1,
        );
      }, 0);
    }

    /**
     * A lookup of alpha values for tiles at the target rendering resolution
     * for tiles that are in transition.  If a tile coord key is absent from
     * this lookup, the tile should be rendered at alpha 1.
     * @type {Object<string, number>}
     */
    const alphaLookup = {};

    let blend = false;
    const representationsByZ = tileRepresentationLookup.representationsByZ;

    // look for cached tiles to use if a target tile is not ready
    if (z in representationsByZ) {
      const uid = getUid(this);
      const time = frameState.time;
      for (const tileRepresentation of representationsByZ[z]) {
        const tile = tileRepresentation.tile;
        if (tile.getState() === TileState.EMPTY) {
          continue;
        }
        const tileCoord = tile.tileCoord;

        if (tileRepresentation.ready) {
          const alpha = tile.getAlpha(uid, time);
          if (alpha === 1) {
            // no need to look for alt tiles
            tile.endTransition(uid);
            continue;
          }
          blend = true;
          const tileCoordKey = getTileCoordKey(tileCoord);
          alphaLookup[tileCoordKey] = alpha;
        }
        this.renderComplete = false;

        // first look for child tiles (at z + 1)
        const coveredByChildren = this.findAltTiles_(
          tileGrid,
          tileCoord,
          z + 1,
          tileRepresentationLookup,
        );

        if (coveredByChildren) {
          continue;
        }

        // next look for parent tiles
        const minZoom = tileGrid.getMinZoom();
        for (let parentZ = z - 1; parentZ >= minZoom; --parentZ) {
          const coveredByParent = this.findAltTiles_(
            tileGrid,
            tileCoord,
            parentZ,
            tileRepresentationLookup,
          );

          if (coveredByParent) {
            break;
          }
        }
      }
    }

    const zs = Object.keys(representationsByZ).map(Number).sort(descending);

    const renderTileMask = this.beforeTilesMaskRender(frameState);

    if (renderTileMask) {
      for (let j = 0, jj = zs.length; j < jj; ++j) {
        const tileZ = zs[j];
        for (const tileRepresentation of representationsByZ[tileZ]) {
          const tileCoord = tileRepresentation.tile.tileCoord;
          const tileCoordKey = getTileCoordKey(tileCoord);
          // do not render the tile mask if alpha < 1
          if (tileCoordKey in alphaLookup) {
            continue;
          }
          const tileExtent = tileGrid.getTileCoordExtent(tileCoord);
          this.renderTileMask(
            /** @type {TileRepresentation} */ (tileRepresentation),
            tileZ,
            tileExtent,
            depthForZ(tileZ),
          );
        }
      }
    }

    // Compute draw calls to provide a stable renderIndex/renderCount.
    /** @type {Array<{tileZ:number, tileRepresentation:TileRepresentation}>} */
    const drawCalls = [];
    for (let j = 0, jj = zs.length; j < jj; ++j) {
      const tileZ = zs[j];
      for (const tileRepresentation of representationsByZ[tileZ]) {
        const tileCoord = tileRepresentation.tile.tileCoord;
        const tileCoordKey = getTileCoordKey(tileCoord);
        if (tileCoordKey in alphaLookup) {
          continue;
        }
        drawCalls.push({
          tileZ,
          tileRepresentation: /** @type {TileRepresentation} */ (
            tileRepresentation
          ),
        });
      }
    }
    if (z in representationsByZ) {
      for (const tileRepresentation of representationsByZ[z]) {
        const tileCoord = tileRepresentation.tile.tileCoord;
        const tileCoordKey = getTileCoordKey(tileCoord);
        if (tileCoordKey in alphaLookup) {
          drawCalls.push({
            tileZ: z,
            tileRepresentation: /** @type {TileRepresentation} */ (
              tileRepresentation
            ),
          });
        }
      }
    }

    this.beforeTilesRender(frameState, blend, drawCalls.length);

    for (let i = 0; i < drawCalls.length; i++) {
      const {tileRepresentation, tileZ} = drawCalls[i];
      this.drawTile_(
        frameState,
        tileRepresentation,
        tileZ,
        gutter,
        extent,
        alphaLookup,
        tileGrid,
        i,
        drawCalls.length,
      );
    }

    const tileRepresentationCache = this.tileRepresentationCache;
    tileRepresentationCache.expireCache();

    return this.helper.getCanvas();
  }

  /**
   * Look for tiles covering the provided tile coordinate at an alternate
   * zoom level.  Loaded tiles will be added to the provided tile representation lookup.
   * @param {import("../../tilegrid/TileGrid.js").default} tileGrid The tile grid.
   * @param {import("../../tilecoord.js").TileCoord} tileCoord The target tile coordinate.
   * @param {number} altZ The alternate zoom level.
   * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of
   * tile representations by zoom level.
   * @return {boolean} The tile coordinate is covered by loaded tiles at the alternate zoom level.
   * @private
   */
  findAltTiles_(tileGrid, tileCoord, altZ, tileRepresentationLookup) {
    const tileRange = tileGrid.getTileRangeForTileCoordAndZ(
      tileCoord,
      altZ,
      this.tempTileRange_,
    );

    if (!tileRange) {
      return false;
    }

    let covered = true;
    const tileRepresentationCache = this.tileRepresentationCache;
    const source = this.getLayer().getRenderSource();
    for (let x = tileRange.minX; x <= tileRange.maxX; ++x) {
      for (let y = tileRange.minY; y <= tileRange.maxY; ++y) {
        const cacheKey = getCacheKey(source, [altZ, x, y]);
        let loaded = false;
        if (tileRepresentationCache.containsKey(cacheKey)) {
          const tileRepresentation = tileRepresentationCache.get(cacheKey);
          if (
            tileRepresentation.ready &&
            !lookupHasTile(tileRepresentationLookup, tileRepresentation.tile)
          ) {
            addTileRepresentationToLookup(
              tileRepresentationLookup,
              tileRepresentation,
              altZ,
            );
            loaded = true;
          }
        }
        if (!loaded) {
          covered = false;
        }
      }
    }
    return covered;
  }

  clearCache() {
    const tileRepresentationCache = this.tileRepresentationCache;
    tileRepresentationCache.forEach((tileRepresentation) =>
      tileRepresentation.dispose(),
    );
    tileRepresentationCache.clear();
  }

  /**
   * @override
   */
  afterHelperCreated() {
    super.afterHelperCreated();

    // Most tile representations will have GPU resources tied to a device.
    // A conservative default is to clear the cache on helper creation.
    this.clearCache();
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    super.disposeInternal();
    delete this.frameState;
  }
}

export default WebGPUBaseTileLayerRenderer;
