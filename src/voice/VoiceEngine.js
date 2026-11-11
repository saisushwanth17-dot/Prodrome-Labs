// src/voice/VoiceEngine.js
import { GaplessAudioQueue } from './GaplessAudioQueue.js';
import { AzureSpeechClient } from './AzureSpeechClient.js';
import { SpeechRecognitionManager } from './SpeechRecognitionManager.js';
import { encodePcmToWav, mergeInt16Arrays, arrayBufferToBase64, base64ToArrayBuffer } from './WavUtils.js';

/**
 * Smart Incomplete-Clause Extension:
 * Trailing conjunctions, prepositions, and hesitation words in English and Arabic.
 * If the user's speech pauses on one of these, add +600ms grace time so breath pauses don't cut them off.
 */
const TRAILING_INCOMPLETE_WORDS = new Set([
  'and', 'but', 'so', 'because', 'or', 'like', 'honestly', 'actually',
  'when', 'while', 'if', 'that', 'to', 'the', 'a', 'an', 'as', 'with', 'about', 'then',
  'و', 'أو', 'لأن', 'بس', 'يعني', 'إذا', 'لما', 'مع', 'عن', 'في', 'من', 'إلى', 'حتى', 'ثم'
]);

function hasIncompleteClause(text) {
  if (!text) return false;
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return false;
  const lastWord = words[words.length - 1].toLowerCase().replace(/[.,!?:;؟]/g, '');
  return TRAILING_INCOMPLETE_WORDS.has(lastWord);
}

/**
 * Prodrome Labs Voice Engine (Phase 5 Pause-Tolerance & Multi-Segment Edition)
 * Master client-side Full-Duplex Audio Pipeline Orchestrator.
 * 
 * Challenge 10: Earlier, Safer Mental Wellbeing Support (Abu Dhabi)
 * Feature Branch: feature/voice-pipeline
 */
export class VoiceEngine {
  constructor(config = {}) {
    const defaultWs = (typeof window !== 'undefined' && window.location && window.location.host)
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/voice`
      : 'ws://127.0.0.1:8001/ws/voice';
    this.wsUrl = config.wsUrl || defaultWs;
    this.currentLanguage = config.language || 'en-US';
    this.sessionUuid = config.sessionUuid || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'prodrome-' + Date.now());

    // Callbacks
    this.onStateChange = config.onStateChange || (() => {});
    this.onTelemetryUpdate = config.onTelemetryUpdate || (() => {});
    this.onRmsUpdate = config.onRmsUpdate || (() => {});
    this.onTranscriptUpdate = config.onTranscriptUpdate || (() => {});
    this.onWsEvent = config.onWsEvent || (() => {});
    this.onEmergencyAction = config.onEmergencyAction || (() => {});
    this.onDispatchedAction = config.onDispatchedAction || (() => {});
    this.onServerConfig = config.onServerConfig || (() => {});
    this.onServerError = config.onServerError || (() => {});
    this.onVerifyResult = config.onVerifyResult || (() => {});
    this.onSlotsUpdate = config.onSlotsUpdate || (() => {});
    this.onPauseProgress = config.onPauseProgress || (() => {});
    this.onTranscriptFinalized = config.onTranscriptFinalized || (() => {});

    // State: IDLE, USER_SPEAKING, HOLDING_FOR_PAUSE, PROCESSING_TURN, AGENT_SPEAKING, EMERGENCY_LOCKED
    this.state = 'IDLE';
    this.vadMode = 'DETECTING'; // 'SILERO' | 'RMS_FALLBACK'

    // Multi-segment pause hold configuration
    this.pauseToleranceMs = config.pauseToleranceMs || 1400; // default 1400ms for natural clinical pauses
    this.turnCommitTimer = null;
    this.pauseInterval = null;
    this.turnInitialStartTime = 0;

    // Barge-in sensitivity & sustained speech gating (LOW = 350ms, MEDIUM = 200ms, PUSH_ONLY = manual)
    this.bargeInSensitivity = config.bargeInSensitivity || 'LOW';
    this.bargeInRmsFloor = 0.045;
    this.bargeInDurationMs = 350;
    this.updateBargeInParams();
    this.bargeInCandidate = null;
    this.playbackEndedTime = 0;

    // Telemetry tracking
    this.telemetry = {
      vadSilenceTriggerMs: 0,
      bargeInHaltLatencyMs: 0,
      timeToFirstAudioMs: 0,
      lastWavPayloadSizeKB: 0,
      currentRms: 0,
      arousal: 0.40,
      valence: 0.50
    };

    // Subsystems
    this.audioCtx = null;
    this.micStream = null;
    this.micSource = null;
    this.workletNode = null;
    this.analyser = null;
    this.vad = null;
    this.ws = null;
    this.wsReconnectTimer = null;
    this.gaplessQueue = null;
    this.azureClient = new AzureSpeechClient();
    this.sttManager = null;

    // Turn tracking and stale chunk cancellation
    this.currentTurnId = null;
    this.canceledTurnIds = new Set();

    // Buffer for accumulating active user speech turn
    this.isUserSpeaking = false;
    this.isTurnActive = false;
    this.preRollBuffer = []; // 500ms pre-roll ring buffer (16 frames x 512 samples at 16kHz)
    this.turnPcmChunks = [];
    this.speechStartTime = 0;
    this.lastVoiceDetectedTime = 0;
    this.turnSubmittedTime = 0;

    // RMS Fallback VAD state
    this.rmsThreshold = 0.015;
    this.rmsSilenceTimeout = null;
  }

  setState(newState) {
    if (this.state === 'EMERGENCY_LOCKED' && newState !== 'IDLE') {
      return;
    }
    this.state = newState;
    this.onStateChange(this.state);
  }

  setBargeInSensitivity(mode) {
    this.bargeInSensitivity = mode;
    this.updateBargeInParams();
    console.log(`[VoiceEngine] Barge-In Sensitivity set to ${mode} (RMS floor: ${this.bargeInRmsFloor}, Hold: ${this.bargeInDurationMs}ms)`);
  }

  setPauseTolerance(ms) {
    this.pauseToleranceMs = Number(ms) || 1400;
    console.log(`[VoiceEngine] Pause Tolerance set to ${this.pauseToleranceMs}ms`);
  }

  hasIncompleteClause(text) {
    return hasIncompleteClause(text);
  }

  updateBargeInParams() {
    if (this.bargeInSensitivity === 'LOW') {
      this.bargeInRmsFloor = 0.045;
      this.bargeInDurationMs = 350;
    } else if (this.bargeInSensitivity === 'MEDIUM') {
      this.bargeInRmsFloor = 0.030;
      this.bargeInDurationMs = 200;
    } else if (this.bargeInSensitivity === 'PUSH_ONLY') {
      this.bargeInRmsFloor = 999.0;
      this.bargeInDurationMs = 999999;
    }
  }

  resetSessionMemory() {
    this.sendWsMessage({
      event: 'RESET_SESSION_MEMORY',
      session_uuid: this.sessionUuid,
      timestamp_ms: Date.now()
    });
    console.log(`[VoiceEngine] Requested session memory reset for ${this.sessionUuid}`);
  }

  updateTelemetry(key, value) {
    this.telemetry[key] = value;
    this.onTelemetryUpdate({ ...this.telemetry });
  }

  /**
   * Returns live frequency data for 60fps canvas visualizer bridge (Person 4 UI).
   * @returns {Uint8Array} Frequency bin spectrum
   */
  getFrequencyData() {
    if (!this.analyser) {
      return new Uint8Array(64);
    }
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(freqData);
    return freqData;
  }

  /**
   * Connects to the local mock Python WebSocket server with auto-reconnect.
   */
  connectWebSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.onWsEvent('STATUS', { status: 'CONNECTING', url: this.wsUrl });
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log(`[WS] Connected to ${this.wsUrl}`);
        if (this.wsReconnectTimer) {
          clearInterval(this.wsReconnectTimer);
          this.wsReconnectTimer = null;
        }
        this.onWsEvent('STATUS', { status: 'CONNECTED', url: this.wsUrl });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.onWsEvent('RECV', data);
          this.handleServerMessage(data);
        } catch (e) {
          console.error('[WS] Error parsing JSON payload:', e, event.data);
        }
      };

      this.ws.onerror = (err) => {
        this.onWsEvent('STATUS', { status: 'DISCONNECTED', error: 'Connection failed. Ensure python sandbox/mock_voice_server.py is running on port 8001.' });
      };

      this.ws.onclose = () => {
        this.onWsEvent('STATUS', { status: 'DISCONNECTED', message: 'Connection closed' });
        // Auto-reconnect every 2 seconds
        if (!this.wsReconnectTimer) {
          this.wsReconnectTimer = setInterval(() => {
            console.log('[WS] Attempting auto-reconnect...');
            this.connectWebSocket();
          }, 2000);
        }
      };
    } catch (err) {
      console.error('[WS] Connection exception:', err);
      this.onWsEvent('STATUS', { status: 'DISCONNECTED', error: err.message });
    }
  }

  sendWsMessage(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      this.onWsEvent('SEND', payload);
    } else {
      console.warn('[WS] Cannot send message, WebSocket not connected:', payload);
      this.onWsEvent('ERROR', { error: 'WebSocket is not connected. Run: python sandbox/mock_voice_server.py' });
    }
  }

  /**
   * Initializes full-duplex session upon user gesture.
   */
  async startSession() {
    if (this.state !== 'IDLE' && this.state !== 'EMERGENCY_LOCKED') {
      return;
    }

    try {
      this.setState('IDLE');

      // 1. Initialize AudioContext (SSR safe)
      if (typeof window === 'undefined') return;
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // 2. Setup Central AnalyserNode
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128; // 64 frequency bins
      this.analyser.smoothingTimeConstant = 0.8;

      // 3. Initialize Gapless Audio Queue
      this.gaplessQueue = new GaplessAudioQueue(this.audioCtx, (isPlaying) => {
        if (isPlaying) {
          if (this.sttManager) {
            this.sttManager.setSuppressed(true);
          }
          if (this.state !== 'USER_SPEAKING' && this.state !== 'PROCESSING_TURN') {
            this.setState('AGENT_SPEAKING');
          }
        } else {
          this.playbackEndedTime = performance.now();
          if (this.sttManager) {
            this.sttManager.setSuppressed(false);
          }
          if (this.state === 'AGENT_SPEAKING') {
            this.setState('IDLE');
          }
        }
      });

      // Tap agent audio output into central visualizer analyser
      this.gaplessQueue.masterGain.connect(this.analyser);

      // 4. Request Microphone Stream with strict hardware Acoustic Echo Cancellation (AEC)
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
        }
      });

      // 5. Initialize AudioWorklet for Real-Time 16kHz Downsampling
      await this.audioCtx.audioWorklet.addModule('/pcm-worklet-processor.js');
      this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-16k-worklet');

      this.workletNode.port.onmessage = (event) => {
        const { pcm16, rms } = event.data;
        this.updateTelemetry('currentRms', rms);
        this.onRmsUpdate(rms);

        // Pre-roll Ring Buffer (Phase 6):
        // While no turn is active, continuously buffer the last ~500ms (16 frames of 512 samples)
        if (!this.isTurnActive && pcm16) {
          this.preRollBuffer.push(pcm16);
          if (this.preRollBuffer.length > 16) {
            this.preRollBuffer.shift();
          }
        }

        // Sustained Speech Barge-In Evaluation while Agent is Playing
        if (this.gaplessQueue && this.gaplessQueue.isPlaying && this.bargeInCandidate) {
          if (rms < this.bargeInRmsFloor) {
            // Energy dropped below threshold: cancel transient/speaker-echo candidate
            this.bargeInCandidate = null;
          } else {
            const heldDuration = performance.now() - this.bargeInCandidate.startTime;
            if (heldDuration >= this.bargeInDurationMs) {
              const src = this.bargeInCandidate.source;
              this.bargeInCandidate = null;
              this.executeBargeIn(src);
            }
          }
        }

        // Resume speech if user speaks during pause hold
        if (this.turnCommitTimer && rms >= 0.025) {
          this.handleSpeechStart('worklet_rms_resume');
        }

        // Record Unbroken Continuous Audio Across Mid-Turn Pauses (Phase 6):
        // As long as isTurnActive is true, append EVERY single incoming pcm16 frame
        // directly into turnPcmChunks continuously until turnCommitTimer commits the turn!
        if (this.isTurnActive && pcm16) {
          this.turnPcmChunks.push(pcm16);
          if (this.isUserSpeaking) {
            this.lastVoiceDetectedTime = performance.now();
          }
        }

        // RMS Energy-Based VAD Fallback logic (runs if Silero fails to load)
        if (this.vadMode === 'RMS_FALLBACK') {
          this.processRmsVad(rms);
        }
      };

      this.micSource.connect(this.workletNode);
      this.micSource.connect(this.analyser);

      // 6. Attempt Silero VAD (ONNX/WASM) with Safe Fallback to RMS VAD
      try {
        let MicVAD = null;
        try {
          const vadModule = await import('@ricky0123/vad-web');
          MicVAD = vadModule.MicVAD || vadModule.default?.MicVAD || window.vad?.MicVAD;
        } catch (mErr) {
          MicVAD = window.vad?.MicVAD;
        }

        if (MicVAD) {
          this.vad = await MicVAD.new({
            stream: this.micStream,
            baseAssetPath: '/vad/',
            onnxWASMBasePath: '/vad/',
            model: 'legacy',
            redemptionFrames: 10,
            positiveSpeechThreshold: 0.75, // Desensitized positive speech threshold
            negativeSpeechThreshold: 0.28, // Lowered from 0.50 so soft/raspy speech tails aren't dropped
            minSpeechFrames: 8,            // ~250-300ms confirmed voice before firing onSpeechStart
            onSpeechStart: () => this.handleSpeechStart('silero'),
            onSpeechEnd: (audio) => this.handleSpeechEnd(audio),
            onVADMisfire: () => console.debug('[VAD] Misfire ignored')
          });
          this.vad.start();
          this.vadMode = 'SILERO';
          console.log('[VoiceEngine] Silero VAD (ONNX/WASM) active.');
        } else {
          throw new Error('MicVAD class not found');
        }
      } catch (vadInitErr) {
        console.warn('[VoiceEngine] Silero VAD initialization failed; falling back to zero-freeze RMS Energy VAD:', vadInitErr);
        this.vadMode = 'RMS_FALLBACK';
      }

      // 7. Initialize Bilingual Speech Recognition Manager
      this.sttManager = new SpeechRecognitionManager({
        language: this.currentLanguage,
        onTranscriptUpdate: (info) => {
          this.onTranscriptUpdate(info);
        }
      });
      this.sttManager.start();

      // Ensure WebSocket connection is active
      this.connectWebSocket();

      this.setState('IDLE');
      console.log(`[VoiceEngine] Full-Duplex Session started (VAD Mode: ${this.vadMode})`);
    } catch (err) {
      console.error('[VoiceEngine] Failed to start full-duplex session:', err);
      this.stopSession();
      throw err;
    }
  }

  /**
   * RMS Energy-Based VAD Processor (Zero-Freeze Fallback).
   * Detects speech onset, triggers instant barge-in if agent is playing,
   * and fires turn completion after 600ms of silence.
   */
  processRmsVad(rms) {
    if (rms >= this.rmsThreshold) {
      // Voice energy detected
      if (this.rmsSilenceTimeout) {
        clearTimeout(this.rmsSilenceTimeout);
        this.rmsSilenceTimeout = null;
      }
      if (!this.isUserSpeaking) {
        this.handleSpeechStart();
      }
    } else if (this.isUserSpeaking) {
      // Energy dropped below threshold; schedule 600ms silence completion
      if (!this.rmsSilenceTimeout) {
        this.rmsSilenceTimeout = setTimeout(() => {
          this.rmsSilenceTimeout = null;
          this.handleSpeechEnd();
        }, 600);
      }
    }
  }

  /**
   * Silero / RMS onSpeechStart Handler (Sustained Speech Gated Barge-In).
   */
  handleSpeechStart(source = 'vad') {
    const now = performance.now();

    // 1. Post-Playback Cooldown Guard (350ms): Ignore room reverb from the end of the sentence
    if (now - this.playbackEndedTime < 350) {
      console.debug('[VAD] Speech onset ignored during post-playback 350ms cooldown');
      return;
    }

    // 2. While Agent is Playing: Evaluate Barge-In Gating
    if (this.gaplessQueue && this.gaplessQueue.isPlaying) {
      if (this.bargeInSensitivity === 'PUSH_ONLY') {
        console.debug('[BARGE-IN] Mic interruption suppressed in Push-to-Interrupt Only mode');
        return;
      }

      // In LOW / MEDIUM mode: start sustained speech candidate gate
      if (!this.bargeInCandidate) {
        this.bargeInCandidate = {
          startTime: now,
          source: source
        };
        console.debug(`[BARGE-IN GATE] Candidate voice onset under test (${this.bargeInSensitivity} mode)`);
      }
      return;
    }

    // 3. User Resumed Speech: Cancel any pending turn commit timer immediately!
    if (this.turnCommitTimer) {
      clearTimeout(this.turnCommitTimer);
      this.turnCommitTimer = null;
      console.log('[PAUSE ACCUMULATOR] User resumed speaking! Canceled turn-commit timer.');
    }
    if (this.pauseInterval) {
      clearInterval(this.pauseInterval);
      this.pauseInterval = null;
    }
    this.onPauseProgress(0, 0, 0);

    // 4. Pre-roll & Turn Accumulator Activation:
    // If this is a new turn, prepend 500ms pre-roll buffer to preserve the first syllable!
    if (!this.isTurnActive) {
      this.isTurnActive = true;
      this.turnInitialStartTime = now;
      this.turnPcmChunks = [...this.preRollBuffer];
      this.preRollBuffer = [];
      if (this.sttManager) {
        this.sttManager.startNewTurn(true);
      }
    } else {
      // Continuing existing turn across a mid-sentence pause
      if (this.sttManager) {
        this.sttManager.startNewTurn(false);
      }
    }

    this.isUserSpeaking = true;
    this.speechStartTime = now;
    this.lastVoiceDetectedTime = now;
    this.bargeInCandidate = null;

    this.setState('USER_SPEAKING');
    if (this.sttManager) {
      this.sttManager.setSuppressed(false);
    }
  }

  /**
   * Executes validated barge-in, halting active playback in <30ms.
   */
  executeBargeIn(source = 'sustained_vad') {
    if (this.currentTurnId) {
      this.canceledTurnIds.add(this.currentTurnId);
      console.log(`[BARGE-IN] Canceled active turn ID '${this.currentTurnId}'`);
      this.currentTurnId = null;
    }

    let haltLatencyMs = 0;
    if (this.gaplessQueue && this.gaplessQueue.isPlaying) {
      haltLatencyMs = this.gaplessQueue.interruptAndFlush();
      this.updateTelemetry('bargeInHaltLatencyMs', parseFloat(haltLatencyMs.toFixed(2)));

      this.sendWsMessage({
        event: 'USER_BARGE_IN',
        session_uuid: this.sessionUuid,
        timestamp_ms: Date.now(),
        halt_latency_ms: haltLatencyMs,
        source: source
      });
      console.log(`[BARGE-IN] Active audio halted in ${haltLatencyMs.toFixed(2)}ms (Source: ${source})`);
    }

    if (this.turnCommitTimer) {
      clearTimeout(this.turnCommitTimer);
      this.turnCommitTimer = null;
    }
    if (this.pauseInterval) {
      clearInterval(this.pauseInterval);
      this.pauseInterval = null;
    }
    this.onPauseProgress(0, 0, 0);

    this.isTurnActive = true;
    this.isUserSpeaking = true;
    this.speechStartTime = performance.now();
    this.lastVoiceDetectedTime = performance.now();
    this.turnPcmChunks = [...this.preRollBuffer];
    this.preRollBuffer = [];
    this.turnInitialStartTime = performance.now();
    this.bargeInCandidate = null;

    this.setState('USER_SPEAKING');
    if (this.sttManager) {
      this.sttManager.setSuppressed(false);
      this.sttManager.startNewTurn(true);
    }
  }

  /**
   * Manual Barge-in trigger (Push-to-Interrupt).
   */
  triggerManualBargeIn() {
    this.executeBargeIn('manual_ui');
  }

  /**
   * Turn Completion Handler: Enters HOLDING_FOR_PAUSE and schedules dynamic commit timer.
   */
  handleSpeechEnd() {
    if (!this.isUserSpeaking && !this.turnCommitTimer) return;
    this.isUserSpeaking = false;
    this.bargeInCandidate = null;

    const speechEndTime = performance.now();
    this.lastVoiceDetectedTime = speechEndTime;

    // If nothing was recorded yet, return to IDLE
    if (this.turnPcmChunks.length === 0) {
      this.isTurnActive = false;
      this.setState('IDLE');
      return;
    }

    // Enter HOLDING_FOR_PAUSE substate while waiting out breath pauses
    this.setState('HOLDING_FOR_PAUSE');

    // Dynamic Pause Tolerance: Base + Smart Incomplete-Clause Extension (+600ms)
    let totalPauseMs = this.pauseToleranceMs;
    const currentTranscript = this.sttManager ? this.sttManager.getCurrentTranscript() : '';
    if (hasIncompleteClause(currentTranscript)) {
      totalPauseMs += 600;
      console.log(`[PAUSE ACCUMULATOR] Trailing clause word detected in "${currentTranscript.slice(-30)}". Added +600ms grace time (Total: ${totalPauseMs}ms).`);
    }

    // Clear any previous timer/interval
    if (this.turnCommitTimer) {
      clearTimeout(this.turnCommitTimer);
      this.turnCommitTimer = null;
    }
    if (this.pauseInterval) {
      clearInterval(this.pauseInterval);
      this.pauseInterval = null;
    }

    // Start UI progress bar updates
    const timerStart = performance.now();
    this.pauseInterval = setInterval(() => {
      const elapsed = performance.now() - timerStart;
      const remaining = Math.max(0, totalPauseMs - elapsed);
      const percent = Math.min(100, Math.round((elapsed / totalPauseMs) * 100));
      this.onPauseProgress(remaining, totalPauseMs, percent);
    }, 30);

    // Schedule turn commit when pause fully elapses without new speech
    this.turnCommitTimer = setTimeout(() => {
      this.commitTurn();
    }, totalPauseMs);
  }

  /**
   * Packages accumulated multi-segment turn into WAV and submits TURN_COMPLETE.
   */
  async commitTurn() {
    if (this.turnCommitTimer) {
      clearTimeout(this.turnCommitTimer);
      this.turnCommitTimer = null;
    }
    if (this.pauseInterval) {
      clearInterval(this.pauseInterval);
      this.pauseInterval = null;
    }
    this.onPauseProgress(0, 0, 0);

    this.isTurnActive = false;
    this.isUserSpeaking = false;

    // If no audio chunks were collected, return to IDLE
    if (this.turnPcmChunks.length === 0) {
      this.setState('IDLE');
      return;
    }

    const measuredSilenceMs = Math.round(performance.now() - this.lastVoiceDetectedTime);
    this.updateTelemetry('vadSilenceTriggerMs', Math.round(measuredSilenceMs || this.pauseToleranceMs));

    // 1. Compile all accumulated 16kHz Int16 PCM chunks across all phrases
    const mergedPcm = mergeInt16Arrays(this.turnPcmChunks);
    this.turnPcmChunks = [];
    this.preRollBuffer = [];

    // Calculate duration and energy metrics over accumulated PCM
    const turnDurationMs = performance.now() - (this.turnInitialStartTime || this.speechStartTime);
    let peakSample = 0;
    let sumSquares = 0;
    for (let i = 0; i < mergedPcm.length; i++) {
      const absVal = Math.abs(mergedPcm[i]);
      if (absVal > peakSample) peakSample = absVal;
      sumSquares += mergedPcm[i] * mergedPcm[i];
    }
    const peakNormalized = peakSample / 32768.0;
    const turnRms = Math.sqrt(sumSquares / (mergedPcm.length || 1)) / 32768.0;

    // 2. Ignore empty / ultra-short noise turns (<400ms duration or <6400 samples)
    if (mergedPcm.length < 6400 || turnDurationMs < 400) {
      const quickTranscript = this.sttManager ? this.sttManager.finalizeTurn().trim() : '';
      if (quickTranscript.length < 2) {
        console.log(`[VAD] Discarded transient noise turn (${turnDurationMs.toFixed(0)}ms, ${mergedPcm.length} samples)`);
        this.setState('IDLE');
        return;
      }
    }

    // 2b. Discard pure background room silence / laptop fan hum (low peak & low RMS)
    const quickTranscript = this.sttManager ? this.sttManager.getCurrentTranscript().trim() : '';
    if (quickTranscript.length < 2 && peakNormalized < 0.035 && turnRms < 0.010) {
      console.log(`[VAD] Discarded ambient silence/hum turn (${turnDurationMs.toFixed(0)}ms, Peak: ${peakNormalized.toFixed(3)}, RMS: ${turnRms.toFixed(4)})`);
      if (this.sttManager) this.sttManager.finalizeTurn();
      this.setState('IDLE');
      return;
    }

    this.setState('PROCESSING_TURN');

    // 3. Wrap in 44-byte RIFF WAV header (Person 2's WavLM Base+ model input)
    const wavBuffer = encodePcmToWav(mergedPcm, 16000);
    const wavBase64 = arrayBufferToBase64(wavBuffer);
    const wavSizeKB = parseFloat((wavBuffer.byteLength / 1024).toFixed(1));
    this.updateTelemetry('lastWavPayloadSizeKB', wavSizeKB);

    // 4. Gather finalized transcript from STT manager (contains all accumulated segments)
    let transcript = this.sttManager ? this.sttManager.finalizeTurn() : '';

    // If STT returned empty or Web Speech API is absent, attempt Groq Whisper fallback
    if (!transcript && wavBuffer.byteLength > 44) {
      try {
        console.log('[STT] Web Speech API returned empty. Invoking client-side Groq Whisper fallback...');
        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        transcript = await this.sttManager.transcribeWithGroqWhisper(wavBlob, this.currentLanguage);
        if (transcript) {
          this.onTranscriptUpdate({
            final: transcript,
            interim: '',
            combined: transcript,
            language: this.currentLanguage,
            source: 'groq-whisper'
          });
        }
      } catch (whisperErr) {
        console.warn('[STT] Client Groq Whisper fallback note:', whisperErr.message);
      }
    }

    // 5. Drop empty/noise turn or Whisper silence hallucinations before sending over WebSocket
    const cleanText = (transcript || '').trim().toLowerCase();
    const noisePhrases = new Set([
      'you', 'thank you', 'thank you.', 'thank you very much', 'thank you so much',
      'thanks', 'thanks.', 'thank you for watching', 'thank you for watching.',
      'bye', 'bye.', 'bye bye', 'subscribe', '.', '..', '...', 'hmm', 'huh',
      'ترجمة', 'ترجمة نانسي قنقر', 'شكرا', 'شكراً', 'شكرا للمشاهدة', 'مع السلامة', 'إلى اللقاء'
    ]);
    if (cleanText.length < 2 || noisePhrases.has(cleanText)) {
      if (peakNormalized < 0.05 || wavBuffer.byteLength < 64000) {
        console.log(`[VAD] Ignored empty or silence hallucination turn ('${transcript}', Peak: ${peakNormalized.toFixed(3)}, RMS: ${turnRms.toFixed(4)})`);
        this.setState('IDLE');
        return;
      }
    }

    // 6. Mark turn submission time for TTFA telemetry
    this.turnSubmittedTime = performance.now();

    // 7. Send TURN_COMPLETE WebSocket payload
    console.log(`[TURN COMMIT] Emitting complete turn (${(mergedPcm.length/16000).toFixed(2)}s audio, transcript: "${transcript}")`);
    this.sendWsMessage({
      event: 'TURN_COMPLETE',
      session_uuid: this.sessionUuid,
      language: this.currentLanguage,
      transcript: transcript || '',
      audio_pcm_base64: wavBase64,
      timestamp_ms: Date.now(),
      silence_trigger_ms: Math.round(measuredSilenceMs)
    });
  }

  /**
   * Manual force-commit button [Done Speaking].
   */
  commitTurnImmediately() {
    if (this.state === 'HOLDING_FOR_PAUSE' || this.isUserSpeaking || this.turnPcmChunks.length > 0) {
      console.log('[MANUAL COMMIT] User clicked Done Speaking! Forcing immediate turn commit.');
      this.isUserSpeaking = false;
      this.commitTurn();
    }
  }

  /**
   * Handles incoming WebSocket messages from the server.
   */
  async handleServerMessage(data) {
    const event = data.event;

    // 0. SERVER_CONFIG_STATUS
    if (event === 'SERVER_CONFIG_STATUS') {
      console.log(`[SERVER CONFIG] Active TTS: ${data.tts_tier} | Azure Configured: ${data.azure_configured} | Groq Whisper: ${data.groq_configured}`);
      this.onServerConfig(data);
      return;
    }

    // 1. SERVER_ERROR
    if (event === 'SERVER_ERROR') {
      console.error('[SERVER ERROR]', data.message);
      this.onServerError(data);
      return;
    }

    // 2. VERIFY_KEYS_RESULT
    if (event === 'VERIFY_KEYS_RESULT') {
      this.onVerifyResult(data);
      // If test audio is present, play it through the speakers!
      if (data.azure?.audio_base64) {
        try {
          const testAudioBuf = base64ToArrayBuffer(data.azure.audio_base64);
          if (this.gaplessQueue) {
            await this.gaplessQueue.enqueueAudioChunk(testAudioBuf);
          }
        } catch (e) {
          console.warn('[VERIFY] Could not play test audio:', e);
        }
      }
      return;
    }

    // 3. TRANSCRIPT_FALLBACK_READY & TRANSCRIPT_FINALIZED (Groq Whisper Verified Full-Audio Transcript)
    if (event === 'TRANSCRIPT_FALLBACK_READY' || event === 'TRANSCRIPT_FINALIZED') {
      const verifiedText = data.verified_transcript || data.transcript || '';
      console.log(`[VoiceEngine] Received ${event} from ${data.source || 'Groq Whisper'}: "${verifiedText}"`);
      this.onTranscriptUpdate({
        final: verifiedText,
        interim: '',
        combined: verifiedText,
        language: this.currentLanguage,
        source: 'groq-whisper'
      });
      if (typeof this.onTranscriptFinalized === 'function') {
        this.onTranscriptFinalized({
          transcript: verifiedText,
          source: data.source || 'groq-whisper-large-v3-turbo'
        });
      }
      return;
    }

    // 4. DISPATCH_ACTION (Emergency Overrides, 4-7-8 Breathing, JIT Gate, Telehealth)
    if (event === 'DISPATCH_ACTION') {
      const actionType = data.action_type;
      console.log(`[DISPATCH_ACTION] Received action: ${actionType}`, data.payload);

      this.onDispatchedAction(data);

      if (actionType === 'HARD_EMERGENCY_OVERRIDE') {
        if (this.gaplessQueue) {
          this.gaplessQueue.interruptAndFlush();
        }
        this.setState('EMERGENCY_LOCKED');
        this.onEmergencyAction(data.payload);
      }
      return;
    }

    // 5. AGENT_RESPONSE_CHUNK (Sentence-boundary streaming audio chunk)
    if (event === 'AGENT_RESPONSE_CHUNK') {
      // Discard stale audio chunks from canceled/barged-in turns
      if (data.turn_id && this.canceledTurnIds.has(data.turn_id)) {
        console.warn(`[VoiceEngine] Discarded stale chunk ${data.chunk_index} for canceled turn ${data.turn_id}`);
        return;
      }

      if (data.turn_id) {
        this.currentTurnId = data.turn_id;
      }

      // Calculate Time-to-First-Audio (TTFA) on chunk 0
      if (this.turnSubmittedTime) {
        const ttfa = performance.now() - this.turnSubmittedTime;
        this.updateTelemetry('timeToFirstAudioMs', Math.round(ttfa));
        this.turnSubmittedTime = 0;
      }

      // Update arousal and valence telemetry hints
      if (data.prosody_hint) {
        if (data.prosody_hint.arousal !== undefined) {
          this.updateTelemetry('arousal', data.prosody_hint.arousal);
        }
        if (data.prosody_hint.valence !== undefined) {
          this.updateTelemetry('valence', data.prosody_hint.valence);
        }
      }

      // Notify UI of extracted clinical slots
      if (data.extracted_slots && typeof this.onSlotsUpdate === 'function') {
        this.onSlotsUpdate(data.extracted_slots);
      }

      // Notify UI of full-audio verified transcript if provided
      if (data.verified_transcript && typeof this.onTranscriptFinalized === 'function') {
        this.onTranscriptFinalized({
          transcript: data.verified_transcript,
          source: 'groq-whisper-large-v3-turbo'
        });
      }

      // Audio bytes attached (MP3 decoded natively by Web Audio API decodeAudioData)
      if (data.audio_base64) {
        const audioBuffer = base64ToArrayBuffer(data.audio_base64);
        if (this.gaplessQueue) {
          await this.gaplessQueue.enqueueAudioChunk(audioBuffer);
        }
      }
      return;
    }

    // 6. SESSION_MEMORY_RESET
    if (event === 'SESSION_MEMORY_RESET') {
      console.log('[VoiceEngine] Conversation memory reset confirmed by server');
      if (typeof this.onSlotsUpdate === 'function') {
        this.onSlotsUpdate(data.extracted_slots || { phq9_estimate: 0, gad7_estimate: 0, somatic_flags: [] });
      }
      return;
    }
  }

  /**
   * Switches language dynamically (en-US <-> ar-AE).
   */
  setLanguage(newLang) {
    if (this.currentLanguage === newLang) return;
    this.currentLanguage = newLang;
    if (this.sttManager) {
      this.sttManager.setLanguage(newLang);
    }
    console.log(`[VoiceEngine] Switched language to ${newLang}`);
  }

  /**
   * Triggers 1-Click Verification of Azure Speech and Groq Whisper keys.
   */
  verifyApiKeys() {
    this.sendWsMessage({ event: 'VERIFY_API_KEYS' });
  }

  /**
   * Simulates Person 2 dispatched action triggers over WebSocket.
   */
  simulatePerson2Action(simulationType) {
    this.sendWsMessage({
      event: 'CLIENT_SIMULATE_ACTION',
      session_uuid: this.sessionUuid,
      simulation_type: simulationType,
      language: this.currentLanguage
    });
  }

  /**
   * Manually trigger simulated emergency override.
   */
  triggerEmergencyOverride() {
    this.simulatePerson2Action('CRISIS_OVERRIDE');
  }

  /**
   * Stops full-duplex session and releases hardware devices.
   */
  stopSession() {
    if (this.rmsSilenceTimeout) {
      clearTimeout(this.rmsSilenceTimeout);
      this.rmsSilenceTimeout = null;
    }

    if (this.vad) {
      try {
        this.vad.destroy();
      } catch (_) {}
      this.vad = null;
    }

    if (this.sttManager) {
      this.sttManager.stop();
      this.sttManager = null;
    }

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }

    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    if (this.gaplessQueue) {
      this.gaplessQueue.interruptAndFlush();
      this.gaplessQueue = null;
    }

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }

    this.isUserSpeaking = false;
    this.turnPcmChunks = [];
    this.currentTurnId = null;
    this.canceledTurnIds.clear();
    this.setState('IDLE');
    console.log('[VoiceEngine] Full-Duplex Session stopped');
  }
}
