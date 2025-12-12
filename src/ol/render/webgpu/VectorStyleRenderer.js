/**
 * @module ol/render/webgpu/VectorStyleRenderer
 */
import earcut from 'earcut';
import {asArray} from '../../color.js';
import {
  create as createTransform,
  multiply as multiplyTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from '../../transform.js';
import {
  create as createMat4,
  fromTransform as mat4FromTransform,
} from '../../vec/mat4.js';
import WebGPUBuffer from '../../webgpu/Buffer.js';
import {writeLineSegmentToBuffers} from '../linestringUtil.js';
import {WGSLBuilder} from './WGSLBuilder.js';
import {collectGetProperties, compileWgslExpression} from './expr.js';

/**
 * @typedef {Object} StrokePatternTexture
 * @property {GPUSampler} sampler Sampler.
 * @property {GPUTextureView} view Texture view.
 * @property {[number, number]} size Texture size in pixels.
 */

/**
 * @typedef {Object} PolygonBufferSet
 * @property {WebGPUBuffer} vertex Vertex buffer.
 * @property {WebGPUBuffer} style Style buffer.
 * @property {string} [fillShader] Optional WGSL shader override.
 * @property {StrokePatternTexture} [pattern] Optional fill pattern resources.
 */

/**
 * @typedef {Object} PointBufferSet
 * @property {WebGPUBuffer} vertex Vertex buffer (instanced: position + featureIndex).
 * @property {WebGPUBuffer} style Style buffer.
 * @property {string} [symbolShader] Optional WGSL shader override.
 * @property {StrokePatternTexture} [pattern] Optional symbol texture resources.
 */

/**
 * @typedef {Object} LineStringBufferSet
 * @property {WebGPUBuffer} vertex Vertex buffer.
 * @property {WebGPUBuffer} style Style buffer.
 * @property {string} [strokeShader] Optional WGSL shader override.
 * @property {StrokePatternTexture} [pattern] Optional stroke pattern resources.
 */

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @return {*} Resolved value.
 */
function resolveExpression(value, feature) {
  if (Array.isArray(value) && value.length === 2 && value[0] === 'get') {
    return feature.get(value[1]);
  }
  return value;
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {number} fallback Fallback.
 * @return {number} Resolved number.
 */
function resolveNumber(value, feature, fallback) {
  const resolved = resolveExpression(value, feature);
  const num = Number(resolved);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * @param {*} expr Encoded expression.
 * @return {number} Maximum numeric output found, or NaN if unknown.
 */
function maxNumberInExpression(expr) {
  if (typeof expr === 'number') {
    return expr;
  }
  if (typeof expr === 'string') {
    const n = Number(expr);
    return Number.isFinite(n) ? n : NaN;
  }
  if (!Array.isArray(expr) || expr.length === 0) {
    return NaN;
  }

  const op = expr[0];
  if (op === 'case' && expr.length >= 4) {
    const t = maxNumberInExpression(expr[2]);
    const f = maxNumberInExpression(expr[3]);
    if (!Number.isFinite(t)) {
      return f;
    }
    if (!Number.isFinite(f)) {
      return t;
    }
    return Math.max(t, f);
  }
  if (
    op === 'interpolate' &&
    Array.isArray(expr[1]) &&
    expr[1][0] === 'linear'
  ) {
    // stops are [stop, output] pairs after the input expression
    let maxVal = NaN;
    for (let i = 3; i + 1 < expr.length; i += 2) {
      const out = maxNumberInExpression(expr[i + 1]);
      if (!Number.isFinite(out)) {
        continue;
      }
      maxVal = Number.isFinite(maxVal) ? Math.max(maxVal, out) : out;
    }
    return maxVal;
  }

  return NaN;
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {number} fallback Fallback.
 * @return {number} Stroke width.
 */
function resolveStrokeWidth(value, feature, fallback) {
  if (!Array.isArray(value)) {
    return resolveNumber(value, feature, fallback);
  }
  if (value[0] === 'get') {
    return resolveNumber(value, feature, fallback);
  }
  const maxWidth = maxNumberInExpression(value);
  if (Number.isFinite(maxWidth) && maxWidth > 0) {
    return maxWidth;
  }
  return fallback;
}

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @param {Array<number>} fallback Fallback RGBA (0..1).
 * @return {Array<number>} Resolved color.
 */
function resolveColor(value, feature, fallback) {
  const resolved = resolveExpression(value, feature);
  if (!resolved) {
    return fallback;
  }
  try {
    const c = asArray(resolved);
    return [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
  } catch {
    return fallback;
  }
}

/**
 * @typedef {Object} StyleShaders
 * @property {WGSLBuilder} builder Helper class to build the shaders
 * @property {import("../webgl/VectorStyleRenderer.js").UniformDefinitions} uniforms Uniform definitions
 * @property {import("../webgl/VectorStyleRenderer.js").AttributeDefinitions} attributes Attribute definitions
 */

/**
 * @classdesc
 * The WebGPU equivalent of VectorStyleRenderer.
 * It manages style compilation and buffer generation for vector layers.
 */
class VectorStyleRenderer {
  /**
   * @param {Array<import("../../style/flat.js").Rule>|Array<import("../../style/flat.js").FlatStyle>|StyleShaders} styles Styles.
   * @param {import("../../style/flat.js").StyleVariables} variables Style variables.
   * @param {import("../../webgpu/Helper.js").default} helper Helper.
   */
  constructor(styles, variables, helper) {
    this.helper_ = helper;
    this.styles_ = styles;
    /** @type {Map<string, GPURenderPipeline>} */
    this.strokePipelineCache_ = new Map();
    /** @type {Map<string, Promise<StrokePatternTexture>>} */
    this.patternTextureCache_ = new Map();

    // TODO: Phase 2 - Implement proper style parsing
    // For now, we manually create a single builder/shader pair
    const builder = new WGSLBuilder();
    if (styles[0] && styles[0]['fill-color']) {
      builder.setFillColorExpression(styles[0]['fill-color']);
    }

    this.styleShaders_ = [
      {
        builder: builder,
        attributes: {},
        uniforms: {},
      },
    ];
  }

  /**
   * @param {string} src Image URL or data URL.
   * @return {Promise<{sampler: GPUSampler, view: GPUTextureView, size: [number, number]}>} Texture resources.
   * @private
   */
  async getPatternTexture_(src) {
    const cached = this.patternTextureCache_.get(src);
    if (cached) {
      return cached;
    }

    const device = this.helper_.getDevice();
    const loadPromise = (async () => {
      /** @type {ImageBitmap|HTMLImageElement} */
      let imageSource;
      let width;
      let height;
      try {
        const response = await fetch(src);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        imageSource = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      } catch {
        // Some image types (notably SVG in headless Chromium) are not reliably supported by createImageBitmap().
        // Fallback to HTMLImageElement decoding.
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = src;
        await image.decode();
        imageSource = image;
        width = image.naturalWidth;
        height = image.naturalHeight;
      }

      const TEXTURE_BINDING = 0x04;
      const COPY_DST = 0x02;
      const RENDER_ATTACHMENT = 0x10;
      const texture = device.createTexture({
        size: {width, height},
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        {source: imageSource},
        {texture},
        {width, height},
      );

      const sampler = device.createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        magFilter: 'linear',
        minFilter: 'linear',
      });

      return {
        sampler,
        view: texture.createView(),
        size: [width, height],
      };
    })();

    this.patternTextureCache_.set(src, loadPromise);
    return loadPromise;
  }

  /**
   * @param {import("../webgl/MixedGeometryBatch.js").default} geometryBatch Geometry batch.
   * @param {import("../../transform.js").Transform} transform Transform.
   * @return {Promise<Object>} Buffers.
   */
  async generateBuffers(geometryBatch, transform) {
    const rules = (Array.isArray(this.styles_) ? this.styles_ : []).map(
      (entry) => (entry && entry.style ? entry : {style: entry}),
    );

    // --- 1. Generate Point Buffers ---
    const pointBatch = geometryBatch.pointBatch;
    const pointEntries = Object.values(pointBatch.entries);
    // Calculate total vertices for points
    let pointVertexCount = 0;
    for (const entry of pointEntries) {
      // Each entry can have multiple points (MultiPoint)
      for (const flatCoordPoints of entry.flatCoordss) {
        pointVertexCount += flatCoordPoints.length / 2;
      }
    }

    // 3 floats per vertex: x, y, featureIndex
    const pointData = new Float32Array(pointVertexCount * 3);

    let cursor = 0;
    for (let i = 0; i < pointEntries.length; i++) {
      const entry = pointEntries[i];
      // Fill Vertex Buffer
      for (const flatCoordPoints of entry.flatCoordss) {
        for (let j = 0; j < flatCoordPoints.length; j += 2) {
          pointData[cursor++] = flatCoordPoints[j];
          pointData[cursor++] = flatCoordPoints[j + 1];
          pointData[cursor++] = i; // featureIndex
        }
      }
    }

    /** @type {Array<PointBufferSet>} */
    const pointBuffers = [];
    let pointBuffer = null;

    const hasAnyPointSymbol = rules.some((r) => {
      const s = r.style;
      return (
        s && ('icon-src' in s || 'shape-points' in s || 'circle-radius' in s)
      );
    });

    if (pointVertexCount > 0 && hasAnyPointSymbol) {
      pointBuffer = new WebGPUBuffer({
        size: pointData.byteLength,
        usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      pointBuffer.create(this.helper_);
      new Float32Array(pointBuffer.getBuffer().getMappedRange()).set(pointData);
      pointBuffer.getBuffer().unmap();
    }

    if (pointBuffer) {
      const STYLE_STRIDE = 20;
      const circleShader =
        this.styleShaders_[0].builder.getCircleSymbolShader();
      const iconShader = this.styleShaders_[0].builder.getIconSymbolShader();
      const shapeShader = this.styleShaders_[0].builder.getShapeSymbolShader();

      for (const rule of rules) {
        const style = rule.style;
        if (!style) {
          continue;
        }

        // --- Icons ---
        const iconSrc = style['icon-src'];
        if (typeof iconSrc === 'string') {
          const texture = await this.getPatternTexture_(iconSrc);
          const textureSize = texture.size;
          const sampleSize = Array.isArray(style['icon-size'])
            ? style['icon-size']
            : textureSize;
          const baseOffset = Array.isArray(style['icon-offset'])
            ? style['icon-offset']
            : [0, 0];
          const origin = style['icon-offset-origin'] || 'top-left';
          let offsetX = baseOffset[0] || 0;
          let offsetY = baseOffset[1] || 0;
          if (origin === 'top-right') {
            offsetX = textureSize[0] - sampleSize[0] - offsetX;
          } else if (origin === 'bottom-left') {
            offsetY = textureSize[1] - sampleSize[1] - offsetY;
          } else if (origin === 'bottom-right') {
            offsetX = textureSize[0] - sampleSize[0] - offsetX;
            offsetY = textureSize[1] - sampleSize[1] - offsetY;
          }

          const uvOrigin = [offsetX / textureSize[0], offsetY / textureSize[1]];
          const uvSize = [
            sampleSize[0] / textureSize[0],
            sampleSize[1] / textureSize[1],
          ];

          const styleData = new Float32Array(
            pointEntries.length * STYLE_STRIDE,
          );
          for (let i = 0; i < pointEntries.length; i++) {
            const feature = pointEntries[i].feature;
            const sIdx = i * STYLE_STRIDE;

            const tint = resolveColor(
              style['icon-color'],
              feature,
              [1, 1, 1, 1],
            );
            const opacity = resolveNumber(style['icon-opacity'], feature, 1.0);
            const rotation = resolveNumber(
              style['icon-rotation'],
              feature,
              0.0,
            );
            const rotateWithView = style['icon-rotate-with-view'] ? 1 : 0;

            const scaleValue = resolveExpression(style['icon-scale'], feature);
            const scale =
              typeof scaleValue === 'number'
                ? [scaleValue, scaleValue]
                : Array.isArray(scaleValue)
                  ? scaleValue
                  : [1, 1];
            const scaleVec = [Number(scale[0]) || 1, Number(scale[1]) || 1];

            const displacement = resolveExpression(
              style['icon-displacement'],
              feature,
            );
            const displacementVec = Array.isArray(displacement)
              ? displacement
              : [0, 0];

            let centerOffset = [
              Number(displacementVec[0]) || 0,
              Number(displacementVec[1]) || 0,
            ];

            if ('icon-anchor' in style) {
              const anchorValue = resolveExpression(
                style['icon-anchor'],
                feature,
              );
              const anchor = Array.isArray(anchorValue)
                ? anchorValue
                : [0.5, 0.5];
              const quadSizePx = [
                sampleSize[0] * scaleVec[0],
                sampleSize[1] * scaleVec[1],
              ];
              const scaleScalar = scaleVec[0];
              const xUnits = style['icon-anchor-x-units'] || 'fraction';
              const yUnits = style['icon-anchor-y-units'] || 'fraction';

              let shiftX;
              let shiftY;
              if (xUnits === 'pixels' && yUnits === 'pixels') {
                shiftX = anchor[0] * scaleScalar;
                shiftY = anchor[1] * scaleScalar;
              } else if (xUnits === 'pixels') {
                shiftX = anchor[0] * scaleScalar;
                shiftY = anchor[1] * quadSizePx[1];
              } else if (yUnits === 'pixels') {
                shiftX = anchor[0] * quadSizePx[0];
                shiftY = anchor[1] * scaleScalar;
              } else {
                shiftX = anchor[0] * quadSizePx[0];
                shiftY = anchor[1] * quadSizePx[1];
              }

              let offsetPxX = quadSizePx[0] * 0.5 - shiftX;
              let offsetPxY = -quadSizePx[1] * 0.5 + shiftY;
              const anchorOrigin = style['icon-anchor-origin'] || 'top-left';
              if (anchorOrigin === 'top-right') {
                offsetPxX = -quadSizePx[0] * 0.5 + shiftX;
                offsetPxY = -quadSizePx[1] * 0.5 + shiftY;
              } else if (anchorOrigin === 'bottom-left') {
                offsetPxX = quadSizePx[0] * 0.5 - shiftX;
                offsetPxY = quadSizePx[1] * 0.5 - shiftY;
              } else if (anchorOrigin === 'bottom-right') {
                offsetPxX = -quadSizePx[0] * 0.5 + shiftX;
                offsetPxY = quadSizePx[1] * 0.5 - shiftY;
              }

              centerOffset = [
                centerOffset[0] + offsetPxX,
                centerOffset[1] + offsetPxY,
              ];
            }

            // tint (vec4)
            styleData[sIdx + 0] = tint[0];
            styleData[sIdx + 1] = tint[1];
            styleData[sIdx + 2] = tint[2];
            styleData[sIdx + 3] = tint[3];
            // uvOrigin (vec2)
            styleData[sIdx + 4] = uvOrigin[0];
            styleData[sIdx + 5] = uvOrigin[1];
            // uvSize (vec2)
            styleData[sIdx + 6] = uvSize[0];
            styleData[sIdx + 7] = uvSize[1];
            // sizePx (vec2)
            styleData[sIdx + 8] = sampleSize[0];
            styleData[sIdx + 9] = sampleSize[1];
            // scale (vec2)
            styleData[sIdx + 10] = scaleVec[0];
            styleData[sIdx + 11] = scaleVec[1];
            // rotation, opacity, rotateWithView, pad
            styleData[sIdx + 12] = rotation;
            styleData[sIdx + 13] = opacity;
            styleData[sIdx + 14] = rotateWithView;
            styleData[sIdx + 15] = 0;
            // offsetPx (vec2) + pad
            styleData[sIdx + 16] = centerOffset[0];
            styleData[sIdx + 17] = centerOffset[1];
            styleData[sIdx + 18] = 0;
            styleData[sIdx + 19] = 0;
          }

          const styleBuffer = new WebGPUBuffer({
            size: styleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          styleBuffer.create(this.helper_);
          new Float32Array(styleBuffer.getBuffer().getMappedRange()).set(
            styleData,
          );
          styleBuffer.getBuffer().unmap();

          pointBuffers.push({
            vertex: pointBuffer,
            style: styleBuffer,
            symbolShader: iconShader,
            pattern: texture,
          });
          continue;
        }

        // --- Shapes ---
        if ('shape-points' in style) {
          const styleData = new Float32Array(
            pointEntries.length * STYLE_STRIDE,
          );
          for (let i = 0; i < pointEntries.length; i++) {
            const feature = pointEntries[i].feature;
            const sIdx = i * STYLE_STRIDE;

            const points = resolveNumber(style['shape-points'], feature, 3.0);
            const strokeWidth = resolveNumber(
              style['shape-stroke-width'],
              feature,
              0.0,
            );
            const opacity = resolveNumber(style['shape-opacity'], feature, 1.0);
            const shapeAngle = resolveNumber(
              style['shape-angle'],
              feature,
              0.0,
            );

            const fillColor = resolveColor(
              style['shape-fill-color'],
              feature,
              [1, 1, 1, 1],
            );
            let strokeColor = resolveColor(
              style['shape-stroke-color'],
              feature,
              [0, 0, 0, 0],
            );
            const strokeExpr = style['shape-stroke-color'];
            if (Array.isArray(strokeExpr) && strokeExpr[0] === '*') {
              const a = resolveColor(strokeExpr[1], feature, strokeColor);
              const b = resolveColor(strokeExpr[2], feature, [1, 1, 1, 1]);
              strokeColor = [
                a[0] * b[0],
                a[1] * b[1],
                a[2] * b[2],
                a[3] * b[3],
              ];
            }

            const baseRadius = resolveNumber(
              style['shape-radius'],
              feature,
              5.0,
            );
            const baseRadius2 =
              'shape-radius2' in style
                ? resolveNumber(style['shape-radius2'], feature, 0.0)
                : 0.0;
            const radius = baseRadius + strokeWidth * 0.5;
            const radius2 =
              baseRadius2 > 0 ? baseRadius2 + strokeWidth * 0.5 : 0.0;

            const displacement = resolveExpression(
              style['shape-displacement'],
              feature,
            );
            const displacementVec = Array.isArray(displacement)
              ? displacement
              : [0, 0];
            const rotation = resolveNumber(
              style['shape-rotation'],
              feature,
              0.0,
            );
            const rotateWithView = style['shape-rotate-with-view'] ? 1 : 0;

            const scaleValue = resolveExpression(style['shape-scale'], feature);
            const scale =
              typeof scaleValue === 'number'
                ? [scaleValue, scaleValue]
                : Array.isArray(scaleValue)
                  ? scaleValue
                  : [1, 1];

            // fillColor (vec4)
            styleData[sIdx + 0] = fillColor[0];
            styleData[sIdx + 1] = fillColor[1];
            styleData[sIdx + 2] = fillColor[2];
            styleData[sIdx + 3] = fillColor[3];
            // strokeColor (vec4)
            styleData[sIdx + 4] = strokeColor[0];
            styleData[sIdx + 5] = strokeColor[1];
            styleData[sIdx + 6] = strokeColor[2];
            styleData[sIdx + 7] = strokeColor[3];
            // radius, radius2, strokeWidth, opacity
            styleData[sIdx + 8] = radius;
            styleData[sIdx + 9] = radius2;
            styleData[sIdx + 10] = strokeWidth;
            styleData[sIdx + 11] = opacity;
            // points, shapeAngle, rotateWithView, rotation
            styleData[sIdx + 12] = points;
            styleData[sIdx + 13] = shapeAngle;
            styleData[sIdx + 14] = rotateWithView;
            styleData[sIdx + 15] = rotation;
            // scale (vec2)
            styleData[sIdx + 16] = Number(scale[0]) || 1;
            styleData[sIdx + 17] = Number(scale[1]) || 1;
            // displacement (vec2)
            styleData[sIdx + 18] = Number(displacementVec[0]) || 0;
            styleData[sIdx + 19] = Number(displacementVec[1]) || 0;
          }

          const styleBuffer = new WebGPUBuffer({
            size: styleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          styleBuffer.create(this.helper_);
          new Float32Array(styleBuffer.getBuffer().getMappedRange()).set(
            styleData,
          );
          styleBuffer.getBuffer().unmap();

          pointBuffers.push({
            vertex: pointBuffer,
            style: styleBuffer,
            symbolShader: shapeShader,
          });
          continue;
        }

        // --- Circles ---
        if ('circle-radius' in style) {
          const styleData = new Float32Array(
            pointEntries.length * STYLE_STRIDE,
          );
          for (let i = 0; i < pointEntries.length; i++) {
            const feature = pointEntries[i].feature;
            const sIdx = i * STYLE_STRIDE;

            const radius = resolveNumber(style['circle-radius'], feature, 5.0);
            const strokeWidth = resolveNumber(
              style['circle-stroke-width'],
              feature,
              0.0,
            );
            const opacity = resolveNumber(
              style['circle-opacity'],
              feature,
              1.0,
            );

            const fillColor = resolveColor(
              style['circle-fill-color'],
              feature,
              [1, 1, 1, 1],
            );
            let strokeColor = resolveColor(
              style['circle-stroke-color'],
              feature,
              [0, 0, 0, 0],
            );
            const strokeExpr = style['circle-stroke-color'];
            if (Array.isArray(strokeExpr) && strokeExpr[0] === '*') {
              const a = resolveColor(strokeExpr[1], feature, strokeColor);
              const b = resolveColor(strokeExpr[2], feature, [1, 1, 1, 1]);
              strokeColor = [
                a[0] * b[0],
                a[1] * b[1],
                a[2] * b[2],
                a[3] * b[3],
              ];
            }

            const displacement = resolveExpression(
              style['circle-displacement'],
              feature,
            );
            const displacementVec = Array.isArray(displacement)
              ? displacement
              : [0, 0];
            const rotation = resolveNumber(
              style['circle-rotation'],
              feature,
              0.0,
            );
            const scaleValue = resolveExpression(
              style['circle-scale'],
              feature,
            );
            const scale =
              typeof scaleValue === 'number'
                ? [scaleValue, scaleValue]
                : Array.isArray(scaleValue)
                  ? scaleValue
                  : [1, 1];
            const rotateWithView = style['circle-rotate-with-view'] ? 1 : 0;

            styleData[sIdx + 0] = fillColor[0];
            styleData[sIdx + 1] = fillColor[1];
            styleData[sIdx + 2] = fillColor[2];
            styleData[sIdx + 3] = fillColor[3];
            styleData[sIdx + 4] = strokeColor[0];
            styleData[sIdx + 5] = strokeColor[1];
            styleData[sIdx + 6] = strokeColor[2];
            styleData[sIdx + 7] = strokeColor[3];
            styleData[sIdx + 8] = radius;
            styleData[sIdx + 9] = strokeWidth;
            styleData[sIdx + 10] = opacity;
            styleData[sIdx + 11] = rotateWithView;
            styleData[sIdx + 12] = Number(scale[0]) || 1;
            styleData[sIdx + 13] = Number(scale[1]) || 1;
            styleData[sIdx + 14] = rotation;
            styleData[sIdx + 15] = 0;
            styleData[sIdx + 16] = Number(displacementVec[0]) || 0;
            styleData[sIdx + 17] = Number(displacementVec[1]) || 0;
            styleData[sIdx + 18] = 0;
            styleData[sIdx + 19] = 0;
          }

          const styleBuffer = new WebGPUBuffer({
            size: styleData.byteLength,
            usage: 0x0080 | 0x0008,
            mappedAtCreation: true,
          });
          styleBuffer.create(this.helper_);
          new Float32Array(styleBuffer.getBuffer().getMappedRange()).set(
            styleData,
          );
          styleBuffer.getBuffer().unmap();

          pointBuffers.push({
            vertex: pointBuffer,
            style: styleBuffer,
            symbolShader: circleShader,
          });
        }
      }
    }

    // --- 2. Generate LineString Buffers ---
    const lineBatch = geometryBatch.lineStringBatch;
    const lineEntries = Object.values(lineBatch.entries);

    // stride is 3 (XYM) for lines in MixedGeometryBatch
    const LINE_STRIDE = 3;

    // Generate per-segment instance attributes compatible with the WebGL stroke pipeline:
    // p0(x,y,m), p1(x,y,m), angle0, angle1, distanceLow, distanceHigh, angleTangentSum, featureIndex
    // -> 12 floats per segment instance.
    /** @type {Array<number>} */
    const lineInstanceAttributes = [];

    const strokeRules = rules.filter((r) => {
      const s = r.style;
      return (
        s &&
        ('stroke-color' in s ||
          'stroke-width' in s ||
          'stroke-line-dash' in s ||
          'stroke-offset' in s)
      );
    });
    const hasAnyStroke = strokeRules.length > 0;

    const identityTransform = createTransform();
    // Generate segment instances per feature/linestring
    for (let i = 0; i < lineEntries.length; i++) {
      const entry = lineEntries[i];

      for (const flatCoords of entry.flatCoordss) {
        const numPoints = flatCoords.length / LINE_STRIDE;
        if (numPoints < 2) {
          continue;
        }
        const instructions = new Float32Array(flatCoords);
        const firstInstructionsIndex = 0;
        const lastInstructionsIndex = (numPoints - 1) * LINE_STRIDE;
        const isLoop =
          instructions[firstInstructionsIndex] ===
            instructions[lastInstructionsIndex] &&
          instructions[firstInstructionsIndex + 1] ===
            instructions[lastInstructionsIndex + 1];

        let currentLength = 0;
        let currentAngleTangentSum = 0;

        for (let j = 0; j < numPoints - 1; j++) {
          let beforeIndex = null;
          if (j > 0) {
            beforeIndex = (j - 1) * LINE_STRIDE;
          } else if (isLoop) {
            beforeIndex = lastInstructionsIndex - LINE_STRIDE;
          }

          let afterIndex = null;
          if (j < numPoints - 2) {
            afterIndex = (j + 2) * LINE_STRIDE;
          } else if (isLoop) {
            afterIndex = firstInstructionsIndex + LINE_STRIDE;
          }

          const measures = writeLineSegmentToBuffers(
            instructions,
            j * LINE_STRIDE,
            (j + 1) * LINE_STRIDE,
            beforeIndex,
            afterIndex,
            lineInstanceAttributes,
            [i], // featureIndex as custom attribute
            identityTransform,
            currentLength,
            currentAngleTangentSum,
          );
          currentLength = measures.length;
          currentAngleTangentSum = measures.angle;
        }
      }
    }

    let lineBuffer = null;
    /** @type {Array<LineStringBufferSet>} */
    const lineStringBuffers = [];
    if (lineInstanceAttributes.length > 0 && hasAnyStroke) {
      const lineData = new Float32Array(lineInstanceAttributes);
      lineBuffer = new WebGPUBuffer({
        size: lineData.byteLength,
        usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      lineBuffer.create(this.helper_);
      new Float32Array(lineBuffer.getBuffer().getMappedRange()).set(lineData);
      lineBuffer.getBuffer().unmap();
    }

    if (lineBuffer) {
      // Style struct is aligned to 16 bytes; 24 floats = 96 bytes per feature:
      // color(4), width, cap, join, miterLimit, offset, dashCount, dashOffset, dashTotal, pad(4),
      // dash0(4), dash1(4), pad(4) => 28 floats (112 bytes) per feature
      const STYLE_STRIDE = 28;
      const DASH_MAX = 8;
      const defaultColor = [0, 0, 0, 1];

      for (const rule of strokeRules) {
        const style = rule.style;
        const filter = rule.filter;
        const lineStyleData = new Float32Array(
          lineEntries.length * STYLE_STRIDE,
        );

        const getProps = new Set();
        collectGetProperties(filter, getProps);
        collectGetProperties(style['stroke-width'], getProps);
        collectGetProperties(style['stroke-color'], getProps);

        const patternSrc = style['stroke-pattern-src'];
        const hasStrokePattern = typeof patternSrc === 'string';
        let patternTexture;
        let patternOptions;
        if (hasStrokePattern) {
          patternTexture = await this.getPatternTexture_(patternSrc);
          const textureSize = patternTexture.size;
          const sampleSize = Array.isArray(style['stroke-pattern-size'])
            ? style['stroke-pattern-size']
            : textureSize;
          const baseOffset = Array.isArray(style['stroke-pattern-offset'])
            ? style['stroke-pattern-offset']
            : [0, 0];
          const origin = style['stroke-pattern-offset-origin'] || 'top-left';
          let offsetX = baseOffset[0] || 0;
          let offsetY = baseOffset[1] || 0;
          if (origin === 'top-right') {
            offsetX = textureSize[0] - sampleSize[0] - offsetX;
          } else if (origin === 'bottom-left') {
            offsetY = textureSize[1] - sampleSize[1] - offsetY;
          } else if (origin === 'bottom-right') {
            offsetX = textureSize[0] - sampleSize[0] - offsetX;
            offsetY = textureSize[1] - sampleSize[1] - offsetY;
          }

          const spacingPx = Number(style['stroke-pattern-spacing'] || 0);
          const startOffsetPx = Number(
            style['stroke-pattern-start-offset'] || 0,
          );
          const tintEnabled = 'stroke-color' in style;
          patternOptions = {
            textureSize: `vec2f(${textureSize[0]}, ${textureSize[1]})`,
            textureOffset: `vec2f(${offsetX}, ${offsetY})`,
            sampleSize: `vec2f(${sampleSize[0]}, ${sampleSize[1]})`,
            spacingPx: `${spacingPx}`,
            startOffsetPx: `${startOffsetPx}`,
            tint: tintEnabled ? 'style.color' : 'vec4f(1.0, 1.0, 1.0, 1.0)',
          };
        }

        for (let i = 0; i < lineEntries.length; i++) {
          const feature = lineEntries[i].feature;
          const sIdx = i * STYLE_STRIDE;

          const color = resolveColor(
            style['stroke-color'],
            feature,
            defaultColor,
          );
          const width = resolveStrokeWidth(style['stroke-width'], feature, 1.0);
          const offsetPx = resolveNumber(style['stroke-offset'], feature, 0.0);
          const miterLimit = resolveNumber(
            style['stroke-miter-limit'],
            feature,
            10.0,
          );

          let capType = 2; // match WebGL default
          if ('stroke-line-cap' in style) {
            const cap = String(
              resolveExpression(style['stroke-line-cap'], feature),
            );
            capType = cap === 'square' ? 1 : cap === 'butt' ? 0 : 2;
          }
          let joinType = 2; // match WebGL default
          if ('stroke-line-join' in style) {
            const join = String(
              resolveExpression(style['stroke-line-join'], feature),
            );
            joinType = join === 'bevel' ? 1 : join === 'round' ? 2 : 0;
          }

          const dash = resolveExpression(style['stroke-line-dash'], feature);
          const dashOffset = resolveNumber(
            style['stroke-line-dash-offset'],
            feature,
            0.0,
          );
          let dashValues = Array.isArray(dash) ? dash : null;
          if (dashValues && dashValues.length % 2 === 1) {
            dashValues = dashValues.concat(dashValues);
          }
          const dashCount = dashValues
            ? Math.min(DASH_MAX, dashValues.length)
            : 0;
          let dashTotal = 0.0;
          for (let d = 0; d < dashCount; d++) {
            dashTotal += resolveNumber(dashValues[d], feature, 0.0);
          }

          lineStyleData[sIdx + 0] = color[0];
          lineStyleData[sIdx + 1] = color[1];
          lineStyleData[sIdx + 2] = color[2];
          lineStyleData[sIdx + 3] = color[3];
          lineStyleData[sIdx + 4] = width;
          lineStyleData[sIdx + 5] = capType;
          lineStyleData[sIdx + 6] = joinType;
          lineStyleData[sIdx + 7] =
            Number.isFinite(miterLimit) && miterLimit > 0 ? miterLimit : 10.0;
          lineStyleData[sIdx + 8] = offsetPx;
          lineStyleData[sIdx + 9] = dashCount;
          lineStyleData[sIdx + 10] = dashOffset;
          lineStyleData[sIdx + 11] = dashTotal;

          for (let d = 0; d < dashCount; d++) {
            const len = resolveNumber(dashValues[d], feature, 0.0);
            const vecBase = d < 4 ? sIdx + 16 : sIdx + 20;
            lineStyleData[vecBase + (d % 4)] = len;
          }

          // Optional numeric get() property used by `webgpu-line-metric` ("limit").
          if (getProps.has('limit')) {
            lineStyleData[sIdx + 24] = resolveNumber(
              ['get', 'limit'],
              feature,
              0.0,
            );
          }
        }

        const lineStyleBuffer = new WebGPUBuffer({
          size: lineStyleData.byteLength,
          usage: 0x0080 | 0x0008, // STORAGE
          mappedAtCreation: true,
        });
        lineStyleBuffer.create(this.helper_);
        new Float32Array(lineStyleBuffer.getBuffer().getMappedRange()).set(
          lineStyleData,
        );
        lineStyleBuffer.getBuffer().unmap();

        let strokeShader;
        if (
          filter ||
          (Array.isArray(style['stroke-width']) &&
            style['stroke-width'][0] !== 'get') ||
          (Array.isArray(style['stroke-color']) &&
            style['stroke-color'][0] !== 'get') ||
          hasStrokePattern
        ) {
          const ctx = {
            lineMetricVar: 'lineMetric',
            getProp: (name) => (name === 'limit' ? 'style.get0' : '0.0'),
          };
          const discard = filter
            ? `!(${compileWgslExpression(filter, ctx, 'bool')})`
            : 'false';
          const widthExpr = Array.isArray(style['stroke-width'])
            ? compileWgslExpression(style['stroke-width'], ctx, 'f32')
            : 'style.width';
          const colorExpr = Array.isArray(style['stroke-color'])
            ? compileWgslExpression(style['stroke-color'], ctx, 'vec4f')
            : 'style.color';
          strokeShader = this.styleShaders_[0].builder.getStrokeShader({
            strokeColor: colorExpr,
            strokeWidth: widthExpr,
            discard: discard,
            pattern: patternOptions,
          });
        }

        lineStringBuffers.push({
          vertex: lineBuffer,
          style: lineStyleBuffer,
          strokeShader,
          pattern: patternTexture,
        });
      }
    }

    // --- 3. Generate Polygon Buffers ---
    const polyBatch = geometryBatch.polygonBatch;
    const polyEntries = Object.values(polyBatch.entries);

    const polyStyleRule = rules.find((r) => {
      const s = r.style;
      return (
        s &&
        (typeof s['fill-color'] === 'string' ||
          typeof s['fill-pattern-src'] === 'string')
      );
    });
    if (!polyStyleRule) {
      // No literal fill style: don't render polygons (prevents wrong default fills).
      return {
        pointBuffers,
        lineStringBuffers,
        polygonBuffers: [],
      };
    }

    // To estimate size, we'd need to triangulate first or use a dynamic array.
    // Since earcut is fast enough for 2D, let's triangulate into a temp array.

    const polyVertices = []; // [x, y, featureIndex, x, y, featureIndex]
    const polyStyleDataArray = []; // [r, g, b, a, ...]

    const polyStyle = polyStyleRule.style;
    const fillPatternSrc = polyStyle['fill-pattern-src'];
    const hasFillPattern = typeof fillPatternSrc === 'string';

    // Resolve Poly Color (used as tint for patterns when fill-color is provided)
    let polyColor = hasFillPattern ? [1, 1, 1, 1] : [0, 0, 1, 1];
    const colorStr = polyStyle['fill-color'];
    if (colorStr) {
      try {
        const c = asArray(colorStr);
        polyColor = [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
      } catch {
        // Ignore
      }
    }

    /** @type {StrokePatternTexture|undefined} */
    let fillPatternTexture;
    /** @type {import("./WGSLBuilder.js").FillPatternShaderOptions|undefined} */
    let fillPatternOptions;
    if (hasFillPattern) {
      fillPatternTexture = await this.getPatternTexture_(fillPatternSrc);
      const textureSize = fillPatternTexture.size;
      const sampleSize = Array.isArray(polyStyle['fill-pattern-size'])
        ? polyStyle['fill-pattern-size']
        : textureSize;
      const baseOffset = Array.isArray(polyStyle['fill-pattern-offset'])
        ? polyStyle['fill-pattern-offset']
        : [0, 0];
      const origin = polyStyle['fill-pattern-offset-origin'] || 'top-left';
      let offsetX = baseOffset[0] || 0;
      let offsetY = baseOffset[1] || 0;
      if (origin === 'top-right') {
        offsetX = textureSize[0] - sampleSize[0] - offsetX;
      } else if (origin === 'bottom-left') {
        offsetY = textureSize[1] - sampleSize[1] - offsetY;
      } else if (origin === 'bottom-right') {
        offsetX = textureSize[0] - sampleSize[0] - offsetX;
        offsetY = textureSize[1] - sampleSize[1] - offsetY;
      }

      fillPatternOptions = {
        textureSize: `vec2f(${textureSize[0]}, ${textureSize[1]})`,
        textureOffset: `vec2f(${offsetX}, ${offsetY})`,
        sampleSize: `vec2f(${sampleSize[0]}, ${sampleSize[1]})`,
        tint: 'input.color',
      };
    }

    const POLY_STRIDE = 2; // MixedGeometryBatch usually 2 unless M/Z

    for (let i = 0; i < polyEntries.length; i++) {
      const entry = polyEntries[i];

      // Style
      polyStyleDataArray.push(
        polyColor[0],
        polyColor[1],
        polyColor[2],
        polyColor[3],
      );

      // entry.flatCoordss is Array<Array<number>> (polygons)
      // entry.ringsVerticesCounts is Array<Array<number>> (rings per polygon)

      for (let pOffset = 0; pOffset < entry.flatCoordss.length; pOffset++) {
        const flatCoords = entry.flatCoordss[pOffset];
        const ringsCounts = entry.ringsVerticesCounts[pOffset];

        if (!flatCoords || flatCoords.length === 0) {
          continue;
        }

        // Calculate holes
        // holes: array of vertex-indices where holes start
        const holes = [];
        let currentVertexIndex = 0;
        for (let r = 0; r < ringsCounts.length; r++) {
          // ringsCounts[r] is number of vertices in this ring
          if (r > 0) {
            holes.push(currentVertexIndex);
          }
          currentVertexIndex += ringsCounts[r];
        }

        // Triangulate
        const triangles = earcut(flatCoords, holes, POLY_STRIDE);

        // triangles is flat array of vertex indices
        for (let t = 0; t < triangles.length; t++) {
          const vIdx = triangles[t]; // Index of vertex (0-based)
          const px = flatCoords[vIdx * POLY_STRIDE];
          const py = flatCoords[vIdx * POLY_STRIDE + 1];

          polyVertices.push(px, py, i); // x, y, featureIndex
        }
      }
    }

    let polyBuffer = null;
    let polyStyleBuffer = null;

    if (polyVertices.length > 0) {
      const polyDataFloat = new Float32Array(polyVertices);
      polyBuffer = new WebGPUBuffer({
        size: polyDataFloat.byteLength,
        usage: 0x0020 | 0x0008,
        mappedAtCreation: true,
      });
      polyBuffer.create(this.helper_);
      new Float32Array(polyBuffer.getBuffer().getMappedRange()).set(
        polyDataFloat,
      );
      polyBuffer.getBuffer().unmap();

      const polyStyleFloat = new Float32Array(polyStyleDataArray);
      polyStyleBuffer = new WebGPUBuffer({
        size: polyStyleFloat.byteLength,
        usage: 0x0080 | 0x0008,
        mappedAtCreation: true,
      });
      polyStyleBuffer.create(this.helper_);
      new Float32Array(polyStyleBuffer.getBuffer().getMappedRange()).set(
        polyStyleFloat,
      );
      polyStyleBuffer.getBuffer().unmap();
    }

    return {
      pointBuffers,
      lineStringBuffers,
      /** @type {Array<PolygonBufferSet>} */
      polygonBuffers: polyBuffer
        ? [
            {
              vertex: polyBuffer,
              style: polyStyleBuffer,
              fillShader: hasFillPattern
                ? this.styleShaders_[0].builder.getFillShader({
                    pattern: fillPatternOptions,
                  })
                : undefined,
              pattern: fillPatternTexture,
            },
          ]
        : [],
    };
  }

  /**
   * @param {Object} buffers Buffers.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  /**
   * @param {Object} buffers Buffers.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  render(buffers, frameState) {
    const device = this.helper_.getDevice();
    const context = this.helper_.getContext();

    if (!device || !context) {
      return;
    }

    // --- Uniforms Calculation (World -> Clip) ---
    const size = frameState.size;
    const width = size[0];
    const height = size[1];
    const pixelRatio = frameState.pixelRatio;
    const rotation = frameState.viewState.rotation;
    const resolution = frameState.viewState.resolution;
    const zoom = frameState.viewState.zoom;
    const center = frameState.viewState.center;

    // 1. World -> Pixel
    const renderTransform = createTransform();
    translateTransform(renderTransform, width / 2, height / 2);
    scaleTransform(renderTransform, 1 / resolution, -1 / resolution);
    rotateTransform(renderTransform, -rotation);
    translateTransform(renderTransform, -center[0], -center[1]);

    // 2. Pixel -> Clip
    // Scale (2/w, -2/h), Translate (-1, 1)
    const clipTransform = createTransform();
    translateTransform(clipTransform, -1, 1);
    scaleTransform(clipTransform, 2 / width, -2 / height);

    // 3. Combine: Clip * Render
    multiplyTransform(clipTransform, renderTransform);

    // 4. Convert to mat4
    const mat4Data = createMat4();
    mat4FromTransform(mat4Data, clipTransform);

    // 5. Update Uniform Buffer (re-done inside render to include resolution)
    if (!this.uniformBuffer_) {
      this.uniformBuffer_ = device.createBuffer({
        size: 96, // mat4x4<f32> (64) + remaining uniforms (32)
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();

    const format = navigator.gpu.getPreferredCanvasFormat();

    const isFirstPass = this.helper_.isFirstPass(frameState.index);
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
          loadOp: isFirstPass ? 'clear' : 'load',
          storeOp: 'store',
        },
      ],
    };

    // Update Uniform Buffer with resolution
    if (this.uniformBuffer_) {
      const uniformData = new Float32Array(24); // 96 bytes
      const mat4Data = createMat4();
      mat4FromTransform(mat4Data, clipTransform);
      uniformData.set(mat4Data);
      uniformData[16] = resolution;
      uniformData[17] = pixelRatio;
      uniformData[18] = width;
      uniformData[19] = height;
      uniformData[20] = rotation;
      uniformData[21] = zoom;
      uniformData[22] = 0;
      uniformData[23] = 0;
      device.queue.writeBuffer(this.uniformBuffer_, 0, uniformData);
    }

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

    // 1. Render Polygons (Draw first to be underneath)
    if (buffers.polygonBuffers) {
      for (const bufferSet of buffers.polygonBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const count = vertexBuffer.size / 12;

        const shaderModule = device.createShaderModule({
          code:
            bufferSet.fillShader ||
            this.styleShaders_[0].builder.getFillShader(),
        });

        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [
              {
                arrayStride: 12, // 3 floats
                attributes: [
                  {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2', // position
                  },
                  {
                    shaderLocation: 1,
                    offset: 8,
                    format: 'float32', // featureIndex
                  },
                ],
              },
            ],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [
              {
                format,
                blend: {
                  color: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                },
              },
            ],
          },
          primitive: {
            topology: 'triangle-list',
          },
        });

        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: styleBuffer,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: this.uniformBuffer_,
              },
            },
            ...(bufferSet.pattern
              ? [
                  {
                    binding: 2,
                    resource: bufferSet.pattern.sampler,
                  },
                  {
                    binding: 3,
                    resource: bufferSet.pattern.view,
                  },
                ]
              : []),
          ],
        });

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(count);
      }
    }

    // 2. Render Lines
    if (buffers.lineStringBuffers) {
      for (const bufferSet of buffers.lineStringBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        // 12 floats per instance (see generation above)
        const count = vertexBuffer.size / (12 * 4);

        const strokeCode =
          bufferSet.strokeShader ||
          this.styleShaders_[0].builder.getStrokeShader();
        const cacheKey = `${format}|${strokeCode}`;
        let pipeline = this.strokePipelineCache_.get(cacheKey);
        if (!pipeline) {
          const shaderModule = device.createShaderModule({code: strokeCode});
          pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
              module: shaderModule,
              entryPoint: 'vs_main',
              buffers: [
                {
                  arrayStride: 48, // 12 floats per instance
                  stepMode: 'instance',
                  attributes: [
                    {
                      shaderLocation: 0,
                      offset: 0,
                      format: 'float32x2', // segmentStart
                    },
                    {
                      shaderLocation: 1,
                      offset: 8,
                      format: 'float32', // measureStart
                    },
                    {
                      shaderLocation: 2,
                      offset: 12,
                      format: 'float32x2', // segmentEnd
                    },
                    {
                      shaderLocation: 3,
                      offset: 20,
                      format: 'float32', // measureEnd
                    },
                    {
                      shaderLocation: 4,
                      offset: 24,
                      format: 'float32x2', // joinAngles (start,end)
                    },
                    {
                      shaderLocation: 5,
                      offset: 32,
                      format: 'float32', // distanceLow
                    },
                    {
                      shaderLocation: 6,
                      offset: 36,
                      format: 'float32', // distanceHigh
                    },
                    {
                      shaderLocation: 7,
                      offset: 40,
                      format: 'float32', // angleTangentSum
                    },
                    {
                      shaderLocation: 8,
                      offset: 44,
                      format: 'float32', // featureIndex
                    },
                  ],
                },
              ],
            },
            fragment: {
              module: shaderModule,
              entryPoint: 'fs_main',
              targets: [
                {
                  format,
                  blend: {
                    color: {
                      srcFactor: 'one',
                      dstFactor: 'one-minus-src-alpha',
                      operation: 'add',
                    },
                    alpha: {
                      srcFactor: 'one',
                      dstFactor: 'one-minus-src-alpha',
                      operation: 'add',
                    },
                  },
                },
              ],
            },
            primitive: {
              topology: 'triangle-strip',
            },
          });
          this.strokePipelineCache_.set(cacheKey, pipeline);
        }

        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: styleBuffer,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: this.uniformBuffer_,
              },
            },
            ...(bufferSet.pattern
              ? [
                  {
                    binding: 2,
                    resource: bufferSet.pattern.sampler,
                  },
                  {
                    binding: 3,
                    resource: bufferSet.pattern.view,
                  },
                ]
              : []),
          ],
        });

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, count); // 4 vertices per instance (quad as triangle-strip)
      }
    }

    // 3. Render Points (Draw last to be on top)
    if (buffers.pointBuffers) {
      for (const bufferSet of buffers.pointBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const instanceCount = vertexBuffer.size / 12;

        const shaderModule = device.createShaderModule({
          code:
            bufferSet.symbolShader ||
            this.styleShaders_[0].builder.getCircleSymbolShader(),
        });

        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [
              {
                arrayStride: 12,
                stepMode: 'instance',
                attributes: [
                  {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2',
                  },
                  {
                    shaderLocation: 1,
                    offset: 8,
                    format: 'float32',
                  },
                ],
              },
            ],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [
              {
                format,
                blend: {
                  color: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                },
              },
            ],
          },
          primitive: {
            topology: 'triangle-strip',
          },
        });

        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: styleBuffer,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: this.uniformBuffer_,
              },
            },
            ...(bufferSet.pattern
              ? [
                  {
                    binding: 2,
                    resource: bufferSet.pattern.sampler,
                  },
                  {
                    binding: 3,
                    resource: bufferSet.pattern.view,
                  },
                ]
              : []),
          ],
        });

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, instanceCount);
      }
    }

    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);
  }
}

export default VectorStyleRenderer;
