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
      'mix(2.0, 4.0, clamp((pow(2.0, (lineMetric - 0.0)) - 1.0) / (pow(2.0, (10.0 - 0.0)) - 1.0), 0.0, 1.0))',
    );
  });

  it('compiles multi-stop interpolate', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['interpolate', ['linear'], ['line-metric'], 0, 2, 10, 4, 20, 6],
      NumberType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'mix(mix(2.0, 4.0, clamp((lineMetric - 0.0) / (10.0 - 0.0), 0.0, 1.0)), 6.0, clamp((lineMetric - 10.0) / (20.0 - 10.0), 0.0, 1.0))',
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

  it('compiles case() with multiple conditions', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['case', ['<', ['zoom'], 2], 10, ['<', ['zoom'], 4], 20, 30],
      NumberType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'select(select(30.0, 20.0, (uniforms.zoom < 4.0)), 10.0, (uniforms.zoom < 2.0))',
    );
  });

  it('compiles boolean ops', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['all', ['any', true, ['!', false]], ['==', 1, 1]],
      BooleanType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      '((true || (!false)) && (1.0 == 1.0))',
    );
  });

  it('compiles floor/ceil/round', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['round', ['+', ['floor', 1.2], ['ceil', 1.2]]],
      NumberType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'floor((floor(1.2) + ceil(1.2)) + 0.5)',
    );
  });

  it('compiles mod()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['%', 5, 2], NumberType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      '(5.0 - (2.0 * floor(5.0 / 2.0)))',
    );
  });

  it('compiles atan()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['atan', 1, 2], NumberType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be('atan2(1.0, 2.0)');
  });

  it('compiles match()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['match', ['get', 'foo'], 1, 10, 2, 20, 30],
      NumberType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      'select(select(30.0, 20.0, (get_foo() == 2.0)), 10.0, (get_foo() == 1.0))',
    );
  });

  it('compiles in()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['in', ['get', 'foo'], [1, 2, 3]],
      BooleanType,
      parsingContext,
    );
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      '((get_foo() == 1.0) || (get_foo() == 2.0) || (get_foo() == 3.0))',
    );
  });

  it('compiles between()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['between', 2, 1, 3], BooleanType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      '(2.0 >= 1.0 && 2.0 <= 3.0)',
    );
  });
});
