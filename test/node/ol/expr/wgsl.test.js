import {
  NumberType,
  newParsingContext,
  parse,
} from '../../../../src/ol/expr/expression.js';
import {compileExpressionToWgsl} from '../../../../src/ol/expr/wgsl.js';
import expect from '../../expect.js';

describe('ol/expr/wgsl', () => {
  const ctx = {
    lineMetric: 'lineMetric',
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
});
