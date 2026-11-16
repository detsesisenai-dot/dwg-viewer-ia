// Paleta AutoCAD Color Index (ACI) 0–255, gerada algoritmicamente.
const BASE = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255],
  5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192]
};
const GRAYS = [51, 91, 132, 173, 214, 255]; // 250–255
const BRIGHT = [1, 0.8, 0.6, 0.5, 0.3];

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const PALETTE = new Array(256);
for (let i = 0; i < 256; i++) {
  let rgb;
  if (BASE[i]) rgb = BASE[i];
  else if (i >= 10 && i <= 249) {
    const k = i - 10;
    const hue = Math.floor(k / 10) * 15;
    const variant = k % 10;
    const v = BRIGHT[Math.floor(variant / 2)];
    const s = variant % 2 === 0 ? 1 : 0.5;
    rgb = hsvToRgb(hue, s, v);
  } else if (i >= 250) rgb = [GRAYS[i - 250], GRAYS[i - 250], GRAYS[i - 250]];
  else rgb = [255, 255, 255];
  PALETTE[i] = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export function aciToCss(index) {
  return PALETTE[index] ?? PALETTE[7];
}

export function rgbIntToCss(rgb) {
  return `rgb(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255})`;
}
