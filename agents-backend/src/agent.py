import asyncio
import logging
import os
import re
from pathlib import Path
import sys
import signal
import psutil

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from typing import Any

from dotenv import load_dotenv

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    WorkerOptions,
    JobExecutorType,
    cli,
)
# Noise cancellation removed - requires LiveKit Cloud
# from livekit.plugins import noise_cancellation
from livekit.plugins.openai import LLM as OpenAICompatibleLLM
from voisona_tts import VoiSonaTTS
import aiohttp
import httpx
from openai import AsyncOpenAI

# Initialize logging first
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice_agent")

# Load env from .env files (try multiple locations)
# 1. agents-backend/src/.env (highest priority - most specific)
# 2. agents-backend/.env (project-level)
# 3. Root .env (if exists)
env_paths = [
    Path(__file__).parent / ".env",  # agents-backend/src/.env
    Path(__file__).parent.parent / ".env",  # agents-backend/.env
    Path(__file__).parent.parent.parent / ".env",  # Root .env
]

loaded_env_files = []
for env_path in env_paths:
    if env_path.exists():
        load_dotenv(env_path, override=False)  # Don't override if already set
        loaded_env_files.append(str(env_path))

if loaded_env_files:
    logger.info(f"Loaded .env files: {', '.join(loaded_env_files)}")
else:
    logger.warning("No .env files found. Using default values or system environment variables.")
    logger.warning(f"Expected locations: {[str(p) for p in env_paths]}")

from prompts import (
    AGENT_INSTRUCTION,
    ERROR_MESSAGE_FULL,
    ERROR_MESSAGE_JP,
    UNCLEAR_INPUT_MESSAGE_FULL,
    UNCLEAR_INPUT_MESSAGE_JP,
    DEFAULT_GREETING_FULL,
    DEFAULT_GREETING_JP,
    TIMEOUT_MESSAGE_FULL,
    TIMEOUT_MESSAGE_JP,
    FOLLOWUP_MESSAGE_FULL,
    FOLLOWUP_MESSAGE_JP,
    THINKING_MESSAGE_FULL,
    THINKING_MESSAGE_JP,
)

# Ensure thread executor on Windows to avoid IPC issues
os.environ.setdefault("LIVEKIT_AGENT_EXECUTOR", "thread")

# Windows compatibility: Fix SIGKILL issue with watchfiles
if sys.platform == "win32":
    # SIGKILL doesn't exist on Windows, patch it for watchfiles compatibility
    if not hasattr(signal, "SIGKILL"):
        signal.SIGKILL = signal.SIGTERM
    # Disable file watching to avoid watchfiles SIGKILL errors
    os.environ.setdefault("LIVEKIT_AGENT_WATCH", "false")

import warnings
warnings.filterwarnings("ignore", message=".*server settings.*")
warnings.filterwarnings("ignore", message=".*audio filter.*")
warnings.filterwarnings("ignore", message=".*LiveKit Cloud.*")
class VoiceAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=AGENT_INSTRUCTION)
        # Initialize VoiSona TTS (local REST API; see https://manual.voisona.com/en/talk/pc/2b6e9bc7efb18014b922c93fcaa8aac4)
        self._voisona_tts = VoiSonaTTS()

    async def tts_node(self, text, model_settings):
        from typing import AsyncIterable

        sentence_buffer: str = ""
        end_punct = {".", "!", "?", "…"}
        max_buffer_chars = 220  # safety cap for very long sentences

        async def flush_buffer():
            nonlocal sentence_buffer
            text_to_say = sentence_buffer.strip()
            if not text_to_say:
                return
            preview = text_to_say[:80]
            if len(text_to_say) > 80:
                preview = preview + "..."
            logger.info(f"TTS flushing sentence: '{preview}'")
            async for audio_event in self._voisona_tts.synthesize(text_to_say):
                yield audio_event.frame
            sentence_buffer = ""

        async for text_segment in text:
            seg = (text_segment or "").strip()
            if not seg:
                continue

            # Append with a space if needed to avoid word concatenation
            if sentence_buffer and not sentence_buffer.endswith(" "):
                sentence_buffer += " "
            sentence_buffer += seg

            # Flush when we have an end-of-sentence marker or very long buffer
            if (seg and seg[-1] in end_punct) or len(sentence_buffer) >= max_buffer_chars:
                async for frame in flush_buffer():
                    yield frame

        # Final flush for any remaining text
        async for frame in flush_buffer():
            yield frame

def prewarm(proc):
    return


async def entrypoint(ctx: JobContext):
    ctx.log_context_fields = {"room": ctx.room.name}
    logger.info("Starting agent (room=%s)", ctx.room.name)

    # Ollama configuration - loaded from .env file
    ollama_base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
    ollama_model = os.getenv("OLLAMA_MODEL", "gemma3:1b")  # SMALLEST model by default (1B parameters)
    ollama_api_key = os.getenv("OLLAMA_API_KEY", "ollama")
    logger.info(f"Ollama LLM: model={ollama_model}, base_url={ollama_base_url}")

    # Check system resources
    try:
        cpu_percent = psutil.cpu_percent(interval=0.5)
        memory = psutil.virtual_memory()
        logger.info(f"System: CPU {cpu_percent}%, Memory {memory.percent}% ({memory.available / (1024**3):.1f}GB free)")
        if cpu_percent > 90 or memory.percent > 90:
            logger.warning(f"High resource usage - may cause timeouts. Consider smaller model (gemma3:1b)")
    except Exception:
        pass

    # Check if Ollama is running and model is available
    try:
        async with aiohttp.ClientSession() as check_sess:
            async with check_sess.get(
                f"{ollama_base_url.replace('/v1', '')}/api/tags",
                timeout=aiohttp.ClientTimeout(total=5.0)
            ) as check_resp:
                if check_resp.status == 200:
                    models_data = await check_resp.json()
                    available_models = [m.get('name', '') for m in models_data.get('models', [])]
                    
                    # Check if model exists (handle 'model' and 'model:latest' formats)
                    if ollama_model not in available_models:
                        model_with_tag = f"{ollama_model}:latest"
                        if model_with_tag in available_models:
                            ollama_model = model_with_tag
                        else:
                            matching = [m for m in available_models if m.startswith(f"{ollama_model}:") or m == ollama_model]
                            if matching:
                                ollama_model = matching[0]
                            else:
                                logger.error(f"Model '{ollama_model}' not found. Available: {', '.join(available_models[:3])}. Run: ollama pull {ollama_model}")
                else:
                    logger.warning(f"Ollama status {check_resp.status}")
    except (aiohttp.ClientConnectorError, asyncio.TimeoutError):
        logger.error(f"Cannot connect to Ollama at {ollama_base_url}. Start: ollama serve")
    except Exception as e:
        logger.warning(f"Ollama check failed: {e}")

    # Create OpenAI client with custom timeout
    ollama_timeout = float(os.getenv("OLLAMA_TIMEOUT", "900.0"))
    httpx_timeout = httpx.Timeout(ollama_timeout, connect=30.0, read=ollama_timeout, write=ollama_timeout, pool=30.0)
    http_client = httpx.AsyncClient(timeout=httpx_timeout)
    openai_client = AsyncOpenAI(
        base_url=ollama_base_url,
        api_key=ollama_api_key,
        http_client=http_client,
        timeout=httpx_timeout,
        max_retries=0,
    )

    llm_kwargs: dict[str, Any] = {
        "model": ollama_model,
        "base_url": ollama_base_url,
        "api_key": ollama_api_key,
        "client": openai_client,
        "timeout": ollama_timeout,
    }

    agent = VoiceAgent()
    
    # Create session with LLM and TTS (from agent)
    session = AgentSession(
        llm=OpenAICompatibleLLM(**llm_kwargs),  # OpenAI-compatible, works with Ollama
        tts=agent._voisona_tts,  # Use VoiSona TTS from agent
    )

    # Helper function to publish full text for display and speak Japanese only
    async def publish_and_say(full_text: str, jp_text: str, allow_interruptions: bool = True):
        """Publish full multilingual text to data channel and speak Japanese via TTS."""
        try:
            await ctx.room.local_participant.publish_data(
                full_text.encode('utf-8'),
                reliable=True,
                topic="lk-chat-message"
            )
        except Exception as e:
            logger.warning(f"Failed to publish text: {e}")
        try:
            await session.say(jp_text, allow_interruptions=allow_interruptions)
        except Exception as e:
            logger.warning(f"Failed to say text: {e}")

    async def reply_with_followup(prompt_text: str):
        # Publish thinking message
        asyncio.create_task(publish_and_say(THINKING_MESSAGE_FULL, THINKING_MESSAGE_JP))
        
        try:
            start_time = asyncio.get_event_loop().time()
            await asyncio.wait_for(
                session.generate_reply(instructions=prompt_text),
                timeout=ollama_timeout,
            )
            elapsed = asyncio.get_event_loop().time() - start_time
            logger.info(f"LLM reply completed in {elapsed:.1f}s")
        except asyncio.TimeoutError:
            try:
                memory = psutil.virtual_memory()
                cpu_percent = psutil.cpu_percent(interval=0.1)
                logger.error(f"LLM timeout after {ollama_timeout}s - CPU: {cpu_percent}%, Memory: {memory.percent}%")
                if memory.percent > 90 or cpu_percent > 90:
                    logger.error(f"High resource usage detected. Use smaller model: export OLLAMA_MODEL=gemma3:1b")
            except:
                pass
            logger.error(f"Model may be too slow. Try: export OLLAMA_MODEL=gemma3:1b && ollama pull gemma3:1b")
            await publish_and_say(TIMEOUT_MESSAGE_FULL, TIMEOUT_MESSAGE_JP)
            return
        except Exception as e:
            error_str = str(e).lower()
            if "timeout" in error_str or "timed out" in error_str:
                logger.error(f"LLM timeout - model: {ollama_model}. Try smaller model (gemma3:1b)")
            elif "connection" in error_str or "connect" in error_str:
                logger.error(f"LLM connection error - check Ollama at {ollama_base_url}")
            else:
                logger.exception(f"LLM error: {e}")
            try:
                await publish_and_say(ERROR_MESSAGE_FULL, ERROR_MESSAGE_JP)
            except:
                pass
            return
        await publish_and_say(FOLLOWUP_MESSAGE_FULL, FOLLOWUP_MESSAGE_JP)

    # Connect FIRST before doing any blocking operations
    await ctx.connect()
    logger.info("Connected to room")

    # Set up TTS translator callback to translate and publish BEFORE speaking
    async def tts_translator_callback(jp_text: str) -> tuple[str, str]:
        """Translate Japanese text to EN and CN for TTS display."""
        en_text = ""
        cn_text = ""
        
        try:
            # Translate to English
            en_response = await openai_client.chat.completions.create(
                model=ollama_model,
                messages=[
                    {"role": "system", "content": "Translate to English. Output only the translation."},
                    {"role": "user", "content": jp_text}
                ],
                max_tokens=200,
                temperature=0.1,
            )
            en_text = en_response.choices[0].message.content.strip() if en_response.choices else ""
            en_text = en_text.replace("**", "").replace("*", "")
        except Exception as e:
            logger.warning(f"TTS EN translation failed: {e}")
            en_text = "(Translation unavailable)"
        
        try:
            # Translate to Simplified Chinese (简体中文) - better for small models
            source_for_cn = en_text if en_text and en_text != "(Translation unavailable)" else jp_text
            cn_response = await openai_client.chat.completions.create(
                model=ollama_model,
                messages=[
                    {"role": "system", "content": "Translate to Simplified Chinese. Output only the Chinese translation."},
                    {"role": "user", "content": f"Translate to Simplified Chinese: {source_for_cn}"}
                ],
                max_tokens=200,
                temperature=0.2,
            )
            cn_text = cn_response.choices[0].message.content.strip() if cn_response.choices else ""
            cn_text = cn_text.replace("**", "").replace("*", "")
            # Remove common prefixes
            for prefix in ["Simplified Chinese:", "Chinese:", "简体中文:", "中文:", "Translation:"]:
                if cn_text.startswith(prefix):
                    cn_text = cn_text[len(prefix):].strip()
            # Check if result has Chinese characters
            cn_chars = len(re.findall(r'[\u4e00-\u9fff]', cn_text))
            if cn_chars < 2 or not cn_text or len(cn_text) < 2:
                cn_text = "(翻译不可用)"
        except Exception as e:
            logger.warning(f"TTS CN translation failed: {e}")
            cn_text = "(翻译不可用)"
        
        # Publish the full multilingual text to data channel BEFORE TTS speaks
        full_text = f"JP:{jp_text}\n\nEN:{en_text}\n\n中文:{cn_text}"
        try:
            await ctx.room.local_participant.publish_data(
                full_text.encode('utf-8'),
                reliable=True,
                topic="lk-chat-message"
            )
            logger.info(f"Published text before TTS: {jp_text[:50]}...")
        except Exception as e:
            logger.warning(f"Failed to publish before TTS: {e}")
        
        return (en_text, cn_text)
    
    agent._voisona_tts.set_translator_callback(tts_translator_callback)
    logger.info("Set up TTS translator callback for text display before speaking")

    # Pre-warm Ollama model
    prewarm_success = False
    try:
        prewarm_timeout = float(os.getenv("OLLAMA_PREWARM_TIMEOUT", "120.0"))
        logger.info("Pre-warming Ollama model...")
        start_time = asyncio.get_event_loop().time()
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"{ollama_base_url.replace('/v1', '')}/api/generate",
                json={"model": ollama_model, "prompt": "Hi", "stream": False, "options": {"num_predict": 5, "keep_alive": "10m"}},
                timeout=aiohttp.ClientTimeout(total=prewarm_timeout)
            ) as resp:
                if resp.status == 200:
                    await resp.read()
                    elapsed = asyncio.get_event_loop().time() - start_time
                    logger.info(f"Model pre-warmed in {elapsed:.1f}s")
                    prewarm_success = True
    except (asyncio.TimeoutError, aiohttp.ClientConnectorError):
        logger.warning("Pre-warm failed or timed out - continuing anyway")
    except Exception as e:
        logger.warning(f"Pre-warm error: {e}")

    await session.start(
        agent=agent,
        room=ctx.room,
    )
    
    # Send initial greeting via TTS (bypass LLM)
    async def send_greeting():
        await asyncio.sleep(1)
        try:
            # Publish full greeting text for display (JP + EN + 中文)
            await ctx.room.local_participant.publish_data(
                DEFAULT_GREETING_FULL.encode('utf-8'),
                reliable=True,
                topic="lk-chat-message"
            )
            logger.info("Published greeting text to data channel")
            
            # Speak Japanese only via TTS
            await session.say(DEFAULT_GREETING_JP, allow_interruptions=False)
        except AttributeError:
            try:
                # Fallback: get actual frame properties from first frame
                source = None
                track = None
                async for audio_event in agent._voisona_tts.synthesize(DEFAULT_GREETING_JP):
                    if source is None:
                        source = rtc.AudioSource(
                            audio_event.frame.sample_rate,
                            audio_event.frame.num_channels
                        )
                        track = rtc.LocalAudioTrack.create_audio_track("greeting", source)
                        await ctx.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
                    await source.capture_frame(audio_event.frame)
                if track:
                    await ctx.room.local_participant.unpublish_track(track)
            except Exception as e:
                logger.warning(f"Greeting failed: {e}")
        except Exception as e:
            logger.warning(f"Greeting failed: {e}")
    
    # Send greeting in background to not block
    asyncio.create_task(send_greeting())

    # User message handler
    @session.on("user_message")
    def _on_user_message(ev):
        async def handle_message():
            try:
                user_text = (ev.text or "").strip()
                if len(user_text) < 2:
                    await publish_and_say(UNCLEAR_INPUT_MESSAGE_FULL, UNCLEAR_INPUT_MESSAGE_JP)
                    return
                logger.info(f"User: {user_text}")
                # Always instruct to respond in Japanese (English prompt for small model)
                prompt = f"User message: {user_text}\n\nRespond in Japanese only. Do not use English."
                await reply_with_followup(prompt)
            except Exception as e:
                logger.exception("Error handling message")
                try:
                    await publish_and_say(ERROR_MESSAGE_FULL, ERROR_MESSAGE_JP)
                except:
                    pass
        asyncio.create_task(handle_message())

    # Helper to translate Japanese text to EN and CN using Ollama
    async def translate_to_multilingual(jp_text: str) -> str:
        """Translate Japanese text to EN and CN, return formatted multilingual text."""
        # Clean Japanese text - remove markdown formatting
        clean_jp = jp_text.replace("**", "").replace("*", "").strip()
        
        try:
            en_text = ""
            cn_text = ""
            
            # Translate to English - strict prompt
            try:
                en_response = await openai_client.chat.completions.create(
                    model=ollama_model,
                    messages=[
                        {"role": "system", "content": "You are a translator. Translate Japanese to English. ONLY output the English translation. No explanations, no notes, no Japanese text."},
                        {"role": "user", "content": f"Translate to English:\n{clean_jp}"}
                    ],
                    max_tokens=300,
                    temperature=0.1,
                )
                raw_en = en_response.choices[0].message.content.strip() if en_response.choices else ""
                # Clean up: remove any Japanese characters, markdown, or prefixes
                en_text = raw_en.replace("**", "").replace("*", "")
                # Remove common prefixes the model might add
                for prefix in ["English:", "EN:", "Translation:", "English translation:"]:
                    if en_text.lower().startswith(prefix.lower()):
                        en_text = en_text[len(prefix):].strip()
                # If still contains Japanese, use fallback
                if re.search(r'[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]', en_text):
                    en_text = "(Translation unavailable)"
            except Exception as e:
                logger.warning(f"EN translation failed: {e}")
                en_text = "(Translation unavailable)"
            
            # Translate to Simplified Chinese (简体中文) - better for small models
            try:
                source_for_cn = en_text if en_text and en_text != "(Translation unavailable)" else clean_jp
                cn_response = await openai_client.chat.completions.create(
                    model=ollama_model,
                    messages=[
                        {"role": "system", "content": "Translate to Simplified Chinese. Output only the Chinese translation."},
                        {"role": "user", "content": f"Translate to Simplified Chinese: {source_for_cn}"}
                    ],
                    max_tokens=300,
                    temperature=0.2,
                )
                raw_cn = cn_response.choices[0].message.content.strip() if cn_response.choices else ""
                cn_text = raw_cn.replace("**", "").replace("*", "")
                # Remove common prefixes
                for prefix in ["Simplified Chinese:", "Chinese:", "中文:", "CN:", "简体中文:", "Translation:"]:
                    if cn_text.startswith(prefix):
                        cn_text = cn_text[len(prefix):].strip()
                # Check if result has Chinese characters
                cn_chars = len(re.findall(r'[\u4e00-\u9fff]', cn_text))
                if cn_chars < 2 or not cn_text or len(cn_text) < 2:
                    cn_text = "(翻译不可用)"
            except Exception as e:
                logger.warning(f"CN translation failed: {e}")
                cn_text = "(翻译不可用)"
            
            # Format as multilingual
            return f"JP:{clean_jp}\n\nEN:{en_text}\n\n中文:{cn_text}"
        except Exception as e:
            logger.warning(f"Translation failed: {e}")
            return f"JP:{clean_jp}\n\nEN:(Translation unavailable)\n\n中文:(翻译不可用)"

    # Agent message handler - disabled, TTS translator callback handles publishing
    # This avoids duplicate messages
    @session.on("conversation_item_added")
    def _on_conversation_item_added(ev):
        # Skip - TTS translator callback publishes text before speaking
        pass

    # Speech created handler - backup for publishing agent speech text
    # Note: conversation_item_added is more reliable, this is just a backup
    @session.on("speech_created")
    def _on_speech_created(ev):
        # Skip - let conversation_item_added handle publishing to avoid duplicates
        pass

    # Cleanup function (no avatar now, just a placeholder for future resources)
    async def cleanup():
        logger.info("Cleanup")

    ctx.add_shutdown_callback(cleanup)


if __name__ == "__main__":
    livekit_url = os.getenv("LIVEKIT_URL") or os.getenv("LIVEKIT_WS_URL") or "ws://localhost:7880"
    livekit_api_key = os.getenv("LIVEKIT_API_KEY") or "devkey"
    livekit_api_secret = os.getenv("LIVEKIT_API_SECRET") or "secret"

    # Ensure we're using local LiveKit (not cloud)
    if livekit_url and ("livekit.cloud" in livekit_url or "livekit.io" in livekit_url):
        logger.warning("Detected LiveKit Cloud URL, switching to local: ws://localhost:7880")
        livekit_url = "ws://localhost:7880"

    options = WorkerOptions(
        entrypoint_fnc=entrypoint,
        prewarm_fnc=prewarm,
        job_executor_type=JobExecutorType.THREAD,
        num_idle_processes=1,
        initialize_process_timeout=120.0,
        ws_url=livekit_url,
        api_key=livekit_api_key,
        api_secret=livekit_api_secret,
    )

    try:
        cli.run_app(options)
    except AttributeError as e:
        if "SIGKILL" in str(e):
            logger.warning("SIGKILL error suppressed (Windows compatibility issue)")
        else:
            raise
