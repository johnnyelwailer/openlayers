import {
  ColorType,
  NumberType,
  isType,
} from '../../../../../src/ol/expr/expression.js';
import {
  collectGetProperties,
  collectVarNames,
  compileWgslExpression,
} from '../../../../../src/ol/render/webgpu/expr.js';
import expect from '../../../expect.js';

describe('ol/render/webgpu/expr', () => {
  describe('collectGetProperties()', () => {
    it('collects get() property names', () => {
      const props = new Set();
      collectGetProperties(
        ['case', ['<', ['line-metric'], ['get', 'limit']], ['get', 'a'], 2],
        props,
      );
      expect(Array.from(props).sort()).to.eql(['a', 'limit']);
    });
  });

  describe('collectVarNames()', () => {
    it('collects var() names', () => {
      const vars = new Set();
      collectVarNames(
        ['case', ['<', ['var', 'threshold'], 3], ['var', 'a'], 2],
        vars,
      );
      expect(Array.from(vars).sort()).to.eql(['a', 'threshold']);
    });
  });

  describe('compileWgslExpression()', () => {
    const ctx = {
      lineMetricVar: 'lineMetric',
      getProp: (name, type) =>
        isType(type, ColorType)
          ? `getColor_${name}()`
          : isType(type, NumberType)
            ? `getNumber_${name}()`
            : `get_${name}()`,
      getVar: (name) => `var_${name}()`,
    };

    it('formats numeric constants as f32', () => {
      expect(compileWgslExpression(2, ctx, 'f32')).to.be('2.0');
      expect(compileWgslExpression(2.5, ctx, 'f32')).to.be('2.5');
      expect(compileWgslExpression('3', ctx, 'f32')).to.be('3.0');
    });

    it('compiles basic operators used by webgpu-line-metric', () => {
      expect(compileWgslExpression(['get', 'limit'], ctx, 'f32')).to.be(
        'getNumber_limit()',
      );
      expect(compileWgslExpression(['line-metric'], ctx, 'f32')).to.be(
        'lineMetric',
      );
      expect(
        compileWgslExpression(['>', ['line-metric'], 60], ctx, 'bool'),
      ).to.be('(lineMetric > 60.0)');

      expect(
        compileWgslExpression(
          ['case', ['>', ['line-metric'], 60], 2, 8],
          ctx,
          'f32',
        ),
      ).to.be('select(8.0, 2.0, (lineMetric > 60.0))');
    });

    it('compiles var()', () => {
      expect(compileWgslExpression(['var', 'limit'], ctx, 'f32')).to.be(
        'var_limit()',
      );
    });

    it('passes expected type to get()', () => {
      expect(compileWgslExpression(['get', 'c'], ctx, 'vec4f')).to.be(
        'getColor_c()',
      );
      expect(compileWgslExpression(['get', 'n'], ctx, 'f32')).to.be(
        'getNumber_n()',
      );
    });

    it('compiles boolean literals', () => {
      expect(compileWgslExpression(true, ctx, 'bool')).to.be('true');
      expect(compileWgslExpression(false, ctx, 'bool')).to.be('false');
    });

    it('compiles time() as a constant', () => {
      expect(compileWgslExpression(['time'], ctx, 'f32')).to.be('0.0');
    });

    it('compiles two-stop linear interpolate', () => {
      expect(
        compileWgslExpression(
          ['interpolate', ['linear'], ['line-metric'], 0, 2, 10, 4],
          ctx,
          'f32',
        ),
      ).to.be(
        'mix(2.0, 4.0, clamp((lineMetric - 0.0) / (10.0 - 0.0), 0.0, 1.0))',
      );
    });
  });
});
