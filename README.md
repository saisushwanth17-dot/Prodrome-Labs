# Prodrome Labs — Full-Duplex Clinical Voice Pipeline

> **Future Health Digital Innovation Challenge (Abu Dhabi / MBZUAI / Microsoft / Inception)**  
> **Challenge 10:** *Earlier, Safer Mental Wellbeing Support*  
> **Repository:** [https://github.com/saisushwanth17-dot/Prodrome-Labs](https://github.com/saisushwanth17-dot/Prodrome-Labs)

---

## 🌟 Executive Summary

Prodrome Labs is an ultra-low-latency, full-duplex conversational voice pipeline designed for early, proactive, and safe mental wellbeing screening. The system provides natural, compassionate, and culturally attuned clinical intake across **English (en-US)** and **UAE Arabic (ar-AE)**.

It pairs client-side ONNX Silero VAD and AudioWorklet streaming with Groq Whisper-Large-v3-Turbo speech recognition, low-latency Socratic conversational intelligence, and streaming Azure Neural TTS with real-time prosody modulation.

---

## 🏗️ Architecture & Core Innovations

```
[ Microphone Input ]
         │
         ├──► 512-sample Int16 AudioWorklet (16 kHz)
         ├──► 500ms Pre-Roll Ring Buffer (Captures initial syllables)
         ├──► Silero VAD v5 (ONNX Runtime Web SIMD)
         ▼
[ Client-Side VoiceEngine.js ]
         │ (Dynamic Pause Hold 1400ms + Incomplete Clause Extension + Energy Gate)
         ▼
   TURN_COMPLETE (16kHz RIFF WAV Base64 + Browser Interim Transcript)
         │  (WebSocket: ws://127.0.0.1:8001/ws/voice)
         ▼
[ Mock Voice Server / FastAPI / Uvicorn ]
         │
         ├──► Groq Whisper Large-v3-Turbo (Full 16kHz audio ground truth)
         │    └─► Silence Hallucination Filter & Normalizer
         │    └─► Emits TRANSCRIPT_FINALIZED (UI Verified User Bubble)
         │
         ├──► Deterministic Crisis Tripwires (C-SSRS / 800-SAKINA / Istijaba)
         │
         ├──► Stateful Clinical Intake LLM (qwen/qwen3.8-27b on Groq Cloud)
         │    ├─► Slot Extraction: PHQ-9 (LOINC 44249-1), GAD-7 (LOINC 69737-5)
         │    ├─► Somatic Matrix: Chest Tightness (SNOMED 271795006), Terminal Insomnia (SNOMED 193462001)
         │    └─► Stepped Care Actions (4-7-8 Breathing, JIT Emirates ID Gate)
         │
         └──► Sentence-Boundary Audio Chunk Streaming (<450ms TTFA)
              └─► Azure AI Speech (ar-AE-FatimaNeural / en-US-JennyMultilingualNeural)
              └─► Emits AGENT_RESPONSE_CHUNK (Prosody-modulated audio)
         │
         ▼
[ Client-Side GaplessAudioQueue (Web Audio API) ]
         ├──► Seamless chained playback of incoming sentence chunks
         └──► Instant Barge-In (<30ms audio interrupt on sustained speech)
```

---

## 🏥 Clinical Code Contract Synchronization

All clinical constants, codes, and escalation hotlines are strictly synchronized with the Abu Dhabi healthcare ecosystem:

| Dimension | Standard / System | Code / Identifier | Specification |
|---|---|---|---|
| **Somatic Matrix** | SNOMED CT | `271795006` | Chest Tightness (Frequency: Episodic during work) |
| **Somatic Matrix** | SNOMED CT | `193462001` | Terminal Insomnia (Frequency: Nightly at ~3 AM) |
| **Psychometric Scale** | LOINC | `44249-1` | PHQ-9 (Depression Severity Scale) |
| **Psychometric Scale** | LOINC | `69737-5` | GAD-7 (Generalized Anxiety Disorder Scale) |
| **Psychometric Scale** | LOINC | `93250-9` | C-SSRS (Columbia-Suicide Severity Rating Scale) |
| **Emergency Hotline** | Primary UAE Hotline | `800-SAKINA (800 968)` | National Mental Health Hotline |
| **Emergency Hotline** | Secondary UAE Hotline | `Istijaba (800 1717)` | Abu Dhabi Department of Health / SEHA |

---

## 🚀 Key Features

1. **Continuous Pre-Roll Audio Recording:**
   Maintains a rolling 500ms ring buffer of 16kHz PCM audio so the first syllable of user speech is never clipped.
2. **Multi-Phrase Turn Accumulation & Clause Extension:**
   Accommodates congested, anxious, or hesitant speech with dynamic pause-hold tolerance (+600ms grace time on trailing conjunctions like *"and"*, *"because"*, *"و"*).
3. **Client & Server Hallucination Suppression:**
   Combines client-side Peak and RMS energy gating with server-side text normalization to eliminate Whisper silence hallucinations (`"Thank you."`, `"Thank you for watching."`).
4. **Sentence-Boundary Audio Streaming (<450ms TTFA):**
   Sentence 1 is synthesized and begins playing in the browser's `GaplessAudioQueue` while Sentence 2 is synthesized in the background.
5. **Instant User Barge-In (<30ms):**
   Cancels active audio buffers and interrupts server streaming instantly when sustained user voice is detected.
6. **Cultural & Linguistic Support:**
   Full bilingual support for Emirati Arabic (`ar-AE-FatimaNeural`) and English (`en-US-JennyMultilingualNeural`).

---

## 🛠️ Quick Start Guide

### Prerequisites
- **Node.js**: v18+ (v20+ recommended)
- **Python**: 3.10+ (tested on Python 3.11)
- Valid API Keys for **Azure AI Speech** and **Groq Cloud**

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/saisushwanth17-dot/Prodrome-Labs.git
cd Prodrome-Labs

# Install frontend dependencies
npm install

# Install Python backend dependencies
pip install fastapi uvicorn websockets python-dotenv
```

### 2. Environment Setup
Copy `.env.example` to `.env` and fill in your API credentials:
```bash
cp .env.example .env
```
Ensure `.env` contains:
```env
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=eastasia # or your region
GROQ_API_KEY=gsk_your_groq_key

VITE_AZURE_SPEECH_KEY=your_azure_speech_key
VITE_AZURE_SPEECH_REGION=eastasia
VITE_GROQ_API_KEY=gsk_your_groq_key
VITE_WS_URL=ws://localhost:8001/ws/voice
```

### 3. Running the Pipeline
Open two terminal windows:

**Terminal 1 — Backend Mock Server:**
```bash
python sandbox/mock_voice_server.py
```
*(Runs on `http://127.0.0.1:8001` with WebSocket endpoint `ws://127.0.0.1:8001/ws/voice`)*

**Terminal 2 — Frontend Dev Server:**
```bash
npm run dev
```
*(Runs on `http://localhost:5173`)*

---

## 🧪 Testing & Verification

Run the full end-to-end integration test suite:
```bash
# Run all 15 integration tests
python sandbox/test_voice_pipeline.py

# Run Phase 6 Groq Whisper full-speech verification
python sandbox/test_phase6_whisper.py

# Verify live cloud credentials
python sandbox/verify_live_credentials.py
```

All 15 test suites verify:
- Server configuration & clinical constants handshake
- Multi-chunk sentence streaming with `<450ms` TTFA
- Instant user barge-in with `<30ms` audio halt
- English and Arabic C-SSRS crisis tripwires
- Stepped Care simulation triggers (4-7-8 Breathing, JIT Emirates ID Gate)
- Multi-turn stateful Socratic LLM dialogue
- Full-audio Whisper transcription accuracy
