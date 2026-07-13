import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

type GeminiModelInvoker<T> = (model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>) => Promise<T>;

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  return apiKey;
}

/**
 * Run a Gemini call with automatic model fallback.
 *
 * Order:
 * - Primary: GEMINI_MODEL or gemini-2.5-flash
 * - Fallbacks: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash, gemini-1.5-flash
 *
 * We only fall back on transient GoogleGenerativeAI fetch errors (503/429).
 */
async function runWithGeminiFallback<T>(invoke: GeminiModelInvoker<T>): Promise<T> {
  const apiKey = getGeminiApiKey();
  const primary = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const candidates = [
    primary,
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ].filter((value, index, self) => value && self.indexOf(value) === index);

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: unknown;

  for (const modelName of candidates) {
    const model = genAI.getGenerativeModel({ model: modelName });
    try {
      return await invoke(model);
    } catch (err: any) {
      const status = typeof err?.status === "number" ? err.status : undefined;
      const name = err?.name ?? err?.constructor?.name;
      const isGoogleFetchError =
        name === "GoogleGenerativeAIFetchError" || typeof status === "number";
      const isTransient = status === 503 || status === 429;

      if (!isGoogleFetchError || !isTransient) {
        throw err;
      }

      lastError = err;
      // Try next candidate in the list.
    }
  }

  throw lastError ?? new Error("All Gemini models failed for this request.");
}

async function runTextLlm(prompt: string): Promise<string> {
  const groqApiKey = process.env.GROQ_API?.trim();
  if (groqApiKey) {
    try {
      const groq = new Groq({ apiKey: groqApiKey });
      const response = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
      });
      const text = response.choices[0]?.message?.content;
      if (text && text.trim()) {
        return text.trim();
      }
    } catch (err) {
      console.error("Groq text completion failed, falling back to Gemini:", err);
    }
  }

  // Fallback to Gemini
  const result = await runWithGeminiFallback((model) => model.generateContent(prompt));
  return result.response.text().trim();
}

async function runImageExtractionGroq(buffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.GROQ_API?.trim();
  if (!apiKey) throw new Error("GROQ_API not configured");

  const groq = new Groq({ apiKey });
  const cleanMime = (mimeType || "image/png").split(";")[0].trim();
  const base64Data = buffer.toString("base64");
  const dataUrl = `data:${cleanMime};base64,${base64Data}`;

  const response = await groq.chat.completions.create({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract all readable text from this image with maximum accuracy. If text is small, rotated, or low contrast, still try to read it. Return only plain text in English.",
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
    model: "llama-3.2-11b-vision-preview",
  });
  return response.choices[0]?.message?.content || "";
}

async function runAudioTranscriptionGroq(buffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.GROQ_API?.trim();
  if (!apiKey) throw new Error("GROQ_API not configured");

  const groq = new Groq({ apiKey });
  const file = new (globalThis as any).File([buffer], "audio.webm", { type: mimeType || "audio/webm" });
  const transcription = await groq.audio.transcriptions.create({
    file: file,
    model: "whisper-large-v3",
    language: "en",
  });
  return transcription.text;
}

export async function extractTextFromImage(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    const text = await runImageExtractionGroq(buffer, mimeType);
    if (text && text.trim()) {
      return text.trim();
    }
  } catch (err) {
    console.error("Groq image extraction failed, falling back to Gemini:", err);
  }

  const prompt =
    "Extract all readable text from this image with maximum accuracy. If text is small, rotated, or low contrast, still try to read it. Return only plain text in English.";
  const cleanMime = (mimeType || "image/png").split(";")[0].trim();
  const result = await runWithGeminiFallback((model) =>
    model.generateContent([
      { text: prompt },
      {
        inlineData: {
          mimeType: cleanMime,
          data: buffer.toString("base64"),
        },
      },
    ]),
  );
  const text = result.response.text();
  return text.trim();
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    const text = await runAudioTranscriptionGroq(buffer, mimeType);
    if (text && text.trim()) {
      return text.trim();
    }
  } catch (err) {
    console.error("Groq audio transcription failed, falling back to Gemini:", err);
  }

  const prompt =
    "Transcribe this audio with high accuracy. Handle background noise and accents. Return only the clean transcription in English.";
  const cleanMime = (mimeType || "audio/webm").split(";")[0].trim();
  const result = await runWithGeminiFallback((model) =>
    model.generateContent([
      { text: prompt },
      {
        inlineData: {
          mimeType: cleanMime,
          data: buffer.toString("base64"),
        },
      },
    ]),
  );
  return result.response.text().trim();
}

/**
 * Combine extracted material with the learner's instructions into structured study notes (markdown).
 */
export async function synthesizeLearningNotes(
  extractedText: string,
  userPrompt: string,
): Promise<string> {
  const instructions = userPrompt.trim() || "No extra instructions.";
  const body = `You are Acadomi, an assistant for higher-education learners.

User instructions (prioritize these if they ask for something specific):
${instructions}

Source material (extracted from PDF, images, and/or audio):
---
${extractedText.slice(0, 120000)}
---

Produce a clear, professional response in markdown with:
1. **Summary** — short overview
2. **Key concepts** — bullet list
3. **Study tips** — 2–4 practical next steps

Keep tone academic but approachable. If the source is empty or unusable, say so briefly.`;

  return runTextLlm(body);
}

export type RoleReversalVisualHints = {
  radar?: { label: string; value: number }[];
  barCompare?: { label: string; you: number; ideal: number }[];
};

export type RoleReversalEvaluation = {
  scoreClarity: number;
  scoreConcepts: number;
  scoreFluency: number;
  totalScore: number;
  feedback: string;
  topicUnderstanding: string;
  weakness: string;
  strength: string;
  visualHints: RoleReversalVisualHints;
};

function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("No JSON object in model output");
  }
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1)) as unknown;
      }
    }
  }
  throw new Error("Unterminated JSON object in model output");
}

function num(v: unknown): number {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function normalizeEvaluation(raw: Record<string, unknown>): RoleReversalEvaluation {
  const scoreClarity = num(raw.scoreClarity ?? raw.score_clarity);
  const scoreConcepts = num(raw.scoreConcepts ?? raw.score_concepts);
  const scoreFluency = num(raw.scoreFluency ?? raw.score_fluency);
  let totalScore = num(raw.totalScore ?? raw.total_score);
  if (totalScore === 0 && (scoreClarity + scoreConcepts + scoreFluency) > 0) {
    totalScore = Math.round((scoreClarity + scoreConcepts + scoreFluency) / 3);
  }
  const visualRaw = raw.visualHints ?? raw.visual_hints;
  let visualHints: RoleReversalVisualHints = {};
  if (visualRaw && typeof visualRaw === "object" && !Array.isArray(visualRaw)) {
    const vr = visualRaw as Record<string, unknown>;
    const radar = Array.isArray(vr.radar)
      ? (vr.radar as unknown[])
        .map((r: unknown) => {
          if (!r || typeof r !== "object") return null;
          const o = r as Record<string, unknown>;
          return {
            label: str(o.label),
            value: num(o.value),
          };
        })
        .filter((x): x is { label: string; value: number } => x !== null && x.label.length > 0)
      : undefined;
    const barRaw = vr.barCompare ?? vr.bar_compare;
    const barCompare = Array.isArray(barRaw)
      ? (barRaw as unknown[])
        .map((r: unknown) => {
          if (!r || typeof r !== "object") return null;
          const o = r as Record<string, unknown>;
          return {
            label: str(o.label),
            you: num(o.you),
            ideal: num(o.ideal ?? o.target ?? 100),
          };
        })
        .filter((x): x is { label: string; you: number; ideal: number } => x !== null && x.label.length > 0)
      : undefined;
    visualHints = { ...(radar?.length ? { radar } : {}), ...(barCompare?.length ? { barCompare } : {}) };
  }

  return {
    scoreClarity,
    scoreConcepts,
    scoreFluency,
    totalScore,
    feedback: str(raw.feedback),
    topicUnderstanding: str(raw.topicUnderstanding ?? raw.topic_understanding),
    weakness: str(raw.weakness ?? raw.weaknesses),
    strength: str(raw.strength ?? raw.strengths),
    visualHints,
  };
}

/**
 * Compare the learner's spoken explanation (transcript) to reference material for "role reversal" teaching.
 */
export async function evaluateRoleReversalTeaching(params: {
  topic: string;
  referenceMaterial: string;
  studentTranscript: string;
}): Promise<RoleReversalEvaluation> {
  const topic = params.topic.trim();
  const ref = params.referenceMaterial.trim().slice(0, 100_000);
  const student = params.studentTranscript.trim().slice(0, 50_000);

  const prompt = `You are an expert tutor evaluating a student's verbal explanation (transcribed) in a "role reversal" exercise: they teach YOU the topic using their own words, compared to reference notes.

Output ONLY valid JSON (no markdown fences, no commentary before or after). Use exactly these camelCase keys:

{
  "scoreClarity": <0-100 how clear and structured the explanation is>,
  "scoreConcepts": <0-100 accuracy and coverage of key concepts vs reference>,
  "scoreFluency": <0-100 coherence and appropriate terminology>,
  "totalScore": <0-100 overall, can be average of the three rounded>,
  "feedback": "<2-4 sentences: encouraging, specific, actionable. Plain text or light markdown allowed.>",
  "topicUnderstanding": "<1-3 sentences on how well they grasp the core idea>",
  "weakness": "<main gap or misconception, if any; else say what could deepen>",
  "strength": "<what they did well>",
  "visualHints": {
    "radar": [
      {"label": "Clarity", "value": <0-100>},
      {"label": "Concepts", "value": <0-100>},
      {"label": "Fluency", "value": <0-100>}
    ],
    "barCompare": [
      {"label": "Clarity", "you": <0-100>, "ideal": 85},
      {"label": "Concepts", "you": <0-100>, "ideal": 90},
      {"label": "Fluency", "you": <0-100>, "ideal": 80}
    ]
  }
}

Topic the student was teaching: ${topic}

Reference material (ground truth for concepts):
---
${ref || "(empty — score conservatively based on general knowledge of the topic)"}
---

Student's spoken explanation (transcription):
---
${student}
---

Be fair: reward correct ideas; note gaps vs reference. JSON only:`;

  const rawText = await runTextLlm(prompt);
  let parsed: unknown;
  try {
    parsed = extractFirstJsonObject(rawText);
  } catch {
    throw new Error("Model did not return parseable JSON for evaluation");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Evaluation JSON was not an object");
  }
  return normalizeEvaluation(parsed as Record<string, unknown>);
}

export type TutorSlideDraft = {
  title: string;
  points: string[];
  script: string;
};

function normalizeTutorSlides(raw: unknown): TutorSlideDraft[] {
  if (!Array.isArray(raw)) {
    throw new Error("slides must be an array");
  }
  const out: TutorSlideDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = str(o.title).trim();
    const script = str(o.script).trim();
    const pointsRaw = o.points;
    const points = Array.isArray(pointsRaw)
      ? pointsRaw.map((p) => str(p).trim()).filter((p) => p.length > 0)
      : [];
    if (!title || !script || points.length === 0) continue;
    out.push({ title, points, script });
  }
  if (out.length < 3) {
    throw new Error("Model returned too few valid slides (need at least 3).");
  }
  if (out.length > 16) {
    return out.slice(0, 16);
  }
  return out;
}

/**
 * Build slide deck + per-slide spoken scripts for the Meet-style AI tutor (Gemini only).
 */
export async function generateTutorSlidesAndScripts(
  material: string,
  topicFocus?: string,
): Promise<TutorSlideDraft[]> {
  const focus = topicFocus?.trim()
    ? `Learner focus / topic to emphasize (still cover the rest at a high level):\n${topicFocus.trim()}\n\n`
    : "";
  const body = `You are an expert curriculum designer. Turn the study material into slides for a live AI tutor session.
Each slide needs: a short title, 2–5 bullet points, and a "script" — exactly what the tutor should SAY aloud (conversational, clear, no markdown, roughly 40–90 words).

${focus}Material:
---
${material.trim().slice(0, 100_000)}
---

Output ONLY valid JSON (no markdown fences, no commentary) with exactly this shape:
{"slides":[{"title":"string","points":["string"],"script":"string"}]}

Rules:
- Produce 6–14 slides in logical teaching order (intro → concepts → recap).
- Bullets are concise; the script expands and teaches them.
- Stay faithful to the material; do not invent facts not supported by the text.`;

  const rawText = await runTextLlm(body);
  let parsed: unknown;
  try {
    parsed = extractFirstJsonObject(rawText);
  } catch {
    throw new Error("Model did not return parseable JSON for tutor slides");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Tutor slides JSON was not an object");
  }
  const slidesRaw = (parsed as Record<string, unknown>).slides;
  return normalizeTutorSlides(slidesRaw);
}

/**
 * Short spoken-style answer during the session (Gemini only).
 */
export async function answerTutorQuestion(params: {
  question: string;
  slideTitle: string;
  slidePoints: string[];
  slideScript: string;
  materialExcerpt: string;
}): Promise<string> {
  const q = params.question.trim().slice(0, 8000);
  const body = `You are a live tutor in a video-style session. The student asked a question during this slide.
Answer clearly in 2–6 short sentences. No markdown headings. If the question is unclear, ask one brief clarifying question.

Slide title: ${params.slideTitle}
Slide bullets: ${params.slidePoints.join(" | ")}
What you were saying on this slide: ${params.slideScript.trim().slice(0, 4000)}

Reference material (for accuracy):
---
${params.materialExcerpt.trim().slice(0, 24_000)}
---

Student question: ${q}`;

  return runTextLlm(body);
}

/**
 * One-slide "explain like I'm five" spoken script (Gemini only). Same facts, simpler words.
 */
export async function generateTutorSlideEli5Script(params: {
  slideTitle: string;
  slidePoints: string[];
  slideScript: string;
  materialExcerpt: string;
}): Promise<string> {
  const body = `The learner pressed "Explain like I'm five" for ONE slide. Write a single script the tutor will read aloud.
Rules:
- Use very simple words and short sentences (like talking to a bright 5-year-old). Stay warm, not babyish to an adult.
- Keep the same ideas and facts as the slide; do not invent or change meaning.
- About 55–130 words. Plain text only: no markdown, no bullet symbols in speech (smooth spoken sentences).
- Output ONLY the script, nothing else.

Slide title: ${params.slideTitle}
Bullets: ${params.slidePoints.join(" | ")}
Current tutor script (rewrite simpler):
${params.slideScript.trim().slice(0, 4500)}

Reference material (for accuracy only):
---
${params.materialExcerpt.trim().slice(0, 14_000)}
---`;

  const rawText = await runTextLlm(body);
  return rawText.slice(0, 6000);
}

function stripOuterMarkdownFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (m) return m[1].trim();
  return t;
}

/**
 * Smart cheat sheet: dense, scannable markdown for one topic from learner material.
 */
export async function generateSmartCheatSheetMarkdown(
  material: string,
  topic: string,
): Promise<string> {
  const excerpt = material.trim().slice(0, 100_000);
  const focus = topic.trim().slice(0, 500);

  const body = `You are Acadomi. Build a **smart cheat sheet** in Markdown for ONE topic the learner chose.

Learner topic (center everything on this):
${focus}

Source material (notes / extracted text from their upload):
---
${excerpt}
---

Strict output rules (follow all):

1. **Prioritize functional syntax and logic** — Focus exclusively on actionable "how-to" steps, core formulas, or operational workflows. Strictly omit long-form definitions or theoretical fluff.

2. **Enforce visual hierarchy and scannability** — Organize all information into distinct, categorized blocks with **bold** section headers (use \`##\` or \`**Header**\` lines). Use Markdown **tables** for quick-reference comparisons or key-value pairs where helpful.

3. **Use realistic contextual examples** — Provide concrete, real-world instances of the concepts in action. Do not use generic brackets or abstract placeholders like [example] or "foo/bar".

4. **Limit scope for high-density retrieval** — Keep the sheet concise enough to fit a single printed page. Put high-frequency essentials at the top; troubleshooting or rare edge cases at the bottom.

Output **only** valid Markdown for the cheat sheet. No preamble, no closing commentary, no code fences wrapping the whole document.`;

  const raw = await runTextLlm(body);
  return stripOuterMarkdownFence(raw).trim().slice(0, 120_000);
}

/**
 * Short spoken recap expanding a bookmarked tutor subtitle line (plain text for TTS).
 */
export async function generateBookmarkRecapScript(params: {
  bookmarkLine: string;
  materialExcerpt: string;
  slideTitle?: string;
}): Promise<string> {
  const slide = params.slideTitle?.trim() ? `Slide context: ${params.slideTitle.trim().slice(0, 200)}\n` : "";
  const body = `You are Acadomi. The learner bookmarked this passage from their AI tutor:
"${params.bookmarkLine.trim().slice(0, 14_000)}"

${slide}Course material (for accuracy — stay consistent with it):
---
${params.materialExcerpt.trim().slice(0, 48_000)}
---

Write a **short audio recap** they can listen to (about 55–130 words). Rules:
- Plain sentences only — no markdown, bullets, or stage directions.
- Expand and clarify the bookmarked idea using the material; do not invent facts.
- Warm, clear teaching tone; one cohesive mini-explanation.

Output ONLY the spoken script, nothing else.`;

  const rawText = await runTextLlm(body);
  return rawText.slice(0, 4000);
}

export type BookmarkChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Answer a follow-up question about a bookmarked concept (text for UI).
 */
export async function answerBookmarkQuestion(params: {
  bookmarkLine: string;
  materialExcerpt: string;
  message: string;
  history: BookmarkChatTurn[];
}): Promise<string> {
  const hist = params.history
    .slice(-8)
    .map((t) => `${t.role === "user" ? "Learner" : "Tutor"}: ${t.content}`)
    .join("\n");
  const body = `You are Acadomi, a patient tutor. The learner saved this bookmark from their lesson:
"${params.bookmarkLine.trim().slice(0, 14_000)}"

Material from their upload (use for accuracy):
---
${params.materialExcerpt.trim().slice(0, 56_000)}
---

Prior conversation (if any):
${hist || "(none)"}

Learner's new question:
${params.message.trim().slice(0, 4000)}

Reply with a clear, helpful answer (markdown allowed for formulas/code if needed). Stay grounded in the material; if the question goes beyond it, say what you can infer and what is unknown. Keep it focused — roughly 80–350 words unless they ask for depth.`;

  const rawText = await runTextLlm(body);
  return rawText.slice(0, 12_000);
}
