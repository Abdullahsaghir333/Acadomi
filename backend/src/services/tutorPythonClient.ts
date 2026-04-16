/** edge-tts (Microsoft neural, default Christopher) + focus — Acadomi Python tutor service (`python/services/tutor`). */

export function tutorPyBase(): string {
  return (process.env.TUTOR_SERVICE_URL?.trim() || "http://127.0.0.1:5002").replace(/\/$/, "");
}

export async function tutorPyTts(text: string): Promise<{ mimeType: string; audioBase64: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${tutorPyBase()}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    const data = (await res.json()) as {
      mimeType?: string;
      audioBase64?: string;
      error?: string;
      detail?: unknown;
    };
    if (!res.ok) {
      const detail =
        typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data.detail)
            ? JSON.stringify(data.detail)
            : data.error;
      throw new Error(detail || "Tutor TTS service error");
    }
    if (!data.audioBase64) {
      throw new Error("Tutor TTS response missing audio");
    }
    return { mimeType: data.mimeType || "audio/mpeg", audioBase64: data.audioBase64 };
  } finally {
    clearTimeout(timer);
  }
}
