# Acadomi — Podcast generator (Python)

Generates a two-speaker script with **Google Gemini** and audio with **gTTS** + **pydub**.

**Voices:** The hosts are **Maya** (female) and **Jonah** (male). gTTS has no gender selector; we use **UK English** (`tld=co.uk`) for Maya and **US English** (`tld=us`) for Jonah, then a light **pydub pitch shift** on Jonah’s lines so the two reads are easier to tell apart.

## Prerequisites

- **Python 3.12.x** (see `.python-version`; use [pyenv](https://github.com/pyenv/pyenv) / [pyenv-win](https://github.com/pyenv-win/pyenv-win)).  
  On Windows, plain `python` may be **3.13+**; create the venv with `py -3.12 -m venv .venv` so it matches this project.  
  If you stay on **3.13 or newer**, `requirements.txt` pulls in **`audioop-lts`** automatically (stdlib `audioop` was removed; without it, pydub fails with `No module named 'audioop'` / `pyaudioop`).
- **ffmpeg** and **ffprobe** (same install; both must be runnable). Add the folder that contains `ffmpeg.exe` to **PATH**, then **restart the terminal** (and your IDE if it launched Python).  
  - Windows: `winget install ffmpeg` or `choco install ffmpeg`, or download a **full** build from [ffmpeg.org](https://ffmpeg.org/) (not ffmpeg.exe alone).  
  - If PATH still fails, set **`ACADOMI_FFMPEG`** in `.env` to **`ffmpeg.exe`** or that **`bin`** folder. In `.env` use **forward slashes** (`C:/Users/...`) so python-dotenv does not treat `\\U` as an escape.  
  - With no `ACADOMI_FFMPEG`, Windows may **auto-detect** FFmpeg under `%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages` (first tree that contains both `ffmpeg.exe` and `ffprobe.exe`).  
  - Check **`GET http://127.0.0.1:5001/health`** — the `ffmpeg` field shows whether the binaries run. **Gemini is only called after** FFmpeg checks pass (no wasted API usage).
- **`GEMINI_API_KEY` in `backend/.env`** when you use the Acadomi API (the server forwards it to this service). Put the key in **this folder’s `.env` only** if you run `python app.py` standalone without the Node proxy.

## Setup

```bash
cd python/services/podcast
# Prefer 3.12 (Windows launcher):
py -3.12 -m venv .venv
# or: python3.12 -m venv .venv   # macOS/Linux if installed
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
```

Copy `.env.example` to `.env` only if you need local overrides (e.g. standalone runs); otherwise rely on `backend/.env` via the API.

## Run

```bash
python app.py
```

Default URL: **http://127.0.0.1:5001**

The Node **Express** API calls this service (`PODCAST_SERVICE_URL` in `backend/.env`). You normally do **not** expose this port publicly in production without authentication.
