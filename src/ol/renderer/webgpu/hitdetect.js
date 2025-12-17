/**
 * @module ol/renderer/webgpu/hitdetect
 */
import {toUserCoordinate, toUserResolution} from '../../proj.js';
import {getUid} from '../../util.js';

/**
 * @param {unknown} value Value.
 * @return {number|null} Numeric literal (or null).
 */
function getNumberLiteral(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value) && value[0] === 'literal') {
    return getNumberLiteral(value[1]);
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param {unknown} value Value.
 * @return {[number, number]|null} Size literal (or null).
 */
function getSizeLiteral(value) {
  if (Array.isArray(value) && value.length === 2) {
    const w = getNumberLiteral(value[0]);
    const h = getNumberLiteral(value[1]);
    if (w !== null && h !== null) {
      return [w, h];
    }
  }
  if (Array.isArray(value) && value[0] === 'literal') {
    return getSizeLiteral(value[1]);
  }
  return null;
}

/**
 * @param {unknown} value Value.
 * @return {number} Max absolute scale.
 */
function getMaxScale(value) {
  const numeric = getNumberLiteral(value);
  if (numeric !== null) {
    return Math.abs(numeric);
  }
  const size = getSizeLiteral(value);
  if (size) {
    return Math.max(Math.abs(size[0]), Math.abs(size[1]));
  }
  return 1;
}

/**
 * Best-effort hit tolerance padding based on static style literals.
 * @param {Array<Object>} styles Styles array as stored on the renderer.
 * @return {{pointRadiusPx: number, strokeHalfWidthPx: number}} Padding values.
 */
export function computeHitDetectionPadding(styles) {
  /** @type {number} */
  let pointRadiusPx = 0;
  /** @type {number} */
  let strokeHalfWidthPx = 0;

  /** @type {Array<any>} */
  const rules = (Array.isArray(styles) ? styles : []).map((entry) =>
    entry && entry.style ? entry : {style: entry},
  );

  for (const rule of rules) {
    const styleOrStyles = rule.style;
    const styleList = Array.isArray(styleOrStyles)
      ? styleOrStyles
      : [styleOrStyles];
    for (const style of styleList) {
      if (!style) {
        continue;
      }

      const strokeWidthLiteral = getNumberLiteral(style['stroke-width']);
      if (strokeWidthLiteral !== null) {
        strokeHalfWidthPx = Math.max(
          strokeHalfWidthPx,
          0.5 * strokeWidthLiteral,
        );
      } else if ('stroke-color' in style) {
        strokeHalfWidthPx = Math.max(strokeHalfWidthPx, 0.5 * 1.25);
      }

      // Circles (default radius 5 when present but not a literal).
      if (
        'circle-radius' in style ||
        'circle-fill-color' in style ||
        'circle-stroke-color' in style ||
        'circle-stroke-width' in style
      ) {
        const radius = getNumberLiteral(style['circle-radius']) ?? 5;
        const stroke = getNumberLiteral(style['circle-stroke-width']) ?? 0;
        const scale = getMaxScale(style['circle-scale']);
        pointRadiusPx = Math.max(
          pointRadiusPx,
          (radius + 0.5 * stroke) * scale,
        );
      }

      // Shapes (no safe default radius; only use literals).
      if (
        'shape-radius' in style ||
        'shape-fill-color' in style ||
        'shape-stroke-color' in style ||
        'shape-stroke-width' in style ||
        'shape-points' in style
      ) {
        const radius = getNumberLiteral(style['shape-radius']) ?? 0;
        const stroke = getNumberLiteral(style['shape-stroke-width']) ?? 0;
        const scale = getMaxScale(style['shape-scale']);
        pointRadiusPx = Math.max(
          pointRadiusPx,
          (radius + 0.5 * stroke) * scale,
        );
      }

      // Icons: use icon-size / width/height if provided, otherwise assume a modest default.
      if ('icon-src' in style) {
        const size =
          getSizeLiteral(style['icon-size']) ||
          (() => {
            const w = getNumberLiteral(style['icon-width']);
            const h = getNumberLiteral(style['icon-height']);
            if (w !== null && h !== null) {
              return [w, h];
            }
            return null;
          })();
        const half = size ? 0.5 * Math.max(size[0], size[1]) : 16;
        const scale = getMaxScale(style['icon-scale']);
        pointRadiusPx = Math.max(pointRadiusPx, half * scale);
      }
    }
  }

  return {pointRadiusPx, strokeHalfWidthPx};
}

/**
 * CPU-based hit detection: spatial-index prefilter via source extent lookup + geometry distance checks.
 * @param {import("../../layer/Layer.js").default} layer Layer.
 * @param {import("../../source/Vector.js").default} source Source.
 * @param {import("../../coordinate.js").Coordinate} coordinate Coordinate in view projection.
 * @param {import("../../Map.js").FrameState} frameState Frame state.
 * @param {number} hitTolerance Hit tolerance in pixels.
 * @param {number} pointRadiusPx Best-effort point hit padding in pixels.
 * @param {number} strokeHalfWidthPx Best-effort stroke hit padding in pixels.
 * @param {import("../vector.js").FeatureCallback<T>} callback Callback.
 * @param {Array<import("../Map.js").HitMatch<T>>} matches Matches.
 * @return {T|undefined} Callback result.
 * @template T
 */
export function forEachFeatureAtCoordinateCPU(
  layer,
  source,
  coordinate,
  frameState,
  hitTolerance,
  pointRadiusPx,
  strokeHalfWidthPx,
  callback,
  matches,
) {
  const viewProjection = frameState.viewState.projection;
  const coord = toUserCoordinate(coordinate.slice(), viewProjection);
  const resolution = toUserResolution(
    frameState.viewState.resolution,
    viewProjection,
  );
  if (!Number.isFinite(resolution) || resolution <= 0) {
    return undefined;
  }

  const x = coord[0];
  const y = coord[1];

  const pointTolPx = hitTolerance + pointRadiusPx;
  const strokeTolPx = hitTolerance + strokeHalfWidthPx;
  const extentTolPx = Math.max(pointTolPx, strokeTolPx);
  const extentTol = extentTolPx * resolution;
  const extent = [x - extentTol, y - extentTol, x + extentTol, y + extentTol];

  const pointTolSq = pointTolPx * pointTolPx;
  const strokeTolSq = strokeTolPx * strokeTolPx;
  const invResSq = 1 / (resolution * resolution);

  /** @type {!Object<string, import("../Map.js").HitMatch<T>|true>} */
  const features = {};

  /** @type {Array<number>} */
  const closestPoint = [NaN, NaN];
  let result;

  /**
   * @param {import("../../Feature.js").FeatureLike} feature Feature.
   * @param {number} distanceSqPx Squared distance in pixel units.
   * @return {T|undefined} Callback result.
   */
  const considerHit = (feature, distanceSqPx) => {
    const key = getUid(feature);
    const match = features[key];
    if (!match) {
      if (distanceSqPx === 0) {
        features[key] = true;
        return callback(feature, layer, null);
      }
      matches.push(
        (features[key] = {
          feature: feature,
          layer: layer,
          geometry: null,
          distanceSq: distanceSqPx,
          callback: callback,
        }),
      );
    } else if (match !== true && distanceSqPx < match.distanceSq) {
      if (distanceSqPx === 0) {
        features[key] = true;
        matches.splice(matches.lastIndexOf(match), 1);
        return callback(feature, layer, null);
      }
      match.distanceSq = distanceSqPx;
    }
    return undefined;
  };

  source.forEachFeatureInExtent(extent, (feature) => {
    const geometry = feature.getGeometry?.();
    if (!geometry) {
      return;
    }
    const distSqMap = geometry.containsXY?.(x, y)
      ? 0
      : geometry.closestPointXY(x, y, closestPoint, Infinity);
    if (!Number.isFinite(distSqMap)) {
      return;
    }
    const distSqPx = distSqMap * invResSq;
    const tolSq =
      geometry.getType?.() === 'Point' || geometry.getType?.() === 'MultiPoint'
        ? pointTolSq
        : strokeTolSq;
    if (distSqPx > tolSq) {
      return;
    }
    result = considerHit(feature, distSqPx);
    return result;
  });

  return result;
}
