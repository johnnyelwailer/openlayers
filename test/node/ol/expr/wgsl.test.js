import {
  BooleanType,
  ColorType,
  NumberType,
  newParsingContext,
  parse,
} from '../../../../src/ol/expr/expression.js';
import {compileExpressionToWgsl} from '../../../../src/ol/expr/wgsl.js';
import expect from '../../expect.js';

describe('ol/expr/wgsl', () => {
  const ctx = {
    lineMetric: 'lineMetric',
    resolution: 'uniforms.resolution',
    zoom: 'uniforms.zoom',
    time: 'uniforms.time',
    get: (name) => `get_${name}()`,
  };

  it('compiles linear interpolate', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['interpolate', ['linear'], ['line-metric'], 0, 2, 10, 4],
      NumberType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'mix(2.0, 4.0, clamp((lineMetric - 0.0) / (10.0 - 0.0), 0.0, 1.0))',
    );
  });

  it('compiles exponential interpolate', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['interpolate', ['exponential', 2], ['line-metric'], 0, 2, 10, 4],
      NumberType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'mix(2.0, 4.0, (pow(2.0, clamp((lineMetric - 0.0) / (10.0 - 0.0), 0.0, 1.0)) - 1.0) / (2.0 - 1.0))',
    );
  });

  it('compiles var()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['var', 'foo'], NumberType, parsingContext);
    const exprCtx = {
      ...ctx,
      var: (name) => `var_${name}`,
    };
    expect(compileExpressionToWgsl(expr, exprCtx)).to.be('var_foo');

    const boolCtx = {
      ...ctx,
      var: (name) => `var_${name}`,
    };
    const boolExpr = parse(['var', 'enabled'], BooleanType, parsingContext);
    expect(compileExpressionToWgsl(boolExpr, boolCtx)).to.be('var_enabled');
  });

  it('compiles color()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['color', 255, 0, 0, 0.5], ColorType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'vec4f(255.0 / 255.0, 0.0 / 255.0, 0.0 / 255.0, 0.5)',
    );
  });

  it('compiles arithmetic', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['*', ['+', 2, 1], 3], NumberType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be('((2.0 + 1.0) * 3.0)');
  });
});
