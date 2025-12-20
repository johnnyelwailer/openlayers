/**
 * @module ol/render/webgpu/vectorstylerenderer/buffers
 */
// @ts-check

const BIND_GROUP_CACHE = Symbol('ol/webgpu/VectorStyleRenderer.bindGroupCache');

/**
 * @param {*} buffers Current buffers.
 * @return {Map<number, *>} Bind group cache.
 */
function getBindGroupCache(buffers) {
  let cache = buffers[BIND_GROUP_CACHE];
  if (!cache) {
    cache = new Map();
    buffers[BIND_GROUP_CACHE] = cache;
  }
  return cache;
}

/**
 * Encode draw calls for a buffer set into an existing render pass.
 * @param {*} renderer Vector style renderer.
 * @param {GPURenderPassEncoder} passEncoder Render pass encoder.
 * @param {GPUDevice} device Device.
 * @param {GPUTextureFormat} format Target format.
 * @param {*} buffers Buffers object (polygon/line/point).
 * @param {GPUBuffer} uniformBuffer Uniform buffer for this draw.
 */
export function renderBuffers(
  renderer,
  passEncoder,
  device,
  format,
  buffers,
  uniformBuffer,
) {
  /** @type {any} */
  const r = renderer;
  const bindGroupCache = getBindGroupCache(buffers);

  // 1. Render Polygons (Draw first to be underneath)
  if (buffers.polygonBuffers) {
    for (const bufferSet of buffers.polygonBuffers) {
      const vertexBuffer = bufferSet.vertex.getBuffer();
      const styleBuffer = bufferSet.style.getBuffer();
      const count = vertexBuffer.size / 12;

      const fillCode = bufferSet.fillShader || r.defaultFillShader_;
      const pipeline = r.getPipeline_(
        r.fillPipelineCache_,
        format,
        fillCode,
        () => {
          const shaderModule = device.createShaderModule({code: fillCode});
          return device.createRenderPipeline({
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
        },
      );

      const usesVars = bufferSet.usesVars;
      const varsBuffer = usesVars ? r.getVariablesBuffer_(device) : null;
      const usesProps = bufferSet.usesProps;
      const propsBuffer =
        buffers.featureProperties && usesProps
          ? buffers.featureProperties.buffer.getBuffer()
          : null;
      const usesTileMask = bufferSet.usesTileMask;
      const tileMaskSampler = usesTileMask ? r.tileMaskSampler_ : null;
      const tileMaskView = usesTileMask ? r.tileMaskView_ : null;
      const patternSampler = bufferSet.pattern?.sampler || null;
      const patternView = bufferSet.pattern?.view || null;
      const bindGroup = r.getCachedBindGroup_(
        bindGroupCache,
        r.getObjectId_(pipeline),
        r.getObjectId_(styleBuffer),
        r.getObjectId_(patternSampler),
        r.getObjectId_(patternView),
        r.getObjectId_(varsBuffer),
        r.getObjectId_(propsBuffer),
        r.getObjectId_(tileMaskSampler),
        r.getObjectId_(tileMaskView),
        () =>
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: {
                  buffer: styleBuffer,
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
              ...(varsBuffer
                ? [
                    {
                      binding: 4,
                      resource: {
                        buffer: varsBuffer,
                      },
                    },
                  ]
                : []),
              ...(propsBuffer
                ? [
                    {
                      binding: 5,
                      resource: {
                        buffer: propsBuffer,
                      },
                    },
                  ]
                : []),
              ...(tileMaskSampler && tileMaskView
                ? [
                    {
                      binding: 6,
                      resource: tileMaskSampler,
                    },
                    {
                      binding: 7,
                      resource: tileMaskView,
                    },
                  ]
                : []),
            ],
          }),
      );
      const uniformsBindGroup = r.getUniformBindGroup_(
        pipeline,
        device,
        uniformBuffer,
      );

      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setBindGroup(1, uniformsBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(count);
    }
  }

  // 2. Render LineStrings (Draw after polygons)
  if (buffers.lineStringBuffers) {
    for (const bufferSet of buffers.lineStringBuffers) {
      const vertexBuffer = bufferSet.vertex.getBuffer();
      const styleBuffer = bufferSet.style.getBuffer();

      // Each vertex = 12 floats = 48 bytes.
      const count = vertexBuffer.size / 48;

      const strokeCode = bufferSet.strokeShader || r.defaultStrokeShader_;
      const pipeline = r.getPipeline_(
        r.strokePipelineCache_,
        format,
        strokeCode,
        () => {
          const shaderModule = device.createShaderModule({code: strokeCode});
          return device.createRenderPipeline({
            layout: 'auto',
            vertex: {
              module: shaderModule,
              entryPoint: 'vs_main',
              buffers: [
                {
                  arrayStride: 48,
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
        },
      );

      const usesVars = bufferSet.usesVars;
      const varsBuffer = usesVars ? r.getVariablesBuffer_(device) : null;
      const usesProps = bufferSet.usesProps;
      const propsBuffer =
        buffers.featureProperties && usesProps
          ? buffers.featureProperties.buffer.getBuffer()
          : null;
      const usesTileMask = bufferSet.usesTileMask;
      const tileMaskSampler = usesTileMask ? r.tileMaskSampler_ : null;
      const tileMaskView = usesTileMask ? r.tileMaskView_ : null;
      const patternSampler = bufferSet.pattern?.sampler || null;
      const patternView = bufferSet.pattern?.view || null;
      const bindGroup = r.getCachedBindGroup_(
        bindGroupCache,
        r.getObjectId_(pipeline),
        r.getObjectId_(styleBuffer),
        r.getObjectId_(patternSampler),
        r.getObjectId_(patternView),
        r.getObjectId_(varsBuffer),
        r.getObjectId_(propsBuffer),
        r.getObjectId_(tileMaskSampler),
        r.getObjectId_(tileMaskView),
        () =>
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: {
                  buffer: styleBuffer,
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
              ...(varsBuffer
                ? [
                    {
                      binding: 4,
                      resource: {
                        buffer: varsBuffer,
                      },
                    },
                  ]
                : []),
              ...(propsBuffer
                ? [
                    {
                      binding: 5,
                      resource: {
                        buffer: propsBuffer,
                      },
                    },
                  ]
                : []),
              ...(tileMaskSampler && tileMaskView
                ? [
                    {
                      binding: 6,
                      resource: tileMaskSampler,
                    },
                    {
                      binding: 7,
                      resource: tileMaskView,
                    },
                  ]
                : []),
            ],
          }),
      );

      const uniformsBindGroup = r.getUniformBindGroup_(
        pipeline,
        device,
        uniformBuffer,
      );

      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setBindGroup(1, uniformsBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(4, count);
    }
  }

  // 3. Render Points (Draw last)
  if (buffers.pointBuffers) {
    for (const bufferSet of buffers.pointBuffers) {
      const vertexBuffer = bufferSet.vertex.getBuffer();
      const styleBuffer = bufferSet.style.getBuffer();

      // Each instance = 3 floats = 12 bytes.
      const instanceCount = vertexBuffer.size / 12;

      const symbolCode = bufferSet.symbolShader || r.defaultSymbolShader_;
      const pipeline = r.getPipeline_(
        r.symbolPipelineCache_,
        format,
        symbolCode,
        () => {
          const shaderModule = device.createShaderModule({code: symbolCode});
          return device.createRenderPipeline({
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
              topology: 'triangle-strip',
            },
          });
        },
      );

      const usesVars = bufferSet.usesVars;
      const varsBuffer = usesVars ? r.getVariablesBuffer_(device) : null;
      const usesProps = bufferSet.usesProps;
      const propsBuffer =
        buffers.featureProperties && usesProps
          ? buffers.featureProperties.buffer.getBuffer()
          : null;
      const usesTileMask = bufferSet.usesTileMask;
      const tileMaskSampler = usesTileMask ? r.tileMaskSampler_ : null;
      const tileMaskView = usesTileMask ? r.tileMaskView_ : null;
      const patternSampler = bufferSet.pattern?.sampler || null;
      const patternView = bufferSet.pattern?.view || null;
      const bindGroup = r.getCachedBindGroup_(
        bindGroupCache,
        r.getObjectId_(pipeline),
        r.getObjectId_(styleBuffer),
        r.getObjectId_(patternSampler),
        r.getObjectId_(patternView),
        r.getObjectId_(varsBuffer),
        r.getObjectId_(propsBuffer),
        r.getObjectId_(tileMaskSampler),
        r.getObjectId_(tileMaskView),
        () =>
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: {
                  buffer: styleBuffer,
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
              ...(varsBuffer
                ? [
                    {
                      binding: 4,
                      resource: {
                        buffer: varsBuffer,
                      },
                    },
                  ]
                : []),
              ...(propsBuffer
                ? [
                    {
                      binding: 5,
                      resource: {
                        buffer: propsBuffer,
                      },
                    },
                  ]
                : []),
              ...(tileMaskSampler && tileMaskView
                ? [
                    {
                      binding: 6,
                      resource: tileMaskSampler,
                    },
                    {
                      binding: 7,
                      resource: tileMaskView,
                    },
                  ]
                : []),
            ],
          }),
      );

      const uniformsBindGroup = r.getUniformBindGroup_(
        pipeline,
        device,
        uniformBuffer,
      );

      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setBindGroup(1, uniformsBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(4, instanceCount);
    }
  }
}
