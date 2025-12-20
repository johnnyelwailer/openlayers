/**
 * A worker that does cpu-heavy tasks related to webgpu rendering.
 * @module ol/worker/webgpu
 */
// @ts-check

import {
  generateLineInstanceAttributes,
  generatePolygonVertexData,
} from '../render/webgpu/vectorstylerenderer/geometry.js';

/** @type {any} */
const worker = self;

/** @param {MessageEvent} event Message event. */
worker.onmessage = (event) => {
  const received = event.data;
  if (!received || received.type !== 'WEBGPU_GENERATE_GEOMETRY_BUFFERS') {
    return;
  }

  const {id, lineWork, polyMeta, polyCoords, polyRings} = received;
  try {
    const lineInstance = generateLineInstanceAttributes(
      lineWork ? new Float32Array(lineWork) : new Float32Array(0),
    );
    const polygonVertices = generatePolygonVertexData(
      polyMeta ? new Uint32Array(polyMeta) : new Uint32Array(0),
      polyCoords ? new Float32Array(polyCoords) : new Float32Array(0),
      polyRings ? new Uint32Array(polyRings) : new Uint32Array(0),
    );

    worker.postMessage(
      {
        id,
        lineInstance: lineInstance.buffer,
        polygonVertices: polygonVertices.buffer,
      },
      [lineInstance.buffer, polygonVertices.buffer],
    );
  } catch (error) {
    worker.postMessage({id, error: error ? String(error) : 'Unknown error'});
  }
};

/** @type {function(): Worker} */ export let create;
