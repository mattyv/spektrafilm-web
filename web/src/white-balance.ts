function clamp(value: number) {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

export function neutralWhiteBalance(red: number, green: number, blue: number) {
  const temperature = clamp((blue - red) / Math.max(1, blue + red) * 500);
  const warmRed = red * (1 + temperature / 500);
  const warmBlue = blue * (1 - temperature / 500);
  const average = (warmRed + warmBlue) / 2;
  const tint = clamp((average - green) / Math.max(1, green + average / 2) * 500);
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
