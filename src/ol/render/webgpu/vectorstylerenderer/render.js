/**
 * @module ol/render/webgpu/vectorstylerenderer/render
 */

import {
  multiply as multiplyTransform,
  reset as resetTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from '../../../transform.js';
import {fromTransform as mat4FromTransform} from '../../../vec/mat4.js';
import {renderBuffers} from './buffers.js';

const UNIFORM_BYTE_SIZE = 112; // 28 * 4 bytes

/**
 * @typedef {Object} Draw
 * @property {Object} buffers Buffers object (polygon/line/point).
 * @property {number} globalAlpha Per-draw alpha multiplier.
 * @property {number} tileZoomLevel Per-draw tile zoom level.
 */

/**
 * Render one or more draw calls in a single WebGPU command submission.
 * @param {import('../VectorStyleRenderer.js').default} renderer Vector style renderer.
 * @param {Array<Draw>} draws Draw calls.
 * @param {import('../../../Map.js').FrameState} frameState Frame state.
 * @param {Object} options Options.
 * @param {number} [options.worldOffsetX] World offset in map units.
 * @param {number} [options.opacity] Layer opacity.
 * @param {boolean} [options.isFirstWorld] Whether this is the first world pass.
 * @param {boolean} [options.isLastWorld] Whether this is the last world pass.
 * @param {boolean} [options.isFirstPass] Whether this is the first pass for the shared canvas.
 * @param {boolean} [options.usePerDrawUniformBuffers] Whether to use a distinct uniform buffer per draw.
 */
export function renderDraws(renderer, draws, frameState, options) {
  if (!draws || draws.length === 0) {
    return;
  }

  /** @type {any} */
  const r = renderer;

  const {
    worldOffsetX = 0,
    opacity = 1,
    isFirstWorld = true,
    isLastWorld = true,
    isFirstPass = false,
    usePerDrawUniformBuffers = false,
  } = options || {};

  const device = r.helper_.getDevice();
  const context = r.helper_.getContext();
  if (!device || !context) {
    return;
  }

  if (r.variableNames_.length > 0) {
    r.syncVariables_(device);
  }

  const size = frameState.size;
  const width = size[0];
  const height = size[1];
  const pixelRatio = frameState.pixelRatio;
  const viewState = frameState.viewState;

  const center = viewState.center;
  const resolution = viewState.resolution;
  const rotation = viewState.rotation;
  const zoom = viewState.zoom;

  // 1. World -> Render (Pixel)
  // Translate(-center), Scale(1/res), Rotate(-rot), Translate(viewportCenter)
  const renderTransform = r.renderTransform_;
  resetTransform(renderTransform);
  translateTransform(renderTransform, width / 2, height / 2);
  scaleTransform(renderTransform, 1 / resolution, -1 / resolution);
  rotateTransform(renderTransform, -rotation);
  translateTransform(renderTransform, -center[0] + worldOffsetX, -center[1]);

  // 2. Pixel -> Clip
  // Scale (2/w, -2/h), Translate (-1, 1)
  const clipTransform = r.clipTransform_;
  resetTransform(clipTransform);
  translateTransform(clipTransform, -1, 1);
  scaleTransform(clipTransform, 2 / width, -2 / height);

  // 3. Combine: Clip * Render
  multiplyTransform(clipTransform, renderTransform);

  const commandEncoder = device.createCommandEncoder();

  const gpu = navigator.gpu;
  const format =
    r.canvasFormat_ || (r.canvasFormat_ = gpu.getPreferredCanvasFormat());
  const widthPx = Math.round(width * pixelRatio);
  const heightPx = Math.round(height * pixelRatio);
  const frameView = r.helper_.getFrameTextureView(
    frameState.index,
    format,
    widthPx,
    heightPx,
  );

  const useOffscreenComposite =
    Number.isFinite(opacity) && opacity >= 0 && opacity < 1;
  const geometryTargetView = useOffscreenComposite
    ? r.getOffscreenView_(device, format, widthPx, heightPx)
    : frameView;

  // If we are the first WebGPU layer in the frame, clear the persistent frame target.
  // This is needed even when the layer uses offscreen compositing (opacity < 1), because
  // the frame target will only be written to on the last world pass.
  if (useOffscreenComposite && isFirstPass && isFirstWorld) {
    const clearPassDesc =
      r.clearPassDescriptor_ ||
      (r.clearPassDescriptor_ = {
        colorAttachments: [
          {
            view: frameView,
            clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
    clearPassDesc.colorAttachments[0].view = frameView;
    const clearPass = commandEncoder.beginRenderPass(clearPassDesc);
    clearPass.end();
  }

  const renderPassDesc =
    r.renderPassDescriptor_ ||
    (r.renderPassDescriptor_ = {
      colorAttachments: [
        {
          view: geometryTargetView,
          clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
  renderPassDesc.colorAttachments[0].view = geometryTargetView;
  renderPassDesc.colorAttachments[0].loadOp = useOffscreenComposite
    ? isFirstWorld
      ? 'clear'
      : 'load'
    : isFirstPass && isFirstWorld
      ? 'clear'
      : 'load';

  const uniformData = r.uniformData_ || (r.uniformData_ = new Float32Array(28));
  const mat4Data = r.clipMat4_;
  mat4FromTransform(mat4Data, clipTransform);
  uniformData.set(mat4Data);
  uniformData[16] = resolution;
  uniformData[17] = pixelRatio;
  uniformData[18] = width;
  uniformData[19] = height;
  uniformData[20] = rotation;
  uniformData[21] = zoom;

  const now =
    typeof frameState.time === 'number' ? frameState.time : Date.now();
  if (r.startTime_ === null) {
    r.startTime_ = now;
  }
  uniformData[24] = (now - r.startTime_) * 0.001;
  uniformData[25] = 0;
  uniformData[26] = 0;
  uniformData[27] = 0;

  if (usePerDrawUniformBuffers) {
    while (r.tileUniformBuffers_.length < draws.length) {
      r.tileUniformBuffers_.push(
        device.createBuffer({
          size: UNIFORM_BYTE_SIZE,
          usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
        }),
      );
    }
  } else if (!r.uniformBuffer_) {
    r.uniformBuffer_ = device.createBuffer({
      size: UNIFORM_BYTE_SIZE,
      usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
    });
  }

  const passEncoder = commandEncoder.beginRenderPass(renderPassDesc);
  for (let i = 0; i < draws.length; i++) {
    const draw = draws[i];
    const uniformBuffer = usePerDrawUniformBuffers
      ? r.tileUniformBuffers_[i]
      : r.uniformBuffer_;
    uniformData[22] = draw.globalAlpha;
    uniformData[23] = draw.tileZoomLevel;
    device.queue.writeBuffer(
      uniformBuffer,
      0,
      /** @type {GPUAllowSharedBufferSource} */ (uniformData),
    );

    renderBuffers(
      renderer,
      passEncoder,
      device,
      format,
      draw.buffers,
      uniformBuffer,
    );
  }
  passEncoder.end();

  if (useOffscreenComposite && isLastWorld) {
    r.compositeToView_(
      device,
      geometryTargetView,
      frameView,
      format,
      opacity,
      commandEncoder,
      false,
    );
  }

  if (isLastWorld) {
    const swapChainView = r.helper_.getCurrentTextureView(frameState.index);
    r.compositeToView_(
      device,
      frameView,
      swapChainView,
      format,
      1,
      commandEncoder,
      true,
    );
  }

  device.queue.submit([commandEncoder.finish()]);
}
