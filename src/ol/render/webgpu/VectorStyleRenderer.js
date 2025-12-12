/**
 * @module ol/render/webgpu/VectorStyleRenderer
 */
import earcut from 'earcut';
import {asArray} from '../../color.js';
import WebGPUBuffer from '../../webgpu/Buffer.js';
import {WGSLBuilder} from './WGSLBuilder.js';

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

    // Note: Variable 'data' meant 'pointData' here.
    // Wait, the original code used 'pointData'. The above replacement uses 'data' in loop but 'pointData' definition?
    // In original code: const pointData = ... pointData[cursor++] = ...
    // In my replacement: I must use pointData!
    // I will fix 'data' to 'pointData' in the loop below.

    const pointBuffer = new WebGPUBuffer({
      size: pointData.byteLength,
      usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
      mappedAtCreation: true,
    });
    pointBuffer.create(this.helper_);
    new Float32Array(pointBuffer.getBuffer().getMappedRange()).set(pointData);
    pointBuffer.getBuffer().unmap();

    const pointStyleBuffer = new WebGPUBuffer({
      size: pointStyleData.byteLength,
      usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
      mappedAtCreation: true,
    });
    pointStyleBuffer.create(this.helper_);
    new Float32Array(pointStyleBuffer.getBuffer().getMappedRange()).set(
      pointStyleData,
    );
    pointStyleBuffer.getBuffer().unmap();

    // --- 2. Generate LineString Buffers ---
    const lineBatch = geometryBatch.lineStringBatch;
    const lineEntries = Object.values(lineBatch.entries);

    // Calculate total vertices for lines (LineList topology: 2 vertices per segment)
    let lineVertexCount = 0;
    for (const entry of lineEntries) {
      for (const flatCoords of entry.flatCoordss) {
        const numPoints = flatCoords.length / 2;
        if (numPoints >= 2) {
          lineVertexCount += (numPoints - 1) * 2; // N points -> N-1 segments -> 2*(N-1) vertices
        }
      }
    }

    // 3 floats per vertex: x, y, featureIndex
    const lineData = new Float32Array(lineVertexCount * 3);
    const lineStyleData = new Float32Array(lineEntries.length * 4);

    // Resolve Line Color
    let lineColor = [0, 0, 0, 1]; // Default Black
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
    }

    cursor = 0;
    for (let i = 0; i < lineEntries.length; i++) {
      const entry = lineEntries[i];

      // Style
      lineStyleData[i * 4 + 0] = lineColor[0];
      lineStyleData[i * 4 + 1] = lineColor[1];
      lineStyleData[i * 4 + 2] = lineColor[2];
      lineStyleData[i * 4 + 3] = lineColor[3];

      for (const flatCoords of entry.flatCoordss) {
        const numPoints = flatCoords.length / 2;
        if (numPoints < 2) {
          continue;
        }

        for (let j = 0; j < numPoints - 1; j++) {
          const idx = j * 2;
          // Segment Start
          lineData[cursor++] = flatCoords[idx];
          lineData[cursor++] = flatCoords[idx + 1];
          lineData[cursor++] = i;

          // Segment End
          lineData[cursor++] = flatCoords[idx + 2];
          lineData[cursor++] = flatCoords[idx + 3];
          lineData[cursor++] = i;
        }
      }
    }

    let lineBuffer = null;
    let lineStyleBuffer = null;
    if (lineVertexCount > 0) {
      lineBuffer = new WebGPUBuffer({
        size: lineData.byteLength,
        usage: 0x0020 | 0x0008,
        mappedAtCreation: true,
      });
      lineBuffer.create(this.helper_);
      new Float32Array(lineBuffer.getBuffer().getMappedRange()).set(lineData);
      lineBuffer.getBuffer().unmap();

      lineStyleBuffer = new WebGPUBuffer({
        size: lineStyleData.byteLength,
        usage: 0x0080 | 0x0008,
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
      pointBuffers: [
        {
          vertex: pointBuffer,
          style: pointStyleBuffer,
        },
      ],
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
  render(buffers, frameState) {
    const device = this.helper_.getDevice();
    const context = this.helper_.getContext();

    if (!device || !context) {
      return;
    }

    // Render Points
    if (buffers.pointBuffers) {
      for (const bufferSet of buffers.pointBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const count = vertexBuffer.size / 12; // 3 floats * 4 bytes = 12 bytes per vertex

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
                arrayStride: 12, // 3 floats (x, y, featureIndex)
                attributes: [
                  {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2', // position
                  },
                  {
                    shaderLocation: 1,
                    offset: 8,
                    format: 'float32', // featureIndex (as float for now)
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
                format: navigator.gpu.getPreferredCanvasFormat(),
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
          ],
        });

        const commandEncoder = device.createCommandEncoder();
        const textureView = context.getCurrentTexture().createView();

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

        const passEncoder =
          commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(count);
        passEncoder.end();

        device.queue.submit([commandEncoder.finish()]);
      }
    }

    // Render Lines
    if (buffers.lineStringBuffers) {
      for (const bufferSet of buffers.lineStringBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const count = vertexBuffer.size / 12;

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
            entryPoint: 'fs_main', // stroke fragment
            targets: [
              {
                format: navigator.gpu.getPreferredCanvasFormat(),
              },
            ],
          },
          primitive: {
            topology: 'line-list',
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
          ],
        });

        const commandEncoder = device.createCommandEncoder();

        const textureView = context.getCurrentTexture().createView();

        const renderPassDescriptor = {
          colorAttachments: [
            {
              view: textureView,
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        };

        const passEncoder =
          commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(count);
        passEncoder.end();

        device.queue.submit([commandEncoder.finish()]);
      }
    }

    // Render Polygons
    if (buffers.polygonBuffers) {
      for (const bufferSet of buffers.polygonBuffers) {
        const vertexBuffer = bufferSet.vertex.getBuffer();
        const styleBuffer = bufferSet.style.getBuffer();
        const count = vertexBuffer.size / 12;

        const shaderModule = device.createShaderModule({
          code: this.styleShaders_[0].builder.getFillVertexShader(), // Use fill shader
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
                format: navigator.gpu.getPreferredCanvasFormat(),
              },
            ],
          },
          primitive: {
            topology: 'triangle-list', // Polygons
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
          ],
        });

        const commandEncoder = device.createCommandEncoder();
        const textureView = context.getCurrentTexture().createView();

        const renderPassDescriptor = {
          colorAttachments: [
            {
              view: textureView,
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        };

        const passEncoder =
          commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(count);
        passEncoder.end();

        device.queue.submit([commandEncoder.finish()]);
      }
    }
  }
}

export default VectorStyleRenderer;
