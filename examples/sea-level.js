import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import ImageLayer from '../src/ol/layer/Image.js';
import TileLayer from '../src/ol/layer/Tile.js';
import {fromLonLat} from '../src/ol/proj.js';
import ImageTile from '../src/ol/source/ImageTile.js';
import RasterSource from '../src/ol/source/Raster.js';

function flood(pixels, data) {
  const pixel = pixels[0];
  if (pixel[3]) {
    const height =
      -10000 + (pixel[0] * 256 * 256 + pixel[1] * 256 + pixel[2]) * 0.1;
    if (height <= data.level) {
      pixel[0] = 134;
      pixel[1] = 203;
      pixel[2] = 249;
      pixel[3] = 255;
    } else {
      pixel[3] = 0;
    }
  }
  return pixel;
}

const key = 'get_your_own_D6rA4zTHduk6KOKTXzGB';
const attributions =
  '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

const elevation = new ImageTile({
  // The RGB values in the source collectively represent elevation.
  // Interpolation of individual colors would produce incorrect elevations and is disabled.
  url:
    'https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key=' + key,
  tileSize: 512,
  maxZoom: 14,
  interpolate: false,
});

const raster = new RasterSource({
  sources: [elevation],
  operation: flood,
});

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new ImageTile({
        attributions: attributions,
        url:
          'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=' + key,
        tileSize: 512,
        maxZoom: 22,
      }),
    }),
    new ImageLayer({
      opacity: 0.6,
      source: raster,
    }),
  ],
  view: new View({
    center: fromLonLat([-122.3267, 37.8377]),
    zoom: 11,
  }),
});

const control = document.getElementById('level');
const output = document.getElementById('output');
control.addEventListener('input', function () {
  output.innerText = control.value;
  raster.changed();
});
output.innerText = control.value;

raster.on('beforeoperations', function (event) {
  event.data.level = control.value;
});

const locations = document.getElementsByClassName('location');
for (let i = 0, ii = locations.length; i < ii; ++i) {
  locations[i].addEventListener('click', relocate);
}

function relocate(event) {
  const data = event.target.dataset;
  const view = map.getView();
  view.setCenter(fromLonLat(data.center.split(',').map(Number)));
  view.setZoom(Number(data.zoom));
}
