// Worker for terrainsmooth.js: fits the planes off the main thread.
import { fitPlanes } from './terrainsmooth.js';

self.onmessage = (e) => {
  const { id, xs, ys, hs, widthM, heightM, sigma } = e.data;
  const fit = fitPlanes(xs, ys, hs, widthM, heightM, sigma);
  self.postMessage({ id, fit }, [fit.z.buffer, fit.gx.buffer, fit.gy.buffer, fit.ok.buffer]);
};
