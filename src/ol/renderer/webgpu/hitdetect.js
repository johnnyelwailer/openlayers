/**
 * @module ol/renderer/webgpu/hitdetect
 */
import {buildExpression, newEvaluationContext} from '../../expr/cpu.js';
import {
  AnyType,
  BooleanType,
  NumberType,
  SizeType,
  newParsingContext,
} from '../../expr/expression.js';
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
 * @typedef {Object} HitDetectionStyleState
 * @property {number} pointRadiusPx Point padding radius in pixels.
 * @property {number} strokeHalfWidthPx Stroke half-width in pixels.
 * @property {boolean} fillActive Whether polygon interiors should be hittable.
 */

/**
 * @typedef {Object} HitDetectionRuleEvaluator
 * @property {boolean} elseRule Else semantics.
 * @property {(null|import("../../expr/cpu.js").BooleanEvaluator)} filter Filter evaluator.
 * @property {Array<HitDetectionStyleEvaluator>} styles Style evaluators.
 */

/**
 * @typedef {Object} HitDetectionStyleEvaluator
 * @property {boolean} hasStroke Whether style contributes to stroke width.
 * @property {boolean} hasFill Whether style contributes to fill.
 * @property {boolean} hasCircle Whether style contributes to circle points.
 * @property {boolean} hasShape Whether style contributes to shape points.
 * @property {boolean} hasIcon Whether style contributes to icon points.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} strokeWidth Stroke width evaluator.
 * @property {(null|import("../../expr/cpu.js").ExpressionEvaluator)} strokeColor Stroke color evaluator.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} circleRadius Circle radius evaluator.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} circleStrokeWidth Circle stroke width evaluator.
 * @property {(null|import("../../expr/cpu.js").ExpressionEvaluator)} circleFillColor Circle fill color evaluator.
 * @property {(null|import("../../expr/cpu.js").SizeEvaluator)} circleScale Circle scale evaluator.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} shapeRadius Shape radius evaluator.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} shapeStrokeWidth Shape stroke width evaluator.
 * @property {(null|import("../../expr/cpu.js").SizeEvaluator)} shapeScale Shape scale evaluator.
 * @property {(null|import("../../expr/cpu.js").SizeEvaluator)} iconSize Icon size evaluator.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} iconWidth Icon width evaluator.
 * @property {(null|import("../../expr/cpu.js").NumberEvaluator)} iconHeight Icon height evaluator.
 * @property {(null|import("../../expr/cpu.js").SizeEvaluator)} iconScale Icon scale evaluator.
 * @property {(null|import("../../expr/cpu.js").ExpressionEvaluator)} fillColor Fill color evaluator.
 * @property {boolean} fillPattern Whether fill pattern is present.
 */

/**
 * @typedef {function(import("../../Feature.js").FeatureLike, import("../../geom/Geometry.js").default, import("../../Map.js").FrameState): HitDetectionStyleState} HitDetectionStateEvaluator
 */

/**
 * @typedef {Object} HitDetectionEvaluator
 * @property {HitDetectionStateEvaluator} evaluate Per-feature style-dependent hit state evaluator.
 * @property {number} maxPointRadiusPx Maximum point padding radius in pixels.
 * @property {number} maxStrokeHalfWidthPx Maximum stroke half-width in pixels.
 */

/**
 * @param {unknown} value Value.
 * @return {number} Finite number or 0.
 */
function getFiniteNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} value Value.
 * @return {number} Max absolute scale.
 */
function getMaxScaleValue(value) {
  if (typeof value === 'number') {
    return Math.abs(getFiniteNumber(value));
  }
  if (Array.isArray(value) && value.length >= 2) {
    return Math.max(
      Math.abs(getFiniteNumber(value[0])),
      Math.abs(getFiniteNumber(value[1])),
    );
  }
  return 1;
}

/**
 * @param {unknown} value Value.
 * @return {boolean} Whether the value disables drawing/hit detection.
 */
function isNone(value) {
  return value === 'none';
}

/**
 * @param {unknown} value Value.
 * @return {unknown} Color-like literal, when passed through ['literal', ...].
 */
function unwrapLiteral(value) {
  if (Array.isArray(value) && value[0] === 'literal') {
    return value[1];
  }
  return value;
}

/**
 * @param {Object} style Flat style.
 * @param {string} name Property name.
 * @return {boolean} Whether the property exists on the style.
 */
function hasStyleProp(style, name) {
  return style && typeof style === 'object' && name in style;
}

/**
 * @param {unknown} encoded Encoded expression.
 * @param {number} type Expected type.
 * @param {import("../../expr/expression.js").ParsingContext} parsing Parsing context.
 * @param {any} fallback Fallback evaluator.
 * @return {any} Evaluator.
 */
function tryBuildExpression(encoded, type, parsing, fallback) {
  try {
    return buildExpression(
      /** @type {import("../../expr/expression.js").EncodedExpression} */ (
        encoded
      ),
      type,
      parsing,
    );
  } catch {
    return fallback;
  }
}

/**
 * @param {Array<Object>} styles Styles array as stored on the renderer.
 * @param {Object} variables Style variables.
 * @return {HitDetectionEvaluator} Evaluator.
 */
export function createHitDetectionEvaluator(styles, variables) {
  /** @type {Array<any>} */
  const rules = (Array.isArray(styles) ? styles : []).map((entry) =>
    entry && entry.style ? entry : {style: entry},
  );

  /** @type {Set<string>} */
  const propsUsed = new Set();
  /** @type {Set<string>} */
  const varsUsed = new Set();

  /** @type {Array<HitDetectionRuleEvaluator>} */
  const compiledRules = [];

  for (const rule of rules) {
    const styleOrStyles = rule.style;
    const styleList = Array.isArray(styleOrStyles)
      ? styleOrStyles
      : [styleOrStyles];

    const parsing = newParsingContext();
    const filter = rule.filter
      ? tryBuildExpression(rule.filter, BooleanType, parsing, null)
      : null;

    /** @type {Array<HitDetectionStyleEvaluator>} */
    const compiledStyles = [];
    for (const style of styleList) {
      if (!style) {
        continue;
      }

      const hasStroke =
        hasStyleProp(style, 'stroke-width') ||
        hasStyleProp(style, 'stroke-color');
      const hasFill =
        hasStyleProp(style, 'fill-color') ||
        hasStyleProp(style, 'fill-pattern-src');
      const hasCircle =
        hasStyleProp(style, 'circle-radius') ||
        hasStyleProp(style, 'circle-fill-color') ||
        hasStyleProp(style, 'circle-stroke-width') ||
        hasStyleProp(style, 'circle-stroke-color') ||
        hasStyleProp(style, 'circle-scale');
      const hasShape =
        hasStyleProp(style, 'shape-radius') ||
        hasStyleProp(style, 'shape-fill-color') ||
        hasStyleProp(style, 'shape-stroke-width') ||
        hasStyleProp(style, 'shape-stroke-color') ||
        hasStyleProp(style, 'shape-scale') ||
        hasStyleProp(style, 'shape-points');
      const hasIcon = hasStyleProp(style, 'icon-src');

      const strokeWidth = hasStyleProp(style, 'stroke-width')
        ? tryBuildExpression(style['stroke-width'], NumberType, parsing, null)
        : null;
      const strokeColor = hasStyleProp(style, 'stroke-color')
        ? tryBuildExpression(style['stroke-color'], AnyType, parsing, null)
        : null;

      const circleRadius = hasStyleProp(style, 'circle-radius')
        ? tryBuildExpression(style['circle-radius'], NumberType, parsing, null)
        : null;
      const circleStrokeWidth = hasStyleProp(style, 'circle-stroke-width')
        ? tryBuildExpression(
            style['circle-stroke-width'],
            NumberType,
            parsing,
            null,
          )
        : null;
      const circleFillColor = hasStyleProp(style, 'circle-fill-color')
        ? tryBuildExpression(style['circle-fill-color'], AnyType, parsing, null)
        : null;
      const circleScale = hasStyleProp(style, 'circle-scale')
        ? tryBuildExpression(style['circle-scale'], SizeType, parsing, null)
        : null;

      const shapeRadius = hasStyleProp(style, 'shape-radius')
        ? tryBuildExpression(style['shape-radius'], NumberType, parsing, null)
        : null;
      const shapeStrokeWidth = hasStyleProp(style, 'shape-stroke-width')
        ? tryBuildExpression(
            style['shape-stroke-width'],
            NumberType,
            parsing,
            null,
          )
        : null;
      const shapeScale = hasStyleProp(style, 'shape-scale')
        ? tryBuildExpression(style['shape-scale'], SizeType, parsing, null)
        : null;

      const iconSize = hasStyleProp(style, 'icon-size')
        ? tryBuildExpression(style['icon-size'], SizeType, parsing, null)
        : null;
      const iconWidth = hasStyleProp(style, 'icon-width')
        ? tryBuildExpression(style['icon-width'], NumberType, parsing, null)
        : null;
      const iconHeight = hasStyleProp(style, 'icon-height')
        ? tryBuildExpression(style['icon-height'], NumberType, parsing, null)
        : null;
      const iconScale = hasStyleProp(style, 'icon-scale')
        ? tryBuildExpression(style['icon-scale'], SizeType, parsing, null)
        : null;

      const fillColor = hasStyleProp(style, 'fill-color')
        ? tryBuildExpression(style['fill-color'], AnyType, parsing, null)
        : null;
      const fillPattern = !!style['fill-pattern-src'];

      compiledStyles.push({
        hasStroke,
        hasFill,
        hasCircle,
        hasShape,
        hasIcon,
        strokeWidth,
        strokeColor,
        circleRadius,
        circleStrokeWidth,
        circleFillColor,
        circleScale,
        shapeRadius,
        shapeStrokeWidth,
        shapeScale,
        iconSize,
        iconWidth,
        iconHeight,
        iconScale,
        fillColor,
        fillPattern,
      });
    }

    for (const name of parsing.properties) {
      propsUsed.add(name);
    }
    for (const name of parsing.variables) {
      varsUsed.add(name);
    }

    if (filter || compiledStyles.length) {
      compiledRules.push({
        elseRule: !!rule.else,
        filter,
        styles: compiledStyles,
      });
    }
  }

  const evalCtx = newEvaluationContext();
  evalCtx.variables = variables;
  const propsScratch = /** @type {Record<string, any>} */ ({});
  const propNames = Array.from(propsUsed);

  /**
   * @param {import("../../Feature.js").FeatureLike} feature Feature.
   * @param {import("../../geom/Geometry.js").default} geometry Geometry.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {HitDetectionStyleState} Style state.
   */
  const evaluate = (feature, geometry, frameState) => {
    for (let i = 0; i < propNames.length; i++) {
      const name = propNames[i];
      propsScratch[name] = feature.get?.(name);
    }
    evalCtx.properties = propsScratch;
    evalCtx.resolution = frameState.viewState.resolution;
    evalCtx.featureId = feature.getId?.() ?? null;
    evalCtx.geometryType = geometry.getType?.() || '';

    let pointRadiusPx = 0;
    let strokeHalfWidthPx = 0;
    let fillActive = false;

    let pointMatched = false;
    let strokeMatched = false;
    let fillMatched = false;

    for (const rule of compiledRules) {
      const filterOk = rule.filter ? !!rule.filter(evalCtx) : true;
      if (!filterOk) {
        continue;
      }

      let rulePointRadius = 0;
      let ruleStrokeHalfWidth = 0;
      let ruleFillActive = false;

      for (const style of rule.styles) {
        if (style.hasStroke) {
          const strokeColorValue = style.strokeColor
            ? unwrapLiteral(style.strokeColor(evalCtx))
            : null;
          const strokeDisabled = style.strokeColor
            ? isNone(strokeColorValue)
            : false;
          if (!strokeDisabled) {
            let width = 0;
            if (style.strokeWidth) {
              width = getFiniteNumber(style.strokeWidth(evalCtx));
            } else if (style.strokeColor) {
              width = 1.25;
            }
            ruleStrokeHalfWidth = Math.max(ruleStrokeHalfWidth, 0.5 * width);
          }
        }

        if (style.hasCircle) {
          const fillValue = style.circleFillColor
            ? unwrapLiteral(style.circleFillColor(evalCtx))
            : null;
          if (!style.circleFillColor || !isNone(fillValue)) {
            const radius = style.circleRadius
              ? getFiniteNumber(style.circleRadius(evalCtx))
              : 5;
            const stroke = style.circleStrokeWidth
              ? getFiniteNumber(style.circleStrokeWidth(evalCtx))
              : 0;
            const scale = style.circleScale
              ? getMaxScaleValue(style.circleScale(evalCtx))
              : 1;
            rulePointRadius = Math.max(
              rulePointRadius,
              (radius + 0.5 * stroke) * scale,
            );
          }
        }

        if (style.hasShape) {
          const radius = style.shapeRadius
            ? getFiniteNumber(style.shapeRadius(evalCtx))
            : 0;
          if (radius > 0) {
            const stroke = style.shapeStrokeWidth
              ? getFiniteNumber(style.shapeStrokeWidth(evalCtx))
              : 0;
            const scale = style.shapeScale
              ? getMaxScaleValue(style.shapeScale(evalCtx))
              : 1;
            rulePointRadius = Math.max(
              rulePointRadius,
              (radius + 0.5 * stroke) * scale,
            );
          }
        }

        if (style.hasIcon) {
          let half = 16;
          if (style.iconSize) {
            const size = /** @type {any} */ (style.iconSize(evalCtx));
            if (Array.isArray(size) && size.length >= 2) {
              half =
                0.5 *
                Math.max(getFiniteNumber(size[0]), getFiniteNumber(size[1]));
            }
          } else if (style.iconWidth && style.iconHeight) {
            half =
              0.5 *
              Math.max(
                getFiniteNumber(style.iconWidth(evalCtx)),
                getFiniteNumber(style.iconHeight(evalCtx)),
              );
          }
          const scale = style.iconScale
            ? getMaxScaleValue(style.iconScale(evalCtx))
            : 1;
          rulePointRadius = Math.max(rulePointRadius, half * scale);
        }

        if (style.hasFill) {
          if (style.fillPattern) {
            ruleFillActive = true;
          } else if (style.fillColor) {
            const fillColorValue = unwrapLiteral(style.fillColor(evalCtx));
            if (!isNone(fillColorValue)) {
              ruleFillActive = true;
            }
          } else {
            ruleFillActive = true;
          }
        }
      }

      if (rulePointRadius > 0) {
        if (!rule.elseRule || !pointMatched) {
          pointRadiusPx = Math.max(pointRadiusPx, rulePointRadius);
          pointMatched = true;
        }
      }

      if (ruleStrokeHalfWidth > 0) {
        if (!rule.elseRule || !strokeMatched) {
          strokeHalfWidthPx = Math.max(strokeHalfWidthPx, ruleStrokeHalfWidth);
          strokeMatched = true;
        }
      }

      if (ruleFillActive) {
        if (!rule.elseRule || !fillMatched) {
          fillActive = true;
          fillMatched = true;
        }
      }
    }

    return {pointRadiusPx, strokeHalfWidthPx, fillActive};
  };

  const padding = computeHitDetectionPadding(styles);
  const hasDynamicSizes = propsUsed.size > 0 || varsUsed.size > 0;
  const dynamicMaxPointRadiusPx = 128;
  const dynamicMaxStrokeHalfWidthPx = 64;
  return {
    evaluate,
    maxPointRadiusPx: hasDynamicSizes
      ? Math.max(padding.pointRadiusPx, dynamicMaxPointRadiusPx)
      : padding.pointRadiusPx,
    maxStrokeHalfWidthPx: hasDynamicSizes
      ? Math.max(padding.strokeHalfWidthPx, dynamicMaxStrokeHalfWidthPx)
      : padding.strokeHalfWidthPx,
  };
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
 * @param {HitDetectionStateEvaluator} [styleEvaluator] Style evaluator.
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
  styleEvaluator,
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

    const state = styleEvaluator
      ? styleEvaluator(feature, geometry, frameState)
      : /** @type {HitDetectionStyleState} */ ({
          pointRadiusPx,
          strokeHalfWidthPx,
          fillActive: true,
        });

    const type = geometry.getType?.() || '';
    const isPoint = type === 'Point' || type === 'MultiPoint';
    const isPolygon = type === 'Polygon' || type === 'MultiPolygon';
    if (isPoint) {
      if (!(state.pointRadiusPx > 0)) {
        return;
      }
    } else if (isPolygon) {
      if (!state.fillActive && !(state.strokeHalfWidthPx > 0)) {
        return;
      }
    } else if (!(state.strokeHalfWidthPx > 0)) {
      return;
    }

    const featurePointTolPx = hitTolerance + state.pointRadiusPx;
    const featureStrokeTolPx = hitTolerance + state.strokeHalfWidthPx;
    const featurePointTolSq = featurePointTolPx * featurePointTolPx;
    const featureStrokeTolSq = featureStrokeTolPx * featureStrokeTolPx;

    const allowFillHit = state.fillActive && isPolygon;
    const distSqMap =
      allowFillHit && geometry.containsXY?.(x, y)
        ? 0
        : geometry.closestPointXY(x, y, closestPoint, Infinity);
    if (!Number.isFinite(distSqMap)) {
      return;
    }
    const distSqPx = distSqMap * invResSq;
    const tolSq = isPoint ? featurePointTolSq : featureStrokeTolSq;
    if (distSqPx > tolSq) {
      return;
    }
    result = considerHit(feature, distSqPx);
    return result;
  });

  return result;
}
