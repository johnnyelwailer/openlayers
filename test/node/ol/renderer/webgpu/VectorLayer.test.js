import Feature from '../../../../../src/ol/Feature.js';
import LineString from '../../../../../src/ol/geom/LineString.js';
import MultiPoint from '../../../../../src/ol/geom/MultiPoint.js';
import Point from '../../../../../src/ol/geom/Point.js';
import Polygon from '../../../../../src/ol/geom/Polygon.js';
import VectorLayer from '../../../../../src/ol/layer/Vector.js';
import WebGPUVectorLayerRenderer from '../../../../../src/ol/renderer/webgpu/VectorLayer.js';
import VectorSource from '../../../../../src/ol/source/Vector.js';
import expect from '../../../expect.js';

describe('ol/renderer/webgpu/VectorLayer', () => {
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

  it('combines hitTolerance with style-derived tolerance', () => {
    const feature = new Feature(new Point([0, 0]));
    const layer = new VectorLayer({
      source: new VectorSource({features: [feature]}),
    });
    const renderer = new WebGPUVectorLayerRenderer(layer, {
      style: {
        'circle-radius': 0,
        'circle-fill-color': 'black',
      },
    });

    const matches = [];
    renderer.forEachFeatureAtCoordinate(
      [3, 0],
      /** @type {*} */ ({viewState: {resolution: 1, projection: {}}}),
      3,
      () => undefined,
      matches,
    );

    expect(matches.length).to.be(1);
    expect(matches[0].feature).to.be(feature);
    expect(matches[0].distanceSq).to.be(9);
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
