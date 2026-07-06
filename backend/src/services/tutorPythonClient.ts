/** edge-tts (Microsoft neural, default Christopher) + focus — Acadomi Python tutor service (`python/services/tutor`). */

const ttsCache = new Map<string, { mimeType: string; audioBase64: string }>();
const MAX_CACHE_SIZE = 200;

export function tutorPyBase(): string {
  return (process.env.TUTOR_SERVICE_URL?.trim() || "http://127.0.0.1:5002").replace(/\/$/, "");
}

export async function tutorPyTts(text: string): Promise<{ mimeType: string; audioBase64: string }> {
  const cacheKey = text.trim();
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey)!;
  }

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
    const result = { mimeType: data.mimeType || "audio/mpeg", audioBase64: data.audioBase64 };

    // Evict oldest cache entries if size limit exceeded
    if (ttsCache.size >= MAX_CACHE_SIZE) {
      const firstKey = ttsCache.keys().next().value;
      if (firstKey) ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, result);

    return result;
  } finally {
    clearTimeout(timer);
  }
}

