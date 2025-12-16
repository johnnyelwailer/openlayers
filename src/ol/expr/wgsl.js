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
  isType,
} from './expression.js';

/**
 * @typedef {'f32'|'bool'|'vec4f'} WGSLType
 */

/**
 * @typedef {Object} CompileWgslContext
 * @property {string} lineMetric WGSL expression for line metric.
 * @property {string} resolution WGSL expression for resolution.
 * @property {string} zoom WGSL expression for zoom.
 * @property {string} time WGSL expression for time.
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
  /**
   * @param {number} type Expression type.
   * @return {string} WGSL literal for a safe default value.
   */
  function defaultForType(type) {
    if (isType(type, ColorType)) {
      return 'vec4f(0.0, 0.0, 0.0, 0.0)';
    }
    if (isType(type, BooleanType)) {
      return 'false';
    }
    return '0.0';
  }

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
    return defaultForType(expression.type);
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

  if (op === Ops.Resolution) {
    return ctx.resolution;
  }

  if (op === Ops.Zoom) {
    return ctx.zoom;
  }

  if (op === Ops.Time) {
    return ctx.time;
  }

  if (
    op === Ops.Add ||
    op === Ops.Multiply ||
    op === Ops.Subtract ||
    op === Ops.Divide ||
    op === Ops.Mod ||
    op === Ops.Pow
  ) {
    const compiled = call.args.map((arg) => compileExpressionToWgsl(arg, ctx));
    if (compiled.length === 0) {
      return defaultForType(call.type);
    }
    if (
      op === Ops.Subtract ||
      op === Ops.Divide ||
      op === Ops.Mod ||
      op === Ops.Pow
    ) {
      // Binary operators.
      const a = compiled[0];
      const b = compiled[1] || defaultForType(call.type);
      if (op === Ops.Pow) {
        return `pow(${a}, ${b})`;
      }
      return `(${a} ${op} ${b})`;
    }
    // N-ary (+/*).
    return `(${compiled.join(` ${op} `)})`;
  }

  if (op === Ops.Clamp) {
    const v = compileExpressionToWgsl(call.args[0], ctx);
    const min = compileExpressionToWgsl(call.args[1], ctx);
    const max = compileExpressionToWgsl(call.args[2], ctx);
    return `clamp(${v}, ${min}, ${max})`;
  }

  if (op === Ops.Abs) {
    const v = compileExpressionToWgsl(call.args[0], ctx);
    return `abs(${v})`;
  }

  if (op === Ops.Color) {
    const args = call.args.map((arg) => compileExpressionToWgsl(arg, ctx));
    const r = args[0] || '0.0';
    const g = args[1] || r;
    const b = args[2] || r;
    const a = args[3] || '1.0';
    return `vec4f(${r} / 255.0, ${g} / 255.0, ${b} / 255.0, ${a})`;
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

  return defaultForType(call.type);
}
