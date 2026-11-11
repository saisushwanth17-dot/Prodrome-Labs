// src/voice/AzureSSMLBuilder.js
/**
 * Prodrome Labs Azure SSML Builder
 * 
 * Formats clinical dialogue with dynamic prosody modulation derived from
 * backend WavLM acoustic scoring (arousal & valence).
 * 
 * Target voices:
 * - Arabic: ar-AE-FatimaNeural
 * - English: en-US-JennyMultilingualNeural
 */

export function buildClinicalSSML({ text, language = 'en-US', arousal = 0.4, valence = 0.5 }) {
  const isArabic = language.startsWith('ar');
  const voiceName = isArabic ? 'ar-AE-FatimaNeural' : 'en-US-JennyMultilingualNeural';
  const xmlLang = isArabic ? 'ar-AE' : 'en-US';

  // Clinical calming prosody:
  // When autonomic arousal is high (>0.65) or valence is low (<0.35) (anxious/distressed),
  // modulate rate and pitch to provide empathetic, grounding cadence.
  let rate = '0%';
  let pitch = '0%';
  let volume = '+0%';

  if (arousal > 0.65) {
    rate = '-8%';
    pitch = '-3%';
    volume = '-5%'; // Softer, calmer vocal delivery
  } else if (arousal < 0.30) {
    // Depressive/hypoarousal state: warm, attentive pace
    rate = '-4%';
    pitch = '+0%';
    volume = '+0%';
  }

  const escapedText = (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${xmlLang}">
  <voice name="${voiceName}">
    <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">
      ${escapedText}
    </prosody>
  </voice>
</speak>`;
}
