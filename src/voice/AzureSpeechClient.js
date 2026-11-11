// src/voice/AzureSpeechClient.js
import { buildClinicalSSML } from './AzureSSMLBuilder.js';

/**
 * Prodrome Labs Azure Speech Client
 * 
 * Interacts with Azure Cognitive Services Speech REST API (F0 Free Tier / Standard)
 * to synthesize speech from SSML dynamically.
 */
export class AzureSpeechClient {
  constructor(apiKey = null, region = null) {
    this.apiKey = apiKey || import.meta.env.VITE_AZURE_SPEECH_KEY || null;
    this.region = region || import.meta.env.VITE_AZURE_SPEECH_REGION || 'eastus';
  }

  setCredentials(apiKey, region) {
    this.apiKey = apiKey;
    if (region) this.region = region;
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Synthesizes clinical SSML via Azure Speech REST API.
   * @param {Object} params
   * @param {string} params.text - Response text to speak
   * @param {string} params.language - 'en-US' or 'ar-AE'
   * @param {number} [params.arousal=0.4] - WavLM arousal hint
   * @param {number} [params.valence=0.5] - WavLM valence hint
   * @returns {Promise<ArrayBuffer>} Audio ArrayBuffer
   */
  async synthesize({ text, language = 'en-US', arousal = 0.4, valence = 0.5 }) {
    if (!this.hasCredentials()) {
      throw new Error('Azure Speech API Key is not configured.');
    }

    const ssml = buildClinicalSSML({ text, language, arousal, valence });
    const endpoint = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.apiKey.trim(),
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'ProdromeLabsClinicalAgent'
      },
      body: ssml
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure Speech API failed (${response.status}): ${errText}`);
    }

    return await response.arrayBuffer();
  }
}
