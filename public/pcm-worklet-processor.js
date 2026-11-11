// public/pcm-worklet-processor.js
class PCM16kWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.frameSize = 512; // 32ms @ 16kHz (optimal for Silero VAD)
    this.pcmBuffer = new Int16Array(this.frameSize);
    this.floatBuffer = new Float32Array(this.frameSize);
    this.bufferIndex = 0;
    this.sampleRateRatio = sampleRate / this.targetSampleRate;
    this.fractionalIndex = 0;
    this.rmsSum = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0]; // Mono channel

    while (this.fractionalIndex < channelData.length) {
      const idx = Math.floor(this.fractionalIndex);
      const sample = Math.max(-1, Math.min(1, channelData[idx] || 0));
      this.floatBuffer[this.bufferIndex] = sample;
      this.pcmBuffer[this.bufferIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      this.rmsSum += sample * sample;
      this.bufferIndex++;

      if (this.bufferIndex >= this.frameSize) {
        const rms = Math.sqrt(this.rmsSum / this.frameSize);
        this.port.postMessage({
          pcm16: this.pcmBuffer.slice(0),
          float32: this.floatBuffer.slice(0),
          rms: rms
        });
        this.bufferIndex = 0;
        this.rmsSum = 0;
      }

      this.fractionalIndex += this.sampleRateRatio;
    }
    // Carry over remainder into next process quantum
    this.fractionalIndex -= channelData.length;
    return true;
  }
}

registerProcessor('pcm-16k-worklet', PCM16kWorkletProcessor);
