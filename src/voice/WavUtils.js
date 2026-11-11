// src/voice/WavUtils.js
/**
 * Prodrome Labs WAV Utility Library
 * 
 * Provides bit-exact 44-byte RIFF WAVE encapsulation for 16kHz 16-bit mono PCM buffers,
 * ensuring seamless ingestion by Person 2's WavLM Base+ acoustic model for vocal arousal/valence extraction.
 */

/**
 * Wraps raw 16-bit Int16 PCM samples in a standard 44-byte RIFF WAV header.
 * @param {Int16Array} int16Samples - Raw PCM samples
 * @param {number} sampleRate - Target sample rate (default 16000 Hz)
 * @returns {ArrayBuffer} Complete WAV file as ArrayBuffer
 */
export function encodePcmToWav(int16Samples, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8); // 32000
  const blockAlign = numChannels * (bitsPerSample / 8); // 2
  const dataByteLength = int16Samples.byteLength;
  const totalByteLength = 44 + dataByteLength;

  const buffer = new ArrayBuffer(totalByteLength);
  const view = new DataView(buffer);

  // 1. ChunkID "RIFF" (0x52494646)
  view.setUint8(0, 0x52); // 'R'
  view.setUint8(1, 0x49); // 'I'
  view.setUint8(2, 0x46); // 'F'
  view.setUint8(3, 0x46); // 'F'

  // 2. ChunkSize: 36 + SubChunk2Size
  view.setUint32(4, 36 + dataByteLength, true);

  // 3. Format "WAVE" (0x57415645)
  view.setUint8(8, 0x57);  // 'W'
  view.setUint8(9, 0x41);  // 'A'
  view.setUint8(10, 0x56); // 'V'
  view.setUint8(11, 0x45); // 'E'

  // 4. Subchunk1ID "fmt " (0x666d7420)
  view.setUint8(12, 0x66); // 'f'
  view.setUint8(13, 0x6d); // 'm'
  view.setUint8(14, 0x74); // 't'
  view.setUint8(15, 0x20); // ' '

  // 5. Subchunk1Size: 16 for PCM
  view.setUint32(16, 16, true);

  // 6. AudioFormat: 1 for linear PCM
  view.setUint16(20, 1, true);

  // 7. NumChannels: 1 (mono)
  view.setUint16(22, numChannels, true);

  // 8. SampleRate: 16000 Hz
  view.setUint32(24, sampleRate, true);

  // 9. ByteRate: 32000 bytes/sec
  view.setUint32(28, byteRate, true);

  // 10. BlockAlign: 2 bytes per sample frame
  view.setUint16(32, blockAlign, true);

  // 11. BitsPerSample: 16 bits
  view.setUint16(34, bitsPerSample, true);

  // 12. Subchunk2ID "data" (0x64617461)
  view.setUint8(36, 0x64); // 'd'
  view.setUint8(37, 0x61); // 'a'
  view.setUint8(38, 0x74); // 't'
  view.setUint8(39, 0x61); // 'a'

  // 13. Subchunk2Size: Length of raw PCM data
  view.setUint32(40, dataByteLength, true);

  // 14. Write raw PCM samples
  const pcmDest = new Int16Array(buffer, 44, int16Samples.length);
  pcmDest.set(int16Samples);

  return buffer;
}

/**
 * Concatenates an array of Int16Array frames into a single unified Int16Array.
 * @param {Int16Array[]} chunks
 * @returns {Int16Array}
 */
export function mergeInt16Arrays(chunks) {
  if (!chunks || chunks.length === 0) return new Int16Array(0);
  let totalLength = 0;
  for (let i = 0; i < chunks.length; i++) {
    totalLength += chunks[i].length;
  }
  const result = new Int16Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}

/**
 * Converts ArrayBuffer to Base64 in chunked segments (safe against maximum call stack size limits).
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 string into an ArrayBuffer.
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Validates whether an ArrayBuffer contains a well-formed 44-byte RIFF WAV header.
 * @param {ArrayBuffer} buffer
 * @returns {{ valid: boolean, sampleRate?: number, channels?: number, bitsPerSample?: number, pcmBytes?: number, error?: string }}
 */
export function validateWavHeader(buffer) {
  if (!buffer || buffer.byteLength < 44) {
    return { valid: false, error: 'Buffer too short for 44-byte WAV header' };
  }
  const view = new DataView(buffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') return { valid: false, error: `Invalid ChunkID: ${riff}` };

  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (wave !== 'WAVE') return { valid: false, error: `Invalid Format: ${wave}` };

  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);

  return {
    valid: audioFormat === 1 && sampleRate === 16000 && channels === 1 && bitsPerSample === 16,
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    pcmBytes: dataSize,
    totalBytes: buffer.byteLength
  };
}
