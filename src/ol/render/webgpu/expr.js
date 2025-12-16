/**
 * @module ol/render/webgpu/expr
 */
import {
  BooleanType,
  ColorType,
  NumberType,
  newParsingContext,
  parse,
} from '../../expr/expression.js';
import {
  colorToWgsl,
  compileExpressionToWgsl,
  numberToWgsl,
} from '../../expr/wgsl.js';

/**
 * @typedef {'f32'|'bool'|'vec4f'} WGSLType
 */

/**
 * @typedef {Object} CompileContext
 * @property {string} lineMetricVar WGSL variable name for line metric.
 * @property {(name: string, type: number) => string} getProp WGSL expression for a `get` property.
 * @property {(name: string, type: number) => string} [getVar] WGSL expression for a style variable.
 */

/**
 * @param {unknown} expr Encoded expression.
 * @param {Set<string>} out Output set.
 */
export function collectGetProperties(expr, out) {
  if (!expr) {
    return;
  }

  if (Array.isArray(expr)) {
    try {
      const parsingContext = newParsingContext();
      // We only care about collecting `get()` names; NumberType is permissive enough
      // for the current WebGPU use-cases (filter/width/color expressions).
      parse(expr, NumberType | BooleanType | ColorType, parsingContext);
      for (const name of parsingContext.properties) {
        out.add(name);
      }
      return;
    } catch {
      // fall back to a best-effort recursive walk
    }
  }

  if (Array.isArray(expr)) {
    if (expr[0] === 'get' && typeof expr[1] === 'string') {
      out.add(expr[1]);
      return;
    }
    for (const v of expr) {
      collectGetProperties(v, out);
    }
  }
}

/**
 * @param {unknown} expr Encoded expression.
 * @param {Set<string>} out Output set.
 */
export function collectVarNames(expr, out) {
  if (!expr) {
    return;
  }

  if (Array.isArray(expr)) {
    try {
      const parsingContext = newParsingContext();
      parse(expr, NumberType | BooleanType | ColorType, parsingContext);
      for (const name of parsingContext.variables) {
        out.add(name);
      }
      return;
    } catch {
      // fall back to a best-effort recursive walk
    }
  }

  if (Array.isArray(expr)) {
    if (expr[0] === 'var' && typeof expr[1] === 'string') {
      out.add(expr[1]);
      return;
    }
    for (const v of expr) {
      collectVarNames(v, out);
    }
  }
}

/**
 * @param {unknown} expr Encoded expression.
 * @param {CompileContext} ctx Compile context.
 * @param {WGSLType} expected Expected type.
 * @return {string} WGSL expression.
 */
export function compileWgslExpression(expr, ctx, expected) {
  if (expected === 'bool') {
    if (typeof expr === 'boolean') {
      return expr ? 'true' : 'false';
    }
  }
  if (expected === 'f32') {
    if (typeof expr === 'number') {
      return numberToWgsl(expr);
    }
    if (typeof expr === 'string') {
      const n = Number(expr);
      if (!Number.isFinite(n)) {
        return '0.0';
      }
      return numberToWgsl(n);
    }
  }
  if (expected === 'vec4f') {
    if (typeof expr === 'string') {
      return colorToWgsl(expr);
    }
  }
  if (Array.isArray(expr)) {
    const parsingContext = newParsingContext();
    const expectedType =
      expected === 'bool'
        ? BooleanType
        : expected === 'vec4f'
          ? ColorType
          : NumberType;
    const parsed = parse(expr, expectedType, parsingContext);
    return compileExpressionToWgsl(parsed, {
      lineMetric: ctx.lineMetricVar,
      resolution: 'uniforms.resolution',
      zoom: 'uniforms.zoom',
      time: '0.0',
      get: (name, type) => ctx.getProp(name, type),
      var: (name, type) => ctx.getVar?.(name, type) || '0.0',
    });
  }
  if (expected === 'bool') {
    return 'false';
  }
  if (expected === 'vec4f') {
    return 'vec4f(0.0, 0.0, 0.0, 0.0)';
  }
  return '0.0';
}
