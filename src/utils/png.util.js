const fs = require("node:fs");

function readPngDimensionsFromBuffer(buffer) {
  if (!buffer || buffer.length < 24) return null;

  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 24) return null;

  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;

  if (!isPng) return null;

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

function readPngDimensionsFromFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24) return null;

  return readPngDimensionsFromBuffer(buffer);
}

module.exports = {
  readPngDimensionsFromBuffer,
  readPngDimensionsFromFile
};
