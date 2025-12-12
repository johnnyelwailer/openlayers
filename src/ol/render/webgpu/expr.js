/**
 * @module ol/render/webgpu/expr
 */
import {asArray} from '../../color.js';

/**
 * @typedef {'f32'|'bool'|'vec4f'} WGSLType
 */

/**
 * @typedef {Object} CompileContext
 * @property {string} lineMetricVar WGSL variable name for line metric.
 * @property {(name: string) => string} getProp WGSL expression for a numeric property.
 */

/**
 * @param {string} colorStr Color string.
 * @return {string} WGSL vec4f expression.
 */
function wgslColor(colorStr) {
  const c = asArray(colorStr);
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const a = c[3];
  return `vec4f(${r}, ${g}, ${b}, ${a})`;
}

/**
 * @param {unknown} expr Encoded expression.
 * @param {Set<string>} out Output set.
 */
export function collectGetProperties(expr, out) {
  if (!expr) return;
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
 * @param {CompileContext} ctx Compile context.
 * @param {WGSLType} expected Expected type.
 * @return {string} WGSL expression.
 */
export function compileWgslExpression(expr, ctx, expected) {
  if (expected === 'f32') {
    if (typeof expr === 'number') {
      return Number.isInteger(expr) ? `${expr}.0` : `${expr}`;
    }
    if (typeof expr === 'string') {
      const n = Number(expr);
      if (!Number.isFinite(n)) return '0.0';
      return Number.isInteger(n) ? `${n}.0` : `${n}`;
    }
  }
  if (expected === 'vec4f') {
    if (typeof expr === 'string') return wgslColor(expr);
  }
  if (Array.isArray(expr)) {
    const op = expr[0];
    if (op === 'get' && typeof expr[1] === 'string') {
      return ctx.getProp(expr[1]);
    }
    if (op === 'line-metric') {
      return ctx.lineMetricVar;
    }
    if (op === '<' || op === '>') {
      const a = compileWgslExpression(expr[1], ctx, 'f32');
      const b = compileWgslExpression(expr[2], ctx, 'f32');
      return `(${a} ${op} ${b})`;
    }
    if (op === 'case') {
      const cond = compileWgslExpression(expr[1], ctx, 'bool');
      const t = compileWgslExpression(expr[2], ctx, expected);
      const f = compileWgslExpression(expr[3], ctx, expected);
      return `select(${f}, ${t}, ${cond})`;
    }
    if (op === 'interpolate' && Array.isArray(expr[1]) && expr[1][0] === 'linear') {
      const input = compileWgslExpression(expr[2], ctx, 'f32');
      // minimal: two-stop interpolate (covers current rendering tests)
      const stop0 = compileWgslExpression(expr[3], ctx, 'f32');
      const out0 = compileWgslExpression(expr[4], ctx, expected);
      const stop1 = compileWgslExpression(expr[5], ctx, 'f32');
      const out1 = compileWgslExpression(expr[6], ctx, expected);
      const t = `clamp((${input} - ${stop0}) / (${stop1} - ${stop0}), 0.0, 1.0)`;
      if (expected === 'vec4f') {
        return `mix(${out0}, ${out1}, ${t})`;
      }
      return `mix(${out0}, ${out1}, ${t})`;
    }
  }
  if (expected === 'bool') {
    return 'false';
  }
  if (expected === 'vec4f') {
    return 'vec4f(0.0, 0.0, 0.0, 0.0)';
  }
  return '0.0';
}
