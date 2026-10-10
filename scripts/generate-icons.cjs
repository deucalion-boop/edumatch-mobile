// Deterministic, original EduMatch launcher artwork. No image service needed.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const size = 1024;
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, checksum]);
}
function inside(x, y, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function png(transparent) {
  const image = Buffer.alloc(size * (size * 4 + 1));
  const bookLeft = [[248, 443], [472, 474], [491, 508], [491, 748], [454, 715], [248, 687]];
  const bookRight = [[533, 508], [552, 474], [776, 443], [776, 687], [570, 715], [533, 748]];
  const cap = [[220, 353], [512, 228], [804, 353], [512, 481]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let rgba = transparent ? [0, 0, 0, 0] : [9, 106, 86, 255];
    if (inside(x, y, bookLeft) || inside(x, y, bookRight)) rgba = [255, 255, 255, 255];
    if (inside(x, y, cap)) rgba = [223, 243, 173, 255];
    if (x > 779 && x < 799 && y > 354 && y < 520) rgba = [223, 243, 173, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 4; channel++) image[offset + channel] = rgba[channel];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(image)), chunk('IEND', Buffer.alloc(0))]);
}
const target = path.resolve(__dirname, '../assets');
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'icon.png'), png(false));
fs.writeFileSync(path.join(target, 'adaptive-icon.png'), png(true));
console.log('Generated EduMatch launcher assets.');
