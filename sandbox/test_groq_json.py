import urllib.request, json, sys, os
sys.path.insert(0, '.')
from sandbox.mock_voice_server import get_env_credentials
_, _, key = get_env_credentials()

sys_prompt = '''You are an empathetic, human-like clinical navigation assistant for Prodrome Labs in Abu Dhabi.
You must respond strictly in a valid JSON object matching this example format:
{
  "reply_text": "I hear how frightening that feels.",
  "prosody_hint": {"arousal": 0.45, "valence": 0.50},
  "extracted_slots": {
    "phq9_estimate": 7,
    "gad7_estimate": 8,
    "somatic_flags": ["Chest Tightness (SNOMED: 271795006)"]
  },
  "dispatched_action": null
}'''

for m in ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b']:
    url = 'https://api.groq.com/openai/v1/chat/completions'
    # Test multi-turn with JSON assistant message
    messages = [
        {'role': 'system', 'content': sys_prompt},
        {'role': 'user', 'content': 'I have not slept for a week.'},
        {'role': 'assistant', 'content': json.dumps({"reply_text": "I hear how difficult that is. What happens when you try to sleep?"})},
        {'role': 'user', 'content': 'I keep waking up at 3 AM with chest tightness.'}
    ]
    payload = {
        'model': m,
        'messages': messages,
        'response_format': {'type': 'json_object'},
        'temperature': 0.6
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            print(m, 'SUCCESS:', data['choices'][0]['message']['content'][:100])
    except urllib.error.HTTPError as e:
        print(m, 'FAILED:', e.code, e.read().decode()[:100])
