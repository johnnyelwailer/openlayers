import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import KML from '../../../../src/ol/format/KML.js';
import TileLayer from '../../../../src/ol/layer/WebGLTile.js';
import WebGPUVectorLayer from '../../../../src/ol/layer/WebGPUVector.js';
import DataTile from '../../../../src/ol/source/DataTile.js';
import VectorSource from '../../../../src/ol/source/Vector.js';
import XYZ from '../../../../src/ol/source/XYZ.js';

const labelCanvasSize = 256;

const labelCanvas = document.createElement('canvas');
labelCanvas.width = labelCanvasSize;
labelCanvas.height = labelCanvasSize;

const labelContext = labelCanvas.getContext('2d');
labelContext.textAlign = 'center';
labelContext.font = '16px sans-serif';
const labelLineHeight = 16;

const vector = new WebGPUVectorLayer({
  opacity: 0.5,
  source: new VectorSource({
    url: '/data/2012_Earthquakes_Mag5.kml',
    format: new KML({
      extractStyles: false,
    }),
  }),
  style: {
    'circle-radius': 3,
    'circle-fill-color': 'orange',
  },
});

const map = new Map({
  layers: [
    new TileLayer({
      source: new XYZ({
        url: '/data/tiles/satellite/{z}/{x}/{y}.jpg',
        transition: 0,
      }),
    }),
    vector,
    new TileLayer({
      source: new DataTile({
        wrapX: true,
        loader: function (z, x, y) {
          const half = labelCanvasSize / 2;

          labelContext.clearRect(0, 0, labelCanvasSize, labelCanvasSize);

          labelContext.fillStyle = 'white';
          labelContext.fillText(`z: ${z}`, half, half - labelLineHeight);
          labelContext.fillText(`x: ${x}`, half, half);
          labelContext.fillText(`y: ${y}`, half, half + labelLineHeight);

          labelContext.strokeStyle = 'white';
          labelContext.lineWidth = 2;
          labelContext.strokeRect(0, 0, labelCanvasSize, labelCanvasSize);

          const data = labelContext.getImageData(
            0,
            0,
            labelCanvasSize,
            labelCanvasSize,
          ).data;
          return new Uint8Array(data.buffer);
        },
        transition: 0,
      }),
    }),
  ],
  target: 'map',
  view: new View({
    center: [15180597.9736, 2700366.3807],
    zoom: 2,
  }),
});

function hasPointBuffers(renderer) {
  const buffers = renderer.currentBuffers_;
  if (!buffers || !buffers.pointBuffers || buffers.pointBuffers.length === 0) {
    return false;
  }
  return buffers.pointBuffers.some((set) => set.vertex.getSize() > 0);
}

function renderWhenReady() {
  let attempts = 0;
  const checkReady = () => {
    attempts += 1;
    const renderer = vector.getRenderer();
    if (
      renderer &&
      renderer.helper &&
      renderer.helper.getDevice() &&
      hasPointBuffers(renderer)
    ) {
      map.once('rendercomplete', () => {
        const device = renderer.helper.getDevice();
        device.queue.onSubmittedWorkDone().then(() => {
          render({
            message: 'a mix of WebGL and WebGPU layers are rendered',
          });
        });
      });
      map.renderSync();
      return;
    }
    if (attempts > 60) {
      render({
        message: 'timed out waiting for WebGPU points to render',
      });
      return;
    }
    map.once('rendercomplete', checkReady);
    map.renderSync();
  };
  map.once('rendercomplete', checkReady);
  map.renderSync();
}

const source = vector.getSource();
if (source.getFeatures().length > 0) {
  renderWhenReady();
} else {
  source.once('featuresloadend', renderWhenReady);
}
