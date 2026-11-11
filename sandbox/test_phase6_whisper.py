# sandbox/test_phase6_whisper.py
import urllib.request
import json
import os
import wave
import io
import struct
import base64
import asyncio
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sandbox.mock_voice_server import get_env_credentials, transcribe_groq_whisper

azure_key, azure_reg, groq_key = get_env_credentials()

def synthesize_wav_sentence(text: str) -> bytes:
    ssml = (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
        f'<voice name="en-US-JennyMultilingualNeural">{text}</voice>'
        f'</speak>'
    )
    req = urllib.request.Request(
        f"https://{azure_reg}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": azure_key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
            "User-Agent": "Phase6VerificationClient"
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()

def create_multi_sentence_wav_with_pause() -> bytes:
    print("[TEST SETUP] Synthesizing Sentence 1 via Azure Speech...")
    wav1 = synthesize_wav_sentence("I am having severe chest tightness.")
    print(f"  -> Sentence 1 WAV size: {len(wav1)} bytes")

    print("[TEST SETUP] Synthesizing Sentence 2 via Azure Speech...")
    wav2 = synthesize_wav_sentence("I wake up at three AM every night with my heart racing.")
    print(f"  -> Sentence 2 WAV size: {len(wav2)} bytes")

    # Strip 44-byte headers to extract raw 16kHz Int16 PCM samples
    pcm1 = wav1[44:]
    pcm2 = wav2[44:]
    # 1.0 second silence (16000 samples @ 2 bytes/sample = 32000 zero bytes)
    silence_1s = struct.pack("<16000h", *([0] * 16000))

    combined_pcm = pcm1 + silence_1s + pcm2

    out_buf = io.BytesIO()
    with wave.open(out_buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(combined_pcm)
    combined_wav = out_buf.getvalue()
    print(f"[TEST SETUP] Combined multi-sentence WAV with 1.0s breath pause: {len(combined_wav)} bytes ({len(combined_wav)/1024:.1f} KB)")
    return combined_wav

async def test_websocket_turn():
    import websockets
    combined_wav = create_multi_sentence_wav_with_pause()
    wav_b64 = base64.b64encode(combined_wav).decode("utf-8")

    uri = "ws://127.0.0.1:8001/ws/voice"
    print(f"\n[PHASE 6 WS TEST] Connecting to {uri}...")
    async with websockets.connect(uri) as ws:
        cfg = json.loads(await ws.recv())
        print(f"[PHASE 6 WS TEST] Server Config Received: Active TTS = '{cfg['tts_tier']}'")

        # Submit TURN_COMPLETE with PARTIAL browser transcript to test Groq Whisper ground-truth override!
        partial_browser_stt = "I am having severe..."
        print(f"\n[PHASE 6 WS TEST] Submitting TURN_COMPLETE with partial browser STT: '{partial_browser_stt}'")
        print("  -> Expecting Groq Whisper to transcribe the FULL audio (both sentences + pause)...")

        await ws.send(json.dumps({
            "event": "TURN_COMPLETE",
            "session_uuid": "phase6-test-session",
            "language": "en-US",
            "transcript": partial_browser_stt,
            "audio_pcm_base64": wav_b64,
            "silence_trigger_ms": 1400,
            "timestamp_ms": int(asyncio.get_event_loop().time() * 1000)
        }))

        # 1. Expect TRANSCRIPT_FINALIZED event from Groq Whisper
        msg1 = json.loads(await ws.recv())
        assert msg1.get("event") == "TRANSCRIPT_FINALIZED", f"Expected TRANSCRIPT_FINALIZED, got: {msg1.get('event')}"
        verified = msg1.get("verified_transcript", "")
        print(f"\n[PHASE 6 SUCCESS] Received TRANSCRIPT_FINALIZED!")
        print(f"  -> Full-Audio Verified Transcript: \"{verified}\"")
        print(f"  -> Source: {msg1.get('source')}")

        lower_v = verified.lower()
        assert "chest" in lower_v, "Error: 'chest' missing from verified transcript!"
        assert "tightness" in lower_v or "tight" in lower_v, "Error: 'tightness' missing from verified transcript!"
        assert ("three" in lower_v or "3" in lower_v), "Error: 'three' missing from verified transcript!"
        assert "night" in lower_v, "Error: 'night' missing from verified transcript!"

        # 2. Receive the subsequent AGENT_RESPONSE_CHUNKs
        chunk_count = 0
        while True:
            resp = json.loads(await ws.recv())
            if resp.get("event") == "DISPATCH_ACTION":
                print(f"  -> Dispatched Stepped Care Action: {resp.get('action_type')}")
                continue
            if resp.get("event") == "AGENT_RESPONSE_CHUNK":
                chunk_count += 1
                assert resp.get("verified_transcript") == verified, "verified_transcript missing or mismatched in chunk!"
                print(f"  -> Agent Response Chunk {chunk_count}: \"{resp.get('text_chunk')}\" (Final: {resp.get('is_final_chunk')})")
                if resp.get("is_final_chunk"):
                    break

        print("\n===================================================================")
        print(" [PHASE 6 VERIFICATION PASSED 100%] Groq Whisper Full-Audio STT Verified!")
        print("===================================================================")

if __name__ == "__main__":
    asyncio.run(test_websocket_turn())
