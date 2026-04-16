"""
Acadomi tutor microservice: Edge TTS (Microsoft neural voices) + MediaPipe focus (called by Node only).
Default voice: en-US-ChristopherNeural (male teaching tone). Slides and Q&A use Gemini on the Express API.
"""

from __future__ import annotations

import base64
import os
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

import cv2
import edge_tts
import numpy as np
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from focus_tracker import FocusTracker, mediapipe_import_ok

_here = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_here, ".env"))
load_dotenv()

# Microsoft Azure neural voice (free via edge-tts). Override with TUTOR_TTS_VOICE in .env.
DEFAULT_TUTOR_TTS_VOICE = "en-US-ChristopherNeural"

app = FastAPI(title="Acadomi Tutor Service", version="1.0.0")

# FaceMesh must be created and used on the SAME thread. FastAPI runs each sync route on a
# different thread-pool worker, so we funnel all tracker work through one dedicated thread.
_trackers: dict[str, FocusTracker] = {}
_face_exec = ThreadPoolExecutor(max_workers=1, thread_name_prefix="acadomi_focus")


class TtsBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)


class FocusResetBody(BaseModel):
    session_key: str = Field(..., min_length=8, max_length=64)


class FocusAnalyzeBody(BaseModel):
    session_key: str = Field(..., min_length=8, max_length=64)
    image_base64: str = Field(..., min_length=32)


def _to_api_focus(d: dict) -> dict:
    """Map tracker dict to JSON-friendly camelCase for the frontend."""
    fv = d.get("focus_val")
    out: dict = {
        "faceFound": bool(d.get("face_found", False)),
        "focusVal": None if fv is None else int(fv),
        "status": str(d.get("status", "UNKNOWN")),
        "alarm": bool(d.get("alarm", False)),
        "isCalibrated": bool(d.get("is_calibrated", False)),
    }
    optional = [
        ("pitch", "pitch"),
        ("yaw", "yaw"),
        ("roll", "roll"),
        ("delta_pitch", "deltaPitch"),
        ("delta_yaw", "deltaYaw"),
        ("baseline_pitch", "baselinePitch"),
        ("baseline_yaw", "baselineYaw"),
        ("baseline_ear", "baselineEar"),
        ("ear", "ear"),
        ("delta_ear", "deltaEar"),
        ("gaze_variance", "gazeVariance"),
        ("time_since_blink_sec", "timeSinceBlinkSec"),
        ("time_since_gaze_move_sec", "timeSinceGazeMoveSec"),
        ("pose_score", "poseScore"),
        ("eye_score", "eyeScore"),
        ("gaze_score", "gazeScore"),
        ("raw_focus", "rawFocus"),
        ("calibration_progress", "calibrationProgress"),
    ]
    for snake, camel in optional:
        if snake in d and d[snake] is not None:
            out[camel] = d[snake]
    if "stare_alarm" in d:
        out["stareAlarm"] = bool(d["stare_alarm"])
    return out


def _focus_reset_worker(key: str) -> None:
    _trackers[key] = FocusTracker()


def _focus_analyze_worker(key: str, raw: bytes) -> dict:
    if key not in _trackers:
        _trackers[key] = FocusTracker()
    tracker = _trackers[key]
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return {
            "face_found": False,
            "focus_val": 0,
            "status": "BAD FRAME",
            "alarm": False,
            "is_calibrated": tracker.is_calibrated,
        }
    return tracker.process_frame(frame)


@app.get("/health")
def health() -> dict:
    ok, detail = mediapipe_import_ok()
    voice = (os.environ.get("TUTOR_TTS_VOICE") or DEFAULT_TUTOR_TTS_VOICE).strip()
    return {
        "ok": True,
        "service": "acadomi-tutor",
        "port": int(os.environ.get("TUTOR_PORT", "5002")),
        "mediapipe": {"ok": ok, "detail": detail},
        "tts": {"engine": "edge-tts", "voice": voice},
    }


@app.post("/tts")
async def tts(body: TtsBody) -> dict:
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    voice = (os.environ.get("TUTOR_TTS_VOICE") or DEFAULT_TUTOR_TTS_VOICE).strip()
    try:
        communicate = edge_tts.Communicate(text, voice)
        fd, path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        try:
            await communicate.save(path)
            with open(path, "rb") as f:
                raw = f.read()
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        if not raw:
            raise RuntimeError("edge-tts produced no audio")
        return {
            "mimeType": "audio/mpeg",
            "audioBase64": base64.b64encode(raw).decode("utf-8"),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/focus/reset")
def focus_reset(body: FocusResetBody) -> dict:
    key = body.session_key.strip()
    try:
        fut = _face_exec.submit(_focus_reset_worker, key)
        fut.result(timeout=120)
    except ImportError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except FuturesTimeoutError:
        raise HTTPException(status_code=504, detail="Focus reset timed out.") from None
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"focus reset failed: {e}") from e
    return {"ok": True}


@app.post("/focus/analyze")
def focus_analyze(body: FocusAnalyzeBody) -> dict:
    key = body.session_key.strip()
    try:
        raw = base64.b64decode(body.image_base64, validate=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail="invalid image_base64") from e

    try:
        fut = _face_exec.submit(_focus_analyze_worker, key, raw)
        result = fut.result(timeout=45)
    except FuturesTimeoutError:
        raise HTTPException(status_code=504, detail="Focus analysis timed out.") from None
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"focus processing failed: {e}") from e
    return _to_api_focus(result)


if __name__ == "__main__":
    port = int(os.environ.get("TUTOR_PORT", "5002"))
    uvicorn.run(app, host="127.0.0.1", port=port)
