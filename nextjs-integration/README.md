# Next.js 14 Integration Guide (Person 4 UI Alignment)
## Prodrome Labs &bull; Feature Branch: `feature/voice-pipeline`

This guide explains how Person 4 integrates Person 1's Full-Duplex Voice Engine into the Next.js 14 App Router UI.

### Step 1: Copy Static Assets to Next.js `public/`
Copy the following folders/files from `feature/voice-pipeline` to your Next.js project root:
- `public/pcm-worklet-processor.js` -> `next-app/public/pcm-worklet-processor.js`
- `public/vad/` -> `next-app/public/vad/` (contains ONNX models and WASM runtimes)

### Step 2: Copy Voice Engine Modules to `src/voice/`
Copy all files under `src/voice/` into your Next.js codebase:
- `src/voice/useVoiceEngine.js` (React `'use client'` hook)
- `src/voice/VoiceEngine.js` (Master orchestrator)
- `src/voice/GaplessAudioQueue.js` (Web Audio API scheduler)
- `src/voice/AzureSSMLBuilder.js` (SSML prosody builder)
- `src/voice/AzureSpeechClient.js` (Azure Cognitive Services client)
- `src/voice/SpeechRecognitionManager.js` (Bilingual STT manager)
- `src/voice/WavUtils.js` (44-byte RIFF WAV encoder/decoder)

### Step 3: Use `next.config.mjs`
Merge the settings from `nextjs-integration/next.config.mjs` into your root `next.config.mjs`:
- Adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
- Configures webpack fallbacks for `fs`, `path`, `crypto` for client bundling.

### Step 4: Import and Use `useVoiceEngine` in Client Components
```tsx
'use client';

import { useVoiceEngine } from '@/voice/useVoiceEngine';
import { useEffect, useRef } from 'react';

export default function VoiceSessionWidget() {
  const {
    state,
    language,
    setLanguage,
    transcript,
    telemetry,
    lastDispatchedAction,
    isSessionActive,
    startSession,
    stopSession,
    triggerManualBargeIn,
    getFrequencyData
  } = useVoiceEngine({
    language: 'en-US',
  });

  // Example canvas visualizer loop
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let animId: number;
    const draw = () => {
      const freq = getFrequencyData(); // Uint8Array(64)
      // Render 60fps wave...
      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animId);
  }, [getFrequencyData]);

  return (
    <div>
      <p>State: {state}</p>
      <p>Transcript: {transcript.final} {transcript.interim}</p>
      <button onClick={isSessionActive ? stopSession : startSession}>
        {isSessionActive ? 'Stop' : 'Start'}
      </button>

      {/* Auto-render modals based on lastDispatchedAction */}
      {lastDispatchedAction?.action_type === 'HARD_EMERGENCY_OVERRIDE' && (
        <CrisisModal payload={lastDispatchedAction.payload} />
      )}
      {lastDispatchedAction?.action_type === 'BREATHING_EXERCISE_478' && (
        <BreathingWidget payload={lastDispatchedAction.payload} />
      )}
      {lastDispatchedAction?.action_type === 'JIT_IDENTITY_GATE' && (
        <EmiratesIdGateModal payload={lastDispatchedAction.payload} />
      )}
    </div>
  );
}
```
