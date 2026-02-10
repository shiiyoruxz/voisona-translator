#!/usr/bin/env python3
"""
VoiSona Talk REST API TTS adapter for LiveKit Agents.

Based on the VoiSona Talk "REST API Tutorial" (local REST API, default port 32766):
  - base_url: http://localhost:{port}/api/talk/v1/
  - GET   voices
  - POST  speech-syntheses
  - GET   speech-syntheses/{uuid}
  - DELETE speech-syntheses/{uuid}
  - POST  text-analyses (Text Analysis API for emotion/sentiment detection)
  - GET   text-analyses/{uuid}
  - DELETE text-analyses/{uuid}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import aiohttp
import re

from livekit import rtc
from livekit.agents import tts

logger = logging.getLogger("voisona_tts")

# Load env from .env alongside this file (agents-backend/src/.env)
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

@dataclass(frozen=True)
class VoiSonaVoice:
    language: str
    voice_name: str
    voice_version: str


class VoiSonaTTS(tts.TTS):
    """
    LiveKit TTS implementation that synthesizes using a locally running VoiSona Talk REST API,
    saving to a WAV file and streaming the PCM back to LiveKit.
    """

    def __init__(
        self,
        *,
        host: str | None = None,
        port: int | None = None,
        user: str | None = None,
        password: str | None = None,
        voice_name: str | None = None,
        voice_version: str | None = None,
        language: str | None = None,
        output_dir: str | None = None,
        timeout_s: float | None = None,
        poll_interval_s: float | None = None,
        sample_rate: int = 24000,
        num_channels: int = 1,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=True),
            sample_rate=sample_rate,
            num_channels=num_channels,
        )

        self._host = host or os.getenv("VOISONA_HOST", "localhost")
        self._port = int(port or os.getenv("VOISONA_PORT", "32766"))
        self._user = user or os.getenv("VOISONA_USER", "")
        self._password = password or os.getenv("VOISONA_PASSWORD", "")
        self._preferred_voice_name = voice_name or os.getenv("VOISONA_VOICE_NAME")
        self._preferred_voice_version = voice_version or os.getenv("VOISONA_VOICE_VERSION")
        self._preferred_language = language or os.getenv("VOISONA_LANGUAGE")
        self._timeout_s = float(timeout_s or os.getenv("VOISONA_TIMEOUT_S", "30"))
        self._poll_interval_s = float(poll_interval_s or os.getenv("VOISONA_POLL_INTERVAL_S", "0.1"))

        output_dir_path = output_dir or os.getenv("VOISONA_OUTPUT_DIR", "./voisona_wav")
        self._output_dir = (Path(__file__).parent / output_dir_path).resolve() if not os.path.isabs(output_dir_path) else Path(output_dir_path).resolve()
        
        try:
            self._output_dir.mkdir(parents=True, exist_ok=True)
            test_file = self._output_dir / ".test_write"
            try:
                test_file.touch()
                test_file.unlink()
            except Exception:
                pass
        except Exception:
            raise

        self._global_params = self._load_global_parameters()
        self._use_text_analysis = os.getenv("VOISONA_USE_TEXT_ANALYSIS", "true").lower() == "true"
        self._cached_voice: VoiSonaVoice | None = None
        self._lock = asyncio.Lock()
        self._display_text_override: str | None = None  # For overriding transcription text
        self._translator_callback = None  # Callback function for translation
        self._publish_callback = None  # Callback to publish text to data channel
        self._cleanup_old_files()
    
    def set_display_text_override(self, text: str | None) -> None:
        """Set a temporary override for the display/transcription text."""
        self._display_text_override = text
    
    def set_translator_callback(self, callback) -> None:
        """Set a callback function for translating text. 
        Callback should be: async def translate(jp_text) -> tuple[str, str] (en, cn)
        """
        self._translator_callback = callback
    
    def set_publish_callback(self, callback) -> None:
        """Set a callback function for publishing text to the data channel.
        Callback should be: async def publish(full_text: str) -> None
        """
        self._publish_callback = callback

    def _cleanup_old_files(self, max_age_hours: float = 5.0) -> None:
        """Clean up old WAV files in the output directory."""
        try:
            current_time = time.time()
            max_age_seconds = max_age_hours * 3600
            
            for wav_file in self._output_dir.glob("voisona_*.wav"):
                try:
                    file_age = current_time - wav_file.stat().st_mtime
                    if file_age > max_age_seconds:
                        wav_file.unlink()
                except Exception:
                    pass
        except Exception:
            pass

    @property
    def _base_url(self) -> str:
        return f"http://{self._host}:{self._port}/api/talk/v1/"

    def _auth(self) -> aiohttp.BasicAuth:
        if not self._user or not self._password:
            raise RuntimeError("VOISONA_USER and VOISONA_PASSWORD must be set (VoiSona Talk API auth).")
        return aiohttp.BasicAuth(self._user, self._password)

    def _load_global_parameters(self) -> dict[str, Any] | None:
        raw = os.getenv("VOISONA_GLOBAL_PARAMETERS_JSON")
        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass

        gp: dict[str, Any] = {}
        for key, default in [("VOISONA_SPEED", "1.0"), ("VOISONA_PITCH", "0.0"), ("VOISONA_INTONATION", "1.0"), ("VOISONA_VOLUME", "0.0")]:
            if os.getenv(key) is not None:
                gp[key.replace("VOISONA_", "").lower()] = float(os.getenv(key, default))
        return gp or None

    def _timeout(self) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=self._timeout_s)

    async def close(self) -> None:
        return

    async def _select_voice(self, sess: aiohttp.ClientSession) -> VoiSonaVoice:
        """Choose which VoiSona voice to use."""
        if self._cached_voice:
            return self._cached_voice

        async with sess.get(self._base_url + "voices", auth=self._auth()) as resp:
            resp.raise_for_status()
            data = await resp.json()
        items = data.get("items") or []
        if not items:
            raise RuntimeError("No VoiSona voice libraries found. Download a voice library in VoiSona Talk.")

        for v in items:
            if (
                self._preferred_voice_name
                and self._preferred_voice_version
                and v.get("voice_name") == self._preferred_voice_name
                and v.get("voice_version") == self._preferred_voice_version
            ):
                language = self._preferred_language or (v.get("languages") or [None])[0]
                if not language:
                    raise RuntimeError("Selected voice has no languages.")
                self._cached_voice = VoiSonaVoice(
                    language=language,
                    voice_name=v["voice_name"],
                    voice_version=v["voice_version"],
                )
                return self._cached_voice

        v0 = items[0]
        language = self._preferred_language or (v0.get("languages") or [None])[0]
        if not language:
            raise RuntimeError("First voice library has no languages.")
        self._cached_voice = VoiSonaVoice(
            language=language,
            voice_name=v0["voice_name"],
            voice_version=v0["voice_version"],
        )
        return self._cached_voice

    async def _create_synthesis(
        self, sess: aiohttp.ClientSession, *, text: str, voice: VoiSonaVoice, wav_path: Path, dynamic_params: dict[str, Any] | None = None
    ) -> str:
        payload: dict[str, Any] = {
            "text": text,
            "language": voice.language,
            "voice_name": voice.voice_name,
            "voice_version": voice.voice_version,
            "can_overwrite_file": True,
            "destination": "file",
            "output_file_path": str(wav_path),
            "force_enqueue": True,
        }
        
        # Merge global parameters with dynamic parameters (dynamic takes precedence)
        merged_params = {}
        if self._global_params:
            merged_params.update(self._global_params)
        if dynamic_params:
            merged_params.update(dynamic_params)
        
        if merged_params:
            payload["global_parameters"] = merged_params

        async with sess.post(self._base_url + "speech-syntheses", auth=self._auth(), json=payload) as resp:
            if resp.status not in (200, 201):
                resp.raise_for_status()
            data = await resp.json()
        uuid = data.get("uuid")
        if not uuid:
            raise RuntimeError("VoiSona did not return uuid for speech-syntheses request.")
        return uuid

    async def _wait_synthesis(self, sess: aiohttp.ClientSession, uuid: str) -> None:
        start = time.time()
        while True:
            async with sess.get(self._base_url + "speech-syntheses/" + uuid, auth=self._auth()) as resp:
                resp.raise_for_status()
                data = await resp.json()
            state = data.get("state")
            if state == "succeeded":
                return
            if time.time() - start > self._timeout_s:
                raise TimeoutError("VoiSona synthesis took too long.")
            await asyncio.sleep(self._poll_interval_s)

    async def _delete_synthesis(self, sess: aiohttp.ClientSession, uuid: str) -> None:
        async with sess.delete(self._base_url + "speech-syntheses/" + uuid, auth=self._auth()) as resp:
            pass

    def _read_wav_pcm16_mono(self, wav_path: Path) -> tuple[bytes, int, int, int]:
        with wave.open(str(wav_path), "rb") as wf:
            nch, sr, sampwidth, nframes = wf.getnchannels(), wf.getframerate(), wf.getsampwidth(), wf.getnframes()
            frames = wf.readframes(nframes)

        if sampwidth != 2:
            raise RuntimeError(f"Expected 16-bit WAV from VoiSona (sampwidth=2). Got {sampwidth}.")

        if nch == 1:
            return frames, sr, 1, nframes

        import array
        data = array.array("h")
        data.frombytes(frames)
        mono = array.array("h", [int(sum(data[i * nch:(i + 1) * nch]) / nch) for i in range(nframes)])
        return mono.tobytes(), sr, 1, nframes

    def _is_japanese_text(self, text: str) -> bool:
        """Check if text contains Japanese characters (hiragana, katakana, kanji)."""
        if not text:
            return False
        japanese_chars = re.findall(r'[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]', text)
        non_space_chars = len([c for c in text if not c.isspace()])
        if non_space_chars == 0:
            return False
        return len(japanese_chars) / non_space_chars >= 0.3

    def _extract_japanese_text(self, text: str) -> str:
        if not text:
            return ""
        text = text.strip()
        # If the whole text clearly contains other language labels, do not return it as "Japanese"
        if re.search(r'(?:^|\n)\s*(?:EN|中文|Chinese|zh):\s*', text, re.IGNORECASE):
            # Try to extract only the JP block so we never speak labels
            for pattern in [
                r'(?:^|\n)\s*JP:\s*([^\n]+?)(?=\s*\n\s*(?:\n|EN:|中文:|Chinese:|zh:)|$)',
                r'(?:^|\n)\s*JP:\s*([\s\S]*?)(?=\n\s*(?:EN|中文|Chinese|zh):\s*)',
                r'(?:^|\n)\s*JP:\s*([^\n]+)',
                r'\[JP:\s*([^\]]+)\]',
            ]:
                match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE | re.DOTALL)
                if match:
                    extracted = match.group(1).strip()
                    if extracted and self._is_japanese_text(extracted):
                        return extracted
            return ""
        for pattern in [
            r'(?:^|\n)\s*JP:\s*([^\n]+?)(?:\n|$|EN:|中文:|zh:)',
            r'\[JP:\s*([^\]]+)\]',
        ]:
            match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
            if match:
                extracted = match.group(1).strip()
                if self._is_japanese_text(extracted):
                    return extracted
        return text if self._is_japanese_text(text) else ""

    def _extract_en_or_cn_for_translation(self, text: str) -> str | None:
        if not text:
            return None
        
        for pattern in [
            r'(?:^|\n)\s*EN:\s*([^\n]+?)(?:\n|$|JP:|中文:)',
            r'(?:^|\n)\s*中文:\s*([^\n]+?)(?:\n|$|JP:|EN:)',
            r'\[EN:\s*([^\]]+)\]',
            r'\[中文:\s*([^\]]+)\]'
        ]:
            match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
            if match:
                return match.group(1).strip()
        return None
    
    def _extract_english_text(self, text: str) -> str | None:
        if not text:
            return None
        # Try multiple patterns: EN:, English:, etc.
        for pattern in [
            r'(?:^|\n)\s*EN:\s*([\s\S]*?)(?:\s*\n\s*(?:JP:|中文:|Chinese:)|$)',
            r'(?:^|\n)\s*English:\s*([\s\S]*?)(?:\s*\n\s*(?:JP:|中文:|Chinese:)|$)',
            r'\[EN:\s*([^\]]+)\]',
            r'\[English:\s*([^\]]+)\]'
        ]:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                extracted = match.group(1).strip()
                # Remove any trailing parenthetical pronunciation guides like "(Nǐ hǎo...)"
                extracted = re.sub(r'\s*\([^)]*\)\s*$', '', extracted)
                return extracted
        return None
    
    def _extract_chinese_text(self, text: str) -> str | None:
        if not text:
            return None
        # Try multiple patterns: 中文:, Chinese:, etc.
        for pattern in [
            r'(?:^|\n)\s*中文:\s*([\s\S]*?)(?:\s*\n\s*(?:JP:|EN:|English:)|$)',
            r'(?:^|\n)\s*Chinese:\s*([\s\S]*?)(?:\s*\n\s*(?:JP:|EN:|English:)|$)',
            r'\[中文:\s*([^\]]+)\]',
            r'\[Chinese:\s*([^\]]+)\]'
        ]:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                extracted = match.group(1).strip()
                # Remove any trailing parenthetical pronunciation guides like "(Nǐ hǎo...)"
                extracted = re.sub(r'\s*\([^)]*\)\s*$', '', extracted)
                return extracted
        return None

    async def _analyze_text_with_voisona(self, sess: aiohttp.ClientSession, text: str) -> dict[str, Any] | None:
        if not self._use_text_analysis or not text or not text.strip():
            return None
        
        text_for_analysis = self._extract_japanese_text(text) or text.strip()
        if not text_for_analysis or len(text_for_analysis) < 2:
            return None
        
        text_for_analysis = re.sub(r'\s+', ' ', text_for_analysis.strip())
        text_for_analysis = ''.join(char for char in text_for_analysis if char.isprintable() or '\u3040' <= char <= '\u309F' or '\u30A0' <= char <= '\u30FF' or '\u4E00' <= char <= '\u9FAF')
        if not text_for_analysis or len(text_for_analysis) < 2:
            return None
        
        try:
            for payload in [{"text": text_for_analysis}, {"content": text_for_analysis}]:
                async with sess.post(self._base_url + "text-analyses", auth=self._auth(), json=payload) as resp:
                    if resp.status not in (200, 201):
                        continue
                    try:
                        data = await resp.json()
                        uuid = data.get("uuid")
                        if not uuid:
                            continue
                        
                        start = time.time()
                        while time.time() - start < self._timeout_s:
                            async with sess.get(self._base_url + "text-analyses/" + uuid, auth=self._auth()) as status_resp:
                                if status_resp.status == 200:
                                    analysis_data = await status_resp.json()
                                    state = analysis_data.get("state")
                                    if state == "succeeded":
                                        result = analysis_data.get("result", {})
                                        suggested_params = {}
                                        
                                        emotion_map = {
                                            "happy": {"speed": 1.15, "pitch": 0.2, "intonation": 1.15},
                                            "joy": {"speed": 1.15, "pitch": 0.2, "intonation": 1.15},
                                            "excited": {"speed": 1.15, "pitch": 0.2, "intonation": 1.15},
                                            "sad": {"speed": 0.95, "pitch": -0.1, "intonation": 0.90},
                                            "sorrow": {"speed": 0.95, "pitch": -0.1, "intonation": 0.90},
                                            "melancholy": {"speed": 0.95, "pitch": -0.1, "intonation": 0.90},
                                            "angry": {"speed": 1.1, "pitch": 0.15, "volume": 0.1},
                                            "furious": {"speed": 1.1, "pitch": 0.15, "volume": 0.1},
                                        }
                                        
                                        if "emotion" in result:
                                            emotion = result["emotion"].lower()
                                            if emotion in emotion_map:
                                                suggested_params.update(emotion_map[emotion])
                                        
                                        if "sentiment" in result:
                                            sentiment = result["sentiment"]
                                            if sentiment == "positive":
                                                suggested_params.setdefault("speed", 1.1)
                                                suggested_params.setdefault("pitch", 0.15)
                                            elif sentiment == "negative":
                                                suggested_params.setdefault("speed", 0.95)
                                                suggested_params.setdefault("pitch", -0.05)
                                        
                                        try:
                                            async with sess.delete(self._base_url + "text-analyses/" + uuid, auth=self._auth()):
                                                pass
                                        except:
                                            pass
                                        
                                        return suggested_params if suggested_params else None
                                    elif state == "failed":
                                        return None
                            await asyncio.sleep(self._poll_interval_s)
                        
                        try:
                            async with sess.delete(self._base_url + "text-analyses/" + uuid, auth=self._auth()):
                                pass
                        except:
                            pass
                        return None
                    except Exception:
                        continue
            return None
        except Exception:
            return None

    def _get_sample_adjustments(self) -> dict[str, dict[str, float]]:
        """Pre-defined sample parameter adjustments for common scenarios."""
        return {
            'excited': {'speed': 1.2, 'pitch': 0.25, 'intonation': 1.2, 'volume': 0.15},
            'calm': {'speed': 0.9, 'pitch': -0.1, 'intonation': 0.9, 'volume': -0.1},
            'happy': {'speed': 1.15, 'pitch': 0.2, 'intonation': 1.15, 'volume': 0.1},
            'sad': {'speed': 0.9, 'pitch': -0.15, 'intonation': 0.85, 'volume': -0.15},
            'angry': {'speed': 1.1, 'pitch': 0.2, 'intonation': 1.1, 'volume': 0.2},
            'gentle': {'speed': 0.95, 'pitch': -0.05, 'intonation': 0.95, 'volume': -0.1},
            'whisper': {'speed': 0.9, 'pitch': -0.1, 'intonation': 0.85, 'volume': -0.4},
            'loud': {'speed': 1.05, 'pitch': 0.1, 'intonation': 1.1, 'volume': 0.3},
            'fast': {'speed': 1.3, 'pitch': 0.1, 'intonation': 1.05, 'volume': 0.0},
            'slow': {'speed': 0.8, 'pitch': -0.05, 'intonation': 0.95, 'volume': 0.0},
        }

    def _detect_user_parameter_requests(self, text: str) -> dict[str, Any]:
        text_lower = text.lower()
        params = {}
        
        samples = self._get_sample_adjustments()
        for sample_name, sample_params in samples.items():
            if sample_name in text_lower:
                return sample_params
        
        intensity_modifiers = {
            'much': ['もっと', 'much', 'とても'],
            'slight': ['少し', 'ちょっと', 'a bit']
        }
        
        def get_intensity():
            if any(mod in text_lower for mod in intensity_modifiers['much']):
                return 'much'
            elif any(mod in text_lower for mod in intensity_modifiers['slight']):
                return 'slight'
            return 'normal'
        
        intensity = get_intensity()
        
        param_rules = {
            'speed': {
                'faster': {'much': 1.35, 'slight': 1.1, 'normal': 1.2},
                'slower': {'much': 0.75, 'slight': 0.95, 'normal': 0.85},
                'keywords': {
                    'faster': ['速く', '早く', 'faster', 'quickly', 'speed up', '快点', '快一点', '加快', 'もっと速く', 'much faster'],
                    'slower': ['遅く', 'ゆっくり', 'slow', 'slowly', 'slow down', '慢点', '慢一点', '放慢', 'もっと遅く', 'much slower']
                }
            },
            'volume': {
                'louder': {'much': 0.4, 'slight': 0.15, 'normal': 0.3},
                'quieter': {'much': -0.4, 'slight': -0.15, 'normal': -0.3, 'whisper': -0.5},
                'keywords': {
                    'louder': ['大きい', '大きく', '大声', 'louder', 'volume up', 'turn up', '大声点', '大一点', '提高音量', 'もっと大きく'],
                    'quieter': ['小さい', '小さく', '小声', 'quieter', 'softer', 'volume down', 'turn down', '小声点', '小一点', '降低音量', 'whisper']
                }
            },
            'pitch': {
                'higher': {'much': 0.4, 'slight': 0.15, 'normal': 0.3},
                'lower': {'much': -0.3, 'slight': -0.1, 'normal': -0.2},
                'keywords': {
                    'higher': ['高い', '高く', 'higher pitch', 'raise pitch', '音调高', '提高音调', 'もっと高く'],
                    'lower': ['低い', '低く', 'lower pitch', 'lower', '音调低', '降低音调', 'もっと低く']
                }
            },
            'intonation': {
                'more': {'much': 1.3, 'slight': 1.1, 'normal': 1.2},
                'less': {'much': 0.8, 'slight': 0.95, 'normal': 0.85},
                'keywords': {
                    'more': ['感情豊かに', '表現豊かに', 'more expressive', 'more emotion', '更有感情', '更有表现力', 'もっと感情豊かに'],
                    'less': ['落ち着いて', '冷静に', 'less expressive', 'calm', '冷静', '平静', 'もっと落ち着いて']
                }
            }
        }
        
        for param_name, rules in param_rules.items():
            for direction, values in [('faster', rules.get('faster', {})), ('slower', rules.get('slower', {})),
                                      ('louder', rules.get('louder', {})), ('quieter', rules.get('quieter', {})),
                                      ('higher', rules.get('higher', {})), ('lower', rules.get('lower', {})),
                                      ('more', rules.get('more', {})), ('less', rules.get('less', {}))]:
                if direction in rules.get('keywords', {}) and any(kw in text_lower for kw in rules['keywords'][direction]):
                    if param_name == 'volume' and direction == 'quieter' and ('whisper' in text_lower or 'ささやき' in text_lower):
                        params[param_name] = values.get('whisper', values.get('normal', 0))
                    else:
                        params[param_name] = values.get(intensity, values.get('normal', 0))
                    break
        
        return params

    def _detect_emotion_and_speed(self, text: str) -> dict[str, Any]:
        text_lower = text.lower()
        params = {}
        
        samples = self._get_sample_adjustments()
        for sample_name, sample_params in samples.items():
            if sample_name in text_lower:
                return sample_params
        
        emotion_keywords = {
            'happy': ['楽しい', '嬉しい', '喜び', '笑', '幸せ', 'happy', 'joy', 'smile', 'excited', '高兴', '开心', '快乐'],
            'sad': ['悲しい', '寂しい', '辛い', '苦しい', 'sad', 'lonely', 'pain', 'sorrow', '悲伤', '难过', '痛苦'],
            'excited': ['興奮', 'ワクワク', '急いで', 'excited', 'rush', 'hurry', '兴奋', '激动', '着急'],
            'calm': ['静か', '落ち着いて', 'ゆっくり', 'calm', 'quiet', 'slow', 'peaceful', '安静', '平静', '慢慢'],
            'angry': ['怒り', '怒って', 'angry', 'mad', 'furious', '生气', '愤怒'],
            'gentle': ['優しく', '穏やか', 'gentle', 'soft', '温柔', '温和'],
            'lewd': ['エッチ', 'えっち', 'sexy', 'seductive', 'sensual', '魅惑的', '色っぽい', '色気']
        }
        
        emotion_params = {
            'excited': {'speed': 1.15, 'pitch': 0.0, 'intonation': 1.15, 'volume': 0.1},
            'lewd': {'speed': 0.95, 'pitch': 0.1, 'intonation': 1.25, 'volume': -0.1},
            'calm': {'speed': 0.90, 'pitch': 0.0, 'intonation': 1.0, 'volume': -0.1},
            'sad': {'speed': 0.95, 'pitch': -0.1, 'intonation': 0.90, 'volume': 0.0},
            'angry': {'speed': 1.1, 'pitch': 0.15, 'intonation': 1.1, 'volume': 0.1},
            'happy': {'speed': 1.0, 'pitch': 0.2, 'intonation': 1.15, 'volume': 0.0},
            'gentle': {'speed': 1.0, 'pitch': -0.05, 'intonation': 0.95, 'volume': -0.1}
        }
        
        for emotion, keywords in emotion_keywords.items():
            if any(kw in text_lower for kw in keywords):
                if emotion == 'happy' and any(kw in text_lower for kw in emotion_keywords['excited']):
                    params.update(emotion_params['excited'])
                else:
                    params.update(emotion_params.get(emotion, {}))
                break
        
        params.setdefault('speed', 1.0)
        params.setdefault('pitch', 0.0)
        params.setdefault('intonation', 1.0)
        params.setdefault('volume', 0.0)
        return params

    async def synthesize(
        self,
        text: str,
        *,
        voice: Optional[str] = None,
        full_text_for_display: Optional[str] = None,
        auto_adjust_emotion: bool = True,
        custom_params: Optional[dict[str, Any]] = None,
    ) -> AsyncIterator[tts.SynthesizedAudio]:
        # text is Japanese-only for speech; EN/CN/zh are never read out (use full_text_for_display for captions)
        # Always extract when any language label is present so we never speak "jp:", "en:", "zh:", etc.
        _has_lang_labels = bool(
            re.search(r'(?:^|\n)\s*(?:JP|EN|中文|Chinese|zh):\s*', text, re.IGNORECASE)
            or re.search(r'\[(?:JP|EN|中文):\s*[^\]]+\]', text, re.IGNORECASE)
        )
        text_for_tts = self._extract_japanese_text(text) if _has_lang_labels else text

        # Never send content that still contains language labels to the TTS API
        if text_for_tts and re.search(r'(?:^|\n)\s*(?:EN|中文|Chinese|zh):\s*', text_for_tts, re.IGNORECASE):
            text_for_tts = self._extract_japanese_text(text_for_tts) or ""
        if text_for_tts and re.search(r'(?:^|\n)\s*JP:\s*', text_for_tts, re.IGNORECASE):
            text_for_tts = self._extract_japanese_text(text_for_tts) or ""

        if not text_for_tts or not text_for_tts.strip():
            return
        
        text_for_tts = ''.join(char for char in text_for_tts if char.isprintable() or char.isspace()).strip()
        if not text_for_tts:
            return
        
        # Determine display text with priority: override > explicit param > translator > original
        display_text = None
        
        # 1. Check for temporary override (highest priority) - CHECK THIS FIRST
        if self._display_text_override:
            display_text = self._display_text_override
            logger.info(f"synthesize: Using display_text_override (length={len(display_text)})")
            logger.info(f"synthesize: Override preview: {display_text[:150]}...")
            logger.info(f"synthesize: Override contains EN: {'EN:' in display_text}")
            logger.info(f"synthesize: Override contains 中文: {'中文:' in display_text}")
        # 2. Check for explicit full_text_for_display parameter
        elif full_text_for_display is not None:
            display_text = full_text_for_display
            logger.info(f"synthesize: Using full_text_for_display parameter")
        # 3. Try to generate translations using callback
        elif self._translator_callback and self._is_japanese_text(text_for_tts):
            try:
                logger.info(f"synthesize: Calling translator callback for '{text_for_tts[:50]}...'")
                en_text, cn_text = await self._translator_callback(text_for_tts)
                if en_text and cn_text:
                    display_text = f"JP:{text_for_tts}\n\nEN:{en_text}\n\n中文:{cn_text}"
                    logger.info(f"synthesize: Generated translations via callback")
                else:
                    display_text = f"JP:{text_for_tts}\n\nEN:{en_text or 'Translation unavailable'}\n\n中文:{cn_text or '翻譯不可用'}"
                    logger.warning(f"synthesize: Translations incomplete - EN: {bool(en_text)}, CN: {bool(cn_text)}")
            except Exception as e:
                logger.error(f"synthesize: Translation callback failed: {e}", exc_info=True)
                display_text = text
        else:
            display_text = text
            logger.warning(f"synthesize: No override, no callback, using original text (no translations)")
        dynamic_params = {}
        
        if auto_adjust_emotion:
            voisona_params = None
            if self._use_text_analysis:
                try:
                    async with aiohttp.ClientSession(timeout=self._timeout()) as analysis_sess:
                        voisona_params = await self._analyze_text_with_voisona(analysis_sess, text_for_tts)
                except Exception:
                    pass
            dynamic_params = voisona_params or self._detect_emotion_and_speed(text_for_tts)
        
        if custom_params:
            dynamic_params.update(custom_params)
        
        async with self._lock:
            async with aiohttp.ClientSession(timeout=self._timeout()) as sess:
                voice_sel = await self._select_voice(sess)
                wav_path = self._output_dir / f"voisona_{int(time.time() * 1000)}.wav"
                uuid: str | None = None
                
                try:
                    uuid = await self._create_synthesis(sess, text=text_for_tts, voice=voice_sel, wav_path=wav_path, dynamic_params=dynamic_params)
                    await self._wait_synthesis(sess, uuid)
                    
                    pcm_bytes, sr, nch, spc = self._read_wav_pcm16_mono(wav_path)
                    frame = rtc.AudioFrame(data=pcm_bytes, sample_rate=sr, num_channels=nch, samples_per_channel=spc)
                    
                    # Log what we're sending as delta_text
                    logger.info(f"synthesize: delta_text preview: {display_text[:150] if display_text else 'None'}...")
                    logger.info(f"synthesize: delta_text contains EN: {'EN:' in (display_text or '')}")
                    logger.info(f"synthesize: delta_text contains 中文: {'中文:' in (display_text or '')}")
                    
                    # Publish the full text to data channel for display
                    # Don't use delta_text when using translator callback to avoid duplicates
                    use_delta_text = True
                    if self._publish_callback and display_text:
                        try:
                            await self._publish_callback(display_text)
                            logger.info(f"synthesize: Published text to data channel")
                            use_delta_text = False  # Already published, don't send via transcription
                        except Exception as e:
                            logger.warning(f"synthesize: Failed to publish text: {e}")
                    
                    # If translator callback is set, don't send delta_text to avoid duplicates
                    if self._translator_callback:
                        use_delta_text = False
                    
                    yield tts.SynthesizedAudio(
                        frame=frame,
                        request_id=f"voisona_{uuid}",
                        delta_text=display_text if use_delta_text else "",
                        is_final=True,
                        segment_id="voisona_tts",
                    )
                finally:
                    if uuid:
                        try:
                            await self._delete_synthesis(sess, uuid)
                        except Exception:
                            pass
                    
                    if wav_path.exists():
                        try:
                            for attempt in range(3):
                                try:
                                    wav_path.unlink()
                                    break
                                except PermissionError:
                                    if attempt < 2:
                                        await asyncio.sleep(0.1)
                                except Exception:
                                    break
                        except Exception:
                            pass

