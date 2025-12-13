/**
 * @module ol/renderer/webgpu/VectorLayer
 */
import ViewHint from '../../ViewHint.js';
import {listen, unlistenByKey} from '../../events.js';
import {buffer, createEmpty, equals, getWidth} from '../../extent.js';
import BaseVector from '../../layer/BaseVector.js';
import {
  getTransformFromProjections,
  getUserProjection,
  toUserExtent,
  toUserResolution,
} from '../../proj.js';
import MixedGeometryBatch from '../../render/webgl/MixedGeometryBatch.js';
import VectorStyleRenderer from '../../render/webgpu/VectorStyleRenderer.js';
import VectorEventType from '../../source/VectorEventType.js';
import {create as createTransform} from '../../transform.js';
import {getUid} from '../../util.js';
import WebGPULayerRenderer from './Layer.js';

/**
 * Compute world params (wrapX rendering).
 * Mirrors `src/ol/renderer/webgl/worldUtil.js` but kept local to avoid touching WebGL code.
 * @param {import("../../Map.js").FrameState} frameState Frame state.
 * @param {import("../../layer/Layer.js").default} layer Layer.
 * @return {Array<number>} The world start, end and width.
 */
function getWorldParameters(frameState, layer) {
  const projection = frameState.viewState.projection;
  const vectorSource = layer.getSource();
  const multiWorld = vectorSource.getWrapX() && projection.canWrapX();
  const projectionExtent = projection.getExtent();

  const extent = frameState.extent;
  const worldWidth = multiWorld ? getWidth(projectionExtent) : 0;
  const endWorld = multiWorld
    ? Math.ceil((extent[2] - projectionExtent[2]) / worldWidth) + 1
    : 1;

  const startWorld = multiWorld
    ? Math.floor((extent[0] - projectionExtent[0]) / worldWidth)
    : 0;

  return [startWorld, endWorld, worldWidth];
}

/**
 * @classdesc
 * WebGPU vector renderer.
 * @extends {WebGPULayerRenderer<import("../../layer/Layer.js").default>}
 */
class WebGPUVectorLayerRenderer extends WebGPULayerRenderer {
  /**
   * @param {import("../../layer/Layer.js").default} layer Layer.
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
    this.styles_ = Array.isArray(options.style)
      ? options.style
      : [options.style];

    /**
     * @private
     * @type {Object}
     */
    this.currentBuffers_ = null;

    /**
     * @private
     * @type {boolean}
     */
    this.initialFeaturesAdded_ = false;

    /**
     * @private
     * @type {boolean}
     */
    this.generatingBuffers_ = false;

    /**
     * @private
     * @type {Array<import("../../events.js").EventsKey|null>}
     */
    this.sourceListenKeys_ = null;

    /**
     * @private
     */
    this.geometryDirty_ = true;

    /**
     * @private
     */
    this.previousExtent_ = createEmpty();

    /**
     * @private
     * @type {Map<string, number>}
     */
    this.geometryRevisionByUid_ = new Map();

    /**
     * @private
     * @type {Map<number, import("../../Feature.js").default|import("../../render/Feature.js").default>}
     */
    this.styleDirtyRefs_ = new Map();
  }

  /**
   * @inheritDoc
   * @override
   */
  afterHelperCreated() {
    this.styleRenderer_ = new VectorStyleRenderer(
      this.styles_,
      {},
      this.helper,
    );
  }

  /**
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  addInitialFeatures_(frameState) {
    const source = this.getLayer().getSource();
    const userProjection = getUserProjection();
    let projectionTransform;
    if (userProjection) {
      projectionTransform = getTransformFromProjections(
        userProjection,
        frameState.viewState.projection,
      );
    }
    this.batch_.addFeatures(source.getFeatures(), projectionTransform);
    for (const feature of source.getFeatures()) {
      this.geometryRevisionByUid_.set(
        getUid(feature),
        feature.getGeometry()?.getRevision?.() ?? -1,
      );
    }
    this.sourceListenKeys_ = [
      listen(
        source,
        VectorEventType.ADDFEATURE,
        this.handleSourceFeatureAdded_.bind(this, projectionTransform),
      ),
      listen(
        source,
        VectorEventType.CHANGEFEATURE,
        this.handleSourceFeatureChanged_.bind(this, projectionTransform),
        this,
      ),
      listen(
        source,
        VectorEventType.REMOVEFEATURE,
        this.handleSourceFeatureDelete_,
        this,
      ),
      listen(
        source,
        VectorEventType.CLEAR,
        this.handleSourceFeatureClear_,
        this,
      ),
    ];
  }

  /**
   * @param {import("../../proj.js").TransformFunction} projectionTransform Transform function.
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureAdded_(projectionTransform, event) {
    const feature = event.feature;
    this.batch_.addFeature(feature, projectionTransform);
    this.geometryRevisionByUid_.set(
      getUid(feature),
      feature.getGeometry()?.getRevision?.() ?? -1,
    );
    this.geometryDirty_ = true;
  }

  /**
   * @param {import("../../proj.js").TransformFunction} projectionTransform Transform function.
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureChanged_(projectionTransform, event) {
    const feature = event.feature;
    const uid = getUid(feature);
    const revision = feature.getGeometry()?.getRevision?.() ?? -1;
    const previousRevision = this.geometryRevisionByUid_.get(uid);
    this.geometryRevisionByUid_.set(uid, revision);

    if (previousRevision !== revision) {
      this.batch_.changeFeature(feature, projectionTransform);
      this.geometryDirty_ = true;
      return;
    }

    const entry =
      this.batch_.pointBatch.entries[uid] ||
      this.batch_.lineStringBatch.entries[uid] ||
      this.batch_.polygonBatch.entries[uid];
    if (!entry || !entry.ref) {
      return;
    }
    this.styleDirtyRefs_.set(entry.ref, feature);
  }

  /**
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureDelete_(event) {
    const feature = event.feature;
    this.batch_.removeFeature(feature);
    this.geometryRevisionByUid_.delete(getUid(feature));
    this.geometryDirty_ = true;
  }

  /**
   * @private
   */
  handleSourceFeatureClear_() {
    this.batch_.clear();
    this.geometryRevisionByUid_.clear();
    this.styleDirtyRefs_.clear();
    this.geometryDirty_ = true;
  }

  /**
   * @inheritDoc
   * @override
   */
  prepareFrameInternal(frameState) {
    if (!this.styleRenderer_) {
      return false;
    }

    if (this.generatingBuffers_) {
      frameState.animate = true;
      return true;
    }

    if (!this.initialFeaturesAdded_) {
      this.addInitialFeatures_(frameState);
      this.initialFeaturesAdded_ = true;
    }

    const layer = this.getLayer();
    const vectorSource = layer.getSource();
    const viewState = frameState.viewState;
    const viewNotMoving =
      !frameState.viewHints[ViewHint.ANIMATING] &&
      !frameState.viewHints[ViewHint.INTERACTING];
    const extentChanged = !equals(this.previousExtent_, frameState.extent);

    if (viewNotMoving && extentChanged) {
      const projection = viewState.projection;
      const resolution = viewState.resolution;

      const renderBuffer =
        layer instanceof BaseVector ? layer.getRenderBuffer() : 0;
      const extent = buffer(frameState.extent, renderBuffer * resolution);

      const userProjection = getUserProjection();
      if (userProjection) {
        vectorSource.loadFeatures(
          toUserExtent(extent, userProjection),
          toUserResolution(resolution, projection),
          userProjection,
        );
      } else {
        vectorSource.loadFeatures(extent, resolution, projection);
      }
    }

    if (viewNotMoving && (extentChanged || this.geometryDirty_)) {
      this.ready = false;
      this.generatingBuffers_ = true;
      const transform = createTransform(); // Placeholder, logic moves to shader mainly, or batch transform.

      this.styleRenderer_
        .generateBuffers(this.batch_, transform)
        .then((buffers) => {
          this.currentBuffers_ = buffers;
          this.ready = true;
          this.generatingBuffers_ = false;
          this.geometryDirty_ = false;
          this.styleDirtyRefs_.clear();
          this.getLayer().changed();
        });

      this.previousExtent_ = frameState.extent.slice();
    }

    if (this.geometryDirty_ || !this.currentBuffers_) {
      frameState.animate = true;
    }

    return true;
  }

  /**
   * @inheritDoc
   * @override
   */
  renderFrame(frameState) {
    if (!this.helper || !this.styleRenderer_) {
      return null;
    }

    const size = frameState.size;
    const pixelRatio = frameState.pixelRatio;
    this.helper.configureContextForFrame(
      frameState.index,
      size[0] * pixelRatio,
      size[1] * pixelRatio,
      pixelRatio,
    );

    if (this.currentBuffers_) {
      if (this.styleDirtyRefs_.size > 0) {
        for (const [ref, feature] of this.styleDirtyRefs_) {
          this.styleRenderer_.updateFeatureStyles(
            this.currentBuffers_,
            ref,
            feature,
          );
        }
        this.styleDirtyRefs_.clear();
      }

      const isFirstPass = this.helper.isFirstPass(frameState.index);
      const [startWorld, endWorld, worldWidth] = getWorldParameters(
        frameState,
        this.getLayer(),
      );
      const opacity = this.getLayer().getOpacity();
      for (let world = startWorld; world < endWorld; world++) {
        this.styleRenderer_.render(
          this.currentBuffers_,
          frameState,
          world * worldWidth,
          opacity,
          world === startWorld,
          world === endWorld - 1,
          isFirstPass,
        );
      }
    }

    return this.helper.getCanvas();
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    if (this.sourceListenKeys_) {
      this.sourceListenKeys_.forEach(function (key) {
        unlistenByKey(key);
      });
      this.sourceListenKeys_ = null;
    }
    super.disposeInternal();
  }
}

export default WebGPUVectorLayerRenderer;
