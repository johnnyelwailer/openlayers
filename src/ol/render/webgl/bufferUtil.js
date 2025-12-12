/**
 * Utilities for filling WebGL buffers
 * @module ol/render/webgl/bufferUtil
 */
import earcut from 'earcut';
export {
  LINESTRING_ANGLE_COSINE_CUTOFF,
  writeLineSegmentToBuffers,
} from '../linestringUtil.js';

/** @type {Array<number>} */
const tmpArray_ = [];

/**
 * An object holding positions both in an index and a vertex buffer.
 * @typedef {Object} BufferPositions
 * @property {number} vertexAttributesPosition Position in the vertex buffer
 * @property {number} instanceAttributesPosition Position in the vertex buffer
 * @property {number} indicesPosition Position in the index buffer
 */
const bufferPositions_ = {
  vertexAttributesPosition: 0,
  instanceAttributesPosition: 0,
  indicesPosition: 0,
};

/**
 * Pushes a quad (two triangles) based on a point geometry
 * @param {Float32Array} instructions Array of render instructions for points.
 * @param {number} elementIndex Index from which render instructions will be read.
 * @param {Float32Array} instanceAttributesBuffer Buffer in the form of a typed array.
 * @param {number} customAttributesSize Amount of custom attributes for each element.
 * @param {BufferPositions} [bufferPositions] Buffer write positions; if not specified, positions will be set at 0.
 * @return {BufferPositions} New buffer positions where to write next
 * @property {number} vertexAttributesPosition New position in the vertex buffer where future writes should start.
 * @property {number} indicesPosition New position in the index buffer where future writes should start.
 * @private
 */
export function writePointFeatureToBuffers(
  instructions,
  elementIndex,
  instanceAttributesBuffer,
  customAttributesSize,
  bufferPositions,
) {
  const x = instructions[elementIndex++];
  const y = instructions[elementIndex++];

  // read custom numerical attributes on the feature
  const customAttrs = tmpArray_;
  customAttrs.length = customAttributesSize;
  for (let i = 0; i < customAttrs.length; i++) {
    customAttrs[i] = instructions[elementIndex + i];
  }

  let instPos = bufferPositions
    ? bufferPositions.instanceAttributesPosition
    : 0;

  instanceAttributesBuffer[instPos++] = x;
  instanceAttributesBuffer[instPos++] = y;
  if (customAttrs.length) {
    instanceAttributesBuffer.set(customAttrs, instPos);
    instPos += customAttrs.length;
  }

  bufferPositions_.instanceAttributesPosition = instPos;
  return bufferPositions_;
}

/**
 * Pushes several triangles to form a polygon, including holes
 * @param {Float32Array} instructions Array of render instructions for lines.
 * @param {number} polygonStartIndex Index of the polygon start point from which render instructions will be read.
 * @param {Array<number>} vertexArray Array containing vertices.
 * @param {Array<number>} indexArray Array containing indices.
 * @param {number} customAttributesSize Amount of custom attributes for each element.
 * @return {number} Next polygon instructions index
 * @private
 */
export function writePolygonTrianglesToBuffers(
  instructions,
  polygonStartIndex,
  vertexArray,
  indexArray,
  customAttributesSize,
) {
  const instructionsPerVertex = 2; // x, y
  const attributesPerVertex = 2 + customAttributesSize;
  let instructionsIndex = polygonStartIndex;
  const customAttributes = instructions.slice(
    instructionsIndex,
    instructionsIndex + customAttributesSize,
  );
  instructionsIndex += customAttributesSize;
  const ringsCount = instructions[instructionsIndex++];
  let verticesCount = 0;
  const holes = new Array(ringsCount - 1);
  for (let i = 0; i < ringsCount; i++) {
    verticesCount += instructions[instructionsIndex++];
    if (i < ringsCount - 1) {
      holes[i] = verticesCount;
    }
  }
  const flatCoords = instructions.slice(
    instructionsIndex,
    instructionsIndex + verticesCount * instructionsPerVertex,
  );

  // pushing to vertices and indices!! this is where the magic happens
  const result = earcut(flatCoords, holes, instructionsPerVertex);
  for (let i = 0; i < result.length; i++) {
    indexArray.push(result[i] + vertexArray.length / attributesPerVertex);
  }
  for (let i = 0; i < flatCoords.length; i += 2) {
    vertexArray.push(flatCoords[i], flatCoords[i + 1], ...customAttributes);
  }

  return instructionsIndex + verticesCount * instructionsPerVertex;
}
