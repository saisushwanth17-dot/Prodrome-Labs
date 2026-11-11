# sandbox/verify_live_credentials.py
import os
import urllib.request
import json
import io
import wave
import struct

def test_keys():
    env = {}
    if os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip("\"'")

    azure_key = env.get("AZURE_SPEECH_KEY") or env.get("VITE_AZURE_SPEECH_KEY") or os.environ.get("AZURE_SPEECH_KEY")
    azure_region = env.get("AZURE_SPEECH_REGION") or env.get("VITE_AZURE_SPEECH_REGION") or os.environ.get("AZURE_SPEECH_REGION", "eastus")
    groq_key = env.get("GROQ_API_KEY") or env.get("VITE_GROQ_API_KEY") or os.environ.get("GROQ_API_KEY")

    masked_azure = f"{azure_key[:4]}...{azure_key[-4:]}" if azure_key else "None"
    masked_groq = f"{groq_key[:4]}...{groq_key[-4:]}" if groq_key else "None"
    print(f"Loaded Azure Key: {masked_azure} (Region: {azure_region})")
    print(f"Loaded Groq Key:  {masked_groq}")

    # 1. Test Azure Speech
    azure_ok = False
    azure_bytes = 0
    if azure_key:
        ssml = f"""<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <voice name="en-US-JennyMultilingualNeural">
    <prosody rate="0%" pitch="0%">Prodrome Labs Azure neural voice verified.</prosody>
  </voice>
</speak>"""
        url = f"https://{azure_region}.tts.speech.microsoft.com/cognitiveservices/v1"
        req = urllib.request.Request(
            url,
            data=ssml.encode("utf-8"),
            headers={
                "Ocp-Apim-Subscription-Key": azure_key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
                "User-Agent": "ProdromeLabsKeyTester",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                data = resp.read()
                azure_bytes = len(data)
                azure_ok = True
                print(f"[AZURE SPEECH SUCCESS] Status {resp.status} - Received {azure_bytes} bytes of real neural MP3 audio!")
        except Exception as e:
            print(f"[AZURE SPEECH ERROR] {e}")

    # 2. Test Groq API (models and Whisper audio transcription)
    groq_ok = False
    if groq_key:
        # Create a tiny 1-second WAV buffer
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(struct.pack("<16000h", *([0]*16000)))
        raw_wav = wav_buf.getvalue()

        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body = bytearray()
        # model field
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-large-v3-turbo\r\n".encode())
        # response_format field
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n".encode())
        # file field
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
        body.extend(raw_wav)
        body.extend(f"\r\n--{boundary}--\r\n".encode())

        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            data=bytes(body),
            headers={
                "Authorization": f"Bearer {groq_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": "ProdromeLabsKeyTester"
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                groq_ok = True
                print(f"[GROQ WHISPER SUCCESS] Status {resp.status} - Transcribed: '{res_data.get('text', '')}' via whisper-large-v3-turbo!")
        except Exception as e:
            print(f"[GROQ WHISPER ERROR] {e}")

    return azure_ok, groq_ok

if __name__ == "__main__":
    test_keys()
