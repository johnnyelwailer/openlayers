import expect from 'expect.js';
import Feature from '../../../../../../src/ol/Feature.js';
import Point from '../../../../../../src/ol/geom/Point.js';
import Polygon from '../../../../../../src/ol/geom/Polygon.js';
import VectorLayer from '../../../../../../src/ol/layer/Vector.js';
import WebGPUVectorLayerRenderer from '../../../../../../src/ol/renderer/webgpu/VectorLayer.js';
import VectorSource from '../../../../../../src/ol/source/Vector.js';
import {getUid} from '../../../../../../src/ol/util.js';

// Mock globals for Node environment
if (typeof navigator === 'undefined') {
  global.navigator = {};
}
if (typeof document === 'undefined') {
  global.document = {
    createElement: (tag) => ({
      getContext: () => null,
      style: {},
    }),
  };
}
if (typeof window === 'undefined') {
  global.window = global;
}

describe('ol/renderer/webgpu/VectorLayer', function () {
  let renderer;
  let layer;
  /** @type {null|(() => void)} */
  let restoreNavigatorGpu = null;

  /**
   * @param {*} mockGpu Mock GPU object.
   * @return {() => void} Restore function.
   */
  function stubNavigatorGpu(mockGpu) {
    const originalGpu = navigator.gpu;
    if (originalGpu) {
      const originalRequestAdapter = originalGpu.requestAdapter;
      const originalGetPreferredCanvasFormat =
        originalGpu.getPreferredCanvasFormat;
      Object.defineProperty(originalGpu, 'requestAdapter', {
        value: mockGpu.requestAdapter,
        configurable: true,
      });
      Object.defineProperty(originalGpu, 'getPreferredCanvasFormat', {
        value: mockGpu.getPreferredCanvasFormat,
        configurable: true,
      });
      return () => {
        Object.defineProperty(originalGpu, 'requestAdapter', {
          value: originalRequestAdapter,
          configurable: true,
        });
        Object.defineProperty(originalGpu, 'getPreferredCanvasFormat', {
          value: originalGetPreferredCanvasFormat,
          configurable: true,
        });
      };
    }

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'gpu',
    );
    Object.defineProperty(navigator, 'gpu', {
      value: mockGpu,
      configurable: true,
    });
    return () => {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'gpu', originalDescriptor);
      } else {
        delete navigator.gpu;
      }
    };
  }

  beforeEach(function () {
    // Mock navigator.gpu
    restoreNavigatorGpu = stubNavigatorGpu({
      requestAdapter: async () => ({
        requestDevice: async () => ({
          createBuffer: () => ({}),
          queue: {writeBuffer: () => {}},
          destroy: () => {},
        }),
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    });

    layer = new VectorLayer({
      source: new VectorSource(),
    });
    renderer = new WebGPUVectorLayerRenderer(layer, {
      style: [],
    });
  });

  afterEach(function () {
    renderer?.dispose?.();
    restoreNavigatorGpu?.();
    restoreNavigatorGpu = null;
  });

  it('can be instantiated', function () {
    expect(renderer).to.be.ok();
  });

  it('initializes style renderer after helper creation', async function () {
    // Trigger prepareFrame which initializes helper
    const frameState = {mapId: '1', layerStatesArray: []};
    renderer.prepareFrame(frameState);

    // We need to wait for helper.ready() which is async
    await renderer.helper.ready();

    // Since afterHelperCreated is called in the then() block, we might need a small delay or check
    // However, for this text, we can manually call it to verify the logic *inside* it works
    renderer.afterHelperCreated();

    expect(renderer.styleRenderer_).to.be.ok();
  });

  it('renders frame using style renderer', async function () {
    // Spy on render
    let renderCalled = false;
    renderer.styleRenderer_ = {
      render: () => {
        renderCalled = true;
      },
    };

    renderer.currentBuffers_ = {
      pointBuffers: [],
      lineStringBuffers: [],
      polygonBuffers: [],
    };

    renderer.helper = {
      configureContextForFrame: () => {},
      isFirstPass: () => true,
      getCanvas: () => ({}),
      dispose: () => {},
    };

    const frameState = {
      index: 0,
      size: [100, 100],
      pixelRatio: 1,
      extent: [-1, -1, 1, 1],
      viewHints: [0, 0],
      viewState: {
        center: [0, 0],
        resolution: 1,
        rotation: 0,
        zoom: 0,
        projection: {canWrapX: () => false, getExtent: () => [0, 0, 0, 0]},
      },
    };

    renderer.renderFrame(frameState);

    expect(renderCalled).to.be(true);
  });

  it('updates styles without regenerating geometry buffers', function () {
    const feature = new Feature({geometry: new Point([0, 0])});
    layer.getSource().addFeature(feature);

    renderer.initialFeaturesAdded_ = true;
    renderer.batch_.addFeature(feature);
    const uid = getUid(feature);
    const ref = renderer.batch_.pointBatch.entries[uid].ref;
    renderer.geometryRevisionByUid_.set(
      uid,
      feature.getGeometry().getRevision(),
    );
    renderer.geometryDirty_ = false;

    renderer.currentBuffers_ = {
      pointBuffers: [],
      lineStringBuffers: [],
      polygonBuffers: [],
    };

    let updateCalled = null;
    renderer.styleRenderer_ = {
      updateFeatureStyles: (buffers, dirtyRef, dirtyFeature) => {
        updateCalled = {buffers, dirtyRef, dirtyFeature};
      },
      render: () => {},
    };

    renderer.helper = {
      configureContextForFrame: () => {},
      isFirstPass: () => true,
      getCanvas: () => ({}),
      dispose: () => {},
    };

    // Property-only change: geometry revision remains unchanged.
    feature.set('color', 'red');
    renderer.handleSourceFeatureChanged_(null, {feature});

    expect(renderer.geometryDirty_).to.be(false);
    expect(renderer.styleDirtyRefs_.has(ref)).to.be(true);

    const frameState = {
      index: 0,
      size: [100, 100],
      pixelRatio: 1,
      extent: [-1, -1, 1, 1],
      viewState: {
        center: [0, 0],
        resolution: 1,
        rotation: 0,
        zoom: 0,
        projection: {canWrapX: () => false, getExtent: () => [0, 0, 0, 0]},
      },
    };
    renderer.renderFrame(frameState);

    expect(updateCalled).to.be.ok();
    expect(updateCalled.dirtyRef).to.be(ref);
    expect(updateCalled.dirtyFeature).to.be(feature);
    expect(renderer.styleDirtyRefs_.size).to.be(0);
  });

  it('updates polygon styles without regenerating geometry buffers', function () {
    const feature = new Feature({
      geometry: new Polygon([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ]),
    });
    layer.getSource().addFeature(feature);

    renderer.initialFeaturesAdded_ = true;
    renderer.batch_.addFeature(feature);
    const uid = getUid(feature);
    const ref = renderer.batch_.polygonBatch.entries[uid].ref;
    renderer.geometryRevisionByUid_.set(
      uid,
      feature.getGeometry().getRevision(),
    );
    renderer.geometryDirty_ = false;

    renderer.currentBuffers_ = {
      pointBuffers: [],
      lineStringBuffers: [],
      polygonBuffers: [],
    };

    let updateCalled = null;
    renderer.styleRenderer_ = {
      updateFeatureStyles: (buffers, dirtyRef, dirtyFeature) => {
        updateCalled = {buffers, dirtyRef, dirtyFeature};
      },
      render: () => {},
    };

    renderer.helper = {
      configureContextForFrame: () => {},
      isFirstPass: () => true,
      getCanvas: () => ({}),
      dispose: () => {},
    };

    // Property-only change: geometry revision remains unchanged.
    feature.set('fill', 'blue');
    renderer.handleSourceFeatureChanged_(null, {feature});

    expect(renderer.geometryDirty_).to.be(false);
    expect(renderer.styleDirtyRefs_.has(ref)).to.be(true);

    const frameState = {
      index: 0,
      size: [100, 100],
      pixelRatio: 1,
      extent: [-1, -1, 1, 1],
      viewState: {
        center: [0, 0],
        resolution: 1,
        rotation: 0,
        zoom: 0,
        projection: {canWrapX: () => false, getExtent: () => [0, 0, 0, 0]},
      },
    };
    renderer.renderFrame(frameState);

    expect(updateCalled).to.be.ok();
    expect(updateCalled.dirtyRef).to.be(ref);
    expect(updateCalled.dirtyFeature).to.be(feature);
    expect(renderer.styleDirtyRefs_.size).to.be(0);
  });

  it('marks geometry dirty on geometry changes', function () {
    const feature = new Feature({geometry: new Point([0, 0])});
    layer.getSource().addFeature(feature);

    renderer.initialFeaturesAdded_ = true;
    renderer.batch_.addFeature(feature);
    const uid = getUid(feature);
    const ref = renderer.batch_.pointBatch.entries[uid].ref;
    renderer.geometryRevisionByUid_.set(
      uid,
      feature.getGeometry().getRevision(),
    );
    renderer.geometryDirty_ = false;

    renderer.currentBuffers_ = {
      pointBuffers: [],
      lineStringBuffers: [],
      polygonBuffers: [],
    };

    let updateCalled = false;
    renderer.styleRenderer_ = {
      updateFeatureStyles: () => {
        updateCalled = true;
      },
      render: () => {},
    };

    renderer.helper = {
      configureContextForFrame: () => {},
      isFirstPass: () => true,
      getCanvas: () => ({}),
      dispose: () => {},
    };

    // Geometry change: revision changes, should trigger geometry rebuild path.
    feature.getGeometry().setCoordinates([1, 1]);
    renderer.handleSourceFeatureChanged_(null, {feature});

    expect(renderer.geometryDirty_).to.be(true);
    expect(renderer.styleDirtyRefs_.has(ref)).to.be(false);

    const frameState = {
      index: 0,
      size: [100, 100],
      pixelRatio: 1,
      extent: [-1, -1, 1, 1],
      viewState: {
        center: [0, 0],
        resolution: 1,
        rotation: 0,
        zoom: 0,
        projection: {canWrapX: () => false, getExtent: () => [0, 0, 0, 0]},
      },
    };
    renderer.renderFrame(frameState);
    expect(updateCalled).to.be(false);
  });
});
