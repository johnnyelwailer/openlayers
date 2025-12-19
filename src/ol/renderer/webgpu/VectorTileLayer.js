/**
 * @module ol/renderer/webgpu/VectorTileLayer
 */
import EventType from '../../events/EventType.js';
import VectorStyleRenderer from '../../render/webgpu/VectorStyleRenderer.js';
import {
  create as createTransform,
  multiply as multiplyTransform,
  reset as resetTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from '../../transform.js';
import {
  create as createMat4,
  fromTransform as mat4FromTransform,
} from '../../vec/mat4.js';
import TileGeometry from '../../webgpu/TileGeometry.js';
import WebGPUBaseTileLayerRenderer from './TileLayerBase.js';

const MASK_TEXTURE_FORMAT = 'rgba8unorm';
const MASK_DEPTH_FORMAT = 'depth24plus';

const MASK_SHADER_CODE = `
  struct FrameUniforms {
    transform : mat4x4<f32>,
  };

  struct TileMaskEntry {
    extent : vec4f,
    depth : f32,
    tileZoomLevel : f32,
    _pad0 : vec2f,
  };

  @group(0) @binding(0) var<uniform> u : FrameUniforms;
  @group(0) @binding(1) var<storage, read> tiles : array<TileMaskEntry>;

  fn vertexPos(vertexIndex : u32, extent : vec4f) -> vec2f {
    // Two triangles: (min,min)-(max,min)-(min,max) and (min,max)-(max,min)-(max,max)
    if (vertexIndex == 0u) { return vec2f(extent.x, extent.y); }
    if (vertexIndex == 1u) { return vec2f(extent.z, extent.y); }
    if (vertexIndex == 2u) { return vec2f(extent.x, extent.w); }
    if (vertexIndex == 3u) { return vec2f(extent.x, extent.w); }
    if (vertexIndex == 4u) { return vec2f(extent.z, extent.y); }
    return vec2f(extent.z, extent.w);
  }

  struct VertexOutput {
    @builtin(position) position : vec4f,
    @location(0) @interpolate(flat) tileZoomLevel : f32,
  };

  @vertex
  fn vs_main(
    @builtin(vertex_index) vertexIndex : u32,
    @builtin(instance_index) instanceIndex : u32
  ) -> VertexOutput {
    var out : VertexOutput;
    let tile = tiles[instanceIndex];
    let pos = vertexPos(vertexIndex, tile.extent);
    out.position = u.transform * vec4f(pos, tile.depth, 1.0);
    out.tileZoomLevel = tile.tileZoomLevel;
    return out;
  }

  @fragment
  fn fs_main(input : VertexOutput) -> @location(0) vec4f {
    return vec4f(input.tileZoomLevel / 50.0, 0.0, 0.0, 1.0);
  }
`;

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

    /**
     * @private
     * @type {GPUTexture|null}
     */
    this.tileMaskTexture_ = null;

    /**
     * @private
     * @type {GPUTextureView|null}
     */
    this.tileMaskView_ = null;

    /**
     * @private
     * @type {GPUTexture|null}
     */
    this.tileMaskDepthTexture_ = null;

    /**
     * @private
     * @type {GPUTextureView|null}
     */
    this.tileMaskDepthView_ = null;

    /**
     * @private
     * @type {GPUSampler|null}
     */
    this.tileMaskSampler_ = null;

    /**
     * @private
     * @type {GPURenderPipeline|null}
     */
    this.tileMaskPipeline_ = null;

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.tileMaskUniformBuffer_ = null;

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.tileMaskStorageBuffer_ = null;

    /**
     * @private
     * @type {GPUBindGroup|null}
     */
    this.tileMaskBindGroup_ = null;

    /**
     * @private
     * @type {import("../../transform.js").Transform}
     */
    this.tileMaskRenderTransform_ = createTransform();

    /**
     * @private
     * @type {import("../../transform.js").Transform}
     */
    this.tileMaskClipTransform_ = createTransform();

    /**
     * @private
     * @type {import("../../vec/mat4.js").Mat4}
     */
    this.tileMaskMat4_ = createMat4();

    /**
     * @private
     * @type {[number, number]}
     */
    this.tileMaskSize_ = [0, 0];

    /**
     * @private
     * @type {Float32Array}
     */
    this.tileMaskFrameUniformData_ = new Float32Array(16);

    /**
     * @private
     * @type {Float32Array}
     */
    this.tileMaskTileData_ = new Float32Array(0);

    /**
     * @private
     * @type {number}
     */
    this.tileMaskTileCount_ = 0;

    /**
     * @private
     * @type {number}
     */
    this.tileMaskTileCapacity_ = 0;

    /**
     * World-units padding applied to mask extents to avoid 1px cracks between
     * adjacent tiles due to rasterization rules/precision.
     * @private
     * @type {number}
     */
    this.tileMaskExtentPadding_ = 0;
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
    this.styleRenderer_.setTileMaskEnabled(true);
    this.styleRenderer_.setTileMaskResources(null, null);
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
  beforeTilesMaskRender(frameState) {
    if (!this.helper || !this.styleRenderer_) {
      return false;
    }
    const device = this.helper.getDevice();
    if (!device) {
      this.styleRenderer_.setTileMaskResources(null, null);
      return false;
    }

    const size = frameState.size;
    const pixelRatio = frameState.pixelRatio;
    const widthPx = Math.round(size[0] * pixelRatio);
    const heightPx = Math.round(size[1] * pixelRatio);

    // Collect per-tile mask data during the base renderer loop.
    this.tileMaskTileCount_ = 0;
    // Expand tile extents by one physical pixel in world units to prevent cracks.
    this.tileMaskExtentPadding_ = frameState.viewState.resolution / pixelRatio;

    // Ensure the WebGPU context is configured for the frame before rendering the mask.
    this.helper.configureContextForFrame(
      frameState.index,
      widthPx,
      heightPx,
      pixelRatio,
    );

    const needsResize =
      this.tileMaskSize_[0] !== widthPx || this.tileMaskSize_[1] !== heightPx;
    if (needsResize) {
      this.tileMaskSize_[0] = widthPx;
      this.tileMaskSize_[1] = heightPx;
      if (this.tileMaskTexture_) {
        this.tileMaskTexture_.destroy();
      }
      if (this.tileMaskDepthTexture_) {
        this.tileMaskDepthTexture_.destroy();
      }
      this.tileMaskTexture_ = device.createTexture({
        size: {width: widthPx, height: heightPx},
        format: MASK_TEXTURE_FORMAT,
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      this.tileMaskView_ = this.tileMaskTexture_.createView();
      this.tileMaskDepthTexture_ = device.createTexture({
        size: {width: widthPx, height: heightPx},
        format: MASK_DEPTH_FORMAT,
        usage: 0x10, // RENDER_ATTACHMENT
      });
      this.tileMaskDepthView_ = this.tileMaskDepthTexture_.createView();

      // Mask resources changed -> drop cached bind group.
      this.tileMaskBindGroup_ = null;
    }

    if (!this.tileMaskSampler_) {
      this.tileMaskSampler_ = device.createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        // Match WebGL behavior: the WebGL mask texture uses linear filtering.
        magFilter: 'linear',
        minFilter: 'linear',
      });
    }

    if (!this.tileMaskUniformBuffer_) {
      this.tileMaskUniformBuffer_ = device.createBuffer({
        size: this.tileMaskFrameUniformData_.byteLength, // 16 floats
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }

    if (!this.tileMaskPipeline_) {
      const shaderModule = device.createShaderModule({code: MASK_SHADER_CODE});
      this.tileMaskPipeline_ = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [
            {
              format: MASK_TEXTURE_FORMAT,
              blend: undefined,
            },
          ],
        },
        primitive: {
          topology: 'triangle-list',
        },
        depthStencil: {
          format: MASK_DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'less-equal',
        },
      });
      this.tileMaskBindGroup_ = null;
    }

    // Compute the world -> clip transform for the current view (same math as VectorStyleRenderer).
    const width = size[0];
    const height = size[1];
    const rotation = frameState.viewState.rotation;
    const resolution = frameState.viewState.resolution;
    const center = frameState.viewState.center;

    const renderTransform = this.tileMaskRenderTransform_;
    resetTransform(renderTransform);
    translateTransform(renderTransform, width / 2, height / 2);
    scaleTransform(renderTransform, 1 / resolution, -1 / resolution);
    rotateTransform(renderTransform, -rotation);
    translateTransform(renderTransform, -center[0], -center[1]);

    const clipTransform = this.tileMaskClipTransform_;
    resetTransform(clipTransform);
    translateTransform(clipTransform, -1, 1);
    scaleTransform(clipTransform, 2 / width, -2 / height);
    multiplyTransform(clipTransform, renderTransform);

    mat4FromTransform(this.tileMaskMat4_, clipTransform);

    return true;
  }

  /**
   * @override
   */
  renderTileMask(tileRepresentation, tileZ, extent, depth) {
    if (!this.helper || !tileRepresentation.ready) {
      return;
    }

    const tileIndex = this.tileMaskTileCount_++;
    if (tileIndex >= this.tileMaskTileCapacity_) {
      const newCapacity = Math.max(16, this.tileMaskTileCapacity_ * 2);
      const next = new Float32Array(newCapacity * 8);
      next.set(this.tileMaskTileData_);
      this.tileMaskTileData_ = next;
      this.tileMaskTileCapacity_ = newCapacity;
    }
    const base = tileIndex * 8;
    const data = this.tileMaskTileData_;
    const pad = this.tileMaskExtentPadding_;
    data[base + 0] = extent[0] - pad;
    data[base + 1] = extent[1] - pad;
    data[base + 2] = extent[2] + pad;
    data[base + 3] = extent[3] + pad;
    data[base + 4] = depth;
    data[base + 5] = tileZ;
    data[base + 6] = 0;
    data[base + 7] = 0;
  }

  /**
   * @override
   */
  afterTilesMaskRender(frameState) {
    if (!this.helper) {
      return;
    }
    const device = this.helper.getDevice();
    if (
      !device ||
      !this.tileMaskPipeline_ ||
      !this.tileMaskUniformBuffer_ ||
      !this.tileMaskView_ ||
      !this.tileMaskDepthView_
    ) {
      return;
    }

    // Upload per-frame transform.
    const frameUniform = this.tileMaskFrameUniformData_;
    frameUniform.set(this.tileMaskMat4_, 0);
    device.queue.writeBuffer(
      this.tileMaskUniformBuffer_,
      0,
      /** @type {GPUAllowSharedBufferSource} */ (frameUniform),
    );

    // Ensure storage buffer has enough capacity for the collected tiles.
    const tileCount = this.tileMaskTileCount_;
    const requiredBytes = tileCount * 8 * 4;
    if (
      !this.tileMaskStorageBuffer_ ||
      this.tileMaskStorageBuffer_.size < requiredBytes
    ) {
      if (this.tileMaskStorageBuffer_) {
        this.tileMaskStorageBuffer_.destroy();
      }
      // Over-allocate to reduce churn.
      const capacityBytes = Math.max(requiredBytes, 16 * 8 * 4);
      this.tileMaskStorageBuffer_ = device.createBuffer({
        size: capacityBytes,
        usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
      });
      this.tileMaskBindGroup_ = null;
    }

    if (tileCount > 0) {
      device.queue.writeBuffer(
        this.tileMaskStorageBuffer_,
        0,
        /** @type {GPUAllowSharedBufferSource} */ (
          this.tileMaskTileData_.subarray(0, tileCount * 8)
        ),
      );
    }

    if (!this.tileMaskBindGroup_) {
      this.tileMaskBindGroup_ = device.createBindGroup({
        layout: this.tileMaskPipeline_.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {buffer: this.tileMaskUniformBuffer_},
          },
          {
            binding: 1,
            resource: {buffer: this.tileMaskStorageBuffer_},
          },
        ],
      });
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.tileMaskView_,
          clearValue: {r: 0, g: 0, b: 0, a: 0},
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.tileMaskDepthView_,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.tileMaskPipeline_);
    pass.setBindGroup(0, this.tileMaskBindGroup_);
    if (tileCount > 0) {
      pass.draw(6, tileCount);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);

    // Make the mask available to geometry passes for this frame.
    this.styleRenderer_.setTileMaskResources(
      this.tileMaskSampler_,
      this.tileMaskView_,
    );
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
    const tileZ = tileRepresentation.tile.tileCoord[0];
    this.styleRenderer_.render(
      buffers,
      frameState,
      0,
      this.opacity_,
      isFirstTile,
      isLastTile,
      this.isFirstPass_ && isFirstTile,
      alpha,
      tileZ,
    );
  }
}

export default WebGPUVectorTileLayerRenderer;
