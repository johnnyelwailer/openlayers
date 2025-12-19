/**
 * @module ol/render/webgpu/vectorstylerenderer/patterns
 */

/**
 * @typedef {Object} StrokePatternTexture
 * @property {GPUSampler} sampler Sampler.
 * @property {GPUTextureView} view Texture view.
 * @property {[number, number]} size Texture size in pixels.
 */

/**
 * @param {import('../VectorStyleRenderer.js').default} renderer Vector style renderer.
 * @param {string} src Image URL or data URL.
 * @return {Promise<StrokePatternTexture>} Texture resources.
 */
export async function getPatternTexture(renderer, src) {
  /** @type {any} */
  const r = renderer;
  const cached = r.patternTextureCache_.get(src);
  if (cached) {
    return cached;
  }

  const device = r.helper_.getDevice();
  const loadPromise = (async () => {
    /** @type {ImageBitmap|HTMLImageElement} */
    let imageSource;
    /** @type {number} */
    let width;
    /** @type {number} */
    let height;
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      imageSource = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } catch {
      // Some image types (notably SVG in headless Chromium) are not reliably supported by createImageBitmap().
      // Fallback to HTMLImageElement decoding.
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = src;
      await image.decode();
      imageSource = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
    }

    const TEXTURE_BINDING = 0x04;
    const COPY_DST = 0x02;
    const RENDER_ATTACHMENT = 0x10;
    const texture = device.createTexture({
      size: {width, height},
      format: 'rgba8unorm',
      usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      {source: imageSource},
      {texture},
      {width, height},
    );

    const sampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    return {
      sampler,
      view: texture.createView(),
      size: /** @type {[number, number]} */ ([width, height]),
    };
  })();

  r.patternTextureCache_.set(src, loadPromise);
  return loadPromise;
}
