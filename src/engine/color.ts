// Color conversions used by the pen.

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export function decimalToRgb(decimal: number): Rgb {
  const a = (decimal >> 24) & 0xff;
  const r = (decimal >> 16) & 0xff;
  const g = (decimal >> 8) & 0xff;
  const b = decimal & 0xff;
  return { r, g, b, a: a > 0 ? a : 255 };
}

export function hexToRgb(hex: string): Rgb | null {
  hex = hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (_m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  h %= 360;
  if (h < 0) h += 360;
  s = Math.max(0, Math.min(s, 1));
  v = Math.max(0, Math.min(v, 1));
  const i = Math.floor(h / 60);
  const f = h / 60 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let r: number;
  let g: number;
  let b: number;
  switch (i) {
    default:
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r: Math.floor(r * 255), g: Math.floor(g * 255), b: Math.floor(b * 255) };
}

export function rgbToHsv(rgb: Rgb): { h: number; s: number; v: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const x = Math.min(Math.min(r, g), b);
  const v = Math.max(Math.max(r, g), b);
  let h = 0;
  let s = 0;
  if (x !== v) {
    const f = r === x ? g - b : g === x ? b - r : r - g;
    const i = r === x ? 3 : g === x ? 5 : 1;
    h = ((i - f / (v - x)) * 60) % 360;
    s = (v - x) / v;
  }
  return { h, s, v };
}
