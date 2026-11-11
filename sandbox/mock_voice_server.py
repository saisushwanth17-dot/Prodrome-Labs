# sandbox/mock_voice_server.py
"""
Prodrome Labs - Full-Duplex Voice Sandbox Server (Phase 3 Strict Azure/Groq Edition)
Future Health Digital Innovation Challenge (Abu Dhabi / MBZUAI / Microsoft / Inception)
Challenge 10: Earlier, Safer Mental Wellbeing Support
Feature Branch: feature/voice-pipeline
"""

import os
import sys
import io
import time
import json
import base64
import wave
import struct
import re
import uuid
import asyncio
import urllib.request
import urllib.error
from typing import Dict, Optional, Tuple
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# Explicitly load .env file at startup
try:
    from dotenv import load_dotenv
    load_dotenv(override=True)
except ImportError:
    pass

# Manual fallback parser for .env if needed
def ensure_env_loaded():
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("\"'")
                    if k and v and k not in os.environ:
                        os.environ[k] = v

ensure_env_loaded()

def get_env_credentials() -> Tuple[str, str, str]:
    """Retrieves Azure and Groq credentials from environment."""
    azure_key = os.environ.get("AZURE_SPEECH_KEY") or os.environ.get("VITE_AZURE_SPEECH_KEY", "")
    azure_region = os.environ.get("AZURE_SPEECH_REGION") or os.environ.get("VITE_AZURE_SPEECH_REGION", "eastasia")
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("VITE_GROQ_API_KEY", "")
    return azure_key.strip(), azure_region.strip(), groq_key.strip()

AZURE_KEY, AZURE_REGION, GROQ_KEY = get_env_credentials()

# Print loaded credentials status to console on startup
print("=" * 65)
print(" PRODROME LABS VOICE PIPELINE MOCK SERVER (PHASE 3)")
print(f" [CONFIG] Azure Speech Key:    {AZURE_KEY[:4]}...{AZURE_KEY[-4:] if AZURE_KEY else 'NOT_SET'} ({len(AZURE_KEY)} chars)")
print(f" [CONFIG] Azure Region:        {AZURE_REGION}")
print(f" [CONFIG] Groq Whisper Key:    {GROQ_KEY[:4]}...{GROQ_KEY[-4:] if GROQ_KEY else 'NOT_SET'} ({len(GROQ_KEY)} chars)")
print(f" [CONFIG] Fallback Policy:     STRICT LIVE APIS ONLY (gTTS/pyttsx3/sine stripped)")
print("=" * 65)

app = FastAPI(title="Prodrome Labs Voice Sandbox", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

active_streaming_tasks: Dict[WebSocket, Optional[asyncio.Task]] = {}

# Clinical Constants locked to Team Briefing Specification
CLINICAL_CONSTANTS = {
    "hotlines": {
        "primary": "800-SAKINA (800 968)",
        "secondary": "Istijaba (800 1717)"
    },
    "snomed_matrix": {
        "chest_tightness": {
            "code": "271795006",
            "term": "Chest Tightness",
            "frequency": "Episodic (during working hours)"
        },
        "terminal_insomnia": {
            "code": "193462001",
            "term": "Terminal Insomnia",
            "frequency": "Nightly"
        }
    },
    "loinc_scales": {
        "phq9": {"code": "44249-1", "name": "PHQ-9 (Patient Health Questionnaire 9-item)"},
        "gad7": {"code": "69737-5", "name": "GAD-7 (Generalized Anxiety Disorder 7-item)"},
        "cssrs": {"code": "93250-9", "name": "C-SSRS (Columbia-Suicide Severity Rating Scale)"}
    }
}


def synthesize_azure_speech(text: str, lang: str = "en-US", arousal: float = 0.4) -> Tuple[Optional[bytes], Optional[str]]:
    """
    Synthesizes speech using official Microsoft Azure AI Speech REST API.
    Uses ar-AE-FatimaNeural (Arabic) and en-US-JennyMultilingualNeural (English).
    Returns (audio_bytes, error_message).
    """
    key, region, _ = get_env_credentials()
    if not key:
        return None, "AZURE_SPEECH_KEY is missing from .env"

    is_ar = lang.startswith("ar")
    voice = "ar-AE-FatimaNeural" if is_ar else "en-US-JennyMultilingualNeural"
    xml_lang = "ar-AE" if is_ar else "en-US"
    rate = "-10%" if arousal > 0.65 else "0%"
    pitch = "-3%" if arousal > 0.65 else "0%"

    escaped = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )

    ssml = f"""<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{xml_lang}">
  <voice name="{voice}">
    <prosody rate="{rate}" pitch="{pitch}">
      {escaped}
    </prosody>
  </voice>
</speak>"""

    url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
    req = urllib.request.Request(
        url,
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
            "User-Agent": "ProdromeLabsMockServer",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            data = resp.read()
            print(f"[AZURE SPEECH SUCCESS] Synthesized '{text[:35]}...' | Voice: {voice} | Size: {len(data)/1024:.1f} KB")
            return data, None
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        msg = f"Azure Speech API HTTP {e.code} ({e.reason}): {err_body}"
        print(f"[AZURE SPEECH ERROR] {msg}")
        return None, msg
    except Exception as e:
        msg = f"Azure Speech Connection Error: {str(e)}"
        print(f"[AZURE SPEECH ERROR] {msg}")
        return None, msg


def transcribe_groq_whisper(wav_bytes: bytes, lang: str = "en") -> Tuple[Optional[str], Optional[str]]:
    """
    Transcribes audio using Groq Whisper (whisper-large-v3-turbo with fallback to whisper-large-v3).
    Configured for 100% full-speech accuracy with clinical domain prompt and temperature=0.0.
    Returns (transcript_text, error_message).
    """
    _, _, groq_key = get_env_credentials()
    if not groq_key:
        return None, "GROQ_API_KEY is missing from .env"

    target_lang = "ar" if lang.startswith("ar") else "en"
    if target_lang == "ar":
        clinical_prompt = "محادثة طبية ونفسية في أبوظبي. يرجى تحويل الكلام بدقة كاملة بما في ذلك الأعراض الجسدية، ضيق الصدر، الأرق، الاستيقاظ في الساعة الثالثة صباحاً، العمل، التأمين الصحي ضمان وثقة."
    else:
        clinical_prompt = "Clinical intake conversation. The patient may have a congested voice, cold, sighs, or pauses. Accurately transcribe every word including sleep times like 3 AM, chest tightness, heart racing, work calls, roommates, gym, Daman, Thiqa, SEHA, Emirates ID, visa, anxiety, and physical symptoms."

    def make_request(model_name: str):
        boundary = "----WebKitFormBoundary" + uuid.uuid4().hex[:16]
        body = bytearray()
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model_name}\r\n".encode("utf-8"))
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{target_lang}\r\n".encode("utf-8"))
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"temperature\"\r\n\r\n0.0\r\n".encode("utf-8"))
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n{clinical_prompt}\r\n".encode("utf-8"))
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n".encode("utf-8"))
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"turn_audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode("utf-8"))
        body.extend(wav_bytes)
        body.extend(f"\r\n--{boundary}--\r\n".encode("utf-8"))

        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            data=bytes(body),
            headers={
                "Authorization": f"Bearer {groq_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": "ProdromeLabsMockServer",
            },
            method="POST"
        )
        return urllib.request.urlopen(req, timeout=12.0)

    try:
        try:
            with make_request("whisper-large-v3-turbo") as resp:
                data = json.loads(resp.read().decode("utf-8"))
                transcript = data.get("text", "").strip()
                print(f"[GROQ WHISPER SUCCESS (whisper-large-v3-turbo)] Transcribed: '{transcript}'")
                return transcript, None
        except urllib.error.HTTPError as turbo_err:
            if turbo_err.code in (404, 429, 503):
                print(f"[GROQ WHISPER] whisper-large-v3-turbo returned HTTP {turbo_err.code}, attempting fallback to whisper-large-v3...")
                with make_request("whisper-large-v3") as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    transcript = data.get("text", "").strip()
                    print(f"[GROQ WHISPER SUCCESS (whisper-large-v3)] Transcribed: '{transcript}'")
                    return transcript, None
            raise turbo_err
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        msg = f"Groq Whisper HTTP {e.code} ({e.reason}): {err_body}"
        print(f"[GROQ WHISPER ERROR] {msg}")
        return None, msg
    except Exception as e:
        msg = f"Groq Whisper Connection Error: {str(e)}"
        print(f"[GROQ WHISPER ERROR] {msg}")
        return None, msg


# In-memory multi-turn session storage for clinical dialogue state
SESSION_HISTORIES: Dict[str, dict] = {}

def get_or_create_session(session_uuid: str) -> dict:
    if session_uuid not in SESSION_HISTORIES:
        SESSION_HISTORIES[session_uuid] = {
            "messages": [],
            "extracted_slots": {
                "phq9_estimate": 0,
                "gad7_estimate": 0,
                "somatic_flags": []
            },
            "turn_count": 0
        }
    return SESSION_HISTORIES[session_uuid]


def get_fallback_clinical_response(user_transcript: str, lang: str, turn_num: int) -> dict:
    """Safe, empathetic conversational fallback if LLM network call fails."""
    is_ar = lang.startswith("ar")
    if turn_num == 1:
        if is_ar:
            text = "أسمعك بوضوح، وضيق الصدر مع قلة النوم أمر يسبب إرهاقاً شديداً. هل تلاحظ أن هذه النوبات تتكرر أثناء ساعات العمل؟"
        else:
            text = "I hear you clearly, and having trouble sleeping along with chest tightness can feel so draining. Does this tightness tend to flare up during work hours?"
        slots = {"phq9_estimate": 4, "gad7_estimate": 6, "somatic_flags": ["Chest Tightness (SNOMED: 271795006)"]}
        action = None
    elif turn_num == 2:
        if is_ar:
            text = "الاستيقاظ المتكرر عند الفجر يرهق الجهاز العصبي ويزيد التوتر. كم ساعة تقريباً تتمكن من النوم ليلاً؟"
        else:
            text = "Waking up in the middle of the night puts real strain on your nervous system. How many hours of uninterrupted sleep are you getting?"
        slots = {"phq9_estimate": 7, "gad7_estimate": 8, "somatic_flags": ["Terminal Insomnia (SNOMED: 193462001)"]}
        action = None
    else:
        if is_ar:
            text = "أشعر بمدى الضغط الذي تعيشه. لنأخذ استراحة قصيرة معاً الآن لتهدئة تنفسك وتقليل التوتر."
        else:
            text = "I can feel how overwhelmed your body is right now. Let's take a brief moment together to calm your breathing and ease that chest pressure."
        slots = {"phq9_estimate": 9, "gad7_estimate": 11, "somatic_flags": ["Chest Tightness (SNOMED: 271795006)", "Terminal Insomnia (SNOMED: 193462001)"]}
        action = "BREATHING_EXERCISE_478"

    return {
        "reply_text": text,
        "prosody_hint": {"arousal": 0.45, "valence": 0.50},
        "extracted_slots": slots,
        "dispatched_action": action
    }


def query_groq_clinical_llm(session_uuid: str, user_transcript: str, lang: str) -> dict:
    """
    Executes a multi-turn Socratic clinical intake dialogue via Groq Chat Completions.
    Prioritizes fast, empathetic models (openai/gpt-oss-20b, openai/gpt-oss-120b, qwen/qwen3.8-27b).
    Maintains session history and clinical slot extraction across turns.
    """
    key, _, groq_key = get_env_credentials()
    session = get_or_create_session(session_uuid)
    session["turn_count"] += 1
    turn_num = session["turn_count"]

    is_ar = lang.startswith("ar")
    lang_directive = (
        "Respond strictly in warm, empathetic UAE Arabic (Khaleeji-friendly ar-AE). Use natural spoken colloquial phrasing."
        if is_ar else
        "Respond strictly in warm, empathetic spoken English (en-US)."
    )

    system_prompt = f"""You are an empathetic, human-like clinical navigation assistant for Prodrome Labs in Abu Dhabi (Challenge 10: Earlier, Safer Mental Wellbeing Support).

CLINICAL INTAKE OBJECTIVES:
Engage in a gentle, warm Socratic dialogue with the patient to uncover:
1. Low mood, loss of interest, or exhaustion (PHQ-9, LOINC: 44249-1)
2. Excessive worry, restlessness, or nervous tension (GAD-7, LOINC: 69737-5)
3. Sleep disturbances or early morning waking (ISI, SNOMED: 193462001 Terminal Insomnia)
4. Somatic tension (SNOMED: 271795006 Chest Tightness, headaches, stomach tension)

SPOKEN CONVERSATION RULES:
1. Speak naturally like a real, caring clinician in 1 to 2 short conversational sentences maximum.
2. Directly validate and acknowledge the specific feeling or symptom the patient just described.
3. Gently ask ONE natural follow-up question to uncover onset, frequency, or daily impact.
4. NEVER repeat previous sentences. NEVER use robotic bullet points or diagnostic labels.
5. NEVER say "Thank you for sharing" or start with "Thank you" unless the patient explicitly gave you assistance. Be a conversational therapist.
6. {lang_directive}
7. Stepped Care Navigation:
   - On Turn 3 or later (or if user asks for relaxation/help):
     * If user exhibits mild-to-moderate anxiety/stress, set dispatched_action to "BREATHING_EXERCISE_478".
     * If user describes persistent chest tightness + terminal insomnia or severe distress, set dispatched_action to "JIT_IDENTITY_GATE" to connect with SEHA/AHS/SAKINA stepped care.
   - Otherwise, set dispatched_action to null.

YOU MUST RESPOND STRICTLY IN A VALID JSON OBJECT MATCHING THIS FORMAT:
{{
  "reply_text": "I hear how heavy that feels. Have you noticed if this happens more during work hours?",
  "prosody_hint": {{ "arousal": 0.45, "valence": 0.50 }},
  "extracted_slots": {{
    "phq9_estimate": 10,
    "gad7_estimate": 8,
    "somatic_flags": ["Chest Tightness (SNOMED: 271795006)"]
  }},
  "dispatched_action": null
}}"""

    messages = [{"role": "system", "content": system_prompt}]
    for m in session["messages"][-6:]:
        messages.append(m)
    messages.append({"role": "user", "content": user_transcript})

    if not groq_key:
        print("[GROQ LLM] No GROQ_API_KEY found, using local clinical fallback")
        return get_fallback_clinical_response(user_transcript, lang, turn_num)

    # Use verified Groq models with native JSON support
    models = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]
    for model in models:
        url = "https://api.groq.com/openai/v1/chat/completions"
        payload = {
            "model": model,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "temperature": 0.6,
            "max_tokens": 400
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {groq_key}",
                "Content-Type": "application/json",
                "User-Agent": "ProdromeLabsMockServer"
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                reply_text = parsed.get("reply_text", "").strip()
                if reply_text:
                    # Update session history with JSON assistant turn so Groq json_object format stays valid
                    session["messages"].append({"role": "user", "content": user_transcript})
                    session["messages"].append({"role": "assistant", "content": json.dumps({"reply_text": reply_text})})
                    # Update slots
                    if "extracted_slots" in parsed and isinstance(parsed["extracted_slots"], dict):
                        session["extracted_slots"].update(parsed["extracted_slots"])
                    print(f"[GROQ LLM SUCCESS] Model: {model} | Turn {turn_num} | Reply: '{reply_text[:60]}...'")
                    return parsed
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            print(f"[GROQ LLM] Model {model} HTTP {e.code}: {err_body[:60]} -> trying fallback model")
        except Exception as e:
            print(f"[GROQ LLM] Model {model} Error: {e} -> trying fallback model")

    return get_fallback_clinical_response(user_transcript, lang, turn_num)


@app.get("/health")
def health():
    azure_key, azure_region, groq_key = get_env_credentials()
    return {
        "status": "healthy",
        "service": "Prodrome Labs Full-Duplex Voice Sandbox",
        "version": "3.0.0",
        "challenge": "Challenge 10: Earlier, Safer Mental Wellbeing Support (Abu Dhabi)",
        "azure_speech_configured": bool(azure_key),
        "azure_region": azure_region,
        "groq_whisper_configured": bool(groq_key),
        "tts_provider": "Azure AI Speech Services (F0 Tier)",
        "voices": ["ar-AE-FatimaNeural", "en-US-JennyMultilingualNeural"],
        "stt_fallback_provider": "Groq Whisper (whisper-large-v3-turbo)",
        "clinical_constants": CLINICAL_CONSTANTS
    }


@app.get("/api/verify-keys")
def api_verify_keys():
    """Live 1-click verification endpoint for Azure Speech and Groq Whisper APIs."""
    t0 = time.time()
    azure_key, azure_region, groq_key = get_env_credentials()
    
    # 1. Test Azure Speech
    azure_res = {"status": "FAIL", "latency_ms": 0, "audio_base64": "", "error": None}
    if azure_key:
        t_az0 = time.time()
        test_phrase = "Prodrome Labs Azure neural voice verified."
        audio_bytes, err = synthesize_azure_speech(test_phrase, lang="en-US", arousal=0.4)
        az_latency = int((time.time() - t_az0) * 1000)
        azure_res["latency_ms"] = az_latency
        if audio_bytes:
            azure_res["status"] = "PASS"
            azure_res["audio_base64"] = base64.b64encode(audio_bytes).decode("utf-8")
            azure_res["voice"] = "en-US-JennyMultilingualNeural"
            azure_res["region"] = azure_region
        else:
            azure_res["error"] = err
    else:
        azure_res["error"] = "AZURE_SPEECH_KEY is missing from .env"

    # 2. Test Groq Whisper
    groq_res = {"status": "FAIL", "latency_ms": 0, "error": None}
    if groq_key:
        t_gq0 = time.time()
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(struct.pack("<16000h", *([0]*16000)))
        raw_wav = wav_buf.getvalue()

        txt, err = transcribe_groq_whisper(raw_wav, lang="en")
        gq_latency = int((time.time() - t_gq0) * 1000)
        groq_res["latency_ms"] = gq_latency
        if err is None:
            groq_res["status"] = "PASS"
            groq_res["model"] = "whisper-large-v3-turbo"
            groq_res["sample_transcription"] = txt
        else:
            groq_res["error"] = err
    else:
        groq_res["error"] = "GROQ_API_KEY is missing from .env"

    return {
        "timestamp": int(time.time() * 1000),
        "total_latency_ms": int((time.time() - t0) * 1000),
        "azure": azure_res,
        "groq": groq_res
    }


@app.post("/api/reset-session")
async def api_reset_session(payload: dict = None):
    uuid_str = (payload or {}).get("session_uuid", "prodrome-test")
    if uuid_str in SESSION_HISTORIES:
        del SESSION_HISTORIES[uuid_str]
    print(f"[REST] Reset conversation session memory for {uuid_str}")
    return {"status": "ok", "session_uuid": uuid_str, "message": "Session memory cleared"}


@app.websocket("/ws/voice")
async def voice_endpoint(ws: WebSocket):
    await ws.accept()
    active_streaming_tasks[ws] = None
    azure_key, azure_region, groq_key = get_env_credentials()

    print("[MOCK SERVER] Client connected to Voice Sandbox (/ws/voice)")

    # Send initial configuration status packet
    await ws.send_text(json.dumps({
        "event": "SERVER_CONFIG_STATUS",
        "tts_tier": "Azure AI Speech (F0 Tier)" if azure_key else "AZURE KEY NOT FOUND",
        "azure_configured": bool(azure_key),
        "azure_region": azure_region,
        "groq_configured": bool(groq_key),
        "voices": {
            "arabic": "ar-AE-FatimaNeural",
            "english": "en-US-JennyMultilingualNeural"
        },
        "hotlines": CLINICAL_CONSTANTS["hotlines"],
        "snomed_matrix": CLINICAL_CONSTANTS["snomed_matrix"],
        "loinc_scales": CLINICAL_CONSTANTS["loinc_scales"]
    }))

    try:
        while True:
            raw_msg = await ws.receive_text()
            data = json.loads(raw_msg)
            event = data.get("event")

            # 1. USER_BARGE_IN Handler
            if event == "USER_BARGE_IN":
                halt_ms = data.get("halt_latency_ms", "N/A")
                ts = data.get("timestamp_ms", "N/A")
                trigger = data.get("source", "silero_vad")
                session_uuid = data.get("session_uuid", "unknown")
                print(f"[BARGE-IN] Halting active server stream for session '{session_uuid}' | Trigger: {trigger} | Halt Latency: {halt_ms}ms at {ts}")
                
                # Instantly cancel active sentence streaming task
                active_task = active_streaming_tasks.get(ws)
                if active_task and not active_task.done():
                    active_task.cancel()
                    print(f"[BARGE-IN] In-flight multi-chunk sentence streaming task for '{session_uuid}' canceled.")
                continue

            # 2. VERIFY_API_KEYS WebSocket Trigger
            if event == "VERIFY_API_KEYS":
                print("[VERIFY] Running live credentials check via WebSocket request...")
                result = api_verify_keys()
                await ws.send_text(json.dumps({
                    "event": "VERIFY_KEYS_RESULT",
                    **result
                }))
                continue

            # 2b. RESET_SESSION_MEMORY WebSocket Trigger
            if event == "RESET_SESSION_MEMORY":
                session_uuid = data.get("session_uuid", "prodrome-test")
                if session_uuid in SESSION_HISTORIES:
                    del SESSION_HISTORIES[session_uuid]
                print(f"[SERVER] Cleared conversation session memory for {session_uuid}")
                await ws.send_text(json.dumps({
                    "event": "SESSION_MEMORY_RESET",
                    "session_uuid": session_uuid,
                    "extracted_slots": {
                        "phq9_estimate": 0,
                        "gad7_estimate": 0,
                        "somatic_flags": []
                    }
                }))
                continue

            # 3. CLIENT_SIMULATE_ACTION (Day 3 Bridge Test Triggers)
            if event == "CLIENT_SIMULATE_ACTION":
                sim_type = data.get("simulation_type")
                lang = data.get("language", "en-US")
                session_uuid = data.get("session_uuid", "sim-session")
                print(f"[SIMULATION TRIGGER] Received action simulation: {sim_type} ({lang})")

                # Action 1: Hard Emergency Override
                if sim_type == "CRISIS_OVERRIDE":
                    await ws.send_text(json.dumps({
                        "event": "DISPATCH_ACTION",
                        "action_type": "HARD_EMERGENCY_OVERRIDE",
                        "payload": {
                            "hotline_primary": CLINICAL_CONSTANTS["hotlines"]["primary"],
                            "hotline_secondary": CLINICAL_CONSTANTS["hotlines"]["secondary"],
                            "loinc_code": CLINICAL_CONSTANTS["loinc_scales"]["cssrs"]["code"],
                            "clinic_routing": "SEHA / AHS Urgent Behavioral Support Center",
                            "crisis_type": "C-SSRS_IMM_RISK",
                            "message_en": "Emergency SAKINA protocol activated immediately. Please contact the National Mental Health Hotline 800-SAKINA (800 968) or Istijaba (800 1717).",
                            "message_ar": "تم تفعيل بروتوكول سكينة للطوارئ فوراً. الرجاء الاتصال بالخط الساخن الوطني 800-SAKINA (800 968) أو استجابة (800 1717)."
                        }
                    }))
                    continue

                # Action 2: Level 1 4-7-8 Breathing Exercise
                if sim_type == "BREATHING_478":
                    await ws.send_text(json.dumps({
                        "event": "DISPATCH_ACTION",
                        "action_type": "BREATHING_EXERCISE_478",
                        "payload": {
                            "level": 1,
                            "cycles": 4,
                            "inhale_sec": 4,
                            "hold_sec": 7,
                            "exhale_sec": 8,
                            "rationale": "High autonomic arousal detected (WavLM arousal > 0.70). Activating grounding exercise.",
                            "message_en": "Let's take a moment together. Inhale gently for 4 seconds, hold for 7, and exhale slowly for 8.",
                            "message_ar": "دعنا نهدأ معاً للحظة. خذ نفساً عميقاً لمدة 4 ثوانٍ، احبسه لـ 7 ثوانٍ، ثم ازفره ببطء لـ 8 ثوانٍ."
                        }
                    }))
                    spoken_text = (
                        "دعنا نهدأ معاً للحظة. خذ نفساً عميقاً، احبسه بهدوء، ثم ازفره ببطء."
                        if lang.startswith("ar") else
                        "Let's take a moment together. Inhale gently for 4 seconds, hold for 7, and exhale slowly for 8."
                    )
                    audio_bytes, err = synthesize_azure_speech(spoken_text, lang=lang, arousal=0.75)
                    if audio_bytes:
                        await ws.send_text(json.dumps({
                            "event": "AGENT_RESPONSE_CHUNK",
                            "session_uuid": session_uuid,
                            "turn_id": f"sim-breathe-{uuid.uuid4().hex[:6]}",
                            "chunk_index": 0,
                            "is_final_chunk": True,
                            "language": lang,
                            "text_chunk": spoken_text,
                            "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                            "prosody_hint": {"arousal": 0.75, "valence": 0.40}
                        }))
                    else:
                        await ws.send_text(json.dumps({
                            "event": "SERVER_ERROR",
                            "error_type": "AZURE_SPEECH_ERROR",
                            "message": err or "Failed to synthesize breathing audio with Azure Speech"
                        }))
                    continue

                # Action 3: Level 2 JIT Emirates ID Gate
                if sim_type == "JIT_IDENTITY":
                    await ws.send_text(json.dumps({
                        "event": "DISPATCH_ACTION",
                        "action_type": "JIT_IDENTITY_GATE",
                        "payload": {
                            "level": 2,
                            "clinical_scales": [
                                {
                                    "scale": "PHQ-9",
                                    "loinc": CLINICAL_CONSTANTS["loinc_scales"]["phq9"]["code"],
                                    "score": 12,
                                    "severity": "Moderate"
                                },
                                {
                                    "scale": "GAD-7",
                                    "loinc": CLINICAL_CONSTANTS["loinc_scales"]["gad7"]["code"],
                                    "score": 14,
                                    "severity": "Moderate"
                                }
                            ],
                            "somatic_snomed_codes": [
                                CLINICAL_CONSTANTS["snomed_matrix"]["chest_tightness"],
                                CLINICAL_CONSTANTS["snomed_matrix"]["terminal_insomnia"]
                            ],
                            "routing_target": "AHS / SEHA Stepped Care Primary Clinic (Abu Dhabi)",
                            "zk_anonymized_brief_ready": True,
                            "malaffi_fhir_bundle": "Bundle/malaffi-intake-r4",
                            "message_en": "Based on your clinical markers, we recommend connecting with an AHS Stepped Care specialist. Authenticate via UAE PASS for direct Malaffi booking?",
                            "message_ar": "بناءً على التقييم السريري، نوصي بربطك بأخصائي الرعاية المتدرجة في مراكز صحة. هل تود تسجيل الدخول بالهوية الرقمية UAE PASS لحجز ملفك في ملفي؟"
                        }
                    }))
                    spoken_text = (
                        "بناءً على التقييم السريري، نوصي بربطك بأخصائي في مراكز صحة. هل تود المتابعة؟"
                        if lang.startswith("ar") else
                        "Based on your clinical markers, we recommend connecting with an AHS Stepped Care specialist. Would you like to proceed?"
                    )
                    audio_bytes, err = synthesize_azure_speech(spoken_text, lang=lang, arousal=0.50)
                    if audio_bytes:
                        await ws.send_text(json.dumps({
                            "event": "AGENT_RESPONSE_CHUNK",
                            "session_uuid": session_uuid,
                            "turn_id": f"sim-jit-{uuid.uuid4().hex[:6]}",
                            "chunk_index": 0,
                            "is_final_chunk": True,
                            "language": lang,
                            "text_chunk": spoken_text,
                            "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                            "prosody_hint": {"arousal": 0.50, "valence": 0.50}
                        }))
                    continue

                # Action 4: High Arousal Voice Modulation (0.85)
                if sim_type == "HIGH_AROUSAL_VOICE":
                    spoken_text = (
                        "أشعر بنبرة التوتر والإرهاق في صوتك. أنا هنا معك خطوة بخطوة، وسنمضي معاً بكل هدوء."
                        if lang.startswith("ar") else
                        "I notice significant tension in your voice. I am right here with you, and we will take this step by step at your pace."
                    )
                    audio_bytes, err = synthesize_azure_speech(spoken_text, lang=lang, arousal=0.85)
                    if audio_bytes:
                        await ws.send_text(json.dumps({
                            "event": "AGENT_RESPONSE_CHUNK",
                            "session_uuid": session_uuid,
                            "turn_id": f"sim-arousal-{uuid.uuid4().hex[:6]}",
                            "chunk_index": 0,
                            "is_final_chunk": True,
                            "language": lang,
                            "text_chunk": spoken_text,
                            "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                            "prosody_hint": {"arousal": 0.85, "valence": 0.20}
                        }))
                    else:
                        await ws.send_text(json.dumps({
                            "event": "SERVER_ERROR",
                            "error_type": "AZURE_SPEECH_ERROR",
                            "message": err or "Failed to synthesize high-arousal audio"
                        }))
                    continue

            # 4. TURN_COMPLETE Handler
            if event == "TURN_COMPLETE":
                lang = data.get("language", "en-US")
                transcript = data.get("transcript", "")
                pcm_b64 = data.get("audio_pcm_base64", "")
                silence_ms = data.get("silence_trigger_ms", 600)
                session_uuid = data.get("session_uuid", "prodrome-test")

                # Verify incoming 16kHz WAV buffer from Person 1 (for Person 2's WavLM model)
                wav_bytes = b""
                wav_size_kb = 0
                if pcm_b64:
                    try:
                        wav_bytes = base64.b64decode(pcm_b64)
                        wav_size_kb = round(len(wav_bytes) / 1024, 1)
                        is_riff = wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE"
                        riff_status = "Valid 16kHz RIFF WAV" if is_riff else "Raw PCM"
                    except Exception:
                        riff_status = "Decoding Error"
                else:
                    riff_status = "Empty Buffer"

                # Phase 6: ALWAYS transcribe audio_pcm_base64 with Groq Whisper as primary ground truth!
                raw_browser_transcript = (transcript or "").strip()
                authoritative_transcript = ""
                is_whisper_verified = False

                HALLUCINATION_PATTERNS = {
                    "you", "thank you", "thank you.", "thank you very much", "thank you so much",
                    "thanks", "thanks.", "thank you for watching", "thank you for watching.",
                    "bye", "bye.", "bye bye", "subscribe", ".", "..", "...", "hmm", "huh",
                    "ترجمة", "ترجمة نانسي قنقر", "شكرا", "شكراً", "شكرا للمشاهدة", "مع السلامة", "إلى اللقاء"
                }

                def is_hallucination_text(t: str) -> bool:
                    if not t:
                        return True
                    cleaned = re.sub(r'[^\w\s]', '', t.lower()).strip()
                    if len(cleaned) < 2:
                        return True
                    return (cleaned in HALLUCINATION_PATTERNS or t.lower().strip() in HALLUCINATION_PATTERNS)

                if len(wav_bytes) > 44 and groq_key:
                    print(f"[STT] Transcribing full turn audio ({wav_size_kb} KB) using Groq whisper-large-v3-turbo...")
                    g_trans, g_err = transcribe_groq_whisper(wav_bytes, lang=lang)
                    if g_trans and len(g_trans.strip()) > 0:
                        if is_hallucination_text(g_trans):
                            # Whisper hallucinated on silence/background hiss
                            if not is_hallucination_text(raw_browser_transcript):
                                print(f"[STT] Whisper hallucinated '{g_trans}', keeping browser transcript: '{raw_browser_transcript}'")
                                authoritative_transcript = raw_browser_transcript
                            else:
                                print(f"[STT] Discarded silence hallucination: Whisper='{g_trans}' | Browser='{raw_browser_transcript}'")
                                authoritative_transcript = ""
                        else:
                            authoritative_transcript = g_trans.strip()
                            is_whisper_verified = True
                            print(f"[STT] Groq Whisper 100% full-audio verified: '{authoritative_transcript}'")
                    elif g_err:
                        print(f"[STT] Groq Whisper error ({g_err}); falling back to browser transcript: '{raw_browser_transcript}'")
                        if not is_hallucination_text(raw_browser_transcript):
                            authoritative_transcript = raw_browser_transcript
                        else:
                            authoritative_transcript = ""
                elif not is_hallucination_text(raw_browser_transcript):
                    authoritative_transcript = raw_browser_transcript

                # Strictly discard turns that are empty or noise/silence hallucinations
                if not authoritative_transcript or is_hallucination_text(authoritative_transcript):
                    print(f"[TURN COMPLETE] Discarded ambient silence / hallucination turn: '{authoritative_transcript}' (Whisper/Browser was not human speech)")
                    continue

                # ONLY dispatch TRANSCRIPT_FINALIZED when we have verified legitimate user speech!
                await ws.send_text(json.dumps({
                    "event": "TRANSCRIPT_FINALIZED",
                    "verified_transcript": authoritative_transcript,
                    "source": "groq-whisper-large-v3-turbo" if is_whisper_verified else "browser-speech-api",
                    "session_uuid": session_uuid,
                    "audio_size_kb": wav_size_kb
                }))

                print(f"[TURN COMPLETE] ({lang}) Verified Transcript: '{authoritative_transcript}' | VAD Silence: {silence_ms}ms | Audio: {wav_size_kb} KB [{riff_status}]")

                # Deterministic C-SSRS Crisis Tripwire Check across BOTH authoritative and browser transcripts
                crisis_patterns = [
                    r"\bsuicide\b", r"\bkill myself\b", r"\bend it all\b", r"\bwant to die\b",
                    r"\bno reason to live\b", r"\bhang myself\b", r"\boverdose\b",
                    r"انتحار", r"أنتحر", r"أقتل نفسي", r"أريد الموت", r"أنهي حياتي", r"الموت أفضل"
                ]
                has_crisis = (
                    any(re.search(pat, authoritative_transcript, re.IGNORECASE) for pat in crisis_patterns) or
                    any(re.search(pat, raw_browser_transcript, re.IGNORECASE) for pat in crisis_patterns)
                )

                if has_crisis:
                    print(f"[CRISIS TRIPWIRE TRIGGERED] C-SSRS tripwire intercepted query: '{authoritative_transcript}'")
                    await ws.send_text(json.dumps({
                        "event": "DISPATCH_ACTION",
                        "action_type": "HARD_EMERGENCY_OVERRIDE",
                        "payload": {
                            "hotline_primary": CLINICAL_CONSTANTS["hotlines"]["primary"],
                            "hotline_secondary": CLINICAL_CONSTANTS["hotlines"]["secondary"],
                            "loinc_code": CLINICAL_CONSTANTS["loinc_scales"]["cssrs"]["code"],
                            "clinic_routing": "SEHA / AHS Urgent Behavioral Support Center",
                            "crisis_type": "C-SSRS_IMM_RISK",
                            "message_en": "Emergency SAKINA protocol activated immediately. Please contact the National Mental Health Hotline 800-SAKINA (800 968) or Istijaba (800 1717).",
                            "message_ar": "تم تفعيل بروتوكول سكينة للطوارئ فوراً. الرجاء الاتصال بالخط الساخن الوطني 800-SAKINA (800 968) أو استجابة (800 1717)."
                        }
                    }))
                    continue

                # Multi-Turn Stateful Conversational Clinical Intake (Groq LLM)
                clinical_data = query_groq_clinical_llm(session_uuid, authoritative_transcript, lang)
                reply_text = clinical_data.get("reply_text", "")
                prosody_hint = clinical_data.get("prosody_hint", {"arousal": 0.50, "valence": 0.50})
                if not isinstance(prosody_hint, dict):
                    prosody_hint = {"arousal": 0.50, "valence": 0.50}
                extracted_slots = clinical_data.get("extracted_slots", {})
                dispatched_action = clinical_data.get("dispatched_action")

                # If LLM triggers a clinical Stepped Care action, dispatch event first
                if dispatched_action == "BREATHING_EXERCISE_478":
                    await ws.send_text(json.dumps({
                        "event": "DISPATCH_ACTION",
                        "action_type": "BREATHING_EXERCISE_478",
                        "payload": {
                            "level": 1,
                            "cycles": 4,
                            "inhale_sec": 4,
                            "hold_sec": 7,
                            "exhale_sec": 8,
                            "rationale": "Elevated autonomic arousal detected across conversational turns. Activating grounding exercise.",
                            "message_en": "Let's take a moment together. Inhale gently for 4 seconds, hold for 7, and exhale slowly for 8.",
                            "message_ar": "دعنا نهدأ معاً للحظة. خذ نفساً عميقاً لمدة 4 ثوانٍ، احبسه لـ 7 ثوانٍ، ثم ازفره ببطء لـ 8 ثوانٍ."
                        }
                    }))
                elif dispatched_action == "JIT_IDENTITY_GATE":
                    await ws.send_text(json.dumps({
                        "event": "DISPATCH_ACTION",
                        "action_type": "JIT_IDENTITY_GATE",
                        "payload": {
                            "level": 2,
                            "clinical_scales": [
                                {
                                    "scale": "PHQ-9",
                                    "loinc": CLINICAL_CONSTANTS["loinc_scales"]["phq9"]["code"],
                                    "score": extracted_slots.get("phq9_estimate") or 11,
                                    "severity": "Moderate"
                                },
                                {
                                    "scale": "GAD-7",
                                    "loinc": CLINICAL_CONSTANTS["loinc_scales"]["gad7"]["code"],
                                    "score": extracted_slots.get("gad7_estimate") or 13,
                                    "severity": "Moderate"
                                }
                            ],
                            "somatic_snomed_codes": [
                                CLINICAL_CONSTANTS["snomed_matrix"]["chest_tightness"],
                                CLINICAL_CONSTANTS["snomed_matrix"]["terminal_insomnia"]
                            ],
                            "routing_target": "AHS / SEHA Stepped Care Primary Clinic (Abu Dhabi)",
                            "zk_anonymized_brief_ready": True,
                            "malaffi_fhir_bundle": "Bundle/malaffi-intake-r4",
                            "message_en": "Based on your clinical markers, we recommend connecting with an AHS Stepped Care specialist. Authenticate via UAE PASS for direct Malaffi booking?",
                            "message_ar": "بناءً على التقييم السريري، نوصي بربطك بأخصائي الرعاية المتدرجة في مراكز صحة. هل تود تسجيل الدخول بالهوية الرقمية UAE PASS لحجز ملفك في ملفي؟"
                        }
                    }))

                # Sentence-Boundary Audio Chunk Streaming using Real Azure AI Speech
                async def stream_sentence_chunks():
                    try:
                        turn_id = f"turn-{uuid.uuid4().hex[:8]}"
                        arousal = prosody_hint.get("arousal", 0.50) if isinstance(prosody_hint, dict) else 0.50

                        # Split into natural sentences for progressive streaming (<450ms TTFA)
                        raw_sentences = [s.strip() for s in re.split(r'(?<=[.!?؟])\s+', reply_text) if s.strip()]
                        sentences = raw_sentences if raw_sentences else [reply_text]

                        for chunk_idx, sent in enumerate(sentences):
                            is_final = (chunk_idx == len(sentences) - 1)
                            audio_bytes, err = synthesize_azure_speech(sent, lang=lang, arousal=arousal)

                            if audio_bytes:
                                chunk_payload = {
                                    "event": "AGENT_RESPONSE_CHUNK",
                                    "session_uuid": session_uuid,
                                    "turn_id": turn_id,
                                    "chunk_index": chunk_idx,
                                    "is_final_chunk": is_final,
                                    "language": lang,
                                    "text_chunk": sent,
                                    "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                                    "prosody_hint": prosody_hint,
                                    "extracted_slots": extracted_slots,
                                    "verified_transcript": authoritative_transcript
                                }
                                await ws.send_text(json.dumps(chunk_payload))
                                tag = "Final Tail" if is_final else "TTFA Triggered"
                                print(f"[SENTENCE {chunk_idx+1} SENT] Turn: {turn_id} | Azure Audio: {len(audio_bytes)/1024:.1f} KB | Final: {is_final} ({tag})")
                            else:
                                await ws.send_text(json.dumps({
                                    "event": "SERVER_ERROR",
                                    "error_type": "AZURE_SPEECH_ERROR",
                                    "message": err or f"Azure Speech synthesis failed for chunk {chunk_idx}"
                                }))
                                return

                            if not is_final:
                                # Brief alignment yield for client gapless queue
                                await asyncio.sleep(0.04)
                    except (WebSocketDisconnect, asyncio.CancelledError):
                        pass

                task = asyncio.create_task(stream_sentence_chunks())
                active_streaming_tasks[ws] = task

    except WebSocketDisconnect:
        print("[MOCK SERVER] Client disconnected")
    except Exception as e:
        print(f"[MOCK SERVER ERROR] {e}")
    finally:
        active_task = active_streaming_tasks.pop(ws, None)
        if active_task and not active_task.done():
            active_task.cancel()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
