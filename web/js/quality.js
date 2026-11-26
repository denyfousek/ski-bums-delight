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
  // The shadow map's "normal shading" switch (see setShadowTerminator) changes the shader
  // text but is not part of Cesium's cache key for it; without this a shader built before
  // the switch would be reused after it.
  const originalKey = sms.getShadowReceiveShaderKeyword;
  if (typeof originalKey === 'function') {
    sms.getShadowReceiveShaderKeyword = function patchedKey(shadowMap, ...rest) {
      const bias = shadowMap && shadowMap._terrainBias;
      return originalKey.call(this, shadowMap, ...rest) + (bias && bias.normalShading === false ? ' sbdOwnTerminator' : '');
    };
  }
  sms.sbdPatched = true;
  return true;
}

// Terrain tiles carry "skirts": vertical walls hanging down from their edges that hide the
// gaps between tiles of different detail. The shadow pass draws them too, and with a low
// sun they cast thin shadow lines along the tile borders: a net instead of filled shadows.
// Measured: with globe.showSkirts = false the lines are gone. The skirts' triangles are the
// last ones in a tile's index list, so the commands that draw a tile into the shadow map
// simply stop before them. The picture itself keeps the skirts.
// Upstream: CesiumGS/cesium issue 11459 (open); there is no public option. Cesium itself
// cut the skirts from the cast commands until 2016 (its PR 3871).
// Price: gaps between tiles of different detail are no longer closed in the shadow map, so
// a thin lit sliver inside a shadow is possible there.
// Leans on CesiumJS internals as they are in 1.121 (ShadowMap.createCastDerivedCommand,
// TerrainMesh.indexCountWithoutSkirts). Returns false, changing nothing, if they are missing.
export function patchShadowCasters(Cesium) {
  const sm = Cesium.ShadowMap;
  if (!sm || typeof sm.createCastDerivedCommand !== 'function') return false;
  if (sm.sbdNoSkirts) return true;
  const original = sm.createCastDerivedCommand;
  sm.createCastDerivedCommand = function patched(shadowMaps, command, ...rest) {
    const result = original.call(this, shadowMaps, command, ...rest);
    const mesh = command && command.owner && command.owner.data && command.owner.data.renderedMesh;
    const count = mesh && mesh.indexCountWithoutSkirts;
    // Only the triangle list ends with the skirts (the debug wireframe draws line indices).
    const triangles = Cesium.PrimitiveType ? command.primitiveType === Cesium.PrimitiveType.TRIANGLES : true;
    if (count > 0 && triangles && result && Array.isArray(result.castCommands)) {
      for (const cast of result.castCommands) {
        if (cast && cast.count > count) cast.count = count;
      }
    }
    return result;
  };
  sm.sbdNoSkirts = true;
  return true;
}

export function applyQuality(Cesium, viewer, high, mobile = false) {
  const scene = viewer.scene;
  const q = high ? QUALITY.high : QUALITY.standard;
  // Terrain shadows (switched on and off with the sun in main.js).
  const sm = viewer.shadowMap;
  // Four cascades make Cesium allocate a texture twice this size per side: 8192² (about
  // 256 MB) at 4096. Phones stay at 2048 even in high quality.
  sm.size = mobile ? QUALITY.standard.shadowSize : q.shadowSize;
  // Cesium's setters reset the map's "dirty" flag when the value is unchanged, which would
  // cancel a rebuild another call has just asked for; so only assign real changes.
  if (!sm.softShadows) sm.softShadows = true;
  // Cesium fades shadows out while the sun is below about 6°. The snow shader and the
  // patched shadow pass both work with the nominal darkness, so the fade is switched off.
  sm.fadingEnabled = false;
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
