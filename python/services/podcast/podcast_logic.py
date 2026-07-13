"""
Gemini → two-person script → gTTS + pydub → MP3 bytes.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import warnings
from typing import Any

import google.generativeai as genai

# pydub warns before ensure_pydub_ffmpeg() runs; FFmpeg paths are set on first request.
warnings.filterwarnings(
    "ignore",
    message=r"Couldn't find ffmpeg or avconv",
    category=RuntimeWarning,
    module="pydub.utils",
)
warnings.filterwarnings(
    "ignore",
    message=r"Couldn't find ffprobe or avprobe",
    category=RuntimeWarning,
    module="pydub.utils",
)

import pydub.utils as pydub_utils
from dotenv import load_dotenv
from gtts import gTTS
from pydub import AudioSegment
from pydub.utils import which

_SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
# Ensure podcast .env is applied when this module loads (before any request).
load_dotenv(os.path.join(_SERVICE_DIR, ".env"))

_ORIGINAL_GET_PROBER_NAME = pydub_utils.get_prober_name
_PYDUB_FFMPEG_READY = False
_WINGET_FFMPEG_SCAN_DONE = False
_WINGET_FFMPEG_DIR: str | None = None


def _ffmpeg_hint() -> str:
    return (
        "Install FFmpeg (ffmpeg + ffprobe). On Windows: add WinGet’s …\\bin to PATH, or set "
        "ACADOMI_FFMPEG in python/services/podcast/.env to that bin folder OR to ffmpeg.exe. "
        "Use forward slashes in .env (C:/Users/...) — backslashes can break python-dotenv (\\U…). "
        "winget install ffmpeg"
    )


def _ffmpeg_path_variants(raw: str) -> list[str]:
    """python-dotenv mangles Windows paths like C:\\Users (\\U…); try sane alternatives."""
    s = raw.strip().strip('"').strip("'")
    if not s:
        return []
    s = os.path.expandvars(s)
    candidates = [s, os.path.normpath(s)]
    if os.name == "nt":
        if "/" in s:
            candidates.append(os.path.normpath(s.replace("/", "\\")))
        if "\\" in s:
            candidates.append(os.path.normpath(s.replace("\\", "/")))
    out: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _discover_winget_ffmpeg_dir() -> str | None:
    """Find a directory that contains ffmpeg.exe and ffprobe.exe under WinGet packages."""
    global _WINGET_FFMPEG_SCAN_DONE, _WINGET_FFMPEG_DIR
    if _WINGET_FFMPEG_SCAN_DONE:
        return _WINGET_FFMPEG_DIR
    _WINGET_FFMPEG_SCAN_DONE = True
    if os.name != "nt":
        return None
    local = os.environ.get("LOCALAPPDATA") or os.path.expandvars(r"%LOCALAPPDATA%")
    packages = os.path.join(local, "Microsoft", "WinGet", "Packages")
    if not os.path.isdir(packages):
        return None
    try:
        for entry in os.scandir(packages):
            if not entry.is_dir():
                continue
            try:
                for root, _, files in os.walk(entry.path):
                    if "ffmpeg.exe" in files and "ffprobe.exe" in files:
                        _WINGET_FFMPEG_DIR = root
                        return root
            except OSError:
                continue
    except OSError:
        return None
    return None


def _parse_ffmpeg_env_with_variants(raw: str) -> tuple[str | None, str | None]:
    for cand in _ffmpeg_path_variants(raw):
        ff, fp = _parse_acadomi_ffmpeg_env(cand)
        if ff or fp:
            return ff, fp
    return None, None


def _exe_in_dir(directory: str, stem: str) -> str | None:
    d = os.path.abspath(directory.strip().strip('"'))
    name = f"{stem}.exe" if os.name == "nt" else stem
    p = os.path.join(d, name)
    return p if os.path.isfile(p) else None


def _parse_acadomi_ffmpeg_env(value: str) -> tuple[str | None, str | None]:
    """
    ACADOMI_FFMPEG may be:
    - path to ffmpeg.exe (ffprobe resolved beside it), or
    - path to a directory containing ffmpeg.exe and ffprobe.exe (common for WinGet).
    """
    v = value.strip().strip('"')
    if not v:
        return None, None
    if os.path.isdir(v):
        ff = _exe_in_dir(v, "ffmpeg")
        fp = _exe_in_dir(v, "ffprobe")
        return ff, fp
    if os.path.isfile(v):
        base = os.path.basename(v).lower()
        if "ffprobe" in base and "ffmpeg" not in base:
            return _same_dir_exe(v, "ffmpeg"), v
        return v, _same_dir_exe(v, "ffprobe")
    return None, None


def _parse_acadomi_ffprobe_env(value: str) -> str | None:
    v = value.strip().strip('"')
    if not v:
        return None
    if os.path.isdir(v):
        return _exe_in_dir(v, "ffprobe")
    if os.path.isfile(v):
        return v
    return None


def _parse_ffprobe_env_with_variants(raw: str) -> str | None:
    for cand in _ffmpeg_path_variants(raw):
        p = _parse_acadomi_ffprobe_env(cand)
        if p:
            return p
    return None


def _same_dir_exe(ffmpeg_path: str, name: str) -> str | None:
    d = os.path.dirname(os.path.abspath(ffmpeg_path))
    if os.name == "nt" and not name.endswith(".exe"):
        name = name + ".exe"
    p = os.path.join(d, name)
    return p if os.path.isfile(p) else None


def _can_spawn(cmd: object) -> bool:
    if cmd is None:
        return False
    exe = str(cmd)
    try:
        kwargs: dict[str, Any] = {
            "args": [exe, "-version"],
            "capture_output": True,
            "timeout": 10,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
        r = subprocess.run(**kwargs, check=False)
        return r.returncode == 0
    except (FileNotFoundError, OSError):
        return False


def ensure_pydub_ffmpeg() -> None:
    """
    pydub's mediainfo uses ffprobe by name; on Windows it often is not on PATH while ffmpeg is,
    or neither is found. We point converter at ffmpeg and patch get_prober_name to use ffprobe
    next to ffmpeg or explicit env paths.
    """
    global _PYDUB_FFMPEG_READY
    if _PYDUB_FFMPEG_READY:
        return

    load_dotenv(os.path.join(_SERVICE_DIR, ".env"), override=True)

    env_ff = (
        os.environ.get("ACADOMI_FFMPEG")
        or os.environ.get("FFMPEG_BINARY")
        or os.environ.get("FFMPEG_PATH")
        or ""
    ).strip().strip('"').strip("'")
    env_fp = (
        os.environ.get("ACADOMI_FFPROBE")
        or os.environ.get("FFPROBE_BINARY")
        or os.environ.get("FFPROBE_PATH")
        or ""
    ).strip().strip('"').strip("'")

    ff_path: str | None = None
    fp_path: str | None = None
    if env_ff:
        ff_path, fp_path = _parse_ffmpeg_env_with_variants(env_ff)
    if env_fp:
        fp_only = _parse_ffprobe_env_with_variants(env_fp)
        if fp_only:
            fp_path = fp_only
            if not ff_path:
                ff_path = _same_dir_exe(fp_only, "ffmpeg")

    if not ff_path and not fp_path:
        discovered = _discover_winget_ffmpeg_dir()
        if discovered:
            ff_path, fp_path = _parse_acadomi_ffmpeg_env(discovered)

    if not ff_path:
        w = which("ffmpeg") or shutil.which("ffmpeg")
        ff_path = w if w and os.path.isfile(w) else None
    if not fp_path:
        w = which("ffprobe") or shutil.which("ffprobe")
        fp_path = w if w and os.path.isfile(w) else None
    if ff_path and not fp_path:
        fp_path = _same_dir_exe(ff_path, "ffprobe")
    if fp_path and not ff_path:
        ff_path = _same_dir_exe(fp_path, "ffmpeg")

    if ff_path:
        AudioSegment.converter = ff_path
        AudioSegment.ffmpeg = ff_path

    probe_path = fp_path

    def get_prober_name_patched() -> str:
        if probe_path:
            return probe_path
        return _ORIGINAL_GET_PROBER_NAME()

    pydub_utils.get_prober_name = get_prober_name_patched  # type: ignore[assignment]

    prober = pydub_utils.get_prober_name()
    if not _can_spawn(prober):
        raise RuntimeError(
            f"Cannot run ffprobe ({prober!r}). {_ffmpeg_hint()}"
        )
    if not _can_spawn(AudioSegment.converter):
        raise RuntimeError(
            f"Cannot run ffmpeg ({AudioSegment.converter!r}). {_ffmpeg_hint()}"
        )

    _PYDUB_FFMPEG_READY = True


def _configure_gemini_key(override_key: str | None = None) -> str:
    key = (override_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Either add it to backend/.env (the API forwards it) "
            "or set it in python/services/podcast/.env when running the podcast app alone."
        )
    genai.configure(api_key=key)
    return key


def _strip_json_fences(text: str) -> str:
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.IGNORECASE | re.MULTILINE)
    t = re.sub(r"\s*```\s*$", "", t, flags=re.MULTILINE)
    return t.strip()


# Two-host podcast: Gemini uses these exact speaker ids; gTTS uses different regional endpoints + light pydub shaping.
SPEAKER_FEMALE = "Maya"
SPEAKER_MALE = "Jonah"


def _pitch_shift_semitones(seg: AudioSegment, semitones: float) -> AudioSegment:
    """Slightly lower pitch (gTTS has no male/female toggle; this nudges the male line)."""
    if abs(semitones) < 0.05:
        return seg
    factor = 2.0 ** (semitones / 12.0)
    new_sr = int(seg.frame_rate * factor)
    shifted = seg._spawn(seg.raw_data, overrides={"frame_rate": new_sr})
    return shifted.set_frame_rate(seg.frame_rate)


def _parse_dialogue_json_array(raw: str) -> list[Any]:
    """
    Gemini often appends prose after the JSON array; json.loads then raises Extra data.
    raw_decode from the first '[' parses exactly one JSON value and ignores the rest.
    """
    s = _strip_json_fences(raw)
    dec = json.JSONDecoder()
    idx = s.find("[")
    if idx >= 0:
        try:
            data, _end = dec.raw_decode(s, idx)
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
    # Wrapped object: {"dialogue": [...]}
    idx = s.find("{")
    if idx >= 0:
        try:
            data, _end = dec.raw_decode(s, idx)
            if isinstance(data, dict):
                for key in ("dialogue", "script", "turns", "lines", "podcast", "conversation"):
                    v = data.get(key)
                    if isinstance(v, list):
                        return v
                for v in data.values():
                    if isinstance(v, list) and v and isinstance(v[0], dict):
                        return v
        except json.JSONDecodeError:
            pass
    # Last resort: greedy bracket slice (old behaviour; can fail on strings containing ]).
    m = re.search(r"\[[\s\S]*\]", s)
    if m:
        try:
            data = json.loads(m.group())
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
    raise ValueError("Gemini did not return a usable JSON array of dialogue turns.")


def generate_script_from_groq(prompt: str, api_key: str) -> str:
    import urllib.request
    import json
    
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    
    with urllib.request.urlopen(req, timeout=45) as response:
        res_data = json.loads(response.read().decode("utf-8"))
        return res_data["choices"][0]["message"]["content"]


def generate_script_from_gemini(
    source_text: str,
    *,
    gemini_api_key: str | None = None,
    gemini_model: str | None = None,
) -> list[dict[str, str]]:
    text = source_text.strip()
    if len(text) > 120_000:
        text = text[:120_000] + "\n\n[truncated for model context]"

    prompt = f"""You are a podcast scriptwriter. Convert the following study material into a natural,
two-person conversational podcast between {SPEAKER_FEMALE} (warm, curious host — female voice) and
{SPEAKER_MALE} (clear, thoughtful co-host — male voice).

RULES:
- Do NOT invent facts beyond what the material reasonably supports
- Stay faithful to the meaning of the text
- Friendly, clear, suitable for students; make the banter engaging but grounded in the material
- Alternate speakers ({SPEAKER_FEMALE}, then {SPEAKER_MALE}, then {SPEAKER_FEMALE}, …)
- About 8–14 short turns total
- Only dialogue, no stage directions
- Output ONLY valid JSON (no markdown fences), exactly this shape:
  [{{"speaker":"{SPEAKER_FEMALE}","text":"..."}},{{"speaker":"{SPEAKER_MALE}","text":"..."}}, ...]
- speaker must be exactly "{SPEAKER_FEMALE}" or "{SPEAKER_MALE}"
- text must be plain English suitable for text-to-speech (no emojis, minimal punctuation)
- Do not add any text, labels, or commentary before or after the JSON array

MATERIAL:
---
{text}
---

Your entire reply must be only the JSON array, nothing else:"""

    # 1. Try Groq first
    groq_api_key = (os.environ.get("GROQ_API") or os.environ.get("GROQ_API_KEY") or "").strip()
    if groq_api_key:
        try:
            print("Attempting podcast script generation via Groq...")
            raw = generate_script_from_groq(prompt, groq_api_key)
            data = _parse_dialogue_json_array(raw)
            lines: list[dict[str, str]] = []
            for item in data:
                if not isinstance(item, dict):
                    continue
                sp = str(item.get("speaker", "")).strip()
                tx = str(item.get("text", "")).strip()
                if sp not in (SPEAKER_FEMALE, SPEAKER_MALE) or not tx:
                    continue
                lines.append({"speaker": sp, "text": tx})
            if len(lines) >= 2:
                print("Podcast script successfully generated via Groq!")
                return lines
            else:
                print("Groq generated less than 2 lines. Falling back to Gemini...")
        except Exception as err:
            print(f"Groq podcast script generation failed: {err}. Falling back to Gemini...")
    else:
        print("No GROQ_API or GROQ_API_KEY environment variable configured for podcast service.")

    # 2. Fallback to Gemini
    _configure_gemini_key(gemini_api_key)

    primary = (gemini_model or "").strip() or os.environ.get("GEMINI_MODEL", "").strip() or "gemini-2.5-flash"
    candidates: list[str] = []
    for name in (primary, "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash"):
        name = name.strip()
        if name and name not in candidates:
            candidates.append(name)

    last_error: Exception | None = None
    response = None
    for model_name in candidates:
        model = genai.GenerativeModel(model_name)
        try:
            response = model.generate_content(prompt)
            break
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            # Fallback only on transient/service/not found errors (e.g. 503, 429, resource exhausted, 404).
            transient = "503" in msg or "Service Unavailable" in msg or "RESOURCE_EXHAUSTED" in msg or "429" in msg or "404" in msg or "not found" in msg.lower()
            if not transient:
                raise
            last_error = exc

    if response is None:
        raise last_error or RuntimeError("All Gemini podcast models failed for this request.")

    raw = (response.text or "").strip()
    data = _parse_dialogue_json_array(raw)

    lines: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        sp = str(item.get("speaker", "")).strip()
        tx = str(item.get("text", "")).strip()
        if sp not in (SPEAKER_FEMALE, SPEAKER_MALE) or not tx:
            continue
        lines.append({"speaker": sp, "text": tx})

    if len(lines) < 2:
        raise ValueError("Not enough dialogue lines from Gemini; try again or shorten the source.")

    return lines


def create_podcast_mp3_bytes(script: list[dict[str, str]]) -> tuple[bytes, int]:
    """Returns (mp3_bytes, approximate_duration_ms)."""
    ensure_pydub_ffmpeg()
    segments: list[AudioSegment] = []
    tmpdir = tempfile.mkdtemp(prefix="acadomi_pod_")
    try:
        for i, turn in enumerate(script):
            sp = turn["speaker"]
            # Regional Google Translate TTS: UK (often brighter) vs US (typically lower / distinct from co.uk).
            tld = "co.uk" if sp == SPEAKER_FEMALE else "us"
            tts = gTTS(text=turn["text"], lang="en", tld=tld, slow=False)
            path = os.path.join(tmpdir, f"line_{i}.mp3")
            tts.save(path)
            seg = AudioSegment.from_mp3(path)
            if sp == SPEAKER_MALE:
                seg = _pitch_shift_semitones(seg, -1.25)
            segments.append(seg)
            segments.append(AudioSegment.silent(duration=400))
        if not segments:
            raise ValueError("No audio segments")
        # drop trailing silence
        if segments and len(segments) > 1:
            segments = segments[:-1]
        combined = segments[0]
        for s in segments[1:]:
            combined += s
        out = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        out.close()
        try:
            combined.export(out.name, format="mp3", bitrate="64k")
            with open(out.name, "rb") as f:
                data = f.read()
        finally:
            if os.path.exists(out.name):
                os.remove(out.name)
        duration_ms = int(combined.duration_seconds * 1000)
        return data, duration_ms
    finally:
        for name in os.listdir(tmpdir):
            try:
                os.remove(os.path.join(tmpdir, name))
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def build_podcast_payload(
    source_text: str,
    *,
    gemini_api_key: str | None = None,
    gemini_model: str | None = None,
) -> dict[str, Any]:
    # Fail fast before Gemini (no wasted API calls if audio pipeline cannot run).
    ensure_pydub_ffmpeg()
    script = generate_script_from_gemini(
        source_text,
        gemini_api_key=gemini_api_key,
        gemini_model=gemini_model,
    )
    audio_bytes, duration_ms = create_podcast_mp3_bytes(script)
    return {
        "script": script,
        "mimeType": "audio/mpeg",
        "durationMs": duration_ms,
        "audioBase64": base64.b64encode(audio_bytes).decode("ascii"),
    }
