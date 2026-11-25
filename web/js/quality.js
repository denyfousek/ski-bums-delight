// Rendering quality of the 3D scene: everything that is not the snow shader itself.
// "High" is meant for a desktop graphics card; phones stay on "standard".

export const QUALITY = {
  standard: { shadowSize: 2048, shadowDistance: 20000, shadowDarkness: 0.45, fogDensity: 0.0002 },
  high: { shadowSize: 4096, shadowDistance: 16000, shadowDarkness: 0.5, fogDensity: 0.00011 },
};

// Cesium's shadow pass ends with "colour *= visibility": one grey value for everything. On
// snow that is wrong twice over: shadows come out grey instead of sky blue, and slopes that
// merely face away from the sun get darkened a second time. The pass is generated as text
// in ShadowMapShader; this swaps its last line for one that multiplies by a per-fragment
// colour ratio the snow shader provides (sbd_shadowRatio in snowlook.js).
// It leans on CesiumJS internals as they are in 1.121. Returns false, changing nothing,
// when the expected line is not there; the snow shader then falls back to a simpler fix.
export function patchShadowPass(Cesium) {
  const sms = Cesium.ShadowMapShader;
  const line = 'out_FragColor.rgb *= visibility;';
  if (!sms || typeof sms.createShadowReceiveFragmentShader !== 'function') return false;
  if (sms.sbdPatched) return true;
  if (!sms.createShadowReceiveFragmentShader.toString().includes(line)) return false;
  const original = sms.createShadowReceiveFragmentShader;
  sms.createShadowReceiveFragmentShader = function patched(...args) {
    const source = original.apply(this, args);
    const last = source.sources.length - 1;
    const text = source.sources[last];
    if (typeof text === 'string' && text.includes(line) && text.includes('shadowParameters.darkness')) {
      source.sources[last] = text.replace(line, `
#ifdef SBD_SNOW
    // 0 = fully shadowed, 1 = fully lit, whatever darkness the shadow map is set to
    float sbdLit = clamp((visibility - shadowParameters.darkness) / max(1.0 - shadowParameters.darkness, 0.0001), 0.0, 1.0);
    out_FragColor.rgb *= mix(sbd_shadowRatio, vec3(1.0), sbdLit);
#else
    ${line}
#endif
`);
    }
    return source;
  };
  sms.sbdPatched = true;
  return true;
}

export function applyQuality(Cesium, viewer, high) {
  const scene = viewer.scene;
  const q = high ? QUALITY.high : QUALITY.standard;
  // Terrain shadows (switched on and off with the sun in main.js).
  const sm = viewer.shadowMap;
  sm.size = q.shadowSize;
  sm.softShadows = true;
  sm.maximumDistance = q.shadowDistance;
  sm.darkness = q.shadowDarkness;
  // Haze: distant ranges fade towards the sky colour.
  scene.fog.enabled = true;
  scene.fog.density = q.fogDensity;
  scene.fog.minimumBrightness = high ? 0.12 : 0.03;
}

// With the patched shadow pass the snow shader draws the line between sun and shade
// itself; the shadow map's own fade over dot(normal, light) would darken sun-grazed slopes
// a second time. `own` = true switches that fade off, false restores Cesium's behaviour.
export function setShadowTerminator(viewer, own) {
  const sm = viewer.shadowMap;
  if (!sm._terrainBias || sm._terrainBias.normalShading === !own) return;
  sm._terrainBias.normalShading = !own;
  sm.dirty = true; // the shadow shaders are rebuilt on the next frame
}
