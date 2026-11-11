// src/voice/SpeechRecognitionManager.js
/**
 * Prodrome Labs Bilingual Speech-to-Text Manager
 * 
 * Provides continuous, low-latency streaming speech recognition using
 * the browser's native Web Speech API (webkitSpeechRecognition) with on-the-fly
 * language switching between English (en-US) and UAE Arabic (ar-AE).
 * 
 * Includes a modular fallback to Groq Whisper (whisper-large-v3-turbo)
 * for environments lacking Web Speech API support or when turn transcripts return empty.
 */
export class SpeechRecognitionManager {
  constructor({ language = 'en-US', onTranscriptUpdate = null, groqApiKey = null }) {
    this.currentLanguage = language;
    this.onTranscriptUpdate = onTranscriptUpdate || (() => {});
    this.groqApiKey = groqApiKey || import.meta.env.VITE_GROQ_API_KEY || null;

    this.recognition = null;
    this.isListening = false;
    this.isSuppressed = false;
    this.priorSessionTranscripts = []; // Saves completed phrases across Chrome onend session restarts
    this.currentSessionFinalText = '';
    this.accumulatedFinalSegments = [];
    this.currentTurnTranscript = '';
    this.interimTranscript = '';
    this.isSupported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

    this.initRecognition();
  }

  setSuppressed(suppressed) {
    this.isSuppressed = Boolean(suppressed);
    if (this.isSuppressed) {
      // Clear interim while agent is speaking to eliminate speaker bleed
      this.interimTranscript = '';
    }
  }

  initRecognition() {
    if (!this.isSupported) {
      console.warn('[STT] Web Speech API is not supported in this browser. Falling back to Groq Whisper.');
      return;
    }

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRec();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.currentLanguage;

    this.recognition.onresult = (event) => {
      // If agent is speaking, ignore incoming mic audio bleed
      if (this.isSuppressed) {
        return;
      }

      // Robust 0-to-N Index Scan within current session to prevent word drops
      let sessionFinal = '';
      let sessionInterim = '';
      for (let i = 0; i < event.results.length; i++) {
        const item = event.results[i];
        const text = item[0]?.transcript || '';
        if (item.isFinal) {
          sessionFinal += (sessionFinal ? ' ' : '') + text.trim();
        } else {
          sessionInterim += text;
        }
      }
      this.currentSessionFinalText = sessionFinal;
      this.interimTranscript = sessionInterim;

      const allFinalParts = [...this.priorSessionTranscripts, sessionFinal].filter(Boolean);
      const combinedFinal = allFinalParts.join(' ').trim();
      const fullCombined = (combinedFinal + ' ' + sessionInterim).trim();

      this.onTranscriptUpdate({
        final: combinedFinal,
        interim: sessionInterim,
        combined: fullCombined,
        language: this.currentLanguage
      });
    };

    this.recognition.onerror = (event) => {
      // Ignore 'no-speech' or 'aborted' normal lifecycle events
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('[STT] Recognition error:', event.error);
      }
    };

    this.recognition.onend = () => {
      // Preserve completed session text before Chrome wipes event.results on restart
      if (this.currentSessionFinalText) {
        this.priorSessionTranscripts.push(this.currentSessionFinalText);
        this.currentSessionFinalText = '';
      }
      this.interimTranscript = '';

      // If we are still supposed to be listening, restart to ensure continuous session
      if (this.isListening) {
        try {
          this.recognition.start();
        } catch (_) {}
      }
    };
  }

  setLanguage(newLang) {
    if (this.currentLanguage === newLang) return;
    this.currentLanguage = newLang;
    if (this.recognition) {
      const wasListening = this.isListening;
      if (wasListening) {
        this.stop();
      }
      this.recognition.lang = newLang;
      if (wasListening) {
        this.start();
      }
    }
  }

  start() {
    this.isListening = true;
    this.currentTurnTranscript = '';
    this.interimTranscript = '';
    if (this.recognition) {
      try {
        this.recognition.start();
      } catch (e) {
        // Already started or active
      }
    }
  }

  stop() {
    this.isListening = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (_) {}
    }
  }

  /**
   * Returns current accumulated transcript without clearing.
   * @returns {string}
   */
  getCurrentTranscript() {
    const allFinal = [...this.priorSessionTranscripts, this.currentSessionFinalText].filter(Boolean).join(' ').trim();
    return (allFinal + ' ' + this.interimTranscript).trim();
  }

  /**
   * Resets the speech accumulator for a new user speech turn (invoked by VAD onSpeechStart).
   * @param {boolean} [resetAll=false] - Whether to clear previously accumulated final segments
   */
  startNewTurn(resetAll = false) {
    if (resetAll) {
      this.priorSessionTranscripts = [];
      this.currentSessionFinalText = '';
      this.accumulatedFinalSegments = [];
      this.currentTurnTranscript = '';
    }
    this.interimTranscript = '';
    const allFinal = [...this.priorSessionTranscripts, this.currentSessionFinalText].filter(Boolean).join(' ').trim();
    this.onTranscriptUpdate({
      final: allFinal,
      interim: '',
      combined: allFinal,
      language: this.currentLanguage
    });
  }

  /**
   * Finalizes the current turn and retrieves the captured transcript, resetting buffers.
   * @returns {string}
   */
  finalizeTurn() {
    const allFinal = [...this.priorSessionTranscripts, this.currentSessionFinalText].filter(Boolean).join(' ').trim();
    const fullText = (allFinal + ' ' + this.interimTranscript).trim();
    this.priorSessionTranscripts = [];
    this.currentSessionFinalText = '';
    this.accumulatedFinalSegments = [];
    this.currentTurnTranscript = '';
    this.interimTranscript = '';
    return fullText;
  }

  /**
   * Fallback STT hook: Posts WAV Blob to Groq Cloud Whisper API (whisper-large-v3-turbo).
   * @param {Blob} wavBlob - Encoded 16kHz WAV Blob
   * @param {string} [lang] - Language code (e.g. 'en-US' or 'ar-AE')
   * @returns {Promise<string>} Transcribed text
   */
  async transcribeWithGroqWhisper(wavBlob, lang = null) {
    const apiKey = this.groqApiKey || import.meta.env.VITE_GROQ_API_KEY;
    if (!apiKey) {
      console.warn('[STT Fallback] No Groq API Key set. Skipping Whisper fallback.');
      return '';
    }

    const targetLang = (lang || this.currentLanguage).startsWith('ar') ? 'ar' : 'en';
    const formData = new FormData();
    formData.append('file', wavBlob, 'turn_audio.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', targetLang);
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq Whisper transcription failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.text ? data.text.trim() : '';
  }
}
