import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import mongoose from "mongoose";
import { Server } from "socket.io";

import authRoutes from "./routes/auth.js";
import bookmarkRoutes from "./routes/bookmarks.js";
import podcastRoutes from "./routes/podcasts.js";
import roleReversalRoutes from "./routes/roleReversal.js";
import cheatSheetRoutes from "./routes/cheatSheets.js";
import friendRoutes from "./routes/friends.js";
import tutorGroupRoutes from "./routes/tutorGroup.js";
import tutorRoutes from "./routes/tutor.js";
import uploadRoutes from "./routes/uploads.js";
import { registerTutorGroupSocket } from "./socket/registerTutorGroupSocket.js";
import { setSocketIo } from "./socket/socketRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendEnvPath = path.resolve(__dirname, "..", ".env");
/** Cwd may be repo root (npm from monorepo) or `backend/`; merge both, package `.env` wins. */
dotenv.config();
dotenv.config({ path: backendEnvPath, override: true });

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const MONGODB_URI = process.env.MONGODB_URI;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  const db =
    mongoose.connection.readyState === 1
      ? "connected"
      : mongoose.connection.readyState === 2
        ? "connecting"
        : "disconnected";
  res.json({
    status: "ok",
    service: "acadomi-api",
    database: db,
    gemini: process.env.GEMINI_API_KEY ? "configured" : "missing",
    jwt: process.env.JWT_SECRET ? "configured" : "missing",
    podcastService: process.env.PODCAST_SERVICE_URL ?? "http://127.0.0.1:5001",
    tutorService: process.env.TUTOR_SERVICE_URL ?? "http://127.0.0.1:5002",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/bookmarks", bookmarkRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/podcasts", podcastRoutes);
app.use("/api/role-reversal", roleReversalRoutes);
app.use("/api/tutor/group", tutorGroupRoutes);
app.use("/api/tutor", tutorRoutes);
app.use("/api/cheat-sheets", cheatSheetRoutes);
app.use("/api/friends", friendRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  path: "/socket.io/",
  cors: {
    origin: FRONTEND_URL,
    credentials: true,
  },
});
setSocketIo(io);
registerTutorGroupSocket(io);

async function start() {
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log("MongoDB connected");

      // Auto-migrate: drop the old conflicting unique index on { sourceUploadId, lineFingerprint } if it exists in DB
      try {
        const collection = mongoose.connection.collection("conceptbookmarks");
        const indexes = await collection.indexes();
        for (const idx of indexes) {
          if (idx.unique && idx.name && idx.key && !idx.key.userId && idx.key.sourceUploadId && idx.key.lineFingerprint) {
            console.log("Dropping old unique index:", idx.name);
            await collection.dropIndex(idx.name);
          }
        }
      } catch (indexErr) {
        console.error("Error checking/dropping old concept bookmark indexes:", indexErr);
      }

    } catch (err) {
      console.error("MongoDB connection failed:", err);
    }
  } else {
    console.warn("MONGODB_URI not set — API runs without database.");
  }

  if (!process.env.JWT_SECRET) {
    console.warn("JWT_SECRET not set — auth routes will fail.");
  }

  httpServer.listen(PORT, () => {
    console.log(`Acadomi API listening on http://localhost:${PORT}`);
    console.log(`Socket.IO at ws://localhost:${PORT}/socket.io/`);
  });
}

void start();
