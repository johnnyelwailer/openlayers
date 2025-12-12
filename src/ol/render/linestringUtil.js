/**
 * @module ol/render/linestringUtil
 */
import {clamp} from '../math.js';
import {apply as applyTransform} from '../transform.js';

export const LINESTRING_ANGLE_COSINE_CUTOFF = 0.985;

/**
 * Pushes a single quad instance to form a line segment; also includes a computation for the join angles with previous and next
 * segment, in order to be able to offset the vertices correctly in the shader.
 * Join angles are between 0 and 2PI.
 * This also computes the length of the current segment and the sum of the join angle tangents in order
 * to store this information on each subsequent segment along the line. This is necessary to correctly render dashes
 * and symbols along the line.
 *
 * @param {Float32Array} instructions Array of render instructions for lines.
 * @param {number} segmentStartIndex Index of the segment start point from which render instructions will be read.
 * @param {number} segmentEndIndex Index of the segment end point from which render instructions will be read.
 * @param {number|null} beforeSegmentIndex Index of the point right before the segment (null if none, e.g this is a line start)
 * @param {number|null} afterSegmentIndex Index of the point right after the segment (null if none, e.g this is a line end)
 * @param {Array<number>} instanceAttributesArray Array containing instance attributes.
 * @param {Array<number>} customAttributes Array of custom attributes value
 * @param {import('../transform.js').Transform} toWorldTransform Transform matrix used to obtain world coordinates from instructions
 * @param {number} currentLength Cumulated length of segments processed so far
 * @param {number} currentAngleTangentSum Cumulated tangents of the join angles processed so far
 * @return {{length: number, angle: number}} Cumulated length with the newly processed segment (in world units), new sum of the join angle tangents
 */
export function writeLineSegmentToBuffers(
  instructions,
  segmentStartIndex,
  segmentEndIndex,
  beforeSegmentIndex,
  afterSegmentIndex,
  instanceAttributesArray,
  customAttributes,
  toWorldTransform,
  currentLength,
  currentAngleTangentSum,
) {
  const p0 = [
    instructions[segmentStartIndex],
    instructions[segmentStartIndex + 1],
  ];
  const p1 = [instructions[segmentEndIndex], instructions[segmentEndIndex + 1]];

  const m0 = instructions[segmentStartIndex + 2];
  const m1 = instructions[segmentEndIndex + 2];

  // to compute join angles we need to reproject coordinates back in world units
  const p0world = applyTransform(toWorldTransform, [...p0]);
  const p1world = applyTransform(toWorldTransform, [...p1]);

  /**
   * Compute the angle between p0pA and p0pB
   * @param {import("../coordinate.js").Coordinate} p0 Point 0
   * @param {import("../coordinate.js").Coordinate} pA Point A
   * @param {import("../coordinate.js").Coordinate} pB Point B
   * @return {number} a value in [0, 2PI]
   */
  function angleBetween(p0, pA, pB) {
    const lenA = Math.sqrt(
      (pA[0] - p0[0]) * (pA[0] - p0[0]) + (pA[1] - p0[1]) * (pA[1] - p0[1]),
    );
    const tangentA = [(pA[0] - p0[0]) / lenA, (pA[1] - p0[1]) / lenA];
    const orthoA = [-tangentA[1], tangentA[0]];
    const lenB = Math.sqrt(
      (pB[0] - p0[0]) * (pB[0] - p0[0]) + (pB[1] - p0[1]) * (pB[1] - p0[1]),
    );
    const tangentB = [(pB[0] - p0[0]) / lenB, (pB[1] - p0[1]) / lenB];

    let angle =
      lenA === 0 || lenB === 0
        ? 0
        : Math.acos(
            clamp(tangentB[0] * tangentA[0] + tangentB[1] * tangentA[1], -1, 1),
          );
    angle = Math.max(angle, 0.00001); // avoid a zero angle otherwise this is detected as a line cap
    const isClockwise = tangentB[0] * orthoA[0] + tangentB[1] * orthoA[1] > 0;
    return !isClockwise ? Math.PI * 2 - angle : angle;
  }

  // a negative angle indicates a line cap
  let angle0 = -1;
  let angle1 = -1;
  let newAngleTangentSum = currentAngleTangentSum;

  const joinBefore = beforeSegmentIndex !== null;
  const joinAfter = afterSegmentIndex !== null;

  if (joinBefore) {
    const pB = [
      instructions[beforeSegmentIndex],
      instructions[beforeSegmentIndex + 1],
    ];
    const pBworld = applyTransform(toWorldTransform, [...pB]);
    angle0 = angleBetween(p0world, p1world, pBworld);

    if (Math.cos(angle0) <= LINESTRING_ANGLE_COSINE_CUTOFF) {
      newAngleTangentSum += Math.tan((angle0 - Math.PI) / 2);
    }
  }
  if (joinAfter) {
    const pA = [
      instructions[afterSegmentIndex],
      instructions[afterSegmentIndex + 1],
    ];
    const pAworld = applyTransform(toWorldTransform, [...pA]);
    angle1 = angleBetween(p1world, p0world, pAworld);

    if (Math.cos(angle1) <= LINESTRING_ANGLE_COSINE_CUTOFF) {
      newAngleTangentSum += Math.tan((Math.PI - angle1) / 2);
    }
  }

  const maxPrecision = Math.pow(2, 24);
  const distanceLow = currentLength % maxPrecision;
  const distanceHigh = Math.floor(currentLength / maxPrecision) * maxPrecision;

  instanceAttributesArray.push(
    p0[0],
    p0[1],
    m0,
    p1[0],
    p1[1],
    m1,
    angle0,
    angle1,
    distanceLow,
    distanceHigh,
    currentAngleTangentSum,
  );
  instanceAttributesArray.push(...customAttributes);

  return {
    length:
      currentLength +
      Math.sqrt(
        (p1world[0] - p0world[0]) * (p1world[0] - p0world[0]) +
          (p1world[1] - p0world[1]) * (p1world[1] - p0world[1]),
      ),
    angle: newAngleTangentSum,
  };
}

