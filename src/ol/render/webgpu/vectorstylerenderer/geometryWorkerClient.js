/**
 * @module ol/render/webgpu/vectorstylerenderer/geometryWorkerClient
 */
// @ts-check

import {create as createWebGPUWorker} from '../../../worker/webgpu.js';

/** @type {Worker|undefined} */
let WEBGPU_WORKER;

/** @type {number} */
let messageId = 0;

/** @type {Map<number, {resolve: Function, reject: Function}>} */
const callbacks = new Map();

function getWorker() {
  if (!WEBGPU_WORKER) {
    WEBGPU_WORKER = createWebGPUWorker();
    WEBGPU_WORKER.onmessage = (event) => {
      const data = event.data;
      const cb = data && callbacks.get(data.id);
      if (!cb) {
        return;
      }
      callbacks.delete(data.id);
      if (data.error) {
        cb.reject(new Error(data.error));
        return;
      }
      cb.resolve(data);
    };
    WEBGPU_WORKER.onmessageerror = () => {
      const error = new Error('WebGPU worker message error');
      for (const cb of callbacks.values()) {
        cb.reject(error);
      }
      callbacks.clear();
    };
    WEBGPU_WORKER.onerror = (event) => {
      const error = new Error(
        event && 'message' in event && event.message
          ? event.message
          : 'WebGPU worker error',
      );
      for (const cb of callbacks.values()) {
        cb.reject(error);
      }
      callbacks.clear();
    };
  }
  return WEBGPU_WORKER;
}

/**
 * @typedef {Object} GeometryWork
 * @property {Float32Array} lineWork Packed line work.
 * @property {Uint32Array} polyMeta Polygon meta.
 * @property {Float32Array} polyCoords Polygon coordinates.
 * @property {Uint32Array} polyRings Polygon ring vertex counts.
 */

/**
 * Generate geometry buffers off the main thread.
 * @param {GeometryWork} work Work.
 * @return {Promise<{lineInstance: ArrayBuffer, polygonVertices: ArrayBuffer}>} Result.
 */
export function generateGeometryBuffersInWorker(work) {
  const worker = getWorker();
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    callbacks.set(id, {resolve, reject});
    worker.postMessage(
      {
        type: 'WEBGPU_GENERATE_GEOMETRY_BUFFERS',
        id,
        lineWork: work.lineWork.buffer,
        polyMeta: work.polyMeta.buffer,
        polyCoords: work.polyCoords.buffer,
        polyRings: work.polyRings.buffer,
      },
      [
        work.lineWork.buffer,
        work.polyMeta.buffer,
        work.polyCoords.buffer,
        work.polyRings.buffer,
      ],
    );
  });
}
