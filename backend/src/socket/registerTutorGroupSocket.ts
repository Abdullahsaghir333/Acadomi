import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import type { Server } from "socket.io";

import { TutorGroupSession, type TutorGroupSessionLean } from "../models/TutorGroupSession.js";
import { User } from "../models/User.js";
import {
  appendGroupChatMessage,
  getGroupChatHistory,
  GROUP_CHAT_MAX_TEXT,
  type GroupChatMessage,
} from "./groupChatStore.js";

function verifySocketToken(token: string): string | null {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const p = jwt.verify(token, secret) as { sub: string };
    return typeof p.sub === "string" ? p.sub : null;
  } catch {
    return null;
  }
}

export const groupLastSyncMap = new Map<string, any>();

export function clearGroupLastSync(groupId: string): void {
  groupLastSyncMap.delete(groupId);
}

export function registerTutorGroupSocket(io: Server): void {
  io.use((socket, next) => {
    const raw = socket.handshake.auth as { token?: string } | undefined;
    const token =
      typeof raw?.token === "string"
        ? raw.token
        : typeof socket.handshake.query.token === "string"
          ? socket.handshake.query.token
          : null;
    if (!token) {
      next(new Error("Unauthorized"));
      return;
    }
    const userId = verifySocketToken(token);
    if (!userId) {
      next(new Error("Unauthorized"));
      return;
    }
    (socket.data as { userId: string; groupRoom?: string }).userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const data = socket.data as { userId: string; groupRoom?: string };

    socket.on("group:join", async (payload: { groupId?: string }, cb) => {
      const groupId = typeof payload?.groupId === "string" ? payload.groupId.trim() : "";
      const reply = (r: {
        ok: boolean;
        error?: string;
        status?: string;
        chatMessages?: GroupChatMessage[];
        lastSync?: any;
      }) => {
        if (typeof cb === "function") cb(r);
      };
      if (!mongoose.Types.ObjectId.isValid(groupId)) {
        reply({ ok: false, error: "Invalid group" });
        return;
      }
      try {
        const g = await TutorGroupSession.findById(groupId).lean<TutorGroupSessionLean | null>();
        if (!g || g.status === "cancelled" || g.status === "ended") {
          reply({ ok: false, error: "Group not available" });
          return;
        }
        const uid = new mongoose.Types.ObjectId(data.userId);
        const isHost = g.hostUserId.equals(uid);
        const isInvited = g.inviteeUserIds.some((x) => x.equals(uid));
        if (!isHost && !isInvited) {
          reply({ ok: false, error: "Not invited to this group" });
          return;
        }
        await socket.join(`group:${groupId}`);
        data.groupRoom = groupId;
        const lastSync = groupLastSyncMap.get(groupId) || null;
        reply({
          ok: true,
          status: g.status,
          chatMessages: g.status === "live" ? getGroupChatHistory(groupId) : [],
          lastSync,
        });
      } catch {
        reply({ ok: false, error: "Join failed" });
      }
    });

    socket.on("group:question_started", () => {
      const gid = data.groupRoom;
      if (!gid) return;
      void (async () => {
        const g = await TutorGroupSession.findById(gid).lean<TutorGroupSessionLean | null>();
        if (!g || g.status !== "live") return;
        const uid = new mongoose.Types.ObjectId(data.userId);
        const isHost = g.hostUserId.equals(uid);
        const accepted = g.acceptedUserIds.some((x) => x.equals(uid));
        if (!isHost && !accepted) return;
        const u = await User.findById(data.userId)
          .select("firstName lastName")
          .lean<{ firstName?: string; lastName?: string } | null>();
        const userName = u
          ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "Friend"
          : "Friend";
        io.to(`group:${gid}`).emit("group:media_pause", { byUserId: data.userId, userName });
      })();
    });

    socket.on("group:question_aborted", () => {
      const gid = data.groupRoom;
      if (!gid) return;
      void (async () => {
        const g = await TutorGroupSession.findById(gid).lean<TutorGroupSessionLean | null>();
        if (!g || g.status !== "live") return;
        const uid = new mongoose.Types.ObjectId(data.userId);
        const isHost = g.hostUserId.equals(uid);
        const accepted = g.acceptedUserIds.some((x) => x.equals(uid));
        if (!isHost && !accepted) return;
        io.to(`group:${gid}`).emit("group:media_resume_after_question", { byUserId: data.userId });
      })();
    });

    socket.on("group:chat_send", async (payload: { text?: string }, cb) => {
      const reply = (r: Record<string, unknown>) => {
        if (typeof cb === "function") cb(r);
      };
      const gid = data.groupRoom;
      if (!gid) {
        reply({ ok: false, error: "Join a group room first." });
        return;
      }
      const raw = typeof payload?.text === "string" ? payload.text : "";
      const text = raw.trim().slice(0, GROUP_CHAT_MAX_TEXT);
      if (!text) {
        reply({ ok: false, error: "Message is empty." });
        return;
      }
      try {
        const g = await TutorGroupSession.findById(gid).lean<TutorGroupSessionLean | null>();
        if (!g || g.status !== "live") {
          reply({ ok: false, error: "Chat is only available during a live session." });
          return;
        }
        const uid = new mongoose.Types.ObjectId(data.userId);
        const isHost = g.hostUserId.equals(uid);
        const accepted = g.acceptedUserIds.some((x) => x.equals(uid));
        if (!isHost && !accepted) {
          reply({ ok: false, error: "Not a member." });
          return;
        }
        const u = await User.findById(data.userId)
          .select("firstName lastName")
          .lean<{ firstName?: string; lastName?: string } | null>();
        const firstName = u?.firstName ?? "?";
        const lastName = u?.lastName ?? "";
        const msg = appendGroupChatMessage(gid, {
          userId: data.userId,
          firstName,
          lastName,
          text,
        });
        io.to(`group:${gid}`).emit("group:chat_message", msg);
        reply({ ok: true });
      } catch {
        reply({ ok: false, error: "Send failed." });
      }
    });

    socket.on("lesson:host_sync", (payload: unknown) => {
      const gid = data.groupRoom;
      const userId = data.userId;
      if (!gid || !userId || payload === null || typeof payload !== "object") return;
      void (async () => {
        const g = await TutorGroupSession.findById(gid).lean<TutorGroupSessionLean | null>();
        if (!g || g.status !== "live") return;
        if (!g.hostUserId.equals(new mongoose.Types.ObjectId(userId))) return;
        groupLastSyncMap.set(gid, payload);
        socket.to(`group:${gid}`).emit("lesson:follow", payload);
      })();
    });

    socket.on("group:audio_start", (payload: { groupId?: string; mimeType?: string }) => {
      const gid = data.groupRoom;
      if (!gid || gid !== payload?.groupId) return;
      socket.to(`group:${gid}`).emit("group:audio_start", { mimeType: payload.mimeType });
    });

    socket.on("group:audio_chunk", (payload: { groupId?: string; audioBase64?: string }) => {
      const gid = data.groupRoom;
      if (!gid || gid !== payload?.groupId) return;
      socket.to(`group:${gid}`).emit("group:audio_chunk", { audioBase64: payload.audioBase64 });
    });

    socket.on("group:audio_end", (payload: { groupId?: string }) => {
      const gid = data.groupRoom;
      if (!gid || gid !== payload?.groupId) return;
      socket.to(`group:${gid}`).emit("group:audio_end");
    });

    socket.on("disconnect", () => {
      data.groupRoom = undefined;
    });
  });
}
