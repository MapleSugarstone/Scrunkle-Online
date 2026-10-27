// Shaders for sprites, stamps and pen lines. Colors are premultiplied by alpha throughout.

export const EFFECT_BITS = {
  color: 1 << 0,
  fisheye: 1 << 1,
  whirl: 1 << 2,
  pixelate: 1 << 3,
  mosaic: 1 << 4,
  brightness: 1 << 5,
  ghost: 1 << 6,
  tint: 1 << 7,
} as const;

export const VERTEX = `
precision mediump float;
#ifdef LINE
uniform vec2 u_stageSize;
uniform float u_lineThickness;
uniform float u_lineLength;
// xy: first point, zw: offset to the second point (subtracting on the GPU loses precision).
uniform vec4 u_penPoints;
const float epsilon = 1e-3;
#else
uniform mat4 u_projectionMatrix;
uniform mat4 u_modelMatrix;
attribute vec2 a_texCoord;
#endif
attribute vec2 a_position;
varying vec2 v_texCoord;

void main() {
#ifdef LINE
  // A quad around the segment, padded so antialiased edges fit at any angle.
  float pad = (u_lineThickness * 0.5) + 1.4142135623730951;
  v_texCoord.x = mix(0.0, u_lineLength + (pad * 2.0), a_position.x) - pad;
  v_texCoord.y = ((a_position.y - 0.5) * pad) + 0.5;
  vec2 p = a_position;
  p.x *= u_lineLength + (2.0 * pad);
  p.y *= 2.0 * pad;
  p -= pad;
  vec2 diff = u_penPoints.zw;
  diff.x = (abs(diff.x) < epsilon && abs(diff.y) < epsilon) ? epsilon : diff.x;
  vec2 dir = diff / max(u_lineLength, epsilon);
  p = mat2(dir.x, dir.y, -dir.y, dir.x) * p;
  p += u_penPoints.xy;
  p *= 2.0 / u_stageSize;
  gl_Position = vec4(p, 0, 1);
#else
  gl_Position = u_projectionMatrix * u_modelMatrix * vec4(a_position, 0, 1);
  v_texCoord = a_texCoord;
#endif
}
`;

export const FRAGMENT = `
precision mediump float;
#ifdef ENABLE_color
uniform float u_color;
#endif
#ifdef ENABLE_brightness
uniform float u_brightness;
#endif
#ifdef ENABLE_fisheye
uniform float u_fisheye;
#endif
#ifdef ENABLE_whirl
uniform float u_whirl;
#endif
#ifdef ENABLE_pixelate
uniform float u_pixelate;
uniform vec2 u_skinSize;
#endif
#ifdef ENABLE_mosaic
uniform float u_mosaic;
#endif
#ifdef ENABLE_ghost
uniform float u_ghost;
#endif
#ifdef ENABLE_tint
uniform vec4 u_tint;
#endif
#ifdef LINE
uniform vec4 u_lineColor;
uniform float u_lineThickness;
uniform float u_lineLength;
#endif
uniform sampler2D u_skin;
varying vec2 v_texCoord;
const float epsilon = 1e-3;

#ifdef ENABLE_color
// Branchless RGB/HSV conversions; all channels in [0, 1].
vec3 rgbToHsv(vec3 rgb) {
  const vec4 offsets = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 a = rgb.b > rgb.g ? vec4(rgb.bg, offsets.wz) : vec4(rgb.gb, offsets.xy);
  vec4 b = rgb.r > a.x ? vec4(rgb.r, a.yzx) : vec4(a.xyw, rgb.r);
  float lo = min(b.y, b.w);
  float chroma = b.x - lo;
  return vec3(abs(b.z + (b.w - b.y) / (6.0 * chroma + epsilon)), chroma / (b.x + epsilon), b.x);
}
vec3 hueToRgb(float h) {
  float r = abs(h * 6.0 - 3.0) - 1.0;
  float g = 2.0 - abs(h * 6.0 - 2.0);
  float b = 2.0 - abs(h * 6.0 - 4.0);
  return clamp(vec3(r, g, b), 0.0, 1.0);
}
vec3 hsvToRgb(vec3 hsv) {
  vec3 rgb = hueToRgb(hsv.x);
  float c = hsv.z * hsv.y;
  return rgb * c + hsv.z - c;
}
#endif

const vec2 kCenter = vec2(0.5, 0.5);

void main() {
#ifdef LINE
  // Distance from the segment, with round caps, turned into coverage.
  float along = ((v_texCoord.x - clamp(v_texCoord.x, 0.0, u_lineLength)) * 0.5) + 0.5;
  float dist = distance(vec2(0.5), vec2(along, v_texCoord.y)) * 2.0;
  dist -= ((u_lineThickness - 1.0) * 0.5);
  gl_FragColor = u_lineColor * clamp(1.0 - dist, 0.0, 1.0);
#else
  vec2 uv = v_texCoord;
#ifdef ENABLE_mosaic
  uv = fract(u_mosaic * uv);
#endif
#ifdef ENABLE_pixelate
  {
    vec2 cells = u_skinSize / u_pixelate;
    uv = (floor(uv * cells) + kCenter) / cells;
  }
#endif
#ifdef ENABLE_whirl
  {
    vec2 offset = uv - kCenter;
    float falloff = max(1.0 - (length(offset) / 0.5), 0.0);
    float angle = u_whirl * falloff * falloff;
    float s = sin(angle);
    float c = cos(angle);
    uv = mat2(c, -s, s, c) * offset + kCenter;
  }
#endif
#ifdef ENABLE_fisheye
  {
    vec2 v = (uv - kCenter) / kCenter;
    float len = length(v);
    float r = pow(min(len, 1.0), u_fisheye) * max(1.0, len);
    uv = kCenter + r * (v / len) * kCenter;
  }
#endif
  gl_FragColor = texture2D(u_skin, uv);
#if defined(ENABLE_color) || defined(ENABLE_brightness) || defined(ENABLE_tint)
  gl_FragColor.rgb = clamp(gl_FragColor.rgb / (gl_FragColor.a + epsilon), 0.0, 1.0);
#ifdef ENABLE_color
  {
    vec3 hsv = rgbToHsv(gl_FragColor.xyz);
    // Near-gray pixels get a little saturation so a hue shift still shows.
    const float minLightness = 0.11 / 2.0;
    const float minSaturation = 0.09;
    if (hsv.z < minLightness) hsv = vec3(0.0, 1.0, minLightness);
    else if (hsv.y < minSaturation) hsv = vec3(0.0, minSaturation, hsv.z);
    hsv.x = mod(hsv.x + u_color, 1.0);
    if (hsv.x < 0.0) hsv.x += 1.0;
    gl_FragColor.rgb = hsvToRgb(hsv);
  }
#endif
#ifdef ENABLE_brightness
  gl_FragColor.rgb = clamp(gl_FragColor.rgb + vec3(u_brightness), vec3(0), vec3(1));
#endif
#ifdef ENABLE_tint
  // Paints the pixel in the tint color, darker where the pixel is darker, so shading stays and black still shows the color.
  {
    float light = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
    vec3 painted = u_tint.rgb * (0.4 + 0.6 * clamp(light * 1.4, 0.0, 1.0));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, painted, u_tint.a);
  }
#endif
  gl_FragColor.rgb *= gl_FragColor.a + epsilon;
#endif
#ifdef ENABLE_ghost
  gl_FragColor *= u_ghost;
#endif
#endif
}
`;
