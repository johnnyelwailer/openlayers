/**
 * @module ol/expr/wgsl
 */
import {asArray} from '../color.js';
import {
  BooleanType,
  CallExpression,
  ColorType,
  LiteralExpression,
  NumberType,
  Ops,
  StringType,
  isType,
} from './expression.js';
import {UNDEFINED_PROP_VALUE, getStringNumberEquivalent} from './gpu.js';

/**
 * @typedef {'f32'|'bool'|'vec4f'} WGSLType
 */

/**
 * @typedef {Object} WgslCompileDiagnostics
 * @property {Array<{op: string, message: string}>} issues Issues found during compilation.
 */

/**
 * @typedef {Object} WgslCompileOptions
 * @property {boolean} [strict] Throw on unsupported operators/constructs.
 * @property {WgslCompileDiagnostics} [diagnostics] Optional diagnostics collector.
 */

/**
 * @typedef {Object} CompileWgslContext
 * @property {string} lineMetric WGSL expression for line metric.
 * @property {string} resolution WGSL expression for resolution.
 * @property {string} zoom WGSL expression for zoom.
 * @property {string} time WGSL expression for time.
 * @property {(name: string, type: number) => string} get WGSL expression for a `get` property.
 * @property {(name: string, type: number) => string} [var] WGSL expression for a style variable (`var`).
 * @property {(type: number) => string} [id] WGSL expression for the feature id (`id`).
 * @property {(type: number) => string} [geometryType] WGSL expression for the feature geometry type (`geometry-type`).
 */

/**
 * @param {string} op Operator.
 * @param {string} message Message.
 * @param {WgslCompileOptions|undefined} options Options.
 */
function reportUnsupported(op, message, options) {
  if (options?.diagnostics) {
    options.diagnostics.issues.push({op, message});
  }
  if (options?.strict) {
    throw new Error(message);
  }
}

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
 * @param {WgslCompileOptions} [options] Options.
 * @return {string} WGSL code.
 */
export function compileExpressionToWgsl(expression, ctx, options) {
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
    if (isType(expression.type, StringType)) {
      // Represent string values as stable numeric ids (WebGL parity).
      return numberToWgsl(
        getStringNumberEquivalent(/** @type {string} */ (expression.value)),
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

  if (op === Ops.Has) {
    const firstArg = /** @type {LiteralExpression} */ (call.args[0]);
    const propName = /** @type {string} */ (firstArg.value);
    return `(${ctx.get(propName, NumberType)} != ${numberToWgsl(
      UNDEFINED_PROP_VALUE,
    )})`;
  }

  if (op === Ops.Var) {
    const firstArg = /** @type {LiteralExpression} */ (call.args[0]);
    const varName = /** @type {string} */ (firstArg.value);
    if (!ctx.var) {
      reportUnsupported(
        op,
        'WGSL backend does not have access to style variables in this context',
        options,
      );
      return '0.0';
    }
    return ctx.var(varName, call.type);
  }

  if (op === Ops.Id) {
    if (!ctx.id) {
      reportUnsupported(
        op,
        'WGSL backend does not have access to feature ids in this context',
        options,
      );
      return '0.0';
    }
    return ctx.id(call.type);
  }

  if (op === Ops.GeometryType) {
    if (!ctx.geometryType) {
      reportUnsupported(
        op,
        'WGSL backend does not have access to geometry types in this context',
        options,
      );
      return '0.0';
    }
    return ctx.geometryType(call.type);
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

  if (op === Ops.Any || op === Ops.All) {
    const compiled = call.args.map((arg) =>
      compileExpressionToWgsl(arg, ctx, options),
    );
    if (compiled.length === 0) {
      return defaultForType(call.type);
    }
    return `(${compiled.join(op === Ops.Any ? ' || ' : ' && ')})`;
  }

  if (op === Ops.Not) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `(!${v})`;
  }

  if (
    op === Ops.Add ||
    op === Ops.Multiply ||
    op === Ops.Subtract ||
    op === Ops.Divide ||
    op === Ops.Pow
  ) {
    const compiled = call.args.map((arg) =>
      compileExpressionToWgsl(arg, ctx, options),
    );
    if (compiled.length === 0) {
      return defaultForType(call.type);
    }
    if (op === Ops.Subtract || op === Ops.Divide || op === Ops.Pow) {
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

  if (op === Ops.Mod) {
    const a = compileExpressionToWgsl(call.args[0], ctx, options);
    const b = compileExpressionToWgsl(call.args[1], ctx, options);
    // WGSL remainder operator (%) is integer-only; emulate GLSL `mod(a, b)` for floats:
    // mod(a, b) = a - b * floor(a / b)
    return `(${a} - (${b} * floor(${a} / ${b})))`;
  }

  if (op === Ops.Clamp) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    const min = compileExpressionToWgsl(call.args[1], ctx, options);
    const max = compileExpressionToWgsl(call.args[2], ctx, options);
    return `clamp(${v}, ${min}, ${max})`;
  }

  if (op === Ops.Abs) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `abs(${v})`;
  }

  if (op === Ops.Floor) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `floor(${v})`;
  }

  if (op === Ops.Ceil) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `ceil(${v})`;
  }

  if (op === Ops.Round) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    // Match the existing GLSL backend behavior (floor(x + 0.5)).
    return `floor(${v} + 0.5)`;
  }

  if (op === Ops.Sin) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `sin(${v})`;
  }

  if (op === Ops.Cos) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `cos(${v})`;
  }

  if (op === Ops.Atan) {
    const a = compileExpressionToWgsl(call.args[0], ctx, options);
    if (call.args.length > 1) {
      const b = compileExpressionToWgsl(call.args[1], ctx, options);
      return `atan2(${a}, ${b})`;
    }
    return `atan(${a})`;
  }

  if (op === Ops.Sqrt) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    return `sqrt(${v})`;
  }

  if (op === Ops.Color) {
    const args = call.args.map((arg) =>
      compileExpressionToWgsl(arg, ctx, options),
    );
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
    const a = compileExpressionToWgsl(call.args[0], ctx, options);
    const b = compileExpressionToWgsl(call.args[1], ctx, options);
    return `(${a} ${op} ${b})`;
  }

  if (op === Ops.Case) {
    const compiledArgs = call.args.map((arg) =>
      compileExpressionToWgsl(arg, ctx, options),
    );
    if (compiledArgs.length === 0) {
      return defaultForType(call.type);
    }
    let result = compiledArgs[compiledArgs.length - 1]; // fallback
    for (let i = compiledArgs.length - 3; i >= 0; i -= 2) {
      const cond = compiledArgs[i];
      const output = compiledArgs[i + 1];
      result = `select(${result}, ${output}, ${cond})`;
    }
    return result;
  }

  if (op === Ops.Interpolate) {
    const exponentExpr = /** @type {LiteralExpression} */ (call.args[0]);
    const exponent = /** @type {number} */ (exponentExpr.value);
    const exp = numberToWgsl(exponent);

    const input = compileExpressionToWgsl(call.args[1], ctx, options);
    const stopsAndOutputs = call.args
      .slice(2)
      .map((arg) => compileExpressionToWgsl(arg, ctx, options));

    // Match the existing GLSL backend: chain `mix()` between successive stops.
    let result = '';
    for (let i = 0; i < stopsAndOutputs.length - 3; i += 2) {
      const stop1 = stopsAndOutputs[i];
      const output1 = result || stopsAndOutputs[i + 1];
      const stop2 = stopsAndOutputs[i + 2];
      const output2 = stopsAndOutputs[i + 3];

      let ratio;
      if (exponent === 1) {
        ratio = `(${input} - ${stop1}) / (${stop2} - ${stop1})`;
      } else {
        ratio = `(pow(${exp}, (${input} - ${stop1})) - 1.0) / (pow(${exp}, (${stop2} - ${stop1})) - 1.0)`;
      }
      result = `mix(${output1}, ${output2}, clamp(${ratio}, 0.0, 1.0))`;
    }
    return result || defaultForType(call.type);
  }

  if (op === Ops.Coalesce) {
    // Coalesce returns the first value that is not null/undefined.
    // In WGSL we approximate "undefined" for feature properties by checking the scalar slot
    // against UNDEFINED_PROP_VALUE (works for scalar/bool/string/color, as long as the value
    // comes from `get()`).
    let result = compileExpressionToWgsl(
      call.args[call.args.length - 1],
      ctx,
      options,
    );

    for (let i = call.args.length - 2; i >= 0; i--) {
      const arg = call.args[i];
      if (arg instanceof CallExpression && arg.operator === Ops.Get) {
        const firstArg = /** @type {LiteralExpression} */ (arg.args[0]);
        const propName = /** @type {string} */ (firstArg.value);
        const defined = `(${ctx.get(propName, NumberType)} != ${numberToWgsl(
          UNDEFINED_PROP_VALUE,
        )})`;
        const value = compileExpressionToWgsl(arg, ctx, options);
        result = `select(${result}, ${value}, ${defined})`;
        continue;
      }
      // Everything else is assumed to be always defined.
      result = compileExpressionToWgsl(arg, ctx, options);
    }
    return result;
  }

  if (op === Ops.Match) {
    const inputExpr = call.args[0];
    const input = compileExpressionToWgsl(inputExpr, ctx, options);
    let result = compileExpressionToWgsl(
      call.args[call.args.length - 1],
      ctx,
      options,
    ); // fallback
    for (let i = call.args.length - 3; i >= 1; i -= 2) {
      const match = compileExpressionToWgsl(call.args[i], ctx, options);
      const output = compileExpressionToWgsl(call.args[i + 1], ctx, options);
      result = `select(${result}, ${output}, (${input} == ${match}))`;
    }
    return result;
  }

  if (op === Ops.Between) {
    const v = compileExpressionToWgsl(call.args[0], ctx, options);
    const min = compileExpressionToWgsl(call.args[1], ctx, options);
    const max = compileExpressionToWgsl(call.args[2], ctx, options);
    return `(${v} >= ${min} && ${v} <= ${max})`;
  }

  if (op === Ops.In) {
    const needle = call.args[0];
    // Support string `in` by representing strings as stable numeric ids (WebGL parity).
    if (!isType(needle.type, NumberType) && !isType(needle.type, StringType)) {
      reportUnsupported(
        op,
        'WGSL backend only supports numeric/string in()',
        options,
      );
      return 'false';
    }
    const compiledNeedle = compileExpressionToWgsl(needle, ctx, options);
    const tests = call.args
      .slice(1)
      .map(
        (arg) =>
          `(${compiledNeedle} == ${compileExpressionToWgsl(
            arg,
            ctx,
            options,
          )})`,
      );
    return tests.length ? `(${tests.join(' || ')})` : 'false';
  }

  if (op === Ops.Number || op === Ops.String) {
    const desiredType = op === Ops.Number ? NumberType : StringType;
    for (const arg of call.args) {
      if (isType(arg.type, desiredType)) {
        return compileExpressionToWgsl(arg, ctx, options);
      }
    }
    reportUnsupported(
      op,
      `WGSL backend cannot resolve ${op}() without a statically typed ${op} argument`,
      options,
    );
    return defaultForType(call.type);
  }

  if (op === Ops.Concat) {
    // String concatenation is not supported in WGSL at runtime; only fold literal concatenations.
    if (call.args.every((arg) => arg instanceof LiteralExpression)) {
      const value = call.args
        .map((arg) => /** @type {LiteralExpression} */ (arg).value)
        .map((v) => String(v))
        .join('');
      return numberToWgsl(getStringNumberEquivalent(value));
    }
    reportUnsupported(
      op,
      'WGSL backend only supports concat() with literal arguments',
      options,
    );
    return defaultForType(call.type);
  }

  if (op === Ops.ToString) {
    const arg = call.args[0];
    // Strings are represented as stable numeric ids (WebGL parity).
    if (isType(arg.type, StringType)) {
      return compileExpressionToWgsl(arg, ctx, options);
    }
    // Runtime string conversion is not supported in WGSL; only fold literal conversions.
    if (arg instanceof LiteralExpression) {
      return numberToWgsl(getStringNumberEquivalent(String(arg.value)));
    }
    reportUnsupported(
      op,
      'WGSL backend only supports to-string() for string-typed expressions or literal values',
      options,
    );
    return defaultForType(call.type);
  }

  if (op === Ops.Palette) {
    const index = compileExpressionToWgsl(call.args[0], ctx, options);
    const colors = call.args
      .slice(1)
      .map((arg) => compileExpressionToWgsl(arg, ctx, options));
    if (colors.length === 0) {
      reportUnsupported(op, 'palette() requires at least one color', options);
      return defaultForType(call.type);
    }
    if (colors.length === 1) {
      return colors[0];
    }
    const maxIndex = numberToWgsl(colors.length - 1);
    const clampedIndex = `clamp(floor(${index} + 0.5), 0.0, ${maxIndex})`;
    let result = colors[0];
    for (let i = 1; i < colors.length; i++) {
      result = `select(${result}, ${colors[i]}, (${clampedIndex} == ${numberToWgsl(
        i,
      )}))`;
    }
    return result;
  }

  reportUnsupported(op, `WGSL backend does not support ${op}()`, options);
  return defaultForType(call.type);
}
