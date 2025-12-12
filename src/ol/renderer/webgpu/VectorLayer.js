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
 * @extends {WebGPULayerRenderer<import("../../layer/Layer.js").default>}
 */
import {listen, unlistenByKey} from '../../events.js';
import {getTransformFromProjections, getUserProjection, toUserExtent, toUserResolution} from '../../proj.js';
import VectorEventType from '../../source/VectorEventType.js';
import ViewHint from '../../ViewHint.js';
import {buffer, createEmpty, equals} from '../../extent.js';
import BaseVector from '../../layer/BaseVector.js';

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
    this.sourceRevision_ = -1;

    /**
     * @private
     */
    this.previousExtent_ = createEmpty();
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
    const features = source.getFeatures();
    const userProjection = getUserProjection();
    console.error(`[WebGPUVectorLayer] addInitialFeatures. Count: ${features.length}. UserProj: ${userProjection ? userProjection.getCode() : 'null'}`);
    let projectionTransform;
    if (userProjection) {
      projectionTransform = getTransformFromProjections(
        userProjection,
        frameState.viewState.projection,
      );
      console.error('WebGPUVectorLayer transform:', !!projectionTransform);
    }
    this.batch_.addFeatures(source.getFeatures(), projectionTransform);
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
  }

  /**
   * @param {import("../../proj.js").TransformFunction} projectionTransform Transform function.
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureChanged_(projectionTransform, event) {
    const feature = event.feature;
    this.batch_.changeFeature(feature, projectionTransform);
  }

  /**
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureDelete_(event) {
    const feature = event.feature;
    this.batch_.removeFeature(feature);
  }

  /**
   * @private
   */
  handleSourceFeatureClear_() {
    this.batch_.clear();
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
    const sourceChanged = this.sourceRevision_ < vectorSource.getRevision();

    if (sourceChanged) {
      this.sourceRevision_ = vectorSource.getRevision();
    }

    if (viewNotMoving && (extentChanged || sourceChanged)) {
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
      
      this.ready = false;
      this.generatingBuffers_ = true;
      const transform = createTransform(); // Placeholder, logic moves to shader mainly, or batch transform.
      
      this.styleRenderer_
        .generateBuffers(this.batch_, transform)
        .then((buffers) => {
          this.currentBuffers_ = buffers;
          this.ready = true;
          this.generatingBuffers_ = false;
          this.getLayer().changed();
        });

      this.previousExtent_ = frameState.extent.slice();
    }

    if (sourceChanged || !this.currentBuffers_) {
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
    this.helper.configureContext(
      size[0] * pixelRatio,
      size[1] * pixelRatio,
      pixelRatio,
    );

    if (this.currentBuffers_) {
      this.styleRenderer_.render(this.currentBuffers_, frameState);
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
