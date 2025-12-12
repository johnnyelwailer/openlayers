/**
 * @module ol/render/webgpu/VectorStyleRenderer
 */
import earcut from 'earcut';
import {asArray} from '../../color.js';
import WebGPUBuffer from '../../webgpu/Buffer.js';
import {WGSLBuilder} from './WGSLBuilder.js';
import {writeLineSegmentToBuffers} from '../linestringUtil.js';
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

    // Resolve Point Color
    // For MVP, look at first style 'circle-fill-color' or 'fill-color'
    let pointColor = [1, 0, 0, 1]; // Default Red
    if (this.styles_ && this.styles_[0]) {
      const style = this.styles_[0];
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

    if (pointVertexCount > 0) {
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

    // Style struct is aligned to 16 bytes; 12 floats = 48 bytes per feature:
    // color(4) + width + cap + join + miterLimit + offset + padding(3)
    const lineStyleData = new Float32Array(lineEntries.length * 12);

    // Resolve Line Style
    let lineColor = [0, 0, 0, 1];
    let lineWidth = 1.0;
    let lineCapType = 0; // 0=butt, 1=square, 2=round
    let lineJoinType = 0; // 0=miter, 1=bevel, 2=round
    let lineMiterLimit = 10.0;
    let lineOffset = 0.0;
    if (this.styles_ && this.styles_[0]) {
      const style = this.styles_[0];
      const colorStr = style['stroke-color'];
      if (colorStr) {
        try {
          const c = asArray(colorStr);
          lineColor = [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
        } catch {
          // Ignore
        }
      }
      if (style['stroke-width'] !== undefined) {
        lineWidth = Number(style['stroke-width']);
      }
      if (style['stroke-line-cap']) {
        const cap = String(style['stroke-line-cap']);
        lineCapType = cap === 'square' ? 1 : cap === 'round' ? 2 : 0;
      }
      if (style['stroke-line-join']) {
        const join = String(style['stroke-line-join']);
        lineJoinType = join === 'bevel' ? 1 : join === 'round' ? 2 : 0;
      }
      if (style['stroke-miter-limit'] !== undefined) {
        const limit = Number(style['stroke-miter-limit']);
        if (Number.isFinite(limit) && limit > 0) {
          lineMiterLimit = limit;
        }
      }
      if (style['stroke-offset'] !== undefined) {
        const offset = Number(style['stroke-offset']);
        if (Number.isFinite(offset)) {
          lineOffset = offset;
        }
      }
    }

    // Fill the per-feature style buffer (one style per feature in the batch)
    for (let i = 0; i < lineEntries.length; i++) {
      // Style
      const sIdx = i * 12;
      lineStyleData[sIdx + 0] = lineColor[0];
      lineStyleData[sIdx + 1] = lineColor[1];
      lineStyleData[sIdx + 2] = lineColor[2];
      lineStyleData[sIdx + 3] = lineColor[3];
      lineStyleData[sIdx + 4] = lineWidth;
      lineStyleData[sIdx + 5] = lineCapType;
      lineStyleData[sIdx + 6] = lineJoinType;
      lineStyleData[sIdx + 7] = lineMiterLimit;
      lineStyleData[sIdx + 8] = lineOffset;
    }

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
    let lineStyleBuffer = null;
    if (lineInstanceAttributes.length > 0) {
      const lineData = new Float32Array(lineInstanceAttributes);
      lineBuffer = new WebGPUBuffer({
        size: lineData.byteLength,
        usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
        mappedAtCreation: true,
      });
      lineBuffer.create(this.helper_);
      new Float32Array(lineBuffer.getBuffer().getMappedRange()).set(lineData);
      lineBuffer.getBuffer().unmap();

      lineStyleBuffer = new WebGPUBuffer({
        size: lineStyleData.byteLength,
        usage: 0x0080 | 0x0008, // STORAGE
        mappedAtCreation: true,
      });
      lineStyleBuffer.create(this.helper_);
      new Float32Array(lineStyleBuffer.getBuffer().getMappedRange()).set(
        lineStyleData,
      );
      lineStyleBuffer.getBuffer().unmap();
    }

    // --- 3. Generate Polygon Buffers ---
    const polyBatch = geometryBatch.polygonBatch;
    const polyEntries = Object.values(polyBatch.entries);

    // To estimate size, we'd need to triangulate first or use a dynamic array.
    // Since earcut is fast enough for 2D, let's triangulate into a temp array.

    const polyVertices = []; // [x, y, featureIndex, x, y, featureIndex]
    const polyStyleDataArray = []; // [r, g, b, a, ...]

    // Resolve Poly Color
    let polyColor = [0, 0, 1, 1]; // Default Blue
    if (this.styles_ && this.styles_[0]) {
      const style = this.styles_[0];
      const colorStr = style['fill-color'];
      // TODO: Parse color string
      if (colorStr) {
        try {
          const c = asArray(colorStr);
          polyColor = [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
        } catch {
          // Ignore
        }
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
      lineStringBuffers: lineBuffer
        ? [
            {
              vertex: lineBuffer,
              style: lineStyleBuffer,
            },
          ]
        : [],
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

        const shaderModule = device.createShaderModule({
          code: this.styleShaders_[0].builder.getStrokeVertexShader(),
        });

        const pipeline = device.createRenderPipeline({
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
