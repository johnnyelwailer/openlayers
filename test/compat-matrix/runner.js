import {buildExpression as buildCpuExpression} from '../../src/ol/expr/cpu.js';
import {
  BooleanType,
  ColorType,
  NumberType,
  StringType,
  newParsingContext,
  parse,
} from '../../src/ol/expr/expression.js';
import {buildExpression, newCompilationContext} from '../../src/ol/expr/gpu.js';
import {compileExpressionToWgsl} from '../../src/ol/expr/wgsl.js';

const ol = globalThis.ol;

const RENDERERS = /** @type {const} */ (['canvas', 'webgl', 'webgpu']);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
  <rect width="32" height="32" fill="white"/>
  <path d="M16 3 L29 29 L3 29 Z" fill="black"/>
</svg>`;
const PATTERN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
  <rect width="16" height="16" fill="white"/>
  <path d="M0 0 L16 16 M16 0 L0 16" stroke="black" stroke-width="2"/>
</svg>`;

function svgDataUri(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const iconSrc = svgDataUri(ICON_SVG);
const patternSrc = svgDataUri(PATTERN_SVG);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {string} type Raw type string from JSDoc.
 * @param {string} token Token.
 * @return {boolean} Whether token appears in the union type.
 */
function typeHas(type, token) {
  return type.split('|').some((t) => t.trim() === token);
}

/**
 * @param {string} name Property name.
 * @return {'fill'|'stroke'|'circle'|'icon'|'shape'|'text'|'generic'} Symbolizer group.
 */
function groupForProperty(name) {
  if (name.startsWith('fill-')) {
    return 'fill';
  }
  if (name.startsWith('stroke-')) {
    return 'stroke';
  }
  if (name.startsWith('circle-')) {
    return 'circle';
  }
  if (name.startsWith('icon-')) {
    return 'icon';
  }
  if (name.startsWith('shape-')) {
    return 'shape';
  }
  if (name.startsWith('text-')) {
    return 'text';
  }
  return 'generic';
}

/**
 * @param {string} group Symbolizer group.
 * @return {import('../../src/ol/style/flat.js').FlatStyle} Base style.
 */
function baseStyleForGroup(group) {
  switch (group) {
    case 'fill':
      return {
        'fill-color': [255, 0, 0, 0.6],
      };
    case 'stroke':
      return {
        'stroke-color': [0, 0, 255, 1],
        'stroke-width': 8,
        'stroke-line-cap': 'round',
        'stroke-line-join': 'round',
      };
    case 'circle':
      return {
        'circle-radius': 10,
        'circle-fill-color': [0, 255, 0, 0.6],
        'circle-stroke-color': [0, 0, 0, 1],
        'circle-stroke-width': 2,
      };
    case 'icon':
      return {
        'icon-src': iconSrc,
      };
    case 'shape':
      return {
        'shape-points': 4,
        'shape-radius': 12,
        'shape-fill-color': [0, 0, 255, 0.6],
        'shape-stroke-color': [0, 0, 0, 1],
        'shape-stroke-width': 2,
      };
    case 'text':
      return {
        'text-value': 'Text',
        'text-fill-color': [0, 0, 0, 1],
        'text-font': '14px sans-serif',
      };
    default:
      return {
        'circle-radius': 10,
        'circle-fill-color': [0, 255, 0, 0.6],
        'circle-stroke-color': [0, 0, 0, 1],
        'circle-stroke-width': 2,
      };
  }
}

/**
 * @param {string} name Property name.
 * @param {string} type Type string from JSDoc.
 * @return {*} A safe literal value for the property.
 */
function literalValueForProperty(name, type) {
  // Asset-backed properties
  if (name === 'icon-src') {
    return iconSrc;
  }
  if (name.endsWith('-pattern-src')) {
    return patternSrc;
  }

  // Frequently constrained numeric properties
  if (name.endsWith('-opacity')) {
    return 0.6;
  }
  if (name.endsWith('-rotation') || name.endsWith('-angle')) {
    return 0.5;
  }
  if (name.endsWith('-line-dash-offset')) {
    return 5;
  }
  if (name === 'text-max-angle') {
    return Math.PI / 4;
  }
  if (name === 'shape-points') {
    return 5;
  }

  // Common string enums / imported types
  if (name.endsWith('-origin')) {
    return 'top-left';
  }
  if (name.endsWith('-units')) {
    return 'fraction';
  }
  if (name.endsWith('-line-cap')) {
    return 'round';
  }
  if (name.endsWith('-line-join')) {
    return 'round';
  }
  if (name.endsWith('-placement')) {
    return 'point';
  }
  if (name.endsWith('-align')) {
    return 'center';
  }
  if (name.endsWith('-justify')) {
    return 'center';
  }
  if (name.endsWith('-baseline')) {
    return 'middle';
  }
  if (name.endsWith('-declutter-mode')) {
    return 'none';
  }
  if (name === 'text-font') {
    return '14px sans-serif';
  }
  if (name === 'text-value') {
    return 'Text';
  }
  if (name === 'icon-cross-origin') {
    return 'anonymous';
  }

  if (typeHas(type, 'ColorExpression')) {
    return [255, 0, 0, 0.8];
  }
  if (typeHas(type, 'BooleanExpression')) {
    return true;
  }
  if (typeHas(type, 'NumberArrayExpression')) {
    if (name === 'text-padding') {
      return [2, 4, 6, 8];
    }
    if (name.endsWith('line-dash')) {
      return [10, 10];
    }
    if (name.endsWith('anchor')) {
      return [0.5, 0.5];
    }
    if (name.endsWith('displacement')) {
      return [10, -10];
    }
    return [4, 8];
  }
  if (typeHas(type, 'SizeExpression')) {
    if (name.endsWith('-scale')) {
      return [1.5, 1.5];
    }
    if (name.endsWith('displacement')) {
      return [10, -10];
    }
    if (name.endsWith('offset')) {
      return [0, 0];
    }
    if (name.endsWith('size')) {
      return [16, 16];
    }
    return [12, 18];
  }
  if (typeHas(type, 'NumberExpression')) {
    return 6;
  }
  if (typeHas(type, 'StringExpression')) {
    return 'value';
  }

  // Unknown imported types: best effort.
  return 1;
}

/**
 * @param {'fill'|'stroke'|'circle'|'icon'|'shape'|'text'|'generic'} group Symbolizer group.
 * @return {'point'|'line'|'polygon'} Geometry kind to render.
 */
function geometryForGroup(group) {
  if (group === 'fill') {
    return 'polygon';
  }
  if (group === 'stroke') {
    return 'line';
  }
  if (group === 'text') {
    return 'point';
  }
  return 'point';
}

/**
 * @return {{points: Array<any>, line: any, polygon: any}} Features for point/line/polygon cases.
 */
function createFeatures() {
  const {Feature} = ol;
  const {Point, LineString, Polygon} = ol.geom;

  /** @type {Array<any>} */
  const points = [];
  const size = 8;
  const spacing = 4e5;
  const origin = (-spacing * (size - 1)) / 2;
  let i = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const point = new Feature(
        new Point([origin + x * spacing, origin + y * spacing]),
      );
      point.set('idx', i);
      points.push(point);
      i++;
    }
  }
  const line = new Feature(
    new LineString([
      [-1e6, -2e5],
      [1e6, 2e5],
    ]),
  );
  const polygon = new Feature(
    new Polygon([
      [
        [-1e6, -8e5],
        [1e6, -8e5],
        [1e6, 8e5],
        [-1e6, 8e5],
        [-1e6, -8e5],
      ],
    ]),
  );

  return {points, line, polygon};
}

/**
 * @param {HTMLElement} target Element target.
 * @param {'canvas'|'webgl'|'webgpu'} renderer Renderer.
 * @return {{map: any, layer: any, features: {point: any, line: any, polygon: any}}} Map context.
 */
function createMap(target, renderer) {
  const {Map, View} = ol;
  const {
    Vector: VectorLayer,
    WebGLVector: WebGLVectorLayer,
    WebGPUVector: WebGPUVectorLayer,
  } = ol.layer;
  const {Vector: VectorSource} = ol.source;

  const {points, line, polygon} = createFeatures();
  const source = new VectorSource({
    features: [...points, line, polygon],
  });

  let layer;
  if (renderer === 'canvas') {
    layer = new VectorLayer({source});
  } else if (renderer === 'webgl') {
    layer = new WebGLVectorLayer({source, style: {'circle-radius': 1}});
  } else {
    layer = new WebGPUVectorLayer({source, style: {'circle-radius': 1}});
  }

  const map = new Map({
    target,
    layers: [layer],
    controls: [],
    interactions: [],
    view: new View({
      center: [0, 0],
      zoom: 2,
    }),
  });

  return {map, layer, features: {points, line, polygon}};
}

/** @type {import('../../src/ol/style/flat.js').FlatStyle} */
const SAFE_STYLE = {
  'circle-radius': 4,
  'circle-fill-color': [0, 0, 0, 1],
};

/**
 * @param {number} frames Number of animation frames to wait.
 * @return {Promise<void>} Resolves after frames have elapsed.
 */
function waitForAnimationFrames(frames) {
  return new Promise((resolve) => {
    let remaining = frames;
    const step = () => {
      remaining--;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * @param {Array<{name: string, type: string}>} properties Flat style properties.
 * @return {Array<any>} Scenario list.
 */
function generateScenarios(properties) {
  /** @type {Array<any>} */
  const scenarios = [];

  /**
   * @param {number} from Start (inclusive).
   * @param {number} to End (inclusive).
   * @return {Array<number>} Range.
   */
  function range(from, to) {
    const list = [];
    for (let i = from; i <= to; i++) {
      list.push(i);
    }
    return list;
  }

  /**
   * @param {Array<string>} varNames Variable names.
   * @return {Array|number} Expression that sums variable values.
   */
  function sumVarsExpression(varNames) {
    if (varNames.length === 0) {
      return 0;
    }
    let expr = /** @type {any} */ (['var', varNames[0]]);
    for (let i = 1; i < varNames.length; i++) {
      expr = ['+', expr, ['var', varNames[i]]];
    }
    return expr;
  }

  /**
   * @param {Array<string>} keys Feature property keys.
   * @return {Array|number} Expression that sums feature property values.
   */
  function sumGetsExpression(keys) {
    if (keys.length === 0) {
      return 0;
    }
    let expr = /** @type {any} */ (['get', keys[0]]);
    for (let i = 1; i < keys.length; i++) {
      expr = ['+', expr, ['get', keys[i]]];
    }
    return expr;
  }

  for (const prop of properties) {
    const group = groupForProperty(prop.name);
    const base = baseStyleForGroup(group);
    const type = prop.type;
    const literal = literalValueForProperty(prop.name, type);
    const safeKey = prop.name.replaceAll('-', '_');
    const getKey = `get_${safeKey}`;
    const varKey = `var_${safeKey}`;

    const variants = [
      {name: 'literal', expr: literal, needsGet: false, needsVar: false},
      {name: 'get', expr: ['get', getKey], needsGet: true, needsVar: false},
      {name: 'var', expr: ['var', varKey], needsGet: false, needsVar: true},
    ];

    if (typeHas(type, 'NumberExpression')) {
      variants.push({
        name: 'arith',
        expr: ['*', ['get', getKey], 1.5],
        needsGet: true,
        needsVar: false,
      });
    }

    for (const v of variants) {
      const style = {...base, [prop.name]: v.expr};
      // Ensure pattern properties have required companions in the base style.
      if (prop.name === 'fill-pattern-src' && !('fill-color' in style)) {
        style['fill-color'] = [255, 0, 0, 0.6];
      }
      if (prop.name === 'stroke-pattern-src' && !('stroke-width' in style)) {
        style['stroke-color'] = [0, 0, 255, 1];
        style['stroke-width'] = 8;
      }
      // Pattern sub-rect / companion properties are no-ops without a pattern source.
      // Ensure these scenarios actually exercise the pattern pipeline.
      if (
        prop.name.startsWith('fill-pattern-') &&
        !('fill-pattern-src' in style)
      ) {
        style['fill-pattern-src'] = patternSrc;
        if (!('fill-color' in style)) {
          style['fill-color'] = [255, 0, 0, 0.6];
        }
      }
      if (
        prop.name.startsWith('stroke-pattern-') &&
        !('stroke-pattern-src' in style)
      ) {
        style['stroke-pattern-src'] = patternSrc;
        if (!('stroke-width' in style)) {
          style['stroke-color'] = [0, 0, 255, 1];
          style['stroke-width'] = 8;
        }
      }

      scenarios.push({
        id: `${prop.name}/${v.name}`,
        prop: prop.name,
        group,
        geometry: geometryForGroup(group),
        type,
        style,
        literal,
        getKey,
        varKey,
        needsGet: v.needsGet,
        needsVar: v.needsVar,
      });
    }
  }

  // Capability probes (not tied to a single flat style property)
  // Max number of style variables referenced in expressions.
  const maxVarsSteps = [...range(1, 16), 32, 64, 100];
  for (const count of maxVarsSteps) {
    const varNames = new Array(count).fill(0).map((_, i) => `v${i}`);
    /** @type {Record<string, number>} */
    const variables = {};
    for (const name of varNames) {
      variables[name] = 0.1;
    }
    const radiusExpr = ['+', 20, sumVarsExpression(varNames)];
    scenarios.push({
      id: `capabilities/max-style-vars/${count}`,
      group: 'capability',
      geometry: 'point',
      capabilityKind: 'max-style-vars',
      capabilityCount: count,
      capabilityVarsUsed: count,
      capabilityGetsUsed: 0,
      style: {
        ...baseStyleForGroup('circle'),
        'circle-radius': radiusExpr,
      },
      needsGet: false,
      needsVar: true,
      variables,
    });
  }

  // Max number of feature properties used in expressions (via ['get', ...]).
  const maxFeaturePropsSteps = [...range(1, 16), 32, 64];
  for (const count of maxFeaturePropsSteps) {
    const keys = new Array(count).fill(0).map((_, i) => `p${i}`);
    const radiusExpr = ['+', 20, sumGetsExpression(keys)];
    scenarios.push({
      id: `capabilities/max-feature-props/${count}`,
      group: 'capability',
      geometry: 'point',
      capabilityKind: 'max-feature-props',
      capabilityCount: count,
      capabilityVarsUsed: 0,
      capabilityGetsUsed: count,
      style: {
        ...baseStyleForGroup('circle'),
        'circle-radius': radiusExpr,
      },
      needsGet: true,
      needsVar: false,
      featureProps: keys,
    });
  }

  // Max number of feature properties referenced behind branching.
  // This is primarily about expression operator support and still stresses the distinct ['get', ...] count.
  const maxFeaturePropsCaseSteps = [...range(1, 16), 32, 64];
  for (const count of maxFeaturePropsCaseSteps) {
    const keys = new Array(count).fill(0).map((_, i) => `pc${i}`);
    /** @type {Array<any>} */
    const branches = [];
    for (let i = 0; i < keys.length; i++) {
      branches.push(['==', ['get', 'idx'], i], ['get', keys[i]]);
    }
    const radiusExpr = ['+', 20, ['case', ...branches, 0]];
    scenarios.push({
      id: `capabilities/max-feature-props-case/${count}`,
      group: 'capability',
      geometry: 'point',
      capabilityKind: 'max-feature-props-case',
      capabilityCount: count,
      capabilityVarsUsed: 0,
      capabilityGetsUsed: count + 1,
      style: {
        ...baseStyleForGroup('circle'),
        'circle-radius': radiusExpr,
      },
      needsGet: true,
      needsVar: false,
      featureProps: keys,
    });
  }

  // Max number of feature properties used across rule filters.
  // This is relevant for WebGL because each distinct ['get', ...] generally becomes a vertex attribute.
  const maxRuleFiltersSteps = [...range(1, 16), 32, 64];
  for (const count of maxRuleFiltersSteps) {
    const keys = new Array(count).fill(0).map((_, i) => `pf${i}`);
    const rules = keys.map((key, i) => ({
      filter: ['==', ['get', 'idx'], i],
      style: {
        ...baseStyleForGroup('circle'),
        'circle-radius': ['+', 20, ['get', key]],
      },
    }));
    scenarios.push({
      id: `capabilities/max-rule-filters/${count}`,
      group: 'capability',
      geometry: 'point',
      capabilityKind: 'max-rule-filters',
      capabilityCount: count,
      capabilityVarsUsed: 0,
      capabilityGetsUsed: count + 1,
      style: rules,
      needsGet: true,
      needsVar: false,
      featureProps: keys,
    });
  }

  // Operator probes (focused coverage for expression compiler support).
  // These are intentionally small in number to avoid exploding the baseline.
  // For WebGPU, these are primarily aimed at the WGSL expression backend used
  // by the line (stroke) pipeline.
  const operatorBaseStyle = baseStyleForGroup('stroke');
  const limitKey = 'limit';

  /**
   * @param {string} suffix Scenario suffix.
   * @param {any} styleOrRules Style or rules.
   * @param {number} limitValue Value assigned to `limit`.
   */
  function pushOperatorScenario(suffix, styleOrRules, limitValue) {
    scenarios.push({
      id: `capabilities/operators/${suffix}`,
      group: 'capability',
      geometry: 'line',
      capabilityKind: 'operators',
      capabilityCount: 1,
      capabilityVarsUsed: 0,
      capabilityGetsUsed: 1,
      style: styleOrRules,
      needsGet: true,
      needsVar: false,
      getKey: limitKey,
      literal: limitValue,
      varKey: null,
    });
  }

  /**
   * @param {string} suffix Scenario suffix.
   * @param {any} styleOrRules Style or rules.
   */
  function pushMapStateOperatorScenario(suffix, styleOrRules) {
    scenarios.push({
      id: `capabilities/operators/${suffix}`,
      group: 'capability',
      geometry: 'line',
      capabilityKind: 'operators',
      capabilityCount: 1,
      capabilityVarsUsed: 0,
      capabilityGetsUsed: 0,
      style: styleOrRules,
      needsGet: false,
      needsVar: false,
      getKey: null,
      literal: null,
      varKey: null,
    });
  }

  // Multi-stop interpolate: make the third stop required for non-blank output.
  pushOperatorScenario(
    'interpolate-linear-multistop',
    {
      ...operatorBaseStyle,
      'stroke-width': [
        'interpolate',
        ['linear'],
        ['get', limitKey],
        0,
        0,
        1,
        0,
        2,
        8,
      ],
    },
    2,
  );
  pushOperatorScenario(
    'interpolate-exponential-multistop',
    {
      ...operatorBaseStyle,
      'stroke-width': [
        'interpolate',
        ['exponential', 2],
        ['get', limitKey],
        0,
        0,
        1,
        0,
        2,
        8,
      ],
    },
    2,
  );

  // Multi-branch case.
  pushOperatorScenario(
    'case-multi',
    {
      ...operatorBaseStyle,
      'stroke-width': [
        'case',
        ['<', ['get', limitKey], 2],
        0,
        ['<', ['get', limitKey], 4],
        8,
        0,
      ],
    },
    3,
  );

  // match() (numeric output).
  pushOperatorScenario(
    'match-number',
    {
      ...operatorBaseStyle,
      'stroke-width': ['match', ['get', limitKey], 1, 0, 2, 0, 3, 8, 0],
    },
    3,
  );

  // match() (color output).
  pushOperatorScenario(
    'match-color',
    {
      ...operatorBaseStyle,
      'stroke-color': [
        'match',
        ['get', limitKey],
        1,
        'rgb(0,0,0)',
        3,
        'rgb(255,0,0)',
        'rgb(0,0,0)',
      ],
      'stroke-width': 8,
    },
    3,
  );

  // Numeric in().
  pushOperatorScenario(
    'in',
    [
      {
        filter: ['in', ['get', limitKey], [1, 2, 3]],
        style: operatorBaseStyle,
      },
    ],
    3,
  );

  // between().
  pushOperatorScenario(
    'between',
    [
      {
        filter: ['between', ['get', limitKey], 2, 4],
        style: operatorBaseStyle,
      },
    ],
    3,
  );

  // Boolean ops any/all/!.
  pushOperatorScenario(
    'boolean-any-all-not',
    [
      {
        filter: [
          'all',
          ['any', false, ['==', ['get', limitKey], 3]],
          ['!', false],
        ],
        style: operatorBaseStyle,
      },
    ],
    3,
  );

  // mod().
  pushOperatorScenario(
    'mod',
    {
      ...operatorBaseStyle,
      'stroke-width': ['*', 8, ['%', ['get', limitKey], 1]],
    },
    0.9,
  );

  // floor/ceil/round.
  pushOperatorScenario(
    'floor',
    {
      ...operatorBaseStyle,
      'stroke-width': ['floor', ['get', limitKey]],
    },
    8.9,
  );
  pushOperatorScenario(
    'ceil',
    {
      ...operatorBaseStyle,
      'stroke-width': ['ceil', ['get', limitKey]],
    },
    7.1,
  );
  pushOperatorScenario(
    'round',
    {
      ...operatorBaseStyle,
      'stroke-width': ['round', ['get', limitKey]],
    },
    7.6,
  );

  // Trig + sqrt.
  pushOperatorScenario(
    'sin',
    {
      ...operatorBaseStyle,
      'stroke-width': ['*', 16, ['abs', ['sin', ['get', limitKey]]]],
    },
    1.0,
  );
  pushOperatorScenario(
    'cos',
    {
      ...operatorBaseStyle,
      'stroke-width': ['*', 16, ['abs', ['cos', ['get', limitKey]]]],
    },
    1.0,
  );
  pushOperatorScenario(
    'atan2',
    {
      ...operatorBaseStyle,
      'stroke-width': ['*', 16, ['abs', ['atan', 1, ['get', limitKey]]]],
    },
    2.0,
  );
  pushOperatorScenario(
    'sqrt',
    {
      ...operatorBaseStyle,
      'stroke-width': ['*', 4, ['sqrt', ['get', limitKey]]],
    },
    4,
  );

  // time() operator (map-state dependent).
  // Use it directly so a missing/zeroed time uniform is likely to produce blank output.
  pushMapStateOperatorScenario('time', {
    ...operatorBaseStyle,
    'stroke-width': ['time'],
  });

  // Expression backend probes (compile-time coverage, not rendering-based).
  // These scenarios validate whether the expression compilers can handle specific
  // operators/types, independently of any particular style property pipeline.
  /**
   * @param {string} suffix Scenario suffix.
   * @param {number} expectedType Expression expected type.
   * @param {any} expr Encoded expression.
   */
  function pushExprProbe(suffix, expectedType, expr) {
    scenarios.push({
      id: `capabilities/expr-operators/${suffix}`,
      group: 'capability',
      geometry: 'none',
      capabilityKind: 'expr-operators',
      capabilityCount: 1,
      capabilityVarsUsed: 0,
      capabilityGetsUsed: 0,
      kind: 'expr-probe',
      expectedType,
      expr,
      needsGet: false,
      needsVar: false,
      style: null,
    });
  }

  // Reading operators.
  pushExprProbe('get-number', NumberType, ['get', 'x']);
  pushExprProbe('var-number', NumberType, ['var', 'v']);
  pushExprProbe('resolution', NumberType, ['resolution']);
  pushExprProbe('zoom', NumberType, ['zoom']);
  pushExprProbe('time', NumberType, ['time']);
  pushExprProbe('line-metric', NumberType, ['line-metric']);
  pushExprProbe('geometry-type', StringType, ['geometry-type']);
  pushExprProbe('id', StringType | NumberType, ['id']);
  pushExprProbe('has', BooleanType, ['has', 'x']);

  // Literal support (non-array expressions).
  pushExprProbe('literal-boolean-true', BooleanType, true);
  pushExprProbe('literal-boolean-false', BooleanType, false);

  // Boolean ops.
  pushExprProbe('not', BooleanType, ['!', true]);
  pushExprProbe('any', BooleanType, ['any', false, true]);
  pushExprProbe('all', BooleanType, ['all', true, true]);

  // Comparisons.
  pushExprProbe('lt', BooleanType, ['<', 1, 2]);
  pushExprProbe('lte', BooleanType, ['<=', 1, 2]);
  pushExprProbe('gt', BooleanType, ['>', 2, 1]);
  pushExprProbe('gte', BooleanType, ['>=', 2, 1]);
  pushExprProbe('eq', BooleanType, ['==', 1, 1]);
  pushExprProbe('neq', BooleanType, ['!=', 1, 2]);

  // Math ops.
  pushExprProbe('add', NumberType, ['+', 1, 2, 3]);
  pushExprProbe('sub', NumberType, ['-', 2, 1]);
  pushExprProbe('mul', NumberType, ['*', 2, 3]);
  pushExprProbe('div', NumberType, ['/', 2, 1]);
  pushExprProbe('pow', NumberType, ['^', 2, 3]);
  pushExprProbe('mod', NumberType, ['%', 5, 2]);
  pushExprProbe('clamp', NumberType, ['clamp', 2, 0, 1]);
  pushExprProbe('abs', NumberType, ['abs', -1]);
  pushExprProbe('floor', NumberType, ['floor', 1.9]);
  pushExprProbe('ceil', NumberType, ['ceil', 1.1]);
  pushExprProbe('round', NumberType, ['round', 1.5]);
  pushExprProbe('sin', NumberType, ['sin', 1]);
  pushExprProbe('cos', NumberType, ['cos', 1]);
  pushExprProbe('atan', NumberType, ['atan', 1]);
  pushExprProbe('atan2', NumberType, ['atan', 1, 2]);
  pushExprProbe('sqrt', NumberType, ['sqrt', 4]);

  // Transform ops.
  pushExprProbe('case', NumberType, ['case', true, 1, 0]);
  pushExprProbe('case-color', ColorType, [
    'case',
    ['==', ['get', 'x'], 1],
    'rgb(255,0,0)',
    'rgb(0,0,255)',
  ]);
  pushExprProbe('interpolate-linear', NumberType, [
    'interpolate',
    ['linear'],
    0.5,
    0,
    0,
    1,
    1,
  ]);
  pushExprProbe('interpolate-linear-color', ColorType, [
    'interpolate',
    ['linear'],
    ['get', 'x'],
    0,
    'rgb(0,0,0)',
    1,
    'rgb(255,0,0)',
  ]);
  pushExprProbe('match-number', NumberType, [
    'match',
    ['get', 'x'],
    1,
    0,
    2,
    0,
    3,
    1,
    0,
  ]);
  pushExprProbe('match-color', ColorType, [
    'match',
    ['get', 'x'],
    1,
    'rgb(255,0,0)',
    2,
    'rgb(0,0,255)',
    'rgb(0,0,0)',
  ]);
  pushExprProbe('match-string', NumberType, [
    'match',
    ['get', 's'],
    'a',
    0,
    'b',
    1,
    0,
  ]);
  pushExprProbe('between', BooleanType, ['between', 2, 1, 3]);
  pushExprProbe('in-number', BooleanType, ['in', 2, [1, 2, 3]]);
  pushExprProbe('in-string', BooleanType, [
    'in',
    ['get', 's'],
    ['literal', ['a', 'b']],
  ]);

  // Conversion/assertion ops (supported by the expression language, but backend-specific).
  pushExprProbe('number', NumberType, ['number', 1, '1']);
  pushExprProbe('string', StringType, ['string', 1, 'a']);
  pushExprProbe('concat', StringType, ['concat', 'a', 'b']);
  pushExprProbe('coalesce', NumberType, ['coalesce', ['get', 'missing'], 1]);
  pushExprProbe('coalesce-color', ColorType, [
    'coalesce',
    ['get', 'missing'],
    'rgb(255,0,0)',
  ]);
  pushExprProbe('to-string', StringType, ['to-string', 1]);

  return scenarios;
}

async function main() {
  await Promise.all([loadImage(iconSrc), loadImage(patternSrc)]);

  const res = await fetch('/compat-matrix/properties.json', {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to load properties.json: ${res.status}`);
  }
  const data = await res.json();
  const properties = data.properties || [];
  const scenarios = generateScenarios(properties);

  /** @type {Record<string, any>} */
  const contexts = {};
  for (const renderer of RENDERERS) {
    const target = document.getElementById(`target-${renderer}`);
    try {
      if (renderer === 'webgpu' && !navigator.gpu) {
        contexts[renderer] = {
          status: 'unavailable',
          message: 'WebGPU unavailable',
        };
        continue;
      }
      contexts[renderer] = createMap(target, renderer);
    } catch (err) {
      contexts[renderer] = {
        status: 'unavailable',
        message: String(err?.message || err),
      };
    }
  }

  /** @type {Array<any>} */
  const results = [];

  /** @type {Map<string, number>} */
  const capabilityFirstFailure = new Map();

  /**
   * @param {string} id Scenario id.
   * @return {{prefix: string, n: number}|null} Capability id parts, if applicable.
   */
  function parseCapabilityId(id) {
    const m = id.match(/^(capabilities\/[^/]+\/)(\d+)$/);
    if (!m) {
      return null;
    }
    return {prefix: m[1], n: Number.parseInt(m[2], 10)};
  }

  for (const scenario of scenarios) {
    for (const renderer of RENDERERS) {
      const targetId = `target-${renderer}`;
      const ctx = contexts[renderer];
      const runCtx = ctx;

      /** @type {any} */
      const entry = {
        id: scenario.id,
        renderer,
        targetId,
        scenarioGroup: scenario.group,
        scenarioGeometry: scenario.geometry,
        capabilityKind: scenario.capabilityKind,
        capabilityCount: scenario.capabilityCount,
        capabilityVarsUsed: scenario.capabilityVarsUsed,
        capabilityGetsUsed: scenario.capabilityGetsUsed,
        status: 'ok',
        messages: [],
      };

      if (scenario.kind === 'expr-probe') {
        try {
          if (renderer === 'canvas') {
            const parsingContext = newParsingContext();
            buildCpuExpression(
              scenario.expr,
              scenario.expectedType,
              parsingContext,
            );
          } else if (renderer === 'webgl') {
            const parsingContext = newParsingContext();
            const compilationContext = newCompilationContext();
            buildExpression(
              scenario.expr,
              scenario.expectedType,
              parsingContext,
              compilationContext,
            );
          } else {
            if (!navigator.gpu) {
              entry.status = 'unavailable';
              entry.messages.push({
                type: 'unavailable',
                message: 'WebGPU unavailable',
              });
              results.push(entry);
              continue;
            }

            const parsingContext = newParsingContext();
            const parsed = parse(
              scenario.expr,
              scenario.expectedType,
              parsingContext,
            );

            /** @type {Map<string, {offset: number, type: number}>} */
            const propsLayout = new Map();
            /** @type {Map<string, {offset: number, type: number}>} */
            const varsLayout = new Map();
            let nextPropOffset = 0;
            let nextVarOffset = 0;

            /**
             * @param {Map<string, {offset: number, type: number}>} layout Layout map.
             * @param {string} name Key name.
             * @param {number} type Value type.
             * @param {'prop'|'var'} kind Kind.
             * @return {number} f32 offset.
             */
            function alloc(layout, name, type, kind) {
              const existing = layout.get(name);
              if (existing) {
                return existing.offset;
              }
              const stride = type === ColorType ? 4 : 1;
              const offset = kind === 'prop' ? nextPropOffset : nextVarOffset;
              if (kind === 'prop') {
                nextPropOffset += stride;
              } else {
                nextVarOffset += stride;
              }
              layout.set(name, {offset, type});
              return offset;
            }

            const diagnostics = {issues: []};
            const compiled = compileExpressionToWgsl(
              parsed,
              {
                lineMetric: 'currentLineMetric',
                resolution: 'uniforms.resolution',
                zoom: 'uniforms.zoom',
                time: 'uniforms.time',
                get: (name, type) => {
                  const offset = alloc(propsLayout, name, type, 'prop');
                  if (type === ColorType) {
                    return `vec4f(props[${offset}], props[${offset + 1}], props[${
                      offset + 2
                    }], props[${offset + 3}])`;
                  }
                  if (type === BooleanType) {
                    return `(props[${offset}] > 0.0)`;
                  }
                  return `props[${offset}]`;
                },
                var: (name, type) => {
                  const offset = alloc(varsLayout, name, type, 'var');
                  if (type === ColorType) {
                    return `vec4f(vars[${offset}], vars[${offset + 1}], vars[${
                      offset + 2
                    }], vars[${offset + 3}])`;
                  }
                  if (type === BooleanType) {
                    return `(vars[${offset}] > 0.0)`;
                  }
                  return `vars[${offset}]`;
                },
                id: (type) => {
                  const offset = alloc(propsLayout, '__id__', type, 'prop');
                  return `props[${offset}]`;
                },
              },
              {strict: true, diagnostics},
            );

            // Validate that the compiled expression produces valid WGSL by compiling it into a minimal compute module.
            const device =
              runCtx?.layer?.getRenderer?.()?.helper?.getDevice?.() ||
              (await (await navigator.gpu.requestAdapter())?.requestDevice());
            if (!device) {
              entry.status = 'unavailable';
              entry.messages.push({
                type: 'unavailable',
                message: 'No WebGPU device available',
              });
              results.push(entry);
              continue;
            }

            const wgsl = `
struct Uniforms {
  resolution: f32,
  zoom: f32,
  time: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> props: array<f32>;
@group(0) @binding(2) var<storage, read> vars: array<f32>;
var<private> currentLineMetric: f32 = 0.0;

@compute @workgroup_size(1)
fn main() {
  let _unused = ${compiled};
}
`;

            device.pushErrorScope('validation');
            let module;
            try {
              module = device.createShaderModule({code: wgsl});
              if (module.getCompilationInfo) {
                const info = await module.getCompilationInfo();
                const errors = info.messages?.filter((m) => m.type === 'error');
                if (errors?.length) {
                  throw new Error(errors.map((e) => e.message).join('\n'));
                }
              }
              device.createComputePipeline({
                layout: 'auto',
                compute: {module, entryPoint: 'main'},
              });
            } catch (err) {
              entry.status = 'not_supported';
              entry.messages.push({
                type: 'expr',
                message: String(err?.message || err),
              });
            }
            const scopeErr = await device.popErrorScope();
            if (scopeErr) {
              entry.status = 'not_supported';
              entry.messages.push({
                type: 'validation',
                message: scopeErr.message,
              });
            }
            for (const issue of diagnostics.issues) {
              entry.messages.push({
                type: 'expr',
                message: `${issue.op}: ${issue.message}`,
              });
            }
          }
        } catch (err) {
          entry.status = 'not_supported';
          entry.messages.push({
            type: 'expr',
            message: String(err?.message || err),
          });
        }
        results.push(entry);
        continue;
      }

      const capability = parseCapabilityId(scenario.id);
      if (capability) {
        const key = `${renderer}|${capability.prefix}`;
        const firstFailAt = capabilityFirstFailure.get(key);
        if (typeof firstFailAt === 'number' && capability.n >= firstFailAt) {
          entry.status = 'not_supported';
          entry.messages.push({
            type: 'not_supported',
            message: `Not supported at this count; first failure was at ${capability.prefix}${firstFailAt}`,
          });
          const renderInfo = await globalThis.reportScenarioResult({targetId});
          if (renderInfo) {
            Object.assign(entry, renderInfo);
          }
          results.push(entry);
          continue;
        }
      }

      if (!runCtx?.map || !runCtx?.layer) {
        entry.status = 'unavailable';
        entry.messages.push({
          type: 'unavailable',
          message: ctx?.message || `${renderer} unavailable`,
        });
        const renderInfo = await globalThis.reportScenarioResult({targetId});
        if (renderInfo) {
          Object.assign(entry, renderInfo);
        }
        results.push(entry);
        continue;
      }

      /** @type {GPUDevice|undefined} */
      let device;
      /** @type {boolean} */
      let webgpuScoped = false;
      try {
        if (renderer === 'webgpu') {
          try {
            device = runCtx?.layer?.getRenderer?.()?.helper?.getDevice?.();
            if (device) {
              // Capture validation errors that might not produce a blank frame (more actionable than pixel diffs).
              device.pushErrorScope('validation');
              webgpuScoped = true;
            }
          } catch {
            // ignore
          }
        }

        const features = runCtx.features;
        if (scenario.needsGet) {
          const keys = scenario.featureProps || [scenario.getKey];
          for (const p of features.points) {
            for (const k of keys) {
              p.set(k, 0.1);
            }
            if (!scenario.featureProps) {
              p.set(scenario.getKey, scenario.literal);
            }
          }
          for (const f of [features.line, features.polygon]) {
            for (const k of keys) {
              f.set(k, 0.1);
            }
            if (!scenario.featureProps) {
              f.set(scenario.getKey, scenario.literal);
            }
          }
        }

        if (scenario.needsVar && runCtx.layer.updateStyleVariables) {
          if (scenario.variables) {
            runCtx.layer.updateStyleVariables(scenario.variables);
          } else {
            runCtx.layer.updateStyleVariables({
              [scenario.varKey]: scenario.literal,
            });
          }
        }

        runCtx.layer.setStyle(scenario.style);

        // Render after style/variables changes are applied and give the browser a
        // couple of frames to paint (more stable than waiting for rendercomplete).
        runCtx.map.renderSync();
        await waitForAnimationFrames(2);
        const renderInfo = await globalThis.reportScenarioResult({targetId});
        if (renderInfo) {
          Object.assign(entry, renderInfo);
          if (entry.status === 'ok' && renderInfo.rendered === false) {
            entry.status = 'not_supported';
            entry.messages.push({
              type: 'blank',
              message: 'Rendered blank output',
            });
          }
        }
      } catch (err) {
        entry.status = 'not_supported';
        entry.messages.push({
          type: 'error',
          message: String(err?.message || err),
        });
        const renderInfo = await globalThis.reportScenarioResult({targetId});
        if (renderInfo) {
          Object.assign(entry, renderInfo);
        }
      } finally {
        if (webgpuScoped && device) {
          try {
            // Ensure work is submitted before popping error scope.
            await device.queue.onSubmittedWorkDone();
          } catch {
            // ignore
          }
          try {
            const scopeErr = await device.popErrorScope();
            if (scopeErr) {
              entry.status = 'not_supported';
              entry.messages.push({
                type: 'validation',
                message: scopeErr.message,
              });
            }
          } catch {
            // ignore
          }
        }
        if (
          renderer === 'webgl' &&
          runCtx?.map &&
          runCtx?.layer &&
          entry.status !== 'ok'
        ) {
          try {
            runCtx.layer.setStyle(SAFE_STYLE);
            runCtx.map.renderSync();
            await waitForAnimationFrames(1);
          } catch {
            // ignore - keep collecting results
          }
        }
      }

      results.push(entry);
      if (capability && entry.status !== 'ok') {
        const key = `${renderer}|${capability.prefix}`;
        if (!capabilityFirstFailure.has(key)) {
          capabilityFirstFailure.set(key, capability.n);
        }
      }
    }
  }

  for (const renderer of RENDERERS) {
    const ctx = contexts[renderer];
    if (ctx?.map) {
      ctx.map.setTarget(null);
    }
  }

  await globalThis.reportDone({
    meta: {
      date: nowIso(),
      scenarios: scenarios.length,
      renderers: RENDERERS,
      properties: properties.length,
    },
    scenarios: scenarios.map((s) => ({
      id: s.id,
      prop: s.prop,
      group: s.group,
      geometry: s.geometry,
      kind: s.kind,
      type: s.type,
      style: s.style,
      expr: s.expr,
      expectedType: s.expectedType,
      variables: s.variables,
      needsGet: s.needsGet,
      needsVar: s.needsVar,
      featureProps: s.featureProps,
      getKey: s.getKey,
      varKey: s.varKey,
      literal: s.literal,
      capabilityKind: s.capabilityKind,
      capabilityCount: s.capabilityCount,
      capabilityVarsUsed: s.capabilityVarsUsed,
      capabilityGetsUsed: s.capabilityGetsUsed,
    })),
    results,
  });
}

main().catch((err) => {
  globalThis.reportDone({
    meta: {
      date: nowIso(),
      scenarios: 0,
      renderers: RENDERERS,
      error: String(err?.message || err),
    },
    results: [],
  });
});
