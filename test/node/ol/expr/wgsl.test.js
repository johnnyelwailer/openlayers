import {
  BooleanType,
  ColorType,
  NumberType,
  StringType,
  newParsingContext,
  parse,
} from '../../../../src/ol/expr/expression.js';
import {getStringNumberEquivalent} from '../../../../src/ol/expr/gpu.js';
import {
  compileExpressionToWgsl,
  numberToWgsl,
} from '../../../../src/ol/expr/wgsl.js';
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

  it('compiles has()', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['has', 'foo'], BooleanType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      '(get_foo() != -9999999.0)',
    );
  });

  it('compiles id() when provided by the context', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['id'], NumberType | StringType, parsingContext);
    expect(
      compileExpressionToWgsl(expr, {
        ...ctx,
        id: () => 'feature_id()',
      }),
    ).to.be('feature_id()');
  });

  it('compiles geometry-type() when provided by the context', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['geometry-type'], StringType, parsingContext);
    expect(
      compileExpressionToWgsl(expr, {
        ...ctx,
        geometryType: () => 'geom_type()',
      }),
    ).to.be('geom_type()');
  });

  it('compiles coalesce() with get() using the undefined sentinel', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['coalesce', ['get', 'x'], 7],
      NumberType,
      parsingContext,
    );
    const compiled = compileExpressionToWgsl(expr, {
      ...ctx,
      get: (name, type) =>
        type === NumberType ? `get_${name}_scalar()` : `get_${name}_color()`,
    });
    expect(compiled).to.contain('(get_x_scalar() != -9999999.0)');
    expect(compiled).to.contain('select(');
  });

  it('compiles coalesce(color) with get() using the undefined sentinel', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['coalesce', ['get', 'c'], 'rgb(255,0,0)'],
      ColorType,
      parsingContext,
    );
    const compiled = compileExpressionToWgsl(expr, {
      ...ctx,
      get: (name, type) =>
        type === NumberType ? `get_${name}_scalar()` : `get_${name}_color()`,
    });
    expect(compiled).to.contain('(get_c_scalar() != -9999999.0)');
    expect(compiled).to.contain('select(');
  });

  it('compiles match() with string input', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['match', ['get', 's'], 'a', 1, 'b', 2, 0],
      NumberType,
      parsingContext,
    );
    const compiled = compileExpressionToWgsl(expr, ctx);
    expect(compiled).to.contain(
      `(get_s() == ${numberToWgsl(getStringNumberEquivalent('a'))})`,
    );
    expect(compiled).to.contain(
      `(get_s() == ${numberToWgsl(getStringNumberEquivalent('b'))})`,
    );
  });

  it('compiles in() with string needle', () => {
    const parsingContext = newParsingContext();
    const expr = parse(
      ['in', ['get', 's'], ['literal', ['a', 'b']]],
      BooleanType,
      parsingContext,
    );
    const compiled = compileExpressionToWgsl(expr, ctx);
    expect(compiled).to.contain(
      `${numberToWgsl(getStringNumberEquivalent('a'))}`,
    );
    expect(compiled).to.contain(
      `${numberToWgsl(getStringNumberEquivalent('b'))}`,
    );
  });

  it('compiles number() and string() assertions', () => {
    const parsingContext = newParsingContext();
    const numberExpr = parse(['number', 1, '1'], NumberType, parsingContext);
    expect(compileExpressionToWgsl(numberExpr, ctx)).to.be('1.0');

    const stringExpr = parse(['string', 1, 'a'], StringType, parsingContext);
    expect(compileExpressionToWgsl(stringExpr, ctx)).to.be(
      numberToWgsl(getStringNumberEquivalent('a')),
    );
  });

  it('compiles concat() with literals', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['concat', 'a', 'b'], StringType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      numberToWgsl(getStringNumberEquivalent('ab')),
    );
  });

  it('compiles to-string() for literals', () => {
    const parsingContext = newParsingContext();
    const expr = parse(['to-string', 1], StringType, parsingContext);
    expect(compileExpressionToWgsl(expr, ctx)).to.be(
      numberToWgsl(getStringNumberEquivalent('1')),
    );
  });
});
