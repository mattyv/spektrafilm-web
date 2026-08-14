function clamp(value: number) {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

function linear(value: number) {
  value /= 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function neutralWhiteBalance(red: number, green: number, blue: number) {
  red = linear(red); green = linear(green); blue = linear(blue);
  const temperature = clamp((blue - red) / Math.max(Number.EPSILON, blue + red) * 500);
  const warmRed = red * (1 + temperature / 500);
  const warmBlue = blue * (1 - temperature / 500);
  const average = (warmRed + warmBlue) / 2;
  const tint = clamp((average - green) / Math.max(Number.EPSILON, green + average / 2) * 500);
  return { temperature, tint };
}

export function autoWhiteBalance(pixels: Uint8ClampedArray) {
  let red = 0, green = 0, blue = 0, count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const values = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    if (Math.min(...values) <= 16 || Math.max(...values) >= 240) continue;
    red += values[0];
    green += values[1];
    blue += values[2];
    count += 1;
  }
  return count ? neutralWhiteBalance(red / count, green / count, blue / count) : { temperature: 0, tint: 0 };
}
