// lib/image.js - Image processing utilities

const ImageUtils = {
  // Get file extension from MIME type or URL
  getExtension(mimeOrUrl) {
    const mimeMap = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp',
      'image/tiff': 'tiff',
    };

    if (mimeMap[mimeOrUrl]) return mimeMap[mimeOrUrl];

    // Try to extract from URL
    const match = mimeOrUrl.match(/\.(\w+)(?:\?|$)/);
    return match ? match[1].toLowerCase() : 'png';
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.ImageUtils = ImageUtils;
}
