"""Local original-language transcription; never translate original speakers."""
import json
import sys
import mlx_whisper

result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[3], word_timestamps=True, verbose=False,
                              condition_on_previous_text=False, hallucination_silence_threshold=2)
with open(sys.argv[2], 'w', encoding='utf-8') as target:
    json.dump({'language': result['language'], 'segments': [
        {'start': s['start'], 'end': s['end'], 'text': s['text']}
        for s in result['segments'] if s.get('no_speech_prob', 0) < 0.7 and s['text'].strip()
    ]}, target, ensure_ascii=False)
