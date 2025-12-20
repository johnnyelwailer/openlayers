/**
 * @module ol/render/webgpu/vectorstylerenderer/geometry
 */
// @ts-check

import earcut from 'earcut';
import {create as createTransform} from '../../../transform.js';
import {writeLineSegmentToBuffers} from '../../linestringUtil.js';

const LINE_STRIDE = 3; // XYM
const POLY_STRIDE = 2; // XY

/**
 * @typedef {Object} LineWorkEntry
 * @property {number} [ref] Feature reference.
 * @property {Array<Array<number>>} flatCoordss LineString flat coordinates (XYM stride = 3).
 */

/**
 * Pack line strings into a single Float32Array for worker processing.
 * Layout: [ref, pointCount, x,y,m, x,y,m, ...] repeated.
 * @param {Array<LineWorkEntry>} lineEntries Line batch entries.
 * @return {Float32Array} Packed line work.
 */
export function packLineWork(lineEntries) {
  let size = 0;
  for (let i = 0; i < lineEntries.length; i++) {
    const entry = lineEntries[i];
    for (const flatCoords of entry.flatCoordss) {
      const pointCount = flatCoords.length / LINE_STRIDE;
      if (pointCount < 2) {
        continue;
      }
      size += 2 + flatCoords.length;
    }
  }

  const work = new Float32Array(size);
  let offset = 0;
  for (let i = 0; i < lineEntries.length; i++) {
    const entry = lineEntries[i];
    const ref = entry.ref ?? 0;
    for (const flatCoords of entry.flatCoordss) {
      const pointCount = flatCoords.length / LINE_STRIDE;
      if (pointCount < 2) {
        continue;
      }
      work[offset++] = ref;
      work[offset++] = pointCount;
      work.set(flatCoords, offset);
      offset += flatCoords.length;
    }
  }
  return work;
}

/**
 * Generate WebGPU stroke instance attributes for packed lines.
 * Each instance has 12 floats:
 * p0(x,y,m), p1(x,y,m), angle0, angle1, distanceLow, distanceHigh, angleTangentSum, featureIndex
 * @param {Float32Array} lineWork Packed line work as produced by packLineWork().
 * @return {Float32Array} Instance attributes.
 */
export function generateLineInstanceAttributes(lineWork) {
  if (!lineWork || lineWork.length === 0) {
    return new Float32Array(0);
  }

  /** @type {Array<number>} */
  const instanceAttributes = [];
  const identityTransform = createTransform();

  let offset = 0;
  while (offset + 2 <= lineWork.length) {
    const ref = lineWork[offset++];
    const pointCount = lineWork[offset++];
    const coordCount = pointCount * LINE_STRIDE;
    if (coordCount <= 0 || offset + coordCount > lineWork.length) {
      break;
    }

    const instructions = lineWork.subarray(offset, offset + coordCount);
    offset += coordCount;

    if (pointCount < 2) {
      continue;
    }

    const firstInstructionsIndex = 0;
    const lastInstructionsIndex = (pointCount - 1) * LINE_STRIDE;
    const isLoop =
      instructions[firstInstructionsIndex] ===
        instructions[lastInstructionsIndex] &&
      instructions[firstInstructionsIndex + 1] ===
        instructions[lastInstructionsIndex + 1];

    let currentLength = 0;
    let currentAngleTangentSum = 0;

    for (let j = 0; j < pointCount - 1; j++) {
      let beforeIndex = null;
      if (j > 0) {
        beforeIndex = (j - 1) * LINE_STRIDE;
      } else if (isLoop) {
        beforeIndex = lastInstructionsIndex - LINE_STRIDE;
      }

      let afterIndex = null;
      if (j < pointCount - 2) {
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
        instanceAttributes,
        [ref],
        identityTransform,
        currentLength,
        currentAngleTangentSum,
      );
      currentLength = measures.length;
      currentAngleTangentSum = measures.angle;
    }
  }

  return new Float32Array(instanceAttributes);
}

/**
 * Pack polygon geometries for worker tessellation.
 * @typedef {Object} PolygonWorkEntry
 * @property {number} [ref] Feature reference.
 * @property {Array<Array<number>>} flatCoordss Polygon flat coordinates (XY stride = 2).
 * @property {Array<Array<number>>} [ringsVerticesCounts] Per-polygon ring vertex counts.
 */

/**
 * Pack polygon geometries for worker tessellation.
 * @param {Array<PolygonWorkEntry>} polyEntries Polygon batch entries.
 * @return {{meta: Uint32Array, coords: Float32Array, rings: Uint32Array}} Packed polygon work.
 */
export function packPolygonWork(polyEntries) {
  let polyCount = 0;
  let coordCount = 0;
  let ringsCount = 0;
  for (let i = 0; i < polyEntries.length; i++) {
    const entry = polyEntries[i];
    for (let p = 0; p < entry.flatCoordss.length; p++) {
      const flatCoords = entry.flatCoordss[p];
      const rings = entry.ringsVerticesCounts
        ? entry.ringsVerticesCounts[p]
        : null;
      if (
        !flatCoords ||
        flatCoords.length === 0 ||
        !rings ||
        rings.length === 0
      ) {
        continue;
      }
      polyCount++;
      coordCount += flatCoords.length;
      ringsCount += rings.length;
    }
  }

  const meta = new Uint32Array(polyCount * 5); // [ref, coordOffset, coordLength, ringsOffset, ringsLength]
  const coords = new Float32Array(coordCount);
  const rings = new Uint32Array(ringsCount);

  let polyIndex = 0;
  let coordOffset = 0;
  let ringsOffset = 0;

  for (let i = 0; i < polyEntries.length; i++) {
    const entry = polyEntries[i];
    const ref = entry.ref ?? 0;
    for (let p = 0; p < entry.flatCoordss.length; p++) {
      const flatCoords = entry.flatCoordss[p];
      const ringCounts = entry.ringsVerticesCounts
        ? entry.ringsVerticesCounts[p]
        : null;
      if (
        !flatCoords ||
        flatCoords.length === 0 ||
        !ringCounts ||
        ringCounts.length === 0
      ) {
        continue;
      }

      meta[polyIndex * 5 + 0] = ref;
      meta[polyIndex * 5 + 1] = coordOffset;
      meta[polyIndex * 5 + 2] = flatCoords.length;
      meta[polyIndex * 5 + 3] = ringsOffset;
      meta[polyIndex * 5 + 4] = ringCounts.length;

      coords.set(flatCoords, coordOffset);
      coordOffset += flatCoords.length;

      for (let r = 0; r < ringCounts.length; r++) {
        rings[ringsOffset++] = ringCounts[r];
      }

      polyIndex++;
    }
  }

  return {meta, coords, rings};
}

/**
 * Tessellate packed polygon work and generate fill vertex data.
 * Each vertex has 3 floats: x, y, featureIndex.
 * @param {Uint32Array} meta Packed polygon meta.
 * @param {Float32Array} coords Packed polygon coordinates.
 * @param {Uint32Array} rings Packed ring vertex counts.
 * @return {Float32Array} Vertex data.
 */
export function generatePolygonVertexData(meta, coords, rings) {
  if (!meta || meta.length === 0) {
    return new Float32Array(0);
  }

  // First pass: count triangles.
  let triangleIndexCount = 0;
  for (let i = 0; i < meta.length; i += 5) {
    const coordOffset = meta[i + 1];
    const coordLength = meta[i + 2];
    const ringsOffset = meta[i + 3];
    const ringsLength = meta[i + 4];
    if (coordLength <= 0 || ringsLength <= 0) {
      continue;
    }

    const flatCoords = coords.subarray(coordOffset, coordOffset + coordLength);
    const ringCounts = rings.subarray(ringsOffset, ringsOffset + ringsLength);
    const holes = [];
    let currentVertexIndex = 0;
    for (let r = 0; r < ringCounts.length; r++) {
      if (r > 0) {
        holes.push(currentVertexIndex);
      }
      currentVertexIndex += ringCounts[r];
    }
    const triangles = earcut(flatCoords, holes, POLY_STRIDE);
    triangleIndexCount += triangles.length;
  }

  const out = new Float32Array(triangleIndexCount * 3);
  let outOffset = 0;

  for (let i = 0; i < meta.length; i += 5) {
    const ref = meta[i + 0];
    const coordOffset = meta[i + 1];
    const coordLength = meta[i + 2];
    const ringsOffset = meta[i + 3];
    const ringsLength = meta[i + 4];
    if (coordLength <= 0 || ringsLength <= 0) {
      continue;
    }

    const flatCoords = coords.subarray(coordOffset, coordOffset + coordLength);
    const ringCounts = rings.subarray(ringsOffset, ringsOffset + ringsLength);
    const holes = [];
    let currentVertexIndex = 0;
    for (let r = 0; r < ringCounts.length; r++) {
      if (r > 0) {
        holes.push(currentVertexIndex);
      }
      currentVertexIndex += ringCounts[r];
    }

    const triangles = earcut(flatCoords, holes, POLY_STRIDE);
    for (let t = 0; t < triangles.length; t++) {
      const vIdx = triangles[t];
      out[outOffset++] = flatCoords[vIdx * POLY_STRIDE];
      out[outOffset++] = flatCoords[vIdx * POLY_STRIDE + 1];
      out[outOffset++] = ref;
    }
  }

  return outOffset === out.length ? out : out.subarray(0, outOffset);
}
