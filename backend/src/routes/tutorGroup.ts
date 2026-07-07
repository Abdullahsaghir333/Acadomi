import { Router, type Response } from "express";
import mongoose from "mongoose";
import multer from "multer";

import { FriendInvite } from "../models/FriendInvite.js";
import { TutorGroupSession, type TutorGroupSessionLean } from "../models/TutorGroupSession.js";
import { TutorSession, type TutorSessionLean } from "../models/TutorSession.js";
import { Upload, type UploadDoc } from "../models/Upload.js";
import { User } from "../models/User.js";
import { authMiddleware, type AuthedRequest } from "../middleware/auth.js";
import { clearGroupChat } from "../socket/groupChatStore.js";
import { clearGroupLastSync } from "../socket/registerTutorGroupSocket.js";
import { getSocketIo } from "../socket/socketRegistry.js";
import { answerTutorQuestion, transcribeAudio } from "../services/gemini.js";
import { tutorPyTts } from "../services/tutorPythonClient.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function serializeSession(s: TutorSessionLean) {
  return {
    id: s._id.toString(),
    sourceUploadId: s.sourceUploadId.toString(),
    topicFocus: s.topicFocus,
    displayTitle: s.displayTitle,
    slides: s.slides.map((sl) => ({
      title: sl.title,
      points: sl.points,
      script: sl.script,
    })),
    status: s.status,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function assertFriends(
  hostId: mongoose.Types.ObjectId,
  inviteeId: mongoose.Types.ObjectId,
): Promise<boolean> {
  const doc = await FriendInvite.findOne({
    status: "accepted",
    $or: [
      { fromUserId: hostId, toUserId: inviteeId },
      { fromUserId: inviteeId, toUserId: hostId },
    ],
  }).lean();
  return !!doc;
}

async function loadGroupForUser(
  groupId: string,
  userId: string,
): Promise<{ group: TutorGroupSessionLean | null; isHost: boolean; isMember: boolean }> {
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return { group: null, isHost: false, isMember: false };
  }
  const g = await TutorGroupSession.findById(groupId).lean<TutorGroupSessionLean | null>();
  if (!g) return { group: null, isHost: false, isMember: false };
  const uid = new mongoose.Types.ObjectId(userId);
  const isHost = g.hostUserId.equals(uid);
  const accepted = g.acceptedUserIds.some((x) => x.equals(uid));
  const isMember = isHost || accepted;
  return { group: g, isHost, isMember };
}

function allInviteesAccepted(g: TutorGroupSessionLean): boolean {
  const acc = new Set(g.acceptedUserIds.map((id) => id.toString()));
  return g.inviteeUserIds.length > 0 && g.inviteeUserIds.every((id) => acc.has(id.toString()));
}

function emitGroupStatus(groupId: string, payload: Record<string, unknown>) {
  getSocketIo()?.to(`group:${groupId}`).emit("group:status", payload);
}

type UserNameLean = { _id: mongoose.Types.ObjectId; firstName: string; lastName: string };

async function memberSummaries(g: TutorGroupSessionLean): Promise<
  { userId: string; firstName: string; lastName: string; isHost: boolean }[]
> {
  const ids = [...new Set([g.hostUserId, ...g.acceptedUserIds].map((x) => x.toString()))].map(
    (s) => new mongoose.Types.ObjectId(s),
  );
  const users = await User.find({ _id: { $in: ids } })
    .select("_id firstName lastName")
    .lean<UserNameLean[]>();
  const map = new Map(users.map((u) => [u._id.toString(), u]));
  const hostStr = g.hostUserId.toString();
  return ids.map((oid) => {
    const u = map.get(oid.toString());
    return {
      userId: oid.toString(),
      firstName: u?.firstName ?? "?",
      lastName: u?.lastName ?? "",
      isHost: oid.toString() === hostStr,
    };
  });
}

/** POST body: { tutorSessionId, friendUserIds: string[] } — 1–3 friends, all must be friends with host. */
router.post("/", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const tutorSessionIdRaw =
    typeof req.body?.tutorSessionId === "string" ? req.body.tutorSessionId.trim() : "";
  const friendUserIdsRaw = req.body?.friendUserIds;

  if (!mongoose.Types.ObjectId.isValid(tutorSessionIdRaw)) {
    return res.status(400).json({ error: "Valid tutorSessionId is required." });
  }
  if (!Array.isArray(friendUserIdsRaw)) {
    return res.status(400).json({ error: "friendUserIds must be an array." });
  }

  const friendIds = [
    ...new Set(
      friendUserIdsRaw
        .filter((x: unknown) => typeof x === "string" && mongoose.Types.ObjectId.isValid(x))
        .map((x: string) => x.trim()),
    ),
  ];

  if (friendIds.length < 1 || friendIds.length > 3) {
    return res.status(400).json({ error: "Invite between 1 and 3 friends." });
  }

  const hostId = new mongoose.Types.ObjectId(req.userId);
  const tutorSessionId = new mongoose.Types.ObjectId(tutorSessionIdRaw);

  try {
    const session = await TutorSession.findOne({ _id: tutorSessionId, userId: hostId }).lean<
      TutorSessionLean | null
    >();
    if (!session) {
      return res.status(404).json({ error: "Tutor session not found." });
    }

    const inviteeOids = friendIds.map((id) => new mongoose.Types.ObjectId(id));
    for (const oid of inviteeOids) {
      if (oid.equals(hostId)) {
        return res.status(400).json({ error: "You cannot invite yourself." });
      }
      if (!(await assertFriends(hostId, oid))) {
        return res.status(400).json({ error: "You can only invite people you are friends with." });
      }
    }

    const created = await TutorGroupSession.create({
      tutorSessionId,
      hostUserId: hostId,
      inviteeUserIds: inviteeOids,
      acceptedUserIds: [hostId],
      declinedUserIds: [],
      status: "gathering",
      displayTitle: session.displayTitle.slice(0, 240),
    });

    const lean = created.toObject() as TutorGroupSessionLean;
    const members = await memberSummaries(lean);
    return res.status(201).json({
      group: {
        id: lean._id.toString(),
        tutorSessionId: lean.tutorSessionId.toString(),
        hostUserId: lean.hostUserId.toString(),
        inviteeUserIds: lean.inviteeUserIds.map((x) => x.toString()),
        acceptedUserIds: lean.acceptedUserIds.map((x) => x.toString()),
        status: lean.status,
        displayTitle: lean.displayTitle,
        members,
        isHost: true,
        youAccepted: true,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not create group session." });
  }
});

/** Pending group invites for the current user (dashboard). */
router.get("/invites/mine", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const uid = new mongoose.Types.ObjectId(req.userId);
  try {
    const rows = await TutorGroupSession.find({
      status: "gathering",
      inviteeUserIds: uid,
      declinedUserIds: { $nin: [uid] },
      acceptedUserIds: { $nin: [uid] },
    })
      .populate("hostUserId", "firstName lastName")
      .sort({ createdAt: -1 })
      .lean<
        (TutorGroupSessionLean & {
          hostUserId: { firstName?: string; lastName?: string } | mongoose.Types.ObjectId;
        })[]
      >();

    const invites = rows.map((g) => {
      const h = g.hostUserId as { firstName?: string; lastName?: string };
      const hostName = [h?.firstName, h?.lastName].filter(Boolean).join(" ").trim() || "Friend";
      return {
        id: g._id.toString(),
        hostName,
        displayTitle: g.displayTitle,
        tutorSessionId: g.tutorSessionId.toString(),
      };
    });

    return res.json({ invites });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not load invites." });
  }
});

/** Single group (host or accepted member, or invited while gathering). */
router.get("/:id", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const { group, isHost, isMember } = await loadGroupForUser(req.params.id, req.userId!);
  if (!group) {
    return res.status(404).json({ error: "Group not found." });
  }
  const uid = new mongoose.Types.ObjectId(req.userId);
  const isInvited = group.inviteeUserIds.some((x) => x.equals(uid));
  if (!isHost && !isMember && !isInvited) {
    return res.status(403).json({ error: "Not part of this group." });
  }

  try {
    const members = await memberSummaries(group);
    return res.json({
      group: {
        id: group._id.toString(),
        tutorSessionId: group.tutorSessionId.toString(),
        hostUserId: group.hostUserId.toString(),
        inviteeUserIds: group.inviteeUserIds.map((x) => x.toString()),
        acceptedUserIds: group.acceptedUserIds.map((x) => x.toString()),
        status: group.status,
        displayTitle: group.displayTitle,
        members,
        isHost,
        youAccepted: isMember,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not load group." });
  }
});

/** Tutor session payload — only when group is live and user is a member. */
router.get("/:id/session", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const { group, isMember } = await loadGroupForUser(req.params.id, req.userId!);
  if (!group) {
    return res.status(404).json({ error: "Group not found." });
  }
  if (group.status !== "live") {
    return res.status(403).json({ error: "Session has not started yet." });
  }
  if (!isMember) {
    return res.status(403).json({ error: "Join and accept the invite first." });
  }

  try {
    const s = await TutorSession.findById(group.tutorSessionId).lean<TutorSessionLean | null>();
    if (!s) {
      return res.status(404).json({ error: "Tutor session missing." });
    }
    return res.json({ session: serializeSession(s) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not load session." });
  }
});

router.post("/:id/accept", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }
  const uid = new mongoose.Types.ObjectId(req.userId);

  try {
    const g = await TutorGroupSession.findOne({
      _id: id,
      status: "gathering",
      inviteeUserIds: uid,
    }).lean<TutorGroupSessionLean | null>();

    if (!g) {
      return res.status(404).json({ error: "No pending invite for this group." });
    }

    await TutorGroupSession.updateOne({ _id: id }, { $addToSet: { acceptedUserIds: uid } });
    const fresh = await TutorGroupSession.findById(id).lean<TutorGroupSessionLean | null>();
    if (!fresh) {
      return res.status(500).json({ error: "Update failed." });
    }

    if (allInviteesAccepted(fresh)) {
      await TutorGroupSession.updateOne({ _id: id }, { $set: { status: "live" } });
      const live = await TutorGroupSession.findById(id).lean<TutorGroupSessionLean | null>();
      emitGroupStatus(id, { status: "live" });
      const members = live ? await memberSummaries(live) : [];
      return res.json({
        ok: true,
        group: live
          ? {
              id: live._id.toString(),
              status: live.status,
              members,
            }
          : { id, status: "live", members },
      });
    }

    emitGroupStatus(id, { status: "gathering", acceptedCount: fresh.acceptedUserIds.length });
    const members = await memberSummaries(fresh);
    return res.json({
      ok: true,
      group: {
        id: fresh._id.toString(),
        status: fresh.status,
        members,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not accept invite." });
  }
});

router.post("/:id/decline", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }
  const uid = new mongoose.Types.ObjectId(req.userId);

  try {
    const g = await TutorGroupSession.findOne({
      _id: id,
      status: "gathering",
      inviteeUserIds: uid,
    }).lean<TutorGroupSessionLean | null>();

    if (!g) {
      return res.status(404).json({ error: "No pending invite for this group." });
    }

    await TutorGroupSession.updateOne(
      { _id: id },
      {
        $addToSet: { declinedUserIds: uid },
        $set: { status: "cancelled" },
      },
    );
    clearGroupChat(id);
    clearGroupLastSync(id);
    emitGroupStatus(id, { status: "cancelled" });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not decline invite." });
  }
});

router.post("/:id/end", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }
  const uid = new mongoose.Types.ObjectId(req.userId);

  try {
    const g = await TutorGroupSession.findOne({ _id: id, status: "live" }).lean<TutorGroupSessionLean | null>();
    if (!g) {
      return res.status(404).json({ error: "Live group session not found." });
    }
    if (!g.hostUserId.equals(uid)) {
      return res.status(403).json({ error: "Only the host can end the group session." });
    }
    await TutorGroupSession.updateOne({ _id: id }, { $set: { status: "ended" } });
    clearGroupChat(id);
    clearGroupLastSync(id);
    getSocketIo()?.to(`group:${id}`).emit("group:ended", { groupId: id });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not end session." });
  }
});

router.post(
  "/:id/slides/:slideIndex/tts",
  authMiddleware,
  async (req: AuthedRequest, res: Response) => {
    const { group, isMember } = await loadGroupForUser(req.params.id, req.userId!);
    if (!group || group.status !== "live") {
      return res.status(403).json({ error: "Group session not active." });
    }
    if (!isMember) {
      return res.status(403).json({ error: "Not a member." });
    }

    const idx = Number.parseInt(req.params.slideIndex, 10);
    if (!Number.isFinite(idx) || idx < 0) {
      return res.status(400).json({ error: "Invalid slide index." });
    }

    try {
      const s = await TutorSession.findById(group.tutorSessionId).lean<TutorSessionLean | null>();
      if (!s) {
        return res.status(404).json({ error: "Session not found." });
      }
      const slide = s.slides[idx];
      if (!slide?.script) {
        return res.status(404).json({ error: "Slide not found." });
      }
      const { mimeType, audioBase64 } = await tutorPyTts(slide.script);
      const buf = Buffer.from(audioBase64, "base64");
      res.setHeader("Content-Type", mimeType);
      res.send(buf);
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : "TTS failed.";
      return res.status(503).json({ error: msg });
    }
  },
);

router.post("/:id/tts", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const { group, isMember } = await loadGroupForUser(req.params.id, req.userId!);
  if (!group || group.status !== "live") {
    return res.status(403).json({ error: "Group session not active." });
  }
  if (!isMember) {
    return res.status(403).json({ error: "Not a member." });
  }

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > 6000) {
    return res.status(400).json({ error: "text is required (max 6000 characters)." });
  }

  try {
    const { mimeType, audioBase64 } = await tutorPyTts(text);
    const buf = Buffer.from(audioBase64, "base64");
    res.setHeader("Content-Type", mimeType);
    res.send(buf);
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "TTS failed.";
    return res.status(503).json({ error: msg });
  }
});

router.post("/:id/ask", authMiddleware, upload.single("audio"), async (req: AuthedRequest, res: Response) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
  }

  const groupId = req.params.id;
  const { group, isMember } = await loadGroupForUser(groupId, req.userId!);
  if (!group || group.status !== "live") {
    return res.status(403).json({ error: "Group session not active." });
  }
  if (!isMember) {
    return res.status(403).json({ error: "Not a member." });
  }

  const slideIndexRaw = req.body?.slideIndex;
  const slideIndex =
    typeof slideIndexRaw === "string"
      ? Number.parseInt(slideIndexRaw, 10)
      : typeof slideIndexRaw === "number"
        ? slideIndexRaw
        : NaN;

  if (!Number.isFinite(slideIndex) || slideIndex < 0) {
    return res.status(400).json({ error: "Valid slideIndex is required." });
  }

  const file = req.file;
  if (!file?.buffer?.length) {
    return res.status(400).json({ error: "Audio question is required." });
  }

  try {
    const s = await TutorSession.findById(group.tutorSessionId).lean<TutorSessionLean | null>();
    if (!s) {
      return res.status(404).json({ error: "Session not found." });
    }
    const slide = s.slides[slideIndex];
    if (!slide) {
      return res.status(400).json({ error: "Invalid slide index." });
    }

    const uploadDoc = await Upload.findOne({ _id: s.sourceUploadId, userId: s.userId }).lean<
      UploadDoc | null
    >();
    const material =
      uploadDoc != null
        ? [uploadDoc.processedContent, uploadDoc.extractedText].filter(Boolean).join("\n\n").trim()
        : "";

    const question = await transcribeAudio(file.buffer, file.mimetype || "audio/webm");
    if (!question.trim()) {
      return res.status(400).json({ error: "Could not hear a question. Try again closer to the mic." });
    }

    const answer = await answerTutorQuestion({
      question,
      slideTitle: slide.title,
      slidePoints: slide.points,
      slideScript: slide.script,
      materialExcerpt: material,
    });

    const asker = await User.findById(req.userId).select("firstName lastName").lean<{
      firstName?: string;
      lastName?: string;
    } | null>();
    const askerName = asker
      ? `${asker.firstName ?? ""} ${asker.lastName ?? ""}`.trim() || "Friend"
      : "Friend";

    getSocketIo()?.to(`group:${groupId}`).emit("group:qa", {
      askerName,
      askerId: req.userId,
      question,
      answer,
      questionAudioBase64: file.buffer.toString("base64"),
      questionAudioMimeType: file.mimetype || "audio/webm",
    });

    return res.json({ question, answer });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Could not answer question.";
    return res.status(500).json({ error: msg });
  }
});

export default router;
