import Feature from '../../../../../src/ol/Feature.js';
import LineString from '../../../../../src/ol/geom/LineString.js';
import MultiPoint from '../../../../../src/ol/geom/MultiPoint.js';
import Point from '../../../../../src/ol/geom/Point.js';
import Polygon from '../../../../../src/ol/geom/Polygon.js';
import VectorLayer from '../../../../../src/ol/layer/Vector.js';
import {
  clearUserProjection,
  transform,
  useGeographic,
} from '../../../../../src/ol/proj.js';
import WebGPUVectorLayerRenderer from '../../../../../src/ol/renderer/webgpu/VectorLayer.js';
import VectorSource from '../../../../../src/ol/source/Vector.js';
import expect from '../../../expect.js';

describe('ol/renderer/webgpu/VectorLayer', () => {
  beforeEach(() => clearUserProjection());
  afterEach(() => clearUserProjection());

  it('returns callback result immediately for a direct point hit', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 10,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    const result = renderer.forEachFeatureAtCoordinate(
      [0, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      (f) => f,
      matches,
    );

    expect(result).to.be(feature);
    expect(matches.length).to.be(0);
  });

  it('hits features correctly with user projection enabled', () => {
    useGeographic();

    const feature = new Feature(new Point([10, 20]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 10,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    const result = renderer.forEachFeatureAtCoordinate(
      transform([10, 20], 'EPSG:4326', 'EPSG:3857'),
      /** @type {*} */ ({
        viewState: {resolution: 1, projection: 'EPSG:3857'},
      }),
      0,
      (f) => f,
      matches,
    );

    expect(result).to.be(feature);
    expect(matches.length).to.be(0);
  });

  it('collects point hits into matches using style-derived tolerance', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 10,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    const result = renderer.forEachFeatureAtCoordinate(
      [8, 6],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      (f) => f,
      matches,
    );

    expect(result).to.be(undefined);
    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(100);
  });

  it('does not hit circles with fill color none', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 10,
        'circle-fill-color': 'none',
      },
    });

    const matches = [];
    const result = renderer.forEachFeatureAtCoordinate(
      [0, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      10,
      (f) => f,
      matches,
    );

    expect(result).to.be(undefined);
    expect(matches.length).to.be(0);
  });

  it('combines hitTolerance with style-derived tolerance', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 1,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [3, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      2,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(9);
  });

  it('respects rule filters and else semantics for point hit radius', () => {
    const feature = new Feature(new Point([0, 0]));
    feature.set('kind', 1);
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: [
        {
          filter: ['==', ['get', 'kind'], 1],
          style: {
            'circle-radius': 10,
            'circle-fill-color': 'black',
          },
        },
        {
          else: true,
          style: {
            'circle-radius': 2,
            'circle-fill-color': 'black',
          },
        },
      ],
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [6, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
  });

  it('uses get() expressions when computing point hit radius', () => {
    const feature = new Feature(new Point([0, 0]));
    feature.set('r', 10);
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': ['get', 'r'],
        'circle-fill-color': 'black',
      },
    });

    const matchesA = [];
    renderer.forEachFeatureAtCoordinate(
      [8, 6],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      matchesA,
    );
    expect(matchesA.length).to.be(1);

    feature.set('r', 2);
    const matchesB = [];
    renderer.forEachFeatureAtCoordinate(
      [8, 6],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      matchesB,
    );
    expect(matchesB.length).to.be(0);
  });

  it('scales distances by view resolution', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 5,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [10, 0],
      /** @type {*} */ ({viewState: {resolution: 2, projection: {}}}),
      0,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(25);
  });

  it('collects line hits into matches using stroke width tolerance', () => {
    const feature = new Feature(
      new LineString([
        [0, 0],
        [10, 0],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'stroke-color': 'black',
        'stroke-width': 6,
      },
    });

    const matches = [];
    const result = renderer.forEachFeatureAtCoordinate(
      [5, 2],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      (f) => f,
      matches,
    );

    expect(result).to.be(undefined);
    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(4);
  });

  it('assumes a default stroke width when stroke-color is present', () => {
    const feature = new Feature(
      new LineString([
        [0, 0],
        [10, 0],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'stroke-color': 'black',
      },
    });

    const hitMatches = [];
    renderer.forEachFeatureAtCoordinate(
      [5, 0.6],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      hitMatches,
    );
    expect(hitMatches.length).to.be(1);

    const missMatches = [];
    renderer.forEachFeatureAtCoordinate(
      [5, 0.7],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      missMatches,
    );
    expect(missMatches.length).to.be(0);
  });

  it('does not hit strokes with stroke-color none', () => {
    const feature = new Feature(
      new LineString([
        [0, 0],
        [10, 0],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'stroke-color': 'none',
        'stroke-width': 100,
      },
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [5, 10],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(0);
  });

  it('treats MultiPoint geometries as point hits', () => {
    const feature = new Feature(
      new MultiPoint([
        [0, 0],
        [20, 0],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 2,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [21, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(1);
  });

  it('uses icon-size defaults when icon-src is present', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'icon-src': 'icon.png',
      },
    });

    const hitMatches = [];
    renderer.forEachFeatureAtCoordinate(
      [15, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      hitMatches,
    );
    expect(hitMatches.length).to.be(1);

    const missMatches = [];
    renderer.forEachFeatureAtCoordinate(
      [17, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      missMatches,
    );
    expect(missMatches.length).to.be(0);
  });

  it('applies hitTolerance to polygon edges', () => {
    const feature = new Feature(
      new Polygon([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {'fill-color': 'rgba(0,0,0,0.4)'},
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [10.5, 5],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      1,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(0.25);
  });

  it('returns an immediate hit for polygons when inside', () => {
    const feature = new Feature(
      new Polygon([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {'fill-color': 'rgba(0,0,0,0.4)'},
    });

    const matches = [];
    const result = renderer.forEachFeatureAtCoordinate(
      [5, 5],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      (f) => f,
      matches,
    );

    expect(result).to.be(feature);
    expect(matches.length).to.be(0);
  });

  it('does not hit polygon interiors when fill-color is none', () => {
    const feature = new Feature(
      new Polygon([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]),
    );
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'fill-color': 'none',
        'stroke-color': 'black',
        'stroke-width': 2,
      },
    });

    const insideMatches = [];
    renderer.forEachFeatureAtCoordinate(
      [5, 5],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      insideMatches,
    );
    expect(insideMatches.length).to.be(0);

    const edgeMatches = [];
    renderer.forEachFeatureAtCoordinate(
      [10.5, 5],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      0,
      () => undefined,
      edgeMatches,
    );
    expect(edgeMatches.length).to.be(1);
  });

  it('throws when hit detection is disabled', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 10,
        'circle-fill-color': 'black',
      },
      disableHitDetection: true,
    });

    expect(() => {
      renderer.forEachFeatureAtCoordinate(
        [0, 0],
        /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
        0,
        () => true,
        [],
      );
    }).to.throwError();
  });
});
