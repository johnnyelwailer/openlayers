/**
 * @module ol/render/webgpu/VectorStyleRenderer
 */
import earcut from 'earcut';
import {asArray} from '../../color.js';
import WebGPUBuffer from '../../webgpu/Buffer.js';
import {WGSLBuilder} from './WGSLBuilder.js';
import {writeLineSegmentToBuffers} from '../linestringUtil.js';
import {collectGetProperties, compileWgslExpression} from './expr.js';
import {
  create as createTransform,
  scale as scaleTransform,
  translate as translateTransform,
  rotate as rotateTransform,
  multiply as multiplyTransform,
} from '../../transform.js';
import {
  create as createMat4,
  fromTransform as mat4FromTransform,
} from '../../vec/mat4.js';

/**
 * @param {*} value Expression or literal.
 * @param {import("../../Feature.js").default|import("../../render/Feature.js").default} feature Feature.
 * @return {*}
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
 * @return {number}
 */
function resolveNumber(value, feature, fallback) {
  const resolved = resolveExpression(value, feature);
  const num = Number(resolved);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * @param {*} expr Encoded expression.
 * @return {number} Maximum numeric output found, or NaN.
 */
function maxNumberInExpression(expr) {
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'string') {
    const n = Number(expr);
    return Number.isFinite(n) ? n : NaN;
  }
  if (!Array.isArray(expr) || expr.length === 0) return NaN;

  const op = expr[0];
  if (op === 'case' && expr.length >= 4) {
    const t = maxNumberInExpression(expr[2]);
    const f = maxNumberInExpression(expr[3]);
    if (!Number.isFinite(t)) return f;
    if (!Number.isFinite(f)) return t;
    return Math.max(t, f);
  }
  if (op === 'interpolate' && Array.isArray(expr[1]) && expr[1][0] === 'linear') {
    // stops are [stop, output] pairs after the input expression
    let maxVal = NaN;
    for (let i = 3; i + 1 < expr.length; i += 2) {
      const out = maxNumberInExpression(expr[i + 1]);
      if (!Number.isFinite(out)) continue;
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
 * @return {number}
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
 * @return {Array<number>}
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
    const pointStyleData = new Float32Array(pointEntries.length * 4); // 4 floats (RGBA) per feature

    // Resolve Point Color (only if a literal color is provided in any rule).
    let pointColor = [1, 0, 0, 1]; // Default Red
    const pointStyleRule = rules.find((r) => {
      const s = r.style;
      return (
        s &&
        (typeof s['circle-fill-color'] === 'string' ||
          typeof s['fill-color'] === 'string')
      );
    });
    if (pointStyleRule) {
      const style = pointStyleRule.style;
      const colorStr = style['circle-fill-color'] || style['fill-color'];
      if (colorStr) {
        try {
          const c = asArray(colorStr);
          pointColor = [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
        } catch {
          // Ignore parsing errors (e.g. expressions)
        }
      }
    }

    let cursor = 0;
    for (let i = 0; i < pointEntries.length; i++) {
      const entry = pointEntries[i];
      // Fill Style Buffer (1 entry per feature)
      pointStyleData[i * 4 + 0] = pointColor[0];
      pointStyleData[i * 4 + 1] = pointColor[1];
      pointStyleData[i * 4 + 2] = pointColor[2];
      pointStyleData[i * 4 + 3] = pointColor[3];

      // Fill Vertex Buffer
      for (const flatCoordPoints of entry.flatCoordss) {
        for (let j = 0; j < flatCoordPoints.length; j += 2) {
          pointData[cursor++] = flatCoordPoints[j];
          pointData[cursor++] = flatCoordPoints[j + 1];
          pointData[cursor++] = i; // featureIndex
        }
      }
    }

    let pointBuffer = null;
    let pointStyleBuffer = null;

    if (pointVertexCount > 0 && pointStyleRule) {
      pointBuffer = new WebGPUBuffer({
        size: pointData.byteLength,
        usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      pointBuffer.create(this.helper_);
      new Float32Array(pointBuffer.getBuffer().getMappedRange()).set(pointData);
      pointBuffer.getBuffer().unmap();

      pointStyleBuffer = new WebGPUBuffer({
        size: pointStyleData.byteLength,
        usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
        mappedAtCreation: true,
      });
      pointStyleBuffer.create(this.helper_);
      new Float32Array(pointStyleBuffer.getBuffer().getMappedRange()).set(
        pointStyleData,
      );
      pointStyleBuffer.getBuffer().unmap();
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
    /** @type {Array<{vertex: WebGPUBuffer, style: WebGPUBuffer, strokeShader?: string}>} */
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

        for (let i = 0; i < lineEntries.length; i++) {
          const feature = lineEntries[i].feature;
          const sIdx = i * STYLE_STRIDE;

          const color = resolveColor(style['stroke-color'], feature, defaultColor);
          const width = resolveStrokeWidth(style['stroke-width'], feature, 1.0);
          const offsetPx = resolveNumber(style['stroke-offset'], feature, 0.0);
          const miterLimit = resolveNumber(style['stroke-miter-limit'], feature, 10.0);

          let capType = 2; // match WebGL default
          if ('stroke-line-cap' in style) {
            const cap = String(resolveExpression(style['stroke-line-cap'], feature));
            capType = cap === 'square' ? 1 : cap === 'butt' ? 0 : 2;
          }
          let joinType = 2; // match WebGL default
          if ('stroke-line-join' in style) {
            const join = String(resolveExpression(style['stroke-line-join'], feature));
            joinType = join === 'bevel' ? 1 : join === 'round' ? 2 : 0;
          }

          const dash = resolveExpression(style['stroke-line-dash'], feature);
          const dashOffset = resolveNumber(style['stroke-line-dash-offset'], feature, 0.0);
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
          lineStyleData[sIdx + 7] = Number.isFinite(miterLimit) && miterLimit > 0 ? miterLimit : 10.0;
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
            lineStyleData[sIdx + 24] = resolveNumber(['get', 'limit'], feature, 0.0);
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
          Array.isArray(style['stroke-width']) ||
          Array.isArray(style['stroke-color'])
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
          });
        }

        lineStringBuffers.push({
          vertex: lineBuffer,
          style: lineStyleBuffer,
          strokeShader,
        });
      }
    }

    // --- 3. Generate Polygon Buffers ---
    const polyBatch = geometryBatch.polygonBatch;
    const polyEntries = Object.values(polyBatch.entries);

    const polyStyleRule = rules.find(
      (r) => r.style && typeof r.style['fill-color'] === 'string',
    );
    if (!polyStyleRule) {
      // No literal fill style: don't render polygons (prevents wrong default fills).
      return {
        pointBuffers: pointBuffer
          ? [
              {
                vertex: pointBuffer,
                style: pointStyleBuffer,
              },
            ]
          : [],
        lineStringBuffers,
        polygonBuffers: [],
      };
    }

    // To estimate size, we'd need to triangulate first or use a dynamic array.
    // Since earcut is fast enough for 2D, let's triangulate into a temp array.

    const polyVertices = []; // [x, y, featureIndex, x, y, featureIndex]
    const polyStyleDataArray = []; // [r, g, b, a, ...]

    // Resolve Poly Color
    let polyColor = [0, 0, 1, 1]; // Default Blue
    const colorStr = polyStyleRule.style['fill-color'];
    if (colorStr) {
      try {
        const c = asArray(colorStr);
        polyColor = [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
      } catch {
        // Ignore
      }
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

    // TODO: We should return binding info too
    return {
      pointBuffers: pointBuffer
        ? [
            {
              vertex: pointBuffer,
              style: pointStyleBuffer,
            },
          ]
        : [],
      lineStringBuffers,
      polygonBuffers: polyBuffer
        ? [
            {
              vertex: polyBuffer,
              style: polyStyleBuffer,
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
        size: 80, // mat4x4<f32> (64) + f32 (4) + padding
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();

    const format = navigator.gpu.getPreferredCanvasFormat();

    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: {r: 0.0, g: 0.0, b: 0.0, a: 0.0},
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    // Update Uniform Buffer with resolution
    if (this.uniformBuffer_) {
      const uniformData = new Float32Array(20); // 80 bytes (64 mat + 4 res + padding)
      const mat4Data = createMat4();
      mat4FromTransform(mat4Data, clipTransform);
      uniformData.set(mat4Data);
      uniformData[16] = resolution;
      uniformData[17] = pixelRatio;
      uniformData[18] = width;
      uniformData[19] = height;
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
          code: this.styleShaders_[0].builder.getFillVertexShader(),
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
                    srcFactor: 'src-alpha',
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
          bufferSet.strokeShader || this.styleShaders_[0].builder.getStrokeShader();
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
                      srcFactor: 'src-alpha',
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
        const count = vertexBuffer.size / 12;

        const shaderModule = device.createShaderModule({
          code: this.styleShaders_[0].builder.getFillVertexShader(),
        });

        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [
              {
                arrayStride: 12,
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
                    srcFactor: 'src-alpha',
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
            topology: 'point-list',
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
          ],
        });

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(count);
      }
    }

    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);
  }
}

export default VectorStyleRenderer;
