/**
 * @module ol/expr/wgsl
 */
import {asArray} from '../color.js';
import {
  BooleanType,
  ColorType,
  LiteralExpression,
  NumberType,
  Ops,
  StringType,
  isType,
} from './expression.js';

/**
 * @typedef {'f32'|'bool'|'vec4f'} WGSLType
 */

/**
 * @typedef {Object} CompileWgslContext
 * @property {string} lineMetric WGSL expression for line metric.
 * @property {(name: string, type: number) => string} get WGSL expression for a `get` property.
 * @property {(name: string, type: number) => string} [var] WGSL expression for a style variable (`var`).
 */

/**
 * @param {number} v Number.
 * @return {string} WGSL f32 literal.
 */
export function numberToWgsl(v) {
  const s = v.toString();
  return s.includes('.') ? s : s + '.0';
}

/**
 * @param {string|import("../color.js").Color} color Color.
 * @return {string} WGSL vec4f literal.
 */
export function colorToWgsl(color) {
  const array = asArray(color);
  const alpha = array.length > 3 ? array[3] : 1;
  return `vec4f(${numberToWgsl(array[0] / 255)}, ${numberToWgsl(
    array[1] / 255,
  )}, ${numberToWgsl(array[2] / 255)}, ${numberToWgsl(alpha)})`;
}

/**
 * @param {import('./expression.js').Expression} expression Parsed expression.
 * @param {CompileWgslContext} ctx Compilation context.
 * @return {string} WGSL code.
 */
export function compileExpressionToWgsl(expression, ctx) {
  if (expression instanceof LiteralExpression) {
    if (isType(expression.type, NumberType)) {
      return numberToWgsl(/** @type {number} */ (expression.value));
    }
    if (isType(expression.type, BooleanType)) {
      return /** @type {boolean} */ (expression.value) ? 'true' : 'false';
    }
    if (isType(expression.type, ColorType)) {
      return colorToWgsl(
        /** @type {import("../color.js").Color} */ (expression.value),
      );
    }
    if (isType(expression.type, StringType)) {
      return '0.0';
    }
    return '0.0';
  }

  const call = /** @type {CallExpression} */ (expression);
  const op = call.operator;

  if (op === Ops.Get) {
    const firstArg = /** @type {LiteralExpression} */ (call.args[0]);
    const propName = /** @type {string} */ (firstArg.value);
    return ctx.get(propName, call.type);
  }

  if (op === Ops.Var) {
    const firstArg = /** @type {LiteralExpression} */ (call.args[0]);
    const varName = /** @type {string} */ (firstArg.value);
    if (!ctx.var) {
      return '0.0';
    }
    return ctx.var(varName, call.type);
  }

  if (op === Ops.LineMetric) {
    return ctx.lineMetric;
  }

  if (
    op === Ops.LessThan ||
    op === Ops.GreaterThan ||
    op === Ops.LessThanOrEqualTo ||
    op === Ops.GreaterThanOrEqualTo ||
    op === Ops.Equal ||
    op === Ops.NotEqual
  ) {
    const a = compileExpressionToWgsl(call.args[0], ctx);
    const b = compileExpressionToWgsl(call.args[1], ctx);
    return `(${a} ${op} ${b})`;
  }

  if (op === Ops.Case) {
    const cond = compileExpressionToWgsl(call.args[0], ctx);
    const t = compileExpressionToWgsl(call.args[1], ctx);
    const f = compileExpressionToWgsl(call.args[2], ctx);
    return `select(${f}, ${t}, ${cond})`;
  }

  if (op === Ops.Interpolate) {
    // minimal: two-stop interpolate (covers current WebGPU tests)
    const baseExpr = /** @type {LiteralExpression} */ (call.args[0]);
    const base = /** @type {number} */ (baseExpr.value);

    const input = compileExpressionToWgsl(call.args[1], ctx);
    const stop0 = compileExpressionToWgsl(call.args[2], ctx);
    const out0 = compileExpressionToWgsl(call.args[3], ctx);
    const stop1 = compileExpressionToWgsl(call.args[4], ctx);
    const out1 = compileExpressionToWgsl(call.args[5], ctx);

    let t = `clamp((${input} - ${stop0}) / (${stop1} - ${stop0}), 0.0, 1.0)`;
    if (base !== 1) {
      const b = numberToWgsl(base);
      t = `(pow(${b}, ${t}) - 1.0) / (${b} - 1.0)`;
    }
    return `mix(${out0}, ${out1}, ${t})`;
  }

  return '0.0';
}
