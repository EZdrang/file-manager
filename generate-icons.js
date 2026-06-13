const fs = require('fs');
const path = require('path');

// Modern file manager icon - clean folder design with gradient
// Design: stylized folder with document peeking out, purple/indigo theme

function createPNG(width, height, drawFn) {
  const pixels = Buffer.alloc(width * height * 4);
  drawFn(pixels, width, height);
  
  // PNG encoder (minimal)
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }
  
  // Deflate raw pixel data
  const rawRow = Buffer.alloc(width * (height * 4 + 1));
  for (let y = 0; y < height; y++) {
    rawRow[y * (width * 4 + 1)] = 0; // filter: none
    pixels.copy(rawRow, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawRow);
  
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function drawIcon(pixels, w, h) {
  const cx = w / 2, cy = h / 2;
  
  // Color palette (modern purple/indigo gradient)
  const colors = {
    folderBack:  [79, 70, 229],    // #4f46e5
    folderFront: [99, 102, 241],   // #6366f1
    folderTop:   [129, 140, 248],  // #818cf8
    document:    [255, 255, 255],  // white
    docShadow:   [229, 231, 235],  // #e5e7eb
    accent:      [168, 85, 247],   // #a855f7
  };
  
  function setPixel(x, y, r, g, b, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = (y * w + x) * 4;
    const srcA = pixels[idx + 3] / 255;
    const dstA = a / 255;
    const outA = dstA + srcA * (1 - dstA);
    if (outA > 0) {
      pixels[idx] = Math.round((r * dstA + pixels[idx] * srcA * (1 - dstA)) / outA);
      pixels[idx + 1] = Math.round((g * dstA + pixels[idx + 1] * srcA * (1 - dstA)) / outA);
      pixels[idx + 2] = Math.round((b * dstA + pixels[idx + 2] * srcA * (1 - dstA)) / outA);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  }
  
  function filledRect(x1, y1, x2, y2, r, g, b, a) {
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++)
        setPixel(x, y, r, g, b, a);
  }
  
  function roundedRect(x1, y1, x2, y2, radius, r, g, b, a) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        let dx = Math.max(x1 + radius - x, 0, x - (x2 - radius));
        let dy = Math.max(y1 + radius - y, 0, y - (y2 - radius));
        if (dx * dx + dy * dy <= radius * radius) setPixel(x, y, r, g, b, a);
      }
    }
  }
  
  const s = w / 256; // scale factor
  
  // Background circle (subtle)
  roundedRect(20*s, 20*s, 236*s, 236*s, 40*s, 99, 102, 241, 25);
  
  // Document (back) - white page peeking out
  const docX = 90*s, docY = 55*s, docW = 100*s, docH = 140*s;
  roundedRect(docX, docY, docX + docW, docY + docH, 8*s, 255, 255, 255, 255);
  // Document fold corner
  for (let i = 0; i < 20*s; i++) {
    filledRect(docX + docW - 20*s + i, docY, docX + docW, docY + 20*s - i, 240, 240, 245, 255);
    for (let j = 0; j < 20*s - i; j++) setPixel(docX + docW - 20*s + i, docY + j, 200, 200, 210, 255);
  }
  // Document lines
  for (let i = 0; i < 5; i++) {
    const lineY = docY + 35*s + i * 22*s;
    const lineW = (i === 4 ? 60 : 75) * s;
    filledRect(docX + 12*s, lineY, docX + 12*s + lineW, lineY + 6*s, 200, 205, 215, 200);
  }
  
  // Folder back
  const fX = 30*s, fY = 100*s, fW = 150*s, fH = 100*s;
  roundedRect(fX, fY + 15*s, fX + fW, fY + fH, 10*s, 79, 70, 229, 255);
  
  // Folder tab
  roundedRect(fX, fY, fX + 60*s, fY + 25*s, 8*s, 79, 70, 229, 255);
  
  // Folder front (lighter)
  roundedRect(fX, fY + 20*s, fX + fW, fY + fH, 10*s, 99, 102, 241, 255);
  
  // Folder highlight
  filledRect(fX + 10*s, fY + 28*s, fX + fW - 10*s, fY + 34*s, 129, 140, 248, 120);
  
  // Small accent dot (design element)
  roundedRect(fX + fW - 30*s, fY + 45*s, fX + fW - 10*s, fY + 65*s, 5*s, 168, 85, 247, 200);
  
  // Subtle shadow under folder
  for (let y = 0; y < 8*s; y++) {
    const alpha = Math.round(30 * (1 - y / (8*s)));
    filledRect(fX + 15*s, fY + fH + y, fX + fW - 5*s, fY + fH + y, 0, 0, 0, alpha);
  }
}

// Generate different sizes
const sizes = [16, 32, 48, 64, 128, 256];
const outDir = path.join(__dirname, 'web');

for (const size of sizes) {
  const pixels = Buffer.alloc(size * size * 4);
  drawIcon(pixels, size, size);
  const png = createPNG(size, size, (p, w, h) => {
    // Copy our drawn pixels
    pixels.copy(p);
  });
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`Generated icon-${size}.png`);
}

// Also create a simple ICO file (Windows icon format)
// ICO format: header + directory entries + PNG data for each size
function createICO(pngBuffers) {
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);     // reserved
  icoHeader.writeUInt16LE(1, 2);     // type: icon
  icoHeader.writeUInt16LE(pngBuffers.length, 4); // number of images
  
  const entries = [];
  let dataOffset = 6 + pngBuffers.length * 16;
  
  for (const { size, png } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size < 256 ? size : 0;  // width
    entry[1] = size < 256 ? size : 0;  // height
    entry[2] = 0;   // color palette
    entry[3] = 0;   // reserved
    entry.writeUInt16LE(1, 4);   // color planes
    entry.writeUInt16LE(32, 6);  // bits per pixel
    entry.writeUInt32LE(png.length, 8);  // image size
    entry.writeUInt32LE(dataOffset, 12); // image offset
    entries.push(entry);
    dataOffset += png.length;
  }
  
  return Buffer.concat([icoHeader, ...entries, ...pngBuffers.map(b => b.png)]);
}

const icoSizes = [16, 32, 48, 256];
const icoBuffers = icoSizes.map(size => {
  const pixels = Buffer.alloc(size * size * 4);
  drawIcon(pixels, size, size);
  const png = createPNG(size, size, (p) => pixels.copy(p));
  return { size, png };
});

const ico = createICO(icoBuffers);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log('Generated icon.ico');

// Create tray-sized icon (16x16 PNG)
console.log('All icons generated!');
