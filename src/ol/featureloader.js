/**
 * @module ol/featureloader
 */

import MVT from './format/MVT.js';
import RenderFeature from './render/Feature.js';
import {create as createMVTWorker} from './worker/mvt.js';

/**
 *
 * @type {boolean}
 * @private
 */
let withCredentials = false;

/** @type {Worker|undefined} */
let MVT_WORKER;

/** @type {number} */
let mvtWorkerMessageId = 0;

/** @type {Map<number, {resolve: Function, reject: Function}>} */
const mvtWorkerCallbacks = new Map();

const MVT_WORKER_TIMEOUT_MS = 10000;

function getMvtWorker() {
  if (!MVT_WORKER) {
    MVT_WORKER = createMVTWorker();
    MVT_WORKER.onmessage = (event) => {
      const data = event.data;
      const cb = data && mvtWorkerCallbacks.get(data.id);
      if (!cb) {
        return;
      }
      mvtWorkerCallbacks.delete(data.id);
      if (data.error) {
        cb.reject(new Error(data.error));
        return;
      }
      cb.resolve(data);
    };
    MVT_WORKER.onmessageerror = () => {
      const error = new Error('MVT worker message error');
      for (const cb of mvtWorkerCallbacks.values()) {
        cb.reject(error);
      }
      mvtWorkerCallbacks.clear();
    };
    MVT_WORKER.onerror = (event) => {
      const error = new Error(
        event && 'message' in event && event.message
          ? event.message
          : 'MVT worker error',
      );
      for (const cb of mvtWorkerCallbacks.values()) {
        cb.reject(error);
      }
      mvtWorkerCallbacks.clear();
    };
  }
  return MVT_WORKER;
}

/**
 * @param {MVT} format Format.
 * @param {ArrayBuffer} arrayBuffer Tile data.
 * @param {import("./extent.js").Extent} extent Tile extent.
 * @return {Promise<Array<RenderFeature>>} Parsed features.
 */
function readMvtFeaturesInWorker(format, arrayBuffer, extent) {
  const worker = getMvtWorker();
  const id = ++mvtWorkerMessageId;
  /** @type {any} */
  const mvt = format;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      mvtWorkerCallbacks.delete(id);
      reject(new Error('MVT worker timeout'));
    }, MVT_WORKER_TIMEOUT_MS);
    mvtWorkerCallbacks.set(id, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    worker.postMessage({
      type: 'MVT_READ_FEATURES',
      id,
      arrayBuffer,
      extent,
      options: {
        geometryName: mvt.geometryName_,
        layerName: mvt.layerName_,
        layers: mvt.layers_,
        idProperty: mvt.idProperty_,
        properties: mvt.properties_,
      },
    });
  }).then((result) => {
    const meta = new Uint32Array(result.meta);
    const coords = new Float32Array(result.coords);
    const ends = new Uint32Array(result.ends);
    const ids = result.ids;
    const properties = result.properties;
    const propNames = result.propNames;
    const propStringTable = result.propStringTable;
    const propTypesBuffers = result.propTypes;
    const propNumbersBuffers = result.propNumbers;
    const propStringsBuffers = result.propStrings;
    const propBoolsBuffers = result.propBools;
    const types = result.types;

    const featureCount = ids.length;
    const features = new Array(featureCount);

    let decodedProperties = properties;
    if (
      !decodedProperties &&
      propNames &&
      propStringTable &&
      propTypesBuffers
    ) {
      const propCount = propNames.length;
      const propTypes = new Array(propCount);
      const propNumbers = new Array(propCount);
      const propStrings = new Array(propCount);
      const propBools = new Array(propCount);
      for (let p = 0; p < propCount; p++) {
        propTypes[p] = new Uint8Array(propTypesBuffers[p]);
        propNumbers[p] = new Float64Array(propNumbersBuffers[p]);
        propStrings[p] = new Uint32Array(propStringsBuffers[p]);
        propBools[p] = new Uint8Array(propBoolsBuffers[p]);
      }

      decodedProperties = new Array(featureCount);
      for (let i = 0; i < featureCount; i++) {
        /** @type {Object<string, *>} */
        const props = {};
        for (let p = 0; p < propCount; p++) {
          const code = propTypes[p][i];
          if (code === 0) {
            continue;
          }
          const name = propNames[p];
          if (code === 1) {
            props[name] = propNumbers[p][i];
          } else if (code === 2) {
            props[name] = propStringTable[propStrings[p][i]] || '';
          } else if (code === 3) {
            props[name] = propBools[p][i] > 0;
          }
        }
        decodedProperties[i] = props;
      }
    }

    for (let i = 0; i < featureCount; i++) {
      const typeCode = meta[i * 5 + 0];
      const coordOffset = meta[i * 5 + 1];
      const coordLength = meta[i * 5 + 2];
      const endsOffset = meta[i * 5 + 3];
      const endsLength = meta[i * 5 + 4];

      const flatCoordinates = Array.from(
        coords.subarray(coordOffset, coordOffset + coordLength),
      );
      const featureEnds =
        endsLength > 0
          ? Array.from(ends.subarray(endsOffset, endsOffset + endsLength))
          : null;

      features[i] = new RenderFeature(
        types[typeCode] || 'Point',
        flatCoordinates,
        featureEnds,
        2,
        decodedProperties ? decodedProperties[i] : {},
        ids[i],
      );
    }
    return features;
  });
}

/**
 * {@link module:ol/source/Vector~VectorSource} sources use a function of this type to
 * load features.
 *
 * This function takes up to 5 arguments. These are an {@link module:ol/extent~Extent} representing
 * the area to be loaded, a `{number}` representing the resolution (map units per pixel), a
 * {@link module:ol/proj/Projection~Projection} for the projection, an optional success callback that should get
 * the loaded features passed as an argument and an optional failure callback with no arguments. If
 * the callbacks are not used, the corresponding vector source will not fire `'featuresloadend'` and
 * `'featuresloaderror'` events. `this` within the function is bound to the
 * {@link module:ol/source/Vector~VectorSource} it's called from.
 *
 * The function is responsible for loading the features and adding them to the
 * source.
 *
 * @template {import("./Feature.js").FeatureLike} [FeatureType=import("./Feature.js").FeatureLike]
 * @typedef {(
 *           extent: import("./extent.js").Extent,
 *           resolution: number,
 *           projection: import("./proj/Projection.js").default,
 *           success?: (features: Array<FeatureType>) => void,
 *           failure?: () => void) => void} FeatureLoader
 * @api
 */

/**
 * {@link module:ol/source/Vector~VectorSource} sources use a function of this type to
 * get the url to load features from.
 *
 * This function takes an {@link module:ol/extent~Extent} representing the area
 * to be loaded, a `{number}` representing the resolution (map units per pixel)
 * and an {@link module:ol/proj/Projection~Projection} for the projection  as
 * arguments and returns a `{string}` representing the URL.
 * @typedef {function(import("./extent.js").Extent, number, import("./proj/Projection.js").default): string} FeatureUrlFunction
 * @api
 */

/**
 * @template {import("./Feature.js").FeatureLike} [FeatureType=import("./Feature.js").default]
 * @param {string|FeatureUrlFunction} url Feature URL service.
 * @param {import("./format/Feature.js").default<FeatureType>} format Feature format.
 * @param {import("./extent.js").Extent} extent Extent.
 * @param {number} resolution Resolution.
 * @param {import("./proj/Projection.js").default} projection Projection.
 * @param {function(Array<FeatureType>, import("./proj/Projection.js").default): void} success Success
 *      Function called with the loaded features and optionally with the data projection.
 * @param {function(): void} failure Failure
 *      Function called when loading failed.
 */
export function loadFeaturesXhr(
  url,
  format,
  extent,
  resolution,
  projection,
  success,
  failure,
) {
  const xhr = new XMLHttpRequest();
  xhr.open(
    'GET',
    typeof url === 'function' ? url(extent, resolution, projection) : url,
    true,
  );
  if (format.getType() == 'arraybuffer') {
    xhr.responseType = 'arraybuffer';
  }
  xhr.withCredentials = withCredentials;
  /**
   * @param {Event} event Event.
   * @private
   */
  xhr.onload = function (event) {
    // status will be 0 for file:// urls
    if (!xhr.status || (xhr.status >= 200 && xhr.status < 300)) {
      const type = format.getType();
      try {
        /** @type {Document|Node|Object|string|undefined} */
        let source;
        if (type == 'text' || type == 'json') {
          source = xhr.responseText;
        } else if (type == 'xml') {
          source = xhr.responseXML || xhr.responseText;
        } else if (type == 'arraybuffer') {
          source = /** @type {ArrayBuffer} */ (xhr.response);
        }
        if (source) {
          if (
            type === 'arraybuffer' &&
            typeof Worker !== 'undefined' &&
            format instanceof MVT &&
            format.featureClass === RenderFeature
          ) {
            readMvtFeaturesInWorker(format, source, extent)
              .then((features) => {
                success(
                  /** @type {Array<FeatureType>} */ (features),
                  format.readProjection(source),
                );
              })
              .catch(() => {
                try {
                  success(
                    /** @type {Array<FeatureType>} */
                    (
                      format.readFeatures(source, {
                        extent: extent,
                        featureProjection: projection,
                      })
                    ),
                    format.readProjection(source),
                  );
                } catch {
                  failure();
                }
              });
          } else {
            success(
              /** @type {Array<FeatureType>} */
              (
                format.readFeatures(source, {
                  extent: extent,
                  featureProjection: projection,
                })
              ),
              format.readProjection(source),
            );
          }
        } else {
          failure();
        }
      } catch {
        failure();
      }
    } else {
      failure();
    }
  };
  /**
   * @private
   */
  xhr.onerror = failure;
  xhr.send();
}

/**
 * Create an XHR feature loader for a `url` and `format`. The feature loader
 * loads features (with XHR), parses the features, and adds them to the
 * vector source.
 *
 * @template {import("./Feature.js").FeatureLike} [FeatureType=import("./Feature.js").default]
 * @param {string|FeatureUrlFunction} url Feature URL service.
 * @param {import("./format/Feature.js").default<FeatureType>} format Feature format.
 * @return {FeatureLoader<FeatureType>} The feature loader.
 * @api
 */
export function xhr(url, format) {
  /**
   * @param {import("./extent.js").Extent} extent Extent.
   * @param {number} resolution Resolution.
   * @param {import("./proj/Projection.js").default} projection Projection.
   * @param {function(Array<FeatureType>): void} [success] Success
   *      Function called when loading succeeded.
   * @param {function(): void} [failure] Failure
   *      Function called when loading failed.
   * @this {import("./source/Vector.js").default<FeatureType>}
   */
  return function (extent, resolution, projection, success, failure) {
    loadFeaturesXhr(
      url,
      format,
      extent,
      resolution,
      projection,
      /**
       * @param {Array<FeatureType>} features The loaded features.
       * @param {import("./proj/Projection.js").default} dataProjection Data
       * projection.
       */
      (features, dataProjection) => {
        this.addFeatures(features);
        if (success !== undefined) {
          success(features);
        }
      },
      () => {
        this.changed();
        if (failure !== undefined) {
          failure();
        }
      },
    );
  };
}

/**
 * Setter for the withCredentials configuration for the XHR.
 *
 * @param {boolean} xhrWithCredentials The value of withCredentials to set.
 * Compare https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/
 * @api
 */
export function setWithCredentials(xhrWithCredentials) {
  withCredentials = xhrWithCredentials;
}
