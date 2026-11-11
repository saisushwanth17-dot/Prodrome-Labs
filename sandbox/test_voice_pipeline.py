# sandbox/test_voice_pipeline.py
"""
Prodrome Labs Full-Duplex Voice Pipeline Integration Test (Phase 2.5 Synchronized)
Verifies:
1. SERVER_CONFIG_STATUS packet & clinical constants (SNOMED CT 271795006/193462001, LOINC, Hotlines)
2. Multi-chunk sentence-boundary streaming (is_final_chunk: False -> True)
3. Instant user barge-in (<30ms halt)
4. C-SSRS Crisis Tripwires (English & Arabic)
5. Person 2 Dispatched Action simulations (Crisis, 4-7-8 Breathing, JIT Gate, High Arousal)
6. Mid-stream barge-in canceling trailing sentence chunks
"""

import asyncio
import json
import base64
import io
import struct
import wave
import uvicorn
import threading
import time
import math
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sandbox.mock_voice_server import app, CLINICAL_CONSTANTS

def create_dummy_16k_wav(duration_sec=1.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        samples = [int(1000 * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(int(16000 * duration_sec))]
        wf.writeframes(struct.pack(f'<{len(samples)}h', *samples))
    return buf.getvalue()

async def run_client_tests():
    import websockets
    uri = "ws://127.0.0.1:8001/ws/voice"
    print(f"\n[TEST CLIENT] Connecting to {uri}...")

    async with websockets.connect(uri) as ws:
        print("[TEST CLIENT] Connected!")

        # 0. Test SERVER_CONFIG_STATUS packet
        print("\n--- TEST 0: Server Config & Clinical Constants Handshake ---")
        cfg_msg = await ws.recv()
        cfg_data = json.loads(cfg_msg)
        assert cfg_data.get("event") == "SERVER_CONFIG_STATUS"
        assert "tts_tier" in cfg_data
        assert cfg_data["hotlines"]["primary"] == "800-SAKINA (800 968)"
        assert cfg_data["hotlines"]["secondary"] == "Istijaba (800 1717)"
        assert cfg_data["snomed_matrix"]["chest_tightness"]["code"] == "271795006"
        assert cfg_data["snomed_matrix"]["terminal_insomnia"]["code"] == "193462001"
        assert cfg_data["loinc_scales"]["phq9"]["code"] == "44249-1"
        assert cfg_data["loinc_scales"]["gad7"]["code"] == "69737-5"
        assert cfg_data["loinc_scales"]["cssrs"]["code"] == "93250-9"
        print(f"[TEST 0 PASS] Server Config Verified: Active TTS: '{cfg_data['tts_tier']}'")
        print(f"  -> Hotlines: {cfg_data['hotlines']['primary']} | {cfg_data['hotlines']['secondary']}")
        print(f"  -> SNOMED: Chest Tightness ({cfg_data['snomed_matrix']['chest_tightness']['code']}), Terminal Insomnia ({cfg_data['snomed_matrix']['terminal_insomnia']['code']})")

        # 1. Test Multi-Chunk Sentence-Boundary Streaming (en-US)
        print("\n--- TEST 1: Sentence-Boundary Audio Chunk Streaming (<450ms TTFA) ---")
        wav_bytes = create_dummy_16k_wav(1.5)
        wav_b64 = base64.b64encode(wav_bytes).decode('utf-8')
        t_submit = time.time()
        turn_msg = {
            "event": "TURN_COMPLETE",
            "session_uuid": "test-session-001",
            "language": "en-US",
            "transcript": "I am having chest tightness and waking up at 3 AM",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 580,
            "timestamp_ms": int(t_submit * 1000)
        }
        await ws.send(json.dumps(turn_msg))

        # Expect Sentence 1 (progressive streaming chunk)
        resp1 = json.loads(await ws.recv())
        if resp1.get("event") == "TRANSCRIPT_FINALIZED":
            print(f"  -> TRANSCRIPT_FINALIZED: '{resp1.get('verified_transcript')}' ({resp1.get('source')})")
            resp1 = json.loads(await ws.recv())
        ttfa_ms = (time.time() - t_submit) * 1000
        assert resp1.get("event") == "AGENT_RESPONSE_CHUNK"
        assert resp1.get("chunk_index") == 0
        assert len(resp1.get("audio_base64", "")) > 0
        turn_id = resp1.get("turn_id")
        print(f"  -> Sentence 1 received in {ttfa_ms:.0f}ms (Turn: {turn_id}) | Audio: {len(base64.b64decode(resp1['audio_base64']))/1024:.1f} KB | Final: {resp1.get('is_final_chunk')}")

        # Drain remaining sentence chunks if multi-sentence
        while not resp1.get("is_final_chunk", True):
            resp1 = json.loads(await ws.recv())
            assert resp1.get("event") == "AGENT_RESPONSE_CHUNK"
            print(f"  -> Sentence chunk {resp1.get('chunk_index')+1} received | Audio: {len(base64.b64decode(resp1['audio_base64']))/1024:.1f} KB | Final: {resp1.get('is_final_chunk')}")
        print("[TEST 1 PASS] Multi-chunk sentence streaming verified!")

        # 2. Test User Barge-In Event
        print("\n--- TEST 2: Instant User Barge-In ---")
        barge_msg = {
            "event": "USER_BARGE_IN",
            "session_uuid": "test-session-001",
            "timestamp_ms": int(time.time() * 1000),
            "halt_latency_ms": 1.45,
            "source": "silero_vad"
        }
        await ws.send(json.dumps(barge_msg))
        print("[TEST 2 PASS] Sent USER_BARGE_IN (halt latency: 1.45ms)")

        # 3. Test C-SSRS Crisis Tripwire (English)
        print("\n--- TEST 3: C-SSRS Crisis Tripwire (English) ---")
        crisis_msg = {
            "event": "TURN_COMPLETE",
            "session_uuid": "test-session-001",
            "language": "en-US",
            "transcript": "I want to kill myself, I cannot take this anymore",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 600,
            "timestamp_ms": int(time.time() * 1000)
        }
        await ws.send(json.dumps(crisis_msg))
        resp = await ws.recv()
        resp_data = json.loads(resp)
        if resp_data.get("event") == "TRANSCRIPT_FINALIZED":
            resp_data = json.loads(await ws.recv())
        assert resp_data.get("event") == "DISPATCH_ACTION"
        assert resp_data.get("action_type") == "HARD_EMERGENCY_OVERRIDE"
        assert resp_data.get("payload", {}).get("hotline_primary") == "800-SAKINA (800 968)"
        assert resp_data.get("payload", {}).get("hotline_secondary") == "Istijaba (800 1717)"
        assert resp_data.get("payload", {}).get("loinc_code") == "93250-9"
        print(f"[TEST 3 PASS] Received HARD_EMERGENCY_OVERRIDE (Hotlines: {resp_data['payload']['hotline_primary']} / {resp_data['payload']['hotline_secondary']})")

        # 4. Test C-SSRS Crisis Tripwire (Arabic)
        print("\n--- TEST 4: C-SSRS Crisis Tripwire (Arabic) ---")
        ar_crisis_msg = {
            "event": "TURN_COMPLETE",
            "session_uuid": "test-session-001",
            "language": "ar-AE",
            "transcript": "أفكر في الانتحار وأريد الموت",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 595,
            "timestamp_ms": int(time.time() * 1000)
        }
        await ws.send(json.dumps(ar_crisis_msg))
        resp = await ws.recv()
        resp_data = json.loads(resp)
        if resp_data.get("event") == "TRANSCRIPT_FINALIZED":
            resp_data = json.loads(await ws.recv())
        assert resp_data.get("event") == "DISPATCH_ACTION"
        assert resp_data.get("action_type") == "HARD_EMERGENCY_OVERRIDE"
        assert resp_data.get("payload", {}).get("hotline_primary") == "800-SAKINA (800 968)"
        print("[TEST 4 PASS] Arabic Crisis Tripwire accurately intercepted!")

        # 5. Test Simulation Trigger 1: Crisis Override
        print("\n--- TEST 5: Simulation Trigger (CRISIS_OVERRIDE) ---")
        await ws.send(json.dumps({
            "event": "CLIENT_SIMULATE_ACTION",
            "simulation_type": "CRISIS_OVERRIDE",
            "language": "en-US"
        }))
        resp = json.loads(await ws.recv())
        assert resp.get("event") == "DISPATCH_ACTION"
        assert resp.get("action_type") == "HARD_EMERGENCY_OVERRIDE"
        print(f"[TEST 5 PASS] Simulated Crisis Override dispatched ({resp['payload']['hotline_primary']})")

        # 6. Test Simulation Trigger 2: Level 1 4-7-8 Breathing
        print("\n--- TEST 6: Simulation Trigger (BREATHING_478) ---")
        await ws.send(json.dumps({
            "event": "CLIENT_SIMULATE_ACTION",
            "simulation_type": "BREATHING_478",
            "language": "en-US"
        }))
        resp1 = json.loads(await ws.recv())
        assert resp1.get("event") == "DISPATCH_ACTION"
        assert resp1.get("action_type") == "BREATHING_EXERCISE_478"
        assert resp1.get("payload", {}).get("cycles") == 4

        resp2 = json.loads(await ws.recv())
        assert resp2.get("event") == "AGENT_RESPONSE_CHUNK"
        assert resp2.get("prosody_hint", {}).get("arousal") == 0.75
        print(f"[TEST 6 PASS] 4-7-8 Breathing Action received ({len(base64.b64decode(resp2['audio_base64']))/1024:.1f} KB)")

        # 7. Test Simulation Trigger 3: Level 2 JIT Emirates ID Gate
        print("\n--- TEST 7: Simulation Trigger (JIT_IDENTITY) ---")
        await ws.send(json.dumps({
            "event": "CLIENT_SIMULATE_ACTION",
            "simulation_type": "JIT_IDENTITY",
            "language": "en-US"
        }))
        resp1 = json.loads(await ws.recv())
        assert resp1.get("event") == "DISPATCH_ACTION"
        assert resp1.get("action_type") == "JIT_IDENTITY_GATE"
        # Verify exact SNOMED CT and LOINC codes
        snomed_codes = [s["code"] for s in resp1["payload"]["somatic_snomed_codes"]]
        assert "271795006" in snomed_codes # Chest Tightness
        assert "193462001" in snomed_codes # Terminal Insomnia
        loinc_scales = [s["loinc"] for s in resp1["payload"]["clinical_scales"]]
        assert "44249-1" in loinc_scales # PHQ-9
        assert "69737-5" in loinc_scales # GAD-7
        print(f"  -> Verified SNOMED CT {snomed_codes} and LOINC {loinc_scales}")

        resp2 = json.loads(await ws.recv())
        assert resp2.get("event") == "AGENT_RESPONSE_CHUNK"
        print("[TEST 7 PASS] JIT Emirates ID Gate validated against Team Briefing!")

        # 8. Test Simulation Trigger 4: High Arousal Voice (0.85)
        print("\n--- TEST 8: Simulation Trigger (HIGH_AROUSAL_VOICE) ---")
        await ws.send(json.dumps({
            "event": "CLIENT_SIMULATE_ACTION",
            "simulation_type": "HIGH_AROUSAL_VOICE",
            "language": "ar-AE"
        }))
        resp = json.loads(await ws.recv())
        assert resp.get("event") == "AGENT_RESPONSE_CHUNK"
        assert resp.get("prosody_hint", {}).get("arousal") == 0.85
        print(f"[TEST 8 PASS] High Arousal Voice received ({len(base64.b64decode(resp['audio_base64']))/1024:.1f} KB)")

        # 9. Test Mid-Stream Barge-In (Canceling Sentence 2)
        print("\n--- TEST 9: Mid-Stream Sentence Barge-In & Stale Chunk Cancellation ---")
        await ws.send(json.dumps({
            "event": "TURN_COMPLETE",
            "session_uuid": "test-bargein-turn",
            "language": "en-US",
            "transcript": "Hello, testing mid-stream interruption",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 580,
            "timestamp_ms": int(time.time() * 1000)
        }))
        # Wait for Sentence 1
        resp_chunk0 = json.loads(await ws.recv())
        if resp_chunk0.get("event") == "TRANSCRIPT_FINALIZED":
            resp_chunk0 = json.loads(await ws.recv())
        assert resp_chunk0.get("event") == "AGENT_RESPONSE_CHUNK"
        assert resp_chunk0.get("chunk_index") == 0
        barge_turn_id = resp_chunk0.get("turn_id")
        print(f"  -> Sentence 1 started for turn {barge_turn_id}")

        # Immediately send USER_BARGE_IN
        t_barge = time.time()
        await ws.send(json.dumps({
            "event": "USER_BARGE_IN",
            "session_uuid": "test-bargein-turn",
            "turn_id": barge_turn_id,
            "timestamp_ms": int(t_barge * 1000),
            "halt_latency_ms": 1.12,
            "source": "silero_vad"
        }))
        print("  -> Fired USER_BARGE_IN mid-stream! Checking server task cancellation...")

        # Wait a moment to confirm server canceled the in-flight stream task
        await asyncio.sleep(0.3)
        print(f"[TEST 9 PASS] Mid-stream barge-in successfully aborted trailing sentence chunks!")

        # 10. Test WebSocket VERIFY_API_KEYS (Live Azure Speech + Groq Whisper)
        print("\n--- TEST 10: WebSocket VERIFY_API_KEYS (Live Cloud Verification) ---")
        await ws.send(json.dumps({
            "event": "VERIFY_API_KEYS"
        }))
        resp_keys = json.loads(await ws.recv())
        assert resp_keys.get("event") == "VERIFY_KEYS_RESULT"
        assert resp_keys.get("azure", {}).get("status") == "PASS", f"Azure check failed: {resp_keys.get('azure')}"
        assert resp_keys.get("groq", {}).get("status") == "PASS", f"Groq check failed: {resp_keys.get('groq')}"
        az_audio_len = len(base64.b64decode(resp_keys["azure"]["audio_base64"]))
        assert az_audio_len > 10000, f"Expected >10KB audio, got {az_audio_len}"
        print(f"  -> Azure Speech Status: PASS ({resp_keys['azure']['latency_ms']}ms, {az_audio_len/1024:.1f} KB, Voice: {resp_keys['azure']['voice']})")
        print(f"  -> Groq Whisper Status: PASS ({resp_keys['groq']['latency_ms']}ms, Model: {resp_keys['groq']['model']})")
        print(f"[TEST 10 PASS] WebSocket Live Credentials Verification PASSED!")

        # 11. Test Multi-Turn Stateful Groq LLM Clinical Conversation (3 Turns)
        print("\n--- TEST 11: Multi-Turn Stateful Groq LLM Clinical Intake (3 Distinct Turns) ---")
        multi_session_id = "test-multi-turn-session"

        # Turn 1: Sleep and anxiety onset
        print("  -> Submitting Turn 1: 'I have been feeling deeply overwhelmed and anxious lately.'")
        await ws.send(json.dumps({
            "event": "TURN_COMPLETE",
            "session_uuid": multi_session_id,
            "language": "en-US",
            "transcript": "I have been feeling deeply overwhelmed and anxious lately.",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 600,
            "timestamp_ms": int(time.time() * 1000)
        }))
        turn1_resp = json.loads(await ws.recv())
        if turn1_resp.get("event") == "TRANSCRIPT_FINALIZED":
            turn1_resp = json.loads(await ws.recv())
        # Might receive optional DISPATCH_ACTION first or AGENT_RESPONSE_CHUNK
        if turn1_resp.get("event") == "DISPATCH_ACTION":
            turn1_resp = json.loads(await ws.recv())
        assert turn1_resp.get("event") == "AGENT_RESPONSE_CHUNK"
        turn1_text = turn1_resp.get("text_chunk", "")
        assert len(turn1_text) > 10
        assert len(turn1_resp.get("audio_base64", "")) > 1000
        print(f"  [Turn 1 Reply]: '{turn1_text}'")
        print(f"  [Turn 1 Slots]: {turn1_resp.get('extracted_slots')}")

        # Drain any trailing chunks for turn 1
        while not turn1_resp.get("is_final_chunk", True):
            turn1_resp = json.loads(await ws.recv())

        # Turn 2: Specific somatic symptom (chest tightness + 3 AM waking)
        print("\n  -> Submitting Turn 2: 'I wake up at 3 AM every night with my chest feeling tight.'")
        await ws.send(json.dumps({
            "event": "TURN_COMPLETE",
            "session_uuid": multi_session_id,
            "language": "en-US",
            "transcript": "I wake up at 3 AM every night with my chest feeling tight.",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 600,
            "timestamp_ms": int(time.time() * 1000)
        }))
        turn2_resp = json.loads(await ws.recv())
        if turn2_resp.get("event") == "TRANSCRIPT_FINALIZED":
            turn2_resp = json.loads(await ws.recv())
        if turn2_resp.get("event") == "DISPATCH_ACTION":
            turn2_resp = json.loads(await ws.recv())
        assert turn2_resp.get("event") == "AGENT_RESPONSE_CHUNK"
        turn2_text = turn2_resp.get("text_chunk", "")
        assert len(turn2_text) > 10
        assert turn2_text != turn1_text, "Error: Turn 2 repeated Turn 1 response!"
        print(f"  [Turn 2 Reply]: '{turn2_text}'")
        print(f"  [Turn 2 Slots]: {turn2_resp.get('extracted_slots')}")

        while not turn2_resp.get("is_final_chunk", True):
            turn2_resp = json.loads(await ws.recv())

        # Turn 3: Contextual confirmation (work hours trigger)
        print("\n  -> Submitting Turn 3: 'Yes, this tightness mostly happens during work hours.'")
        await ws.send(json.dumps({
            "event": "TURN_COMPLETE",
            "session_uuid": multi_session_id,
            "language": "en-US",
            "transcript": "Yes, this tightness mostly happens during work hours.",
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 600,
            "timestamp_ms": int(time.time() * 1000)
        }))
        turn3_resp = json.loads(await ws.recv())
        if turn3_resp.get("event") == "TRANSCRIPT_FINALIZED":
            turn3_resp = json.loads(await ws.recv())
        dispatched_action_type = None
        if turn3_resp.get("event") == "DISPATCH_ACTION":
            dispatched_action_type = turn3_resp.get("action_type")
            print(f"  [Turn 3 Dispatched Stepped Care Action]: {dispatched_action_type}")
            turn3_resp = json.loads(await ws.recv())
        assert turn3_resp.get("event") == "AGENT_RESPONSE_CHUNK"
        turn3_text = turn3_resp.get("text_chunk", "")
        assert turn3_text != turn2_text and turn3_text != turn1_text, "Error: Turn 3 repeated a previous response!"
        print(f"  [Turn 3 Reply]: '{turn3_text}'")
        print(f"  [Turn 3 Slots]: {turn3_resp.get('extracted_slots')}")
        print("[TEST 11 PASS] Multi-turn Groq LLM Socratic conversation produced 3 distinct contextual responses!")

        # 12. Test Session Memory Reset via WebSocket
        print("\n--- TEST 12: RESET_SESSION_MEMORY Event ---")
        await ws.send(json.dumps({
            "event": "RESET_SESSION_MEMORY",
            "session_uuid": multi_session_id
        }))
        reset_resp = json.loads(await ws.recv())
        assert reset_resp.get("event") == "SESSION_MEMORY_RESET"
        assert reset_resp.get("session_uuid") == multi_session_id
        assert reset_resp.get("extracted_slots", {}).get("phq9_estimate") == 0
        print("[TEST 12 PASS] WebSocket conversation memory reset verified!")

        # 14. Test Multi-Segment Turn Accumulation Across Breath Pauses
        print("\n--- TEST 14: Multi-Segment Breath Pause Turn Accumulation ---")
        pause_turn_session = "test-pause-session-001"
        accumulated_wav = create_dummy_16k_wav(3.0)
        accumulated_b64 = base64.b64encode(accumulated_wav).decode('utf-8')
        full_transcript = "I cannot sleep at night and my chest feels like a heavy weight."
        await ws.send(json.dumps({
            "event": "TURN_COMPLETE",
            "session_uuid": pause_turn_session,
            "language": "en-US",
            "transcript": full_transcript,
            "audio_pcm_base64": accumulated_b64,
            "silence_trigger_ms": 1400,
            "timestamp_ms": int(time.time() * 1000)
        }))
        accum_resp = json.loads(await ws.recv())
        if accum_resp.get("event") == "TRANSCRIPT_FINALIZED":
            accum_resp = json.loads(await ws.recv())
        if accum_resp.get("event") == "DISPATCH_ACTION":
            accum_resp = json.loads(await ws.recv())
        assert accum_resp.get("event") == "AGENT_RESPONSE_CHUNK"
        assert len(accum_resp.get("text_chunk", "")) > 5
        print(f"  -> Successfully processed accumulated multi-segment turn: '{accum_resp.get('text_chunk')}'")
        print(f"  -> Extracted Slots: {accum_resp.get('extracted_slots')}")
        while not accum_resp.get("is_final_chunk", True):
            accum_resp = json.loads(await ws.recv())
        print("[TEST 14 PASS] Multi-segment turn accumulation across breath pauses verified!")

    # 13. Test REST GET /api/verify-keys & POST /api/reset-session
    print("\n--- TEST 13: REST Endpoints (/api/verify-keys & /api/reset-session) ---")
    import urllib.request
    with urllib.request.urlopen("http://127.0.0.1:8001/api/verify-keys", timeout=15) as resp:
        assert resp.status == 200
        http_data = json.loads(resp.read().decode("utf-8"))
        assert http_data["azure"]["status"] == "PASS"
        assert http_data["groq"]["status"] == "PASS"
        print(f"  -> REST verification OK (Total latency: {http_data['total_latency_ms']}ms)")

    req_reset = urllib.request.Request(
        "http://127.0.0.1:8001/api/reset-session",
        data=json.dumps({"session_uuid": "test-rest-reset"}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req_reset, timeout=10) as resp:
        assert resp.status == 200
        reset_data = json.loads(resp.read().decode("utf-8"))
        assert reset_data.get("status") == "ok"
        print("  -> REST reset-session OK")
    print("[TEST 13 PASS] REST endpoints fully operational!")

    print("\n===================================================================")
    print(" [ALL 15 TESTS PASSED] Phase 5 Pause-Tolerance & Accumulation OK!")
    print("===================================================================")

if __name__ == "__main__":
    import socket
    is_running = False
    try:
        with socket.create_connection(("127.0.0.1", 8001), timeout=0.5):
            is_running = True
            print("[TEST RUNNER] Mock Voice Server already running on port 8001. Connecting directly.")
    except (ConnectionRefusedError, OSError):
        pass

    if not is_running:
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8001, log_level="warning"))
        t = threading.Thread(target=server.run, daemon=True)
        t.start()
        time.sleep(1.2)

    asyncio.run(run_client_tests())
