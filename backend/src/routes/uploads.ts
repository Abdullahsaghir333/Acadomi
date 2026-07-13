import { Router, type Response } from "express";
import type { Express } from "express";
import multer from "multer";
import { Upload } from "../models/Upload.js";
import { authMiddleware, type AuthedRequest } from "../middleware/auth.js";
import { extractTextFromPdf } from "../services/pdfText.js";
import {
  extractTextFromImage,
  synthesizeLearningNotes,
  transcribeAudio,
} from "../services/gemini.js";

const router = Router();
const MAX_UPLOADS_PER_USER = 7;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 28 * 1024 * 1024 },
});

router.get("/", authMiddleware, async (req: AuthedRequest, res: Response) => {
  try {
    const list = await Upload.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({
      uploads: list.map((u) => ({
        id: String(u._id),
        kind: u.kind,
        title: u.title,
        userPrompt: u.userPrompt,
        extractedText: u.extractedText,
        processedContent: u.processedContent,
        fileMeta: u.fileMeta,
        status: u.status,
        errorMessage: u.errorMessage,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      })),
      maxUploads: MAX_UPLOADS_PER_USER,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not list uploads." });
  }
});

router.post(
  "/",
  authMiddleware,
  upload.array("files"),
  async (req: AuthedRequest, res: Response) => {
    if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API && !process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "Neither GEMINI_API_KEY nor GROQ_API keys are configured on the server." });
    }

    const files = req.files as Express.Multer.File[] | undefined;
    const kind = req.body?.type as string | undefined;
    const userPrompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const titleFromUser =
      typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : "";

    if (!kind || !["pdf", "image", "audio"].includes(kind)) {
      return res.status(400).json({ error: 'Invalid or missing "type" (pdf | image | audio).' });
    }
    if (!files?.length) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    try {
      const count = await Upload.countDocuments({ userId: req.userId });
      if (count >= MAX_UPLOADS_PER_USER) {
        return res.status(400).json({
          error: `You can keep at most ${MAX_UPLOADS_PER_USER} uploads. Delete one to add another.`,
        });
      }

      try {
        validateFiles(kind, files);
      } catch (ve) {
        const msg = ve instanceof Error ? ve.message : "Invalid files";
        return res.status(400).json({ error: msg });
      }

      const fallbackTitle =
        files[0]?.originalname?.replace(/\.[^.]+$/, "") || "Learning upload";
      const title = titleFromUser.length > 0 ? titleFromUser : fallbackTitle;

      const doc = await Upload.create({
        userId: req.userId,
        kind,
        title,
        userPrompt,
        status: "processing",
        fileMeta: files.map((f) => ({
          originalName: f.originalname,
          mimeType: f.mimetype,
        })),
      });

      try {
        const extractedParts: string[] = [];

        if (kind === "pdf") {
          extractedParts.push(await extractTextFromPdf(files[0].buffer));
        } else if (kind === "image") {
          for (const f of files) {
            extractedParts.push(await extractTextFromImage(f.buffer, f.mimetype));
          }
        } else {
          extractedParts.push(await transcribeAudio(files[0].buffer, files[0].mimetype));
        }

        const extractedText = extractedParts.filter(Boolean).join("\n\n").trim();
        const processedContent = await synthesizeLearningNotes(extractedText, userPrompt);

        doc.extractedText = extractedText;
        doc.processedContent = processedContent;
        doc.status = "completed";
        await doc.save();

        return res.status(201).json({
          upload: {
            id: doc._id.toString(),
            kind: doc.kind,
            title: doc.title,
            userPrompt: doc.userPrompt,
            extractedText: doc.extractedText,
            processedContent: doc.processedContent,
            fileMeta: doc.fileMeta,
            status: doc.status,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Processing failed";
        doc.status = "failed";
        doc.errorMessage = message;
        await doc.save();
        return res.status(422).json({
          error: message,
          uploadId: doc._id.toString(),
        });
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Upload failed." });
    }
  },
);

router.delete("/:id", authMiddleware, async (req: AuthedRequest, res: Response) => {
  try {
    const result = await Upload.deleteOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Upload not found." });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not delete upload." });
  }
});

function validateFiles(kind: string, files: Express.Multer.File[]) {
  if (kind === "pdf") {
    if (files.length !== 1) {
      throw new Error("PDF upload must contain exactly one file.");
    }
    if (!files[0].mimetype.includes("pdf")) {
      throw new Error("The file must be a PDF.");
    }
  } else if (kind === "image") {
    if (files.length < 1 || files.length > 4) {
      throw new Error("Please upload between 1 and 4 images.");
    }
    for (const f of files) {
      if (!f.mimetype.startsWith("image/")) {
        throw new Error("All files must be images.");
      }
    }
  } else if (kind === "audio") {
    if (files.length !== 1) {
      throw new Error("Audio upload must contain exactly one file.");
    }
    const m = files[0].mimetype;
    const ok =
      m.startsWith("audio/") ||
      m === "video/webm" ||
      m === "application/ogg";
    if (!ok) {
      throw new Error("Unsupported audio format. Use a common audio type or WebM recording.");
    }
  }
}

export default router;
