import { Router, type Response } from "express";
import mongoose from "mongoose";

import { ConceptBookmark, bookmarkLineFingerprint, type ConceptBookmarkLean } from "../models/ConceptBookmark.js";
import { Upload, type UploadDoc } from "../models/Upload.js";
import { TutorGroupSession } from "../models/TutorGroupSession.js";
import { authMiddleware, type AuthedRequest } from "../middleware/auth.js";
import {
  answerBookmarkQuestion,
  generateBookmarkRecapScript,
  type BookmarkChatTurn,
} from "../services/gemini.js";
import { tutorPyTts } from "../services/tutorPythonClient.js";

const router = Router();
const MAX_BOOKMARKS_PER_USER = 400;

function serializeBookmark(b: ConceptBookmarkLean) {
  return {
    id: b._id.toString(),
    sourceUploadId: b.sourceUploadId.toString(),
    lineText: b.lineText,
    tutorSessionId: b.tutorSessionId?.toString() ?? null,
    slideIndex: b.slideIndex,
    slideTitle: b.slideTitle,
    subtitleSource: b.subtitleSource,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

/** Uploads that have at least one bookmark, with counts. */
router.get("/materials", authMiddleware, async (req: AuthedRequest, res: Response) => {
  try {
    const groups = await ConceptBookmark.aggregate<{
      _id: mongoose.Types.ObjectId;
      bookmarkCount: number;
      lastBookmarkAt: Date;
    }>([
      { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
      {
        $group: {
          _id: "$sourceUploadId",
          bookmarkCount: { $sum: 1 },
          lastBookmarkAt: { $max: "$createdAt" },
        },
      },
      { $sort: { lastBookmarkAt: -1 } },
    ]);

    const uploadIds = groups.map((g) => g._id);
    const uploads = await Upload.find({
      _id: { $in: uploadIds },
    })
      .select("_id title kind status")
      .lean<Pick<UploadDoc, "_id" | "title" | "kind" | "status">[]>();

    const byId = new Map(uploads.map((u) => [u._id.toString(), u]));
    const materials = groups
      .map((g) => {
        const u = byId.get(g._id.toString());
        if (!u || u.status !== "completed") return null;
        return {
          uploadId: g._id.toString(),
          title: u.title,
          kind: u.kind,
          bookmarkCount: g.bookmarkCount,
          lastBookmarkAt: g.lastBookmarkAt,
        };
      })
      .filter(Boolean);

    return res.json({ materials, maxBookmarks: MAX_BOOKMARKS_PER_USER });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not list bookmarked materials." });
  }
});

router.get("/", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const uploadId = typeof req.query.uploadId === "string" ? req.query.uploadId.trim() : "";
  if (!uploadId || !mongoose.Types.ObjectId.isValid(uploadId)) {
    return res.status(400).json({ error: "uploadId query is required." });
  }

  try {
    const upload = await Upload.findOne({
      _id: uploadId,
      status: "completed",
    }).lean();
    if (!upload) {
      return res.status(404).json({ error: "Upload not found or not completed." });
    }

    const list = await ConceptBookmark.find({ userId: req.userId, sourceUploadId: uploadId })
      .sort({ createdAt: -1 })
      .lean<ConceptBookmarkLean[]>();

    return res.json({ bookmarks: list.map(serializeBookmark) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not list bookmarks." });
  }
});

router.post("/", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const sourceUploadId =
    typeof req.body?.sourceUploadId === "string" ? req.body.sourceUploadId.trim() : "";
  const lineText = typeof req.body?.lineText === "string" ? req.body.lineText.trim() : "";
  const tutorSessionIdRaw =
    typeof req.body?.tutorSessionId === "string" ? req.body.tutorSessionId.trim() : "";
  const slideTitle = typeof req.body?.slideTitle === "string" ? req.body.slideTitle.trim().slice(0, 300) : "";
  const subtitleSource =
    req.body?.subtitleSource === "qa_answer" ? "qa_answer" : "narration";
  const slideIndexRaw = req.body?.slideIndex;
  const slideIndex =
    typeof slideIndexRaw === "number" && Number.isFinite(slideIndexRaw) && slideIndexRaw >= 0
      ? Math.floor(slideIndexRaw)
      : typeof slideIndexRaw === "string" && /^\d+$/.test(slideIndexRaw)
        ? Number.parseInt(slideIndexRaw, 10)
        : null;

  if (!sourceUploadId || !mongoose.Types.ObjectId.isValid(sourceUploadId)) {
    return res.status(400).json({ error: "Valid sourceUploadId is required." });
  }
  if (!lineText || lineText.length > 16_000) {
    return res.status(400).json({ error: "lineText is required (max 16000 characters)." });
  }

  let tutorSessionId: mongoose.Types.ObjectId | null = null;
  if (tutorSessionIdRaw) {
    if (!mongoose.Types.ObjectId.isValid(tutorSessionIdRaw)) {
      return res.status(400).json({ error: "Invalid tutorSessionId." });
    }
    tutorSessionId = new mongoose.Types.ObjectId(tutorSessionIdRaw);
  }

  try {
    const upload = await Upload.findOne({
      _id: sourceUploadId,
      status: "completed",
    });
    if (!upload) {
      return res.status(404).json({ error: "Upload not found or not completed." });
    }

    let hasAccess = upload.userId.toString() === req.userId;
    if (!hasAccess && tutorSessionId) {
      const group = await TutorGroupSession.findOne({
        tutorSessionId,
        $or: [
          { hostUserId: req.userId },
          { inviteeUserIds: req.userId },
          { acceptedUserIds: req.userId },
        ],
      }).lean();
      if (group) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied to this material." });
    }

    const total = await ConceptBookmark.countDocuments({ userId: req.userId });
    if (total >= MAX_BOOKMARKS_PER_USER) {
      return res.status(400).json({
        error: `You can keep at most ${MAX_BOOKMARKS_PER_USER} bookmarks. Remove some on the Bookmarks page.`,
      });
    }

    const lineFingerprint = bookmarkLineFingerprint(lineText);
    const created = await ConceptBookmark.create({
      userId: req.userId,
      sourceUploadId: upload._id,
      lineText,
      lineFingerprint,
      tutorSessionId,
      slideIndex,
      slideTitle,
      subtitleSource,
    });

    const lean = created.toObject() as ConceptBookmarkLean;
    return res.status(201).json({ bookmark: serializeBookmark(lean) });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: number }).code === 11000) {
      return res.status(409).json({ error: "This line is already bookmarked for this material." });
    }
    console.error(e);
    return res.status(500).json({ error: "Could not save bookmark." });
  }
});

router.delete("/:id", authMiddleware, async (req: AuthedRequest, res: Response) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id." });
    }
    const r = await ConceptBookmark.findOneAndDelete({ _id: id, userId: req.userId });
    if (!r) {
      return res.status(404).json({ error: "Bookmark not found." });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not delete bookmark." });
  }
});

router.post("/:id/recap/tts", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }

  try {
    const b = await ConceptBookmark.findOne({ _id: id, userId: req.userId }).lean<ConceptBookmarkLean | null>();
    if (!b) {
      return res.status(404).json({ error: "Bookmark not found." });
    }

    let scriptForTts = (b.recapScript ?? "").trim();

    if (!scriptForTts) {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
      }
      const uploadDoc = await Upload.findOne({ _id: b.sourceUploadId }).lean<UploadDoc | null>();
      const material =
        uploadDoc != null
          ? [uploadDoc.processedContent, uploadDoc.extractedText].filter(Boolean).join("\n\n").trim()
          : "";
      if (!material) {
        return res.status(400).json({ error: "Source material is missing for this upload." });
      }

      const generated = await generateBookmarkRecapScript({
        bookmarkLine: b.lineText,
        materialExcerpt: material,
        slideTitle: b.slideTitle || undefined,
      });
      scriptForTts = generated.trim();
      if (!scriptForTts) {
        return res.status(500).json({ error: "Model returned an empty recap." });
      }
      await ConceptBookmark.updateOne(
        { _id: id, userId: req.userId },
        { $set: { recapScript: scriptForTts.slice(0, 6500) } },
      );
    }

    const { mimeType, audioBase64 } = await tutorPyTts(scriptForTts.slice(0, 6000));
    const buf = Buffer.from(audioBase64, "base64");
    res.setHeader("Content-Type", mimeType);
    res.send(buf);
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Recap audio failed.";
    return res.status(503).json({
      error: `${msg} Ensure the tutor Python service is running (TUTOR_SERVICE_URL).`,
    });
  }
});

router.post("/:id/chat", authMiddleware, async (req: AuthedRequest, res: Response) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
  }

  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 4000) {
    return res.status(400).json({ error: "message is required (max 4000 characters)." });
  }

  const rawHistory = req.body?.history;
  const history: BookmarkChatTurn[] = [];
  if (Array.isArray(rawHistory)) {
    for (const row of rawHistory.slice(-8)) {
      if (!row || typeof row !== "object") continue;
      const role = (row as { role?: string }).role;
      const content = typeof (row as { content?: string }).content === "string" ? (row as { content: string }).content.trim() : "";
      if (!content || (role !== "user" && role !== "assistant")) continue;
      history.push({ role, content: content.slice(0, 8000) });
    }
  }

  try {
    const b = await ConceptBookmark.findOne({ _id: id, userId: req.userId }).lean<ConceptBookmarkLean | null>();
    if (!b) {
      return res.status(404).json({ error: "Bookmark not found." });
    }

    const uploadDoc = await Upload.findOne({ _id: b.sourceUploadId }).lean<UploadDoc | null>();
    const material =
      uploadDoc != null
        ? [uploadDoc.processedContent, uploadDoc.extractedText].filter(Boolean).join("\n\n").trim()
        : "";
    if (!material) {
      return res.status(400).json({ error: "Source material is missing for this upload." });
    }

    const reply = await answerBookmarkQuestion({
      bookmarkLine: b.lineText,
      materialExcerpt: material,
      message,
      history,
    });

    return res.json({ reply: reply.trim() });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Chat failed.";
    return res.status(500).json({ error: msg });
  }
});

export default router;
