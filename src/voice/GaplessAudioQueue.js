// src/voice/GaplessAudioQueue.js
/**
 * Prodrome Labs Gapless Audio Queue
 * 
 * Schedules streaming incoming audio chunks seamlessly on Web Audio API's
 * AudioContext timeline, guaranteeing zero inter-chunk gaps while providing
 * a deterministic <30ms interruptAndFlush() capability for instantaneous
 * user barge-in and C-SSRS emergency overrides.
 */
export class GaplessAudioQueue {
  constructor(audioContext, onPlaybackStateChange) {
    this.ctx = audioContext;
    this.activeSources = new Set();
    this.nextStartTime = 0;
    this.isPlaying = false;
    this.onPlaybackStateChange = onPlaybackStateChange || (() => {});
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
  }

  /**
   * Decodes and schedules an audio chunk gaplessly.
   * @param {ArrayBuffer} arrayBuffer - Raw audio bytes (WAV, MP3, etc.)
   */
  async enqueueAudioChunk(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    try {
      // Decode audio data (clone slice to prevent detachment conflicts)
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.masterGain);

      const now = this.ctx.currentTime;
      // Schedule ahead: if current playback has lapsed or not started, schedule with 15ms lookahead;
      // otherwise, butt seamlessly against the end of the previous scheduled chunk.
      const startTime = Math.max(now + 0.015, this.nextStartTime);
      source.start(startTime);
      this.nextStartTime = startTime + audioBuffer.duration;

      this.activeSources.add(source);
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.onPlaybackStateChange(true);
      }

      source.onended = () => {
        this.activeSources.delete(source);
        if (this.activeSources.size === 0) {
          this.isPlaying = false;
          this.nextStartTime = 0;
          this.onPlaybackStateChange(false);
        }
      };
    } catch (err) {
      console.error('[GaplessAudioQueue] Failed to decode audio chunk:', err);
    }
  }

  /**
   * Deterministically halts all active playback in <30ms (typically <2ms).
   * Used for user barge-in and HARD_EMERGENCY_OVERRIDE events.
   * @returns {number} Measured halt latency in milliseconds
   */
  interruptAndFlush() {
    const t0 = performance.now();
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop(0);
        source.disconnect();
      } catch (_) {}
    }
    this.activeSources.clear();
    this.nextStartTime = this.ctx ? this.ctx.currentTime : 0;
    const wasPlaying = this.isPlaying;
    this.isPlaying = false;
    if (wasPlaying) {
      this.onPlaybackStateChange(false);
    }
    return performance.now() - t0;
  }
}
