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
uniform vec3 centre;

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

  vec3 world = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz - centre;
  vec2 ground = vec2(dot(world, eastAxis), dot(world, northAxis));
  float coarse = sbdNoise(ground / 140.0);
  float fine = sbdNoise(ground / 31.0);
  float mottle = coarse * 0.65 + fine * 0.35 - 0.5;        // -0.5 .. 0.5

  float line = snowline - aspectShift * northness * steepness;
  float cover = smoothstep(line - band, line + band, h + mottle * band * 1.6);
  float rock = smoothstep(radians(rockFrom), radians(rockTo), slope + mottle * 0.16);
  float snow = cover * (1.0 - rock);

  // Light: warm where the sun hits, sky blue in the shade. Cesium multiplies the result by
  // its own Lambert term afterwards (terrain shading on); the shade colour is brighter than
  // white to compensate, since shaded snow is still lit by the sky.
  float lambert = dot(nEC, czm_lightDirectionEC);
  float sun = smoothstep(-0.08, 0.55, lambert);
  vec3 lit = vec3(1.0, 0.975, 0.93);
  vec3 shade = vec3(0.80, 0.93, 1.22);
  vec3 colour = mix(shade, lit, sun);
  colour *= mix(1.0, 0.84, smoothstep(0.30, 1.05, slope)); // steeper snow reads darker
  colour *= 0.80 + 0.20 * smoothstep(0.05, 0.95, lambert); // soft modelling inside the sunlit side, which Cesium's own term clips to white
  colour *= 0.97 + 0.06 * fine;                            // slight grain
  if (selfShade > 0.5) {
    colour *= mix(0.62, 1.0, sun);                         // terrain shading switched off
  }

  if (contours > 0.5) {
    float dist = length(materialInput.positionToEyeEC);
    float c100 = sbdContour(h, 100.0);
    float c20 = sbdContour(h, 20.0) * (1.0 - smoothstep(2500.0, 6000.0, dist));
    float far = 1.0 - smoothstep(9000.0, 26000.0, dist);  // no line clutter on distant ranges
    float c = max(c100 * 0.34 * far, c20 * 0.20);
    colour = mix(colour, vec3(0.36, 0.47, 0.64), c);
  }

  material.diffuse = colour;
  material.alpha = snow * strength;
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
  return { centre, eastAxis: col(0), northAxis: col(1), upAxis: col(2) };
}

export function createSnowMaterial(Cesium, lon, lat, params = {}) {
  return new Cesium.Material({
    translucent: false,
    fabric: {
      type: 'SkiBumSnow',
      uniforms: { ...SNOW_DEFAULTS, selfShade: 0, ...params, ...axes(Cesium, lon, lat) },
      source: SOURCE,
    },
  });
}

// Moves the material's reference frame to another area.
export function recentreSnowMaterial(Cesium, material, lon, lat) {
  Object.assign(material.uniforms, axes(Cesium, lon, lat));
}
