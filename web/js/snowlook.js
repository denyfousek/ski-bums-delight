// Snow view: a Cesium globe material (fragment shader) that paints a snow cover over the
// imagery. Cover depends on height above the snow line, aspect (north faces hold snow
// lower) and slope (steep faces stay rock, so the imagery underneath shows through).
// Shadows are bluish, sunlit snow is warm, and fine contour lines make the shape readable.
// Everything runs on the GPU per pixel; no raster is computed on the CPU.

export const SNOW_DEFAULTS = {
  snowline: 1800,   // m
  band: 110,        // half width of the patchy transition, m
  aspectShift: 160, // north faces: line this much lower, south faces: higher
  rockFrom: 41,     // degrees: snow starts to thin out
  rockTo: 57,       // degrees: bare rock
  strength: 0.94,   // opacity of full snow
  contours: 1,      // 0 = off
  quality: 0,       // 1 = high quality lighting and close-up detail
  lambertMul: 1.5,  // must match globe.lambertDiffuseMultiplier and vertexShadowDarkness
  lambertFloor: 0.5,
  shadowDark: 1,    // set from the shadow map while terrain shadows are on
  shadowSmooth: 0.3,
  ownShadows: 0,
};

// GLSL for Cesium's Fabric. The normal is taken to world space with czm_inverseViewRotation
// and compared with the area's fixed up/north/east axes; over a few tens of kilometres the
// error of using one set of axes is far below a degree.
const SOURCE = `
uniform float snowline;
uniform float band;
uniform float aspectShift;
uniform float rockFrom;
uniform float rockTo;
uniform float strength;
uniform float contours;
uniform float selfShade;
uniform vec3 upAxis;
uniform vec3 northAxis;
uniform vec3 eastAxis;
uniform vec3 eyeOffset;     // camera position minus the area centre, set every frame in double precision
uniform float quality;      // 1 = high quality lighting and close-up detail
uniform float lambertMul;   // Cesium's own terrain shading: clamp(lambert * lambertMul + lambertFloor)
uniform float lambertFloor;
uniform float shadowDark;   // darkness of Cesium's terrain shadows; 1 = shadows off
uniform float shadowSmooth; // their fade-in over dot(normal, light)
uniform float ownShadows;   // 1 = the shadow pass uses sbd_shadowRatio (see quality.js)

// What a cast shadow leaves of this fragment's colour, per channel. Cesium's shadow pass
// normally multiplies everything by one grey value; with the patch in quality.js it
// multiplies by this instead, so a shadow takes away the sunlight and keeps the sky light.
#define SBD_SNOW
vec3 sbd_shadowRatio = vec3(1.0);

float sbdHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float sbdNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sbdHash(i), sbdHash(i + vec2(1.0, 0.0)), f.x),
             mix(sbdHash(i + vec2(0.0, 1.0)), sbdHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Value noise with its gradient: x = value 0..1, yz = d/dp.
vec3 sbdNoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = sbdHash(i);
  float b = sbdHash(i + vec2(1.0, 0.0));
  float c = sbdHash(i + vec2(0.0, 1.0));
  float d = sbdHash(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float sbdContour(float h, float interval) {
  float f = fract(h / interval);
  float d = min(f, 1.0 - f) * interval;
  float w = max(fwidth(h), 0.0001);
  float line = 1.0 - smoothstep(w * 0.35, w * 1.1, d);
  // Where one pixel spans a large part of the interval the lines would merge into a band.
  return line * (1.0 - smoothstep(interval * 0.15, interval * 0.45, w));
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec3 nEC = normalize(materialInput.normalEC);
  vec3 n = normalize(czm_inverseViewRotation * nEC);
  float up = clamp(dot(n, upAxis), 0.0, 1.0);
  float slope = acos(up);
  float horizontal = sqrt(max(1.0 - up * up, 0.000001));
  float northness = dot(n, northAxis) / horizontal;      // +1 faces north, -1 faces south
  float steepness = smoothstep(0.09, 0.45, slope);        // flat ground has no aspect
  float h = materialInput.height;

  // Position relative to the area centre. Going through absolute world coordinates would
  // leave about half a metre of float precision; eye-relative plus a precise offset keeps millimetres.
  vec3 world = czm_inverseViewRotation * (-materialInput.positionToEyeEC) + eyeOffset;
  vec2 ground = vec2(dot(world, eastAxis), dot(world, northAxis));
  float dist = length(materialInput.positionToEyeEC);
  float coarse = sbdNoise(ground / 140.0);
  float fine = sbdNoise(ground / 31.0);
  float mottle = coarse * 0.65 + fine * 0.35 - 0.5;        // -0.5 .. 0.5

  float line = snowline - aspectShift * northness * steepness;
  float cover = smoothstep(line - band, line + band, h + mottle * band * 1.6);
  float rock = smoothstep(radians(rockFrom), radians(rockTo), slope + mottle * 0.16);
  float snow = cover * (1.0 - rock);

  vec3 colour;
  vec3 shadowCol = vec3(0.0); // the same fragment with the sun blocked
  float veil = 0.0; // cold grey over rock above the snow line (high quality only)
  if (quality > 0.5) {
    // ---- high quality: own lighting with close-up detail ----
    vec3 L = czm_lightDirectionEC;
    vec3 V = normalize(materialInput.positionToEyeEC);
    vec3 upEC = czm_viewRotation * upAxis;
    float pixel = max(length(fwidth(ground)), 0.0005);            // metres on the ground per pixel

    // Surface detail as a tilt of the normal: wind ripples (0.25 m across, 1.6 m along, lying
    // across the fall line would need the wind; a fixed west wind is assumed), drift waves of
    // about 4 m and broad undulations of 25 m. Each fades out before it gets smaller than a pixel.
    vec2 rip = vec2(dot(ground, vec2(0.94, 0.34)), dot(ground, vec2(-0.34, 0.94)));
    vec3 n1 = sbdNoiseD(rip * vec2(4.0, 0.62));
    vec3 n2 = sbdNoiseD(ground * 0.27 + 17.3);
    vec3 n3 = sbdNoiseD(ground * 0.041 + 5.1);
    float f1 = (1.0 - smoothstep(0.035, 0.09, pixel)) * (1.0 - smoothstep(0.5, 0.95, slope));
    float f2 = 1.0 - smoothstep(0.5, 1.4, pixel);
    float f3 = 1.0 - smoothstep(3.0, 9.0, pixel);
    vec2 g1 = vec2(n1.y * 4.0 * 0.94 - n1.z * 0.62 * 0.34, n1.y * 4.0 * 0.34 + n1.z * 0.62 * 0.94);
    vec2 tilt = g1 * 0.012 * f1 + n2.yz * 0.27 * 0.16 * f2 + n3.yz * 0.041 * 0.9 * f3; // height gradients (m per m)
    vec3 nW = normalize(n - (eastAxis * tilt.x + northAxis * tilt.y) * (0.35 + 0.65 * up));
    vec3 N = normalize(czm_viewRotation * nW);

    // Sun: warm, and warmer the lower it stands; nothing once it is below the horizon.
    float sunHeight = dot(L, upEC);
    float sunUp = smoothstep(-0.02, 0.06, sunHeight);
    vec3 sunCol = mix(vec3(1.12, 0.80, 0.56), vec3(0.98, 0.93, 0.85), smoothstep(0.02, 0.30, sunHeight)) * sunUp;
    float NL = dot(N, L);
    float direct = smoothstep(-0.03, 0.10, NL) * max(NL, 0.0);     // soft edge at the terminator
    // Light scattered inside the snow carries a little past the terminator.
    float glow = smoothstep(-0.25, 0.05, NL) * (1.0 - smoothstep(0.05, 0.35, NL)) * 0.06;

    // Sky: blue from above, less of it on steep faces and in hollows.
    float skyView = 0.5 + 0.5 * dot(N, upEC);
    // Curvature from screen-space derivatives: normals that spread apart mean a ridge,
    // normals that converge mean a hollow.
    vec3 dpx = dFdx(world); vec3 dpy = dFdy(world);
    vec3 dnx = dFdx(n); vec3 dny = dFdy(n);
    float curv = (dot(dnx, dpx) + dot(dny, dpy)) / (dot(dpx, dpx) + dot(dpy, dpy) + 0.000001); // 1/m
    float hollow = clamp(curv * 5.0, -1.0, 1.0);                    // -1 hollow .. +1 ridge
    float open = clamp(0.86 + 0.20 * hollow, 0.62, 1.06);
    vec3 skyCol = mix(vec3(0.30, 0.40, 0.66), vec3(0.41, 0.60, 0.95), sunUp) * (0.55 + 0.45 * sunUp);
    vec3 ambient = skyCol * (0.30 + 0.46 * skyView) * open;
    // Snow facing snow: slopes get some warm light back from the sunlit ground around them.
    ambient += sunCol * 0.07 * (1.0 - skyView) * 2.0;

    vec3 albedo = vec3(0.93, 0.95, 0.97) * (0.985 + 0.03 * fine);
    colour = albedo * (sunCol * (direct + glow) + ambient);
    shadowCol = albedo * ambient;

    // Sheen towards the sun and single crystals that flash.
    vec3 H = normalize(L + V);
    float NH = max(dot(N, H), 0.0);
    float lit = smoothstep(0.0, 0.12, NL) * sunUp;
    colour += sunCol * pow(NH, 28.0) * 0.20 * lit;
    float cellSize = max(0.035, pixel * 1.6);
    vec2 cellId = floor(ground / cellSize);
    float crystal = sbdHash(cellId);
    float facet = fract(crystal * 57.3 + dot(V, vec3(31.0, 17.0, 23.0)) + dot(L, vec3(13.0, 29.0, 7.0)));
    float sparkle = step(0.994, crystal) * smoothstep(0.55, 1.0, facet) * pow(NH, 3.0);
    colour += sunCol * sparkle * 1.6 * lit * (1.0 - smoothstep(60.0, 420.0, dist));
    // At a flat angle of view snow mirrors a little of the sky.
    vec3 mirror = skyCol * pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.16;
    colour += mirror;
    shadowCol += mirror;

    // Rock above the snow line: a cold grey veil takes the summer green out of the aerial
    // image, and a little snow stays on its ledges.
    float ledge = smoothstep(0.50, 0.78, coarse * 0.5 + fine * 0.5) * smoothstep(0.35, 0.75, up);
    vec3 rockCol = vec3(0.34, 0.35, 0.39) * (sunCol * direct * 0.9 + ambient * 0.9);
    float dusting = cover * rock * ledge * 0.85;
    veil = cover * rock * 0.42 * (1.0 - ledge);
    float snowA = clamp(snow + dusting, 0.0, 1.0) * strength;
    float total = snowA + (1.0 - snowA) * veil;
    colour = (colour * snowA + rockCol * (1.0 - snowA) * veil) / max(total, 0.0001);
    vec3 rockShade = vec3(0.34, 0.35, 0.39) * ambient * 0.9;
    shadowCol = (shadowCol * snowA + rockShade * (1.0 - snowA) * veil) / max(total, 0.0001);
    veil = total; // final opacity

    // Bright snow rolls off softly towards white instead of cutting off flat.
    colour = mix(colour, 0.72 + 0.28 * (1.0 - exp(-(colour - 0.72) / 0.28)), step(0.72, colour));
    shadowCol = mix(shadowCol, 0.72 + 0.28 * (1.0 - exp(-(shadowCol - 0.72) / 0.28)), step(0.72, shadowCol));

    // Cesium multiplies everything by its own terrain shading afterwards; take it out here,
    // so the lighting above is what arrives on screen.
    if (selfShade < 0.5) {
      float nl = dot(nEC, L);
      float theirs = clamp(max(nl, 0.0) * lambertMul + lambertFloor, 0.0, 1.0);
      // Without the shadow patch the shadow map also darkens slopes that face away from
      // the sun by one grey value; take that out too, the terminator is drawn above.
      float selfShadow = ownShadows > 0.5 ? 1.0 : max(clamp(nl / shadowSmooth, 0.0, 1.0), shadowDark);
      colour /= max(theirs * selfShadow, 0.1);
    }
  } else {
    // Light: warm where the sun hits, sky blue in the shade. Cesium multiplies the result by
    // its own Lambert term afterwards (terrain shading on); the shade colour is brighter than
    // white to compensate, since shaded snow is still lit by the sky.
    float lambert = dot(nEC, czm_lightDirectionEC);
    float sun = smoothstep(-0.08, 0.55, lambert);
    vec3 lit = vec3(1.0, 0.975, 0.93);
    vec3 shade = vec3(0.80, 0.93, 1.22);
    colour = mix(shade, lit, sun);
    colour *= mix(1.0, 0.84, smoothstep(0.30, 1.05, slope)); // steeper snow reads darker
    colour *= 0.80 + 0.20 * smoothstep(0.05, 0.95, lambert); // soft modelling inside the sunlit side, which Cesium's own term clips to white
    colour *= 0.97 + 0.06 * fine;                            // slight grain
    if (selfShade > 0.5) {
      colour *= mix(0.62, 1.0, sun);                         // terrain shading switched off
    }
  }

  if (contours > 0.5) {
    float c100 = sbdContour(h, 100.0);
    float c20 = sbdContour(h, 20.0) * (1.0 - smoothstep(2500.0, 6000.0, dist));
    float far = 1.0 - smoothstep(9000.0, 26000.0, dist);  // no line clutter on distant ranges
    float c = max(c100 * 0.34 * far, c20 * 0.20);
    colour = mix(colour, vec3(0.36, 0.47, 0.64), c);
  }

  material.diffuse = colour;
  material.alpha = quality > 0.5 ? veil : snow * strength;
  // Shadow of this fragment: snow keeps its sky light, everything else (map, rock in the
  // aerial image) is darkened by the usual grey value.
  vec3 ratio = quality > 0.5 ? clamp(shadowCol / max(colour * (selfShade < 0.5 ? max(clamp(max(dot(nEC, czm_lightDirectionEC), 0.0) * lambertMul + lambertFloor, 0.0, 1.0), 0.1) : 1.0), vec3(0.0001)), 0.0, 1.0) : vec3(shadowDark);
  sbd_shadowRatio = mix(vec3(shadowDark), ratio, material.alpha);
  return material;
}
`;

// Fixed east/north/up axes and the centre of the area, in Cesium's world frame.
function axes(Cesium, lon, lat) {
  const centre = Cesium.Cartesian3.fromDegrees(lon, lat, 2000);
  const m = Cesium.Transforms.eastNorthUpToFixedFrame(centre);
  const col = (i) => {
    const c = Cesium.Matrix4.getColumn(m, i, new Cesium.Cartesian4());
    return new Cesium.Cartesian3(c.x, c.y, c.z);
  };
  return { centre, eastAxis: col(0), northAxis: col(1), upAxis: col(2), eyeOffset: new Cesium.Cartesian3() };
}

export function createSnowMaterial(Cesium, lon, lat, params = {}) {
  const { centre, ...uniforms } = axes(Cesium, lon, lat);
  const material = new Cesium.Material({
    translucent: false,
    fabric: {
      type: 'SkiBumSnow',
      uniforms: { ...SNOW_DEFAULTS, selfShade: 0, ...params, ...uniforms },
      source: SOURCE,
    },
  });
  material.sbdCentre = centre; // kept in JS only; the shader works relative to it
  return material;
}

// Keeps the shader's eye-relative coordinates exact: call once per frame before rendering.
export function updateSnowEye(Cesium, material, camera) {
  material.uniforms.eyeOffset = Cesium.Cartesian3.subtract(camera.positionWC, material.sbdCentre, new Cesium.Cartesian3());
}

// Moves the material's reference frame to another area.
export function recentreSnowMaterial(Cesium, material, lon, lat) {
  const { centre, ...uniforms } = axes(Cesium, lon, lat);
  Object.assign(material.uniforms, uniforms);
  material.sbdCentre = centre;
}
