"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import {
  Baby,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  HelpCircle,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Plus,
  Play,
  ScanEye,
  Send,
  Square,
  Trash2,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";

import { MarketingHeader } from "@/components/marketing-header";
import {
  TutorLectureWhiteboard,
  TutorQaWhiteboard,
  type TutorLectureWhiteboardHandle,
} from "@/components/tutor-whiteboard-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";
import {
  API_BASE,
  apiAcceptTutorGroup,
  apiCreateConceptBookmark,
  apiCreateTutorGroup,
  apiCreateTutorSession,
  apiDeclineTutorGroup,
  apiDeleteTutorSession,
  apiEndTutorGroup,
  apiFetchGroupSlideAudioBlobUrl,
  apiFetchGroupTtsBlobUrl,
  apiFetchTutorSlideAudioBlobUrl,
  apiFetchTutorTtsBlobUrl,
  apiGetTutorGroup,
  apiGetTutorGroupSession,
  apiGroupTutorAsk,
  apiListFriends,
  apiListTutorSessions,
  apiListUploads,
  apiTutorAsk,
  apiTutorFocusAnalyze,
  apiTutorFocusReset,
  apiTutorSlideEli5,
  getToken,
  type FriendEntryDTO,
  type TutorFocusDTO,
  type TutorGroupChatMessageDTO,
  type TutorGroupDetailDTO,
  type TutorSessionDTO,
  type UploadDTO,
} from "@/lib/api";

function tokenizeScript(script: string): string[] {
  return script.trim().split(/\s+/).filter(Boolean);
}

/** One subtitle line per phrase; lines swap only when the phrase index changes (avoids word-by-word jitter). */
const SUBTITLE_WORDS_PER_PHRASE = 8;
/** Nudge display slightly early so captions feel aligned with speech (no true word timestamps from TTS). */
const SUBTITLE_LEAD_RATIO = 0.035;

const ELI5_ACK_TEXT = "Sure — I'll explain this slide in simpler, easy words.";

function buildPhraseLines(words: string[], wordsPerPhrase: number): string[] {
  if (words.length === 0) return [];
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerPhrase) {
    lines.push(words.slice(i, i + wordsPerPhrase).join(" "));
  }
  return lines;
}

/** Map each word index to a bullet segment (script has no timestamps; split by bullet weight). */
function wordRangesForBulletSync(script: string, points: string[]): { start: number; end: number }[] {
  const n = tokenizeScript(script).length;
  const k = points.length;
  if (n === 0) return [];
  if (k === 0) return [{ start: 0, end: n }];
  const weights = points.map((p) => Math.max(1, tokenizeScript(p).length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map((w) => Math.max(1, Math.floor((n * w) / sum)));
  let total = sizes.reduce((a, b) => a + b, 0);
  let diff = n - total;
  let i = 0;
  while (diff !== 0 && sizes.length) {
    const idx = i % sizes.length;
    if (diff > 0) {
      sizes[idx]++;
      diff--;
    } else if (sizes[idx] > 1) {
      sizes[idx]--;
      diff++;
    }
    i++;
    if (i > sizes.length * (n + 8)) break;
  }
  if (diff !== 0) {
    const base = Math.floor(n / k);
    let rem = n % k;
    const rangesEq: { start: number; end: number }[] = [];
    let s = 0;
    for (let j = 0; j < k; j++) {
      const len = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
      rangesEq.push({ start: s, end: s + len });
      s += len;
    }
    return rangesEq;
  }
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (const sz of sizes) {
    ranges.push({ start, end: start + sz });
    start += sz;
  }
  if (ranges.length && ranges[ranges.length - 1].end !== n) {
    ranges[ranges.length - 1].end = n;
  }
  return ranges;
}

/** Turn tutor answer text into lines for the Q&A slide (bullets or sentences). */
function parseAnswerIntoBullets(answer: string): string[] {
  const t = answer.trim();
  if (!t) return [];
  const rawLines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const fromLines = rawLines.map((line) => {
    const m =
      line.match(/^[-*•]\s*(.+)$/) ||
      line.match(/^\d+[.)]\s*(.+)$/);
    return (m ? m[1] : line).trim();
  });
  if (fromLines.length >= 2) return fromLines;
  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length >= 2) return sentences.slice(0, 14);
  return [t];
}

type SegmentRange = { start: number; end: number };

const DASHBOARD_GROUP_SESSION_NOTICE_KEY = "acadomi:groupSessionNotice";

/** Lets the dashboard show a one-line reason after group study ends and we redirect there. */
function queueDashboardGroupEndedNotice(role: "host" | "guest") {
  try {
    sessionStorage.setItem(DASHBOARD_GROUP_SESSION_NOTICE_KEY, role);
  } catch {
    /* private mode */
  }
}

function focusTone(f: TutorFocusDTO | null): string {
  if (!f) return "bg-muted text-muted-foreground";
  if (!f.faceFound) return "bg-destructive/15 text-destructive";
  if (f.status === "CALIBRATING") return "bg-muted text-foreground";
  if (f.alarm) return "bg-destructive/15 text-destructive";
  if (f.status === "FOCUSED") return "bg-primary/15 text-primary";
  if (f.status === "DISTRACTED") return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
  return "bg-orange-500/15 text-orange-800 dark:text-orange-200";
}

export default function TutorPage() {
  const [uploads, setUploads] = React.useState<UploadDTO[]>([]);
  const [sessions, setSessions] = React.useState<TutorSessionDTO[]>([]);
  const [maxSessions, setMaxSessions] = React.useState(25);
  const [selectedUploadId, setSelectedUploadId] = React.useState("");
  const [topicFocus, setTopicFocus] = React.useState("");
  const [activeSession, setActiveSession] = React.useState<TutorSessionDTO | null>(null);
  const [slideIndex, setSlideIndex] = React.useState(0);
  const [loadingLists, setLoadingLists] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [bookmarkSaving, setBookmarkSaving] = React.useState<"narration" | "qa_answer" | null>(null);
  const [bookmarkNotice, setBookmarkNotice] = React.useState<string | null>(null);
  const bookmarkErrorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const [camOn, setCamOn] = React.useState(false);
  const [focus, setFocus] = React.useState<TutorFocusDTO | null>(null);
  const [narrationUrls, setNarrationUrls] = React.useState<Record<string, string>>({});
  const [narrationLoading, setNarrationLoading] = React.useState(false);
  const [playingSlide, setPlayingSlide] = React.useState<number | null>(null);

  const [asking, setAsking] = React.useState(false);
  const [lastQa, setLastQa] = React.useState<{
    question: string;
    answer: string;
    askerName?: string;
  } | null>(null);
  const [answerAudioUrl, setAnswerAudioUrl] = React.useState<string | null>(null);
  const [autoAdvanceNarration, setAutoAdvanceNarration] = React.useState(true);
  const [alertSounds, setAlertSounds] = React.useState(true);
  const [narrationSubtitleLine, setNarrationSubtitleLine] = React.useState("");
  const [answerSubtitleLine, setAnswerSubtitleLine] = React.useState("");
  const [playingAnswer, setPlayingAnswer] = React.useState(false);
  const [answerPaused, setAnswerPaused] = React.useState(false);
  const [questionSubmitting, setQuestionSubmitting] = React.useState(false);
  /** Simpler script for the current slide only; cleared when changing slides. */
  const [eli5Script, setEli5Script] = React.useState<string | null>(null);
  const [eli5ForSlideIndex, setEli5ForSlideIndex] = React.useState<number | null>(null);
  const [eli5Busy, setEli5Busy] = React.useState(false);
  /** Main stage: lesson slide vs dedicated Q&A slide while waiting for or playing the answer. */
  const [tutorView, setTutorView] = React.useState<"lecture" | "qa">("lecture");
  /** Which bullet on the current slide tracks the spoken script (time-synced estimate). */
  const [narrationBulletIndex, setNarrationBulletIndex] = React.useState<number | null>(null);
  /** Which answer bullet tracks the spoken reply. */
  const [answerBulletIndex, setAnswerBulletIndex] = React.useState<number | null>(null);
  /** Full-viewport teaching layout with the same controls as the lesson card. */
  const [immersiveTeaching, setImmersiveTeaching] = React.useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const { user: authUser } = useAuth();

  const [groupId, setGroupId] = React.useState<string | null>(null);
  const [groupDetail, setGroupDetail] = React.useState<TutorGroupDetailDTO | null>(null);
  const [friendsList, setFriendsList] = React.useState<FriendEntryDTO[]>([]);
  const [selectedGroupFriendIds, setSelectedGroupFriendIds] = React.useState<string[]>([]);
  const [groupInviteBusy, setGroupInviteBusy] = React.useState(false);
  const [groupUrlBootstrapped, setGroupUrlBootstrapped] = React.useState(false);
  const [groupChatMessages, setGroupChatMessages] = React.useState<TutorGroupChatMessageDTO[]>([]);
  const [groupChatDraft, setGroupChatDraft] = React.useState("");
  const [groupChatSending, setGroupChatSending] = React.useState(false);
  const [endGroupBusy, setEndGroupBusy] = React.useState(false);

  const groupSocketRef = React.useRef<Socket | null>(null);
  const groupApplyingRemoteRef = React.useRef(false);
  const myUserIdRef = React.useRef<string | null>(null);
  const lessonHandlersRef = React.useRef({
    playNarration: (_i: number) => {},
    stopNarration: () => {},
    pauseAnswer: () => {},
    playAnswerTts: (_t: string, _bullets?: string[]) => {},
    setSlideIndex: (_i: number) => {},
  });

  React.useEffect(() => {
    myUserIdRef.current = authUser?.id ?? null;
  }, [authUser?.id]);

  const isGroupGathering = groupDetail?.status === "gathering";
  const isGroupLive = groupDetail?.status === "live";
  const isGroupHost = !!groupDetail?.isHost;
  const showGroupFlow = !!groupId;
  const needsGroupAccept =
    !!groupDetail &&
    !groupDetail.isHost &&
    !groupDetail.youAccepted &&
    groupDetail.status === "gathering";

  const groupIdRef = React.useRef<string | null>(null);
  const groupSyncRef = React.useRef({ live: false, host: false });
  React.useEffect(() => {
    groupIdRef.current = groupId;
  }, [groupId]);
  React.useEffect(() => {
    groupSyncRef.current = { live: !!isGroupLive, host: !!isGroupHost };
  }, [isGroupLive, isGroupHost]);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const questionMicStreamRef = React.useRef<MediaStream | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const recordChunksRef = React.useRef<Blob[]>([]);
  const focusTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRoleRef = React.useRef<"slide" | "answer" | null>(null);
  const activeSessionRef = React.useRef<TutorSessionDTO | null>(null);
  const autoAdvanceRef = React.useRef(true);
  const focusRef = React.useRef<TutorFocusDTO | null>(null);
  const softBeepTickRef = React.useRef(0);
  activeSessionRef.current = activeSession;
  autoAdvanceRef.current = autoAdvanceNarration;
  focusRef.current = focus;

  const narrationUrlsRef = React.useRef(narrationUrls);
  narrationUrlsRef.current = narrationUrls;

  const slideIndexRef = React.useRef(slideIndex);
  slideIndexRef.current = slideIndex;
  const playingSlideRef = React.useRef(playingSlide);
  playingSlideRef.current = playingSlide;
  const tutorViewRef = React.useRef(tutorView);
  tutorViewRef.current = tutorView;
  const playingAnswerRef = React.useRef(playingAnswer);
  playingAnswerRef.current = playingAnswer;
  const isGroupHostRef = React.useRef(isGroupHost);
  isGroupHostRef.current = isGroupHost;
  const groupChatScrollRef = React.useRef<HTMLDivElement | null>(null);

  /** Saved playback position per session slide (blob URL key `${id}:${idx}`). */
  const narrationProgressRef = React.useRef<Record<string, number>>({});
  /** After Q&A, resume slide narration from here (if user is still on that slide). */
  const lectureResumeRef = React.useRef<{ slideIndex: number; key: string; time: number } | null>(null);
  const subtitleRafRef = React.useRef<number | null>(null);
  const subtitlePhraseLinesRef = React.useRef<string[]>([]);
  const answerBlobUrlRef = React.useRef<string | null>(null);
  const lastAnswerTtsTextRef = React.useRef("");
  const answerResumeTimeRef = React.useRef(0);
  const lecturePointRefs = React.useRef<(HTMLLIElement | null)[]>([]);
  const qaBulletRefs = React.useRef<(HTMLLIElement | null)[]>([]);

  const lastQaAnswerBullets = React.useMemo(
    () => (lastQa?.answer ? parseAnswerIntoBullets(lastQa.answer) : []),
    [lastQa?.answer],
  );

  const lectureWhiteboardRef = React.useRef<TutorLectureWhiteboardHandle | null>(null);
  /** When true, handwriting follows `narrationBulletIndex` without pausing audio. */
  const lectureStepSyncActiveRef = React.useRef(false);
  /** Avoid re-running handwriting for the same bullet index during one play. */
  const lastHandwritingBulletRef = React.useRef<number | null>(null);

  const qaAnswerWhiteboardRef = React.useRef<TutorLectureWhiteboardHandle | null>(null);
  /** When true, Q&A answer handwriting follows `answerBulletIndex` (same timing as subtitle RAF). */
  const answerStepSyncActiveRef = React.useRef(false);
  const lastQaAnswerHandwritingRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    lastQaAnswerHandwritingRef.current = null;
  }, [lastQa?.question, lastQa?.answer]);

  React.useEffect(() => {
    if (tutorView !== "lecture" || narrationBulletIndex == null) return;
    const el = lecturePointRefs.current[narrationBulletIndex];
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [tutorView, narrationBulletIndex]);

  React.useEffect(() => {
    if (tutorView !== "qa" || answerBulletIndex == null) return;
    const el = qaBulletRefs.current[answerBulletIndex];
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [tutorView, answerBulletIndex]);

  const cancelSubtitleRaf = React.useCallback(() => {
    if (subtitleRafRef.current != null) {
      cancelAnimationFrame(subtitleRafRef.current);
      subtitleRafRef.current = null;
    }
  }, []);

  const attachPlaybackSyncRaf = React.useCallback(
    (
      a: HTMLAudioElement,
      words: string[],
      setLine: (line: string) => void,
      sync?: {
        segmentRanges: SegmentRange[];
        setActiveSegment: (idx: number | null) => void;
        wordsPerPhrase?: number;
        leadRatio?: number;
      },
    ) => {
      cancelSubtitleRaf();
      const wpp = sync?.wordsPerPhrase ?? SUBTITLE_WORDS_PER_PHRASE;
      const lead = sync?.leadRatio ?? SUBTITLE_LEAD_RATIO;
      const lines = buildPhraseLines(words, wpp);
      subtitlePhraseLinesRef.current = lines;
      const lastChunkIdx = { current: -1 };
      const lastSegIdx = { current: -999 };
      const ranges = sync?.segmentRanges;
      const setSeg = sync?.setActiveSegment;
      const tick = () => {
        const el = audioRef.current;
        if (!el || el !== a) {
          subtitleRafRef.current = null;
          return;
        }
        if (el.paused) {
          subtitleRafRef.current = null;
          return;
        }
        const d = el.duration;
        const t = el.currentTime;
        const phraseLines = subtitlePhraseLinesRef.current;
        if (phraseLines.length > 0 && d > 0 && Number.isFinite(d)) {
          const ratio = Math.min(1, Math.max(0, t / d + lead));
          let ci = Math.floor(ratio * phraseLines.length);
          if (ci >= phraseLines.length) ci = phraseLines.length - 1;
          if (ci !== lastChunkIdx.current) {
            lastChunkIdx.current = ci;
            setLine(phraseLines[ci] ?? "");
          }
          if (ranges?.length && setSeg && words.length > 0) {
            const wi = Math.min(words.length - 1, Math.floor(ratio * words.length));
            let segIdx = ranges.length - 1;
            for (let i = 0; i < ranges.length; i++) {
              const r = ranges[i];
              if (wi >= r.start && wi < r.end) {
                segIdx = i;
                break;
              }
              if (wi < r.start) {
                segIdx = Math.max(0, i - 1);
                break;
              }
            }
            if (segIdx !== lastSegIdx.current) {
              lastSegIdx.current = segIdx;
              setSeg(segIdx);
            }
          }
        }
        subtitleRafRef.current = requestAnimationFrame(tick);
      };
      subtitleRafRef.current = requestAnimationFrame(tick);
    },
    [cancelSubtitleRaf],
  );

  React.useEffect(() => {
    lectureStepSyncActiveRef.current = false;
    lastHandwritingBulletRef.current = null;
    lectureWhiteboardRef.current?.reset();
  }, [slideIndex, activeSession?.id]);

  React.useEffect(() => {
    if (!immersiveTeaching) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersiveTeaching(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [immersiveTeaching]);

  /** Handwriting tracks the same segment index as the voice (subtitle RAF); audio never pauses for this. */
  React.useEffect(() => {
    if (!lectureStepSyncActiveRef.current) return;
    if (tutorView !== "lecture") return;
    if (playingSlide === null || activeSession === null) return;
    if (playingSlide !== slideIndex) return;
    const k = narrationBulletIndex;
    if (k === null) return;
    if (lastHandwritingBulletRef.current === k) return;
    lastHandwritingBulletRef.current = k;
    void lectureWhiteboardRef.current?.animateBullet(k);
  }, [narrationBulletIndex, playingSlide, slideIndex, tutorView, activeSession?.id]);

  React.useEffect(() => {
    if (!answerStepSyncActiveRef.current) return;
    if (tutorView !== "qa") return;
    if (!playingAnswer) return;
    const k = answerBulletIndex;
    if (k === null) return;
    if (lastQaAnswerHandwritingRef.current === k) return;
    lastQaAnswerHandwritingRef.current = k;
    void qaAnswerWhiteboardRef.current?.animateBullet(k);
  }, [answerBulletIndex, playingAnswer, tutorView, lastQa?.answer]);

  React.useEffect(() => {
    return () => {
      Object.values(narrationUrlsRef.current).forEach((u) => URL.revokeObjectURL(u));
      const au = answerBlobUrlRef.current;
      if (au) URL.revokeObjectURL(au);
      if (bookmarkErrorTimerRef.current) clearTimeout(bookmarkErrorTimerRef.current);
    };
  }, []);

  const refresh = React.useCallback(async () => {
    const t = getToken();
    if (!t) return;
    const [up, tut] = await Promise.all([apiListUploads(t), apiListTutorSessions(t)]);
    setUploads(up.uploads);
    setSessions(tut.sessions);
    setMaxSessions(tut.maxSessions);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        setUploads([]);
        setSessions([]);
      } finally {
        setLoadingLists(false);
      }
    })();
  }, [refresh]);

  const completed = uploads.filter((u) => u.status === "completed");

  React.useEffect(() => {
    if (!selectedUploadId && completed.length > 0) {
      setSelectedUploadId(completed[0].id);
    }
  }, [completed, selectedUploadId]);

  function stopQuestionMicStream() {
    questionMicStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    questionMicStreamRef.current = null;
  }

  async function stopCam() {
    if (focusTimerRef.current) {
      clearInterval(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    stopQuestionMicStream();
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamOn(false);
    setFocus(null);
  }

  React.useEffect(() => {
    return () => {
      void stopCam();
    };
  }, []);

  async function startCam() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play();
      }
      setCamOn(true);
    } catch {
      setError("Camera (and mic for questions) permission is required for focus detection and voice Q&A.");
    }
  }

  React.useEffect(() => {
    if (showGroupFlow || !alertSounds || !camOn) return;
    const Ctor =
      typeof window !== "undefined" &&
      (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return;
    const ctx = new Ctor();
    const id = window.setInterval(() => {
      const f = focusRef.current;
      if (!f) return;
      if (f.status === "BAD FRAME") return;
      if (f.status === "CALIBRATING" || f.focusVal === null) return;
      if (f.status === "FOCUSED" && !f.alarm) return;
      const urgent =
        f.alarm ||
        !f.faceFound ||
        f.status === "NO FACE" ||
        f.status === "NOT FOCUSED" ||
        f.status === "WAKE UP" ||
        f.status === "HEAD DOWN" ||
        f.status === "PLEASE BLINK";
      const soft = f.status === "DISTRACTED";
      if (!urgent && !soft) return;
      if (soft && !urgent) {
        softBeepTickRef.current += 1;
        if (softBeepTickRef.current % 3 !== 0) return;
      } else {
        softBeepTickRef.current = 0;
      }
      void ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = urgent ? 880 : 520;
      g.gain.value = urgent ? 0.11 : 0.055;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (urgent ? 0.12 : 0.08));
    }, 400);
    return () => {
      window.clearInterval(id);
      void ctx.close();
    };
  }, [alertSounds, camOn, showGroupFlow]);

  async function captureFrame(): Promise<Blob | null> {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return null;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    return new Promise((resolve) => {
      c.toBlob((b) => resolve(b), "image/jpeg", 0.72);
    });
  }

  React.useEffect(() => {
    if (showGroupFlow || !activeSession || !camOn) {
      if (focusTimerRef.current) {
        clearInterval(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      return;
    }

    const sid = activeSession.id;
    const t = getToken();
    if (!t) return;

    const tick = async () => {
      const blob = await captureFrame();
      if (!blob) return;
      try {
        const f = await apiTutorFocusAnalyze(t, sid, blob);
        setFocus(f);
      } catch {
        /* avoid spamming UI */
      }
    };

    void tick();
    focusTimerRef.current = setInterval(() => void tick(), 480);

    return () => {
      if (focusTimerRef.current) {
        clearInterval(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, [activeSession, camOn, showGroupFlow]);

  React.useEffect(() => {
    const s = activeSession;
    const tok = getToken();
    if (!s || !tok) return;
    const n = s.slides.length;
    const want = [slideIndex, slideIndex + 1, slideIndex - 1].filter((i) => i >= 0 && i < n);
    let cancelled = false;
    void (async () => {
      const gid = groupIdRef.current;
      const live = groupSyncRef.current.live;
      for (const i of want) {
        if (cancelled) break;
        const key = `${s.id}:${i}`;
        if (narrationUrlsRef.current[key]) continue;
        try {
          const url =
            gid && live
              ? await apiFetchGroupSlideAudioBlobUrl(tok, gid, i)
              : await apiFetchTutorSlideAudioBlobUrl(tok, s.id, i);
          if (cancelled) {
            URL.revokeObjectURL(url);
            break;
          }
          setNarrationUrls((prev) => (prev[key] ? prev : { ...prev, [key]: url }));
        } catch {
          /* prefetch optional */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, slideIndex, activeSession?.slides.length, groupId, isGroupLive]);

  React.useEffect(() => {
    setEli5Script(null);
    setEli5ForSlideIndex(null);
    setNarrationUrls((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (k.includes(":eli5")) {
          URL.revokeObjectURL(next[k]!);
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [slideIndex, activeSession?.id]);

  async function openSession(s: TutorSessionDTO, opts?: { groupGuest?: boolean }) {
    stopNarration();
    setError(null);
    setTutorView("lecture");
    setNarrationBulletIndex(null);
    setAnswerBulletIndex(null);
    setLastQa(null);
    if (answerAudioUrl) {
      URL.revokeObjectURL(answerAudioUrl);
      setAnswerAudioUrl(null);
    }
    setActiveSession(s);
    setSlideIndex(0);
    setFocus(null);
    const t = getToken();
    if (t && !opts?.groupGuest) {
      try {
        await apiTutorFocusReset(t, s.id);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Could not reset focus tracking. Try again in a moment or refresh the page.",
        );
      }
    }
    if (!opts?.groupGuest && !camOn) await startCam();
  }

  function emitHostLesson(payload: Record<string, unknown>) {
    const g = groupSyncRef.current;
    if (!g.host || !g.live) return;
    const sock = groupSocketRef.current;
    if (!sock?.connected) return;
    sock.emit("lesson:host_sync", payload);
  }

  function emitGroupQuestionStartedSignal() {
    if (!groupIdRef.current || !groupSyncRef.current.live) return;
    groupSocketRef.current?.emit("group:question_started");
  }

  function emitGroupQuestionAbortedSignal() {
    if (!groupIdRef.current || !groupSyncRef.current.live) return;
    groupSocketRef.current?.emit("group:question_aborted");
  }

  async function refreshGroupDetail() {
    const t = getToken();
    const gid = groupIdRef.current;
    if (!t || !gid) return;
    try {
      const { group } = await apiGetTutorGroup(t, gid);
      setGroupDetail(group);
      if (group.status === "live") {
        const cur = activeSessionRef.current;
        if (!cur || cur.id !== group.tutorSessionId) {
          const { session } = await apiGetTutorGroupSession(t, gid);
          await openSession(session, { groupGuest: !group.isHost });
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function createGroupWithSelectedFriends() {
    const t = getToken();
    const s = activeSession;
    if (!t || !s || groupInviteBusy) return;
    if (selectedGroupFriendIds.length < 1 || selectedGroupFriendIds.length > 3) {
      setError("Choose 1 to 3 friends for group study.");
      return;
    }
    setGroupInviteBusy(true);
    setError(null);
    try {
      const { group } = await apiCreateTutorGroup(t, {
        tutorSessionId: s.id,
        friendUserIds: selectedGroupFriendIds,
      });
      setGroupId(group.id);
      setGroupDetail(group);
      setSelectedGroupFriendIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create group.");
    } finally {
      setGroupInviteBusy(false);
    }
  }

  React.useEffect(() => {
    const t = getToken();
    if (!t) return;
    void apiListFriends(t)
      .then((r) => setFriendsList(r.friends))
      .catch(() => setFriendsList([]));
  }, []);

  React.useEffect(() => {
    const g = searchParams.get("group");
    if (!g || groupUrlBootstrapped) return;
    setGroupUrlBootstrapped(true);
    setGroupId(g);
    void (async () => {
      const t = getToken();
      if (!t) return;
      try {
        const { group } = await apiGetTutorGroup(t, g);
        if (group.status === "ended" || group.status === "cancelled") {
          setGroupUrlBootstrapped(false);
          setGroupId(null);
          setGroupDetail(null);
          setError(
            group.status === "cancelled"
              ? "This group invite is no longer available."
              : "This group study session has already ended.",
          );
          if (group.status === "ended") {
            queueDashboardGroupEndedNotice(group.isHost ? "host" : "guest");
            router.replace("/dashboard");
          } else {
            router.replace("/tutor");
          }
          return;
        }
        setGroupDetail(group);
        if (group.status === "live") {
          const { session } = await apiGetTutorGroupSession(t, g);
          await openSession(session, { groupGuest: !group.isHost });
        }
      } catch (e) {
        setGroupUrlBootstrapped(false);
        setError(e instanceof Error ? e.message : "Could not load group invite.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot URL bootstrap
  }, [searchParams, groupUrlBootstrapped, router]);

  React.useEffect(() => {
    if (!groupId || !isGroupGathering) return;
    void refreshGroupDetail();
    const id = window.setInterval(() => void refreshGroupDetail(), 2000);
    return () => window.clearInterval(id);
  }, [groupId, isGroupGathering]);

  React.useEffect(() => {
    if (!groupId || !isGroupLive) return;
    const t = getToken();
    if (!t) return;
    const socket = io(API_BASE, {
      path: "/socket.io/",
      transports: ["websocket", "polling"],
      auth: { token: t },
    });
    groupSocketRef.current = socket;
    socket.on("connect", () => {
      socket.emit(
        "group:join",
        { groupId },
        (r: { ok?: boolean; chatMessages?: TutorGroupChatMessageDTO[] }) => {
          if (r?.ok && Array.isArray(r.chatMessages)) {
            setGroupChatMessages(r.chatMessages);
          }
        },
      );
    });
    socket.on("lesson:follow", (payload: { kind?: string; slideIndex?: number }) => {
      if (groupSyncRef.current.host) return;
      groupApplyingRemoteRef.current = true;
      try {
        const k = payload?.kind;
        const idx =
          typeof payload?.slideIndex === "number"
            ? payload.slideIndex
            : slideIndexRef.current;
        if (k === "slide") lessonHandlersRef.current.setSlideIndex(idx);
        if (k === "play") {
          lessonHandlersRef.current.setSlideIndex(idx);
          lessonHandlersRef.current.playNarration(idx);
        }
        if (k === "pause" || k === "stop") lessonHandlersRef.current.stopNarration();
      } finally {
        queueMicrotask(() => {
          groupApplyingRemoteRef.current = false;
        });
      }
    });
    socket.on("group:media_pause", (p: { byUserId?: string }) => {
      if (!p?.byUserId || p.byUserId === myUserIdRef.current) return;
      groupApplyingRemoteRef.current = true;
      try {
        lessonHandlersRef.current.stopNarration();
        lessonHandlersRef.current.pauseAnswer();
      } finally {
        queueMicrotask(() => {
          groupApplyingRemoteRef.current = false;
        });
      }
    });
    socket.on("group:media_resume_after_question", (p: { byUserId?: string }) => {
      if (!p?.byUserId || p.byUserId === myUserIdRef.current) return;
      if (tutorViewRef.current === "qa") return;
      if (playingAnswerRef.current) return;
      void lessonHandlersRef.current.playNarration(slideIndexRef.current);
    });
    socket.on(
      "group:qa",
      (p: { askerId?: string; askerName?: string; question: string; answer: string }) => {
        if (p.askerId && p.askerId === myUserIdRef.current) return;
        setLastQa({ question: p.question, answer: p.answer, askerName: p.askerName });
        setTutorView("qa");
        const bullets = parseAnswerIntoBullets(p.answer);
        void lessonHandlersRef.current.playAnswerTts(p.answer, bullets);
      },
    );
    socket.on("group:chat_message", (msg: TutorGroupChatMessageDTO) => {
      setGroupChatMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });
    socket.on("group:ended", () => {
      setGroupChatMessages([]);
      setGroupChatDraft("");
      setGroupId(null);
      setGroupDetail(null);
      setGroupUrlBootstrapped(false);
      queueDashboardGroupEndedNotice(isGroupHostRef.current ? "host" : "guest");
      router.replace("/dashboard");
    });
    socket.on("group:status", () => {
      void refreshGroupDetail();
    });
    return () => {
      socket.disconnect();
      groupSocketRef.current = null;
    };
  }, [groupId, isGroupLive, router]);

  React.useEffect(() => {
    if (!groupDetail || groupDetail.status !== "ended") return;
    const wasHost = groupDetail.isHost;
    setGroupChatMessages([]);
    setGroupChatDraft("");
    setGroupId(null);
    setGroupDetail(null);
    setGroupUrlBootstrapped(false);
    queueDashboardGroupEndedNotice(wasHost ? "host" : "guest");
    router.replace("/dashboard");
  }, [groupDetail?.status, groupDetail?.id, groupDetail?.isHost, router]);

  React.useEffect(() => {
    if (!isGroupLive) return;
    const el = groupChatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [groupChatMessages.length, isGroupLive]);

  React.useEffect(() => {
    if (!showGroupFlow || !activeSession) return;
    void stopCam();
  }, [showGroupFlow, activeSession?.id]);

  async function onCreateSession() {
    setError(null);
    const t = getToken();
    if (!t) return;
    if (!selectedUploadId) {
      setError("Choose a completed upload first.");
      return;
    }
    setCreating(true);
    try {
      const { session } = await apiCreateTutorSession(t, {
        uploadId: selectedUploadId,
        topicFocus: topicFocus.trim() || undefined,
      });
      setSessions((prev) => [session, ...prev]);
      await openSession(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create tutor session.");
    } finally {
      setCreating(false);
    }
  }

  async function onDeleteSession(id: string) {
    setError(null);
    const t = getToken();
    if (!t) return;
    try {
      await apiDeleteTutorSession(t, id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSession?.id === id) {
        setActiveSession(null);
        void stopCam();
      }
      const prefix = `${id}:`;
      setNarrationUrls((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (k.startsWith(prefix)) {
            URL.revokeObjectURL(next[k]!);
            delete next[k];
          }
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete session.");
    }
  }

  const slide = activeSession?.slides[slideIndex];

  const saveBookmarkFromSubtitle = React.useCallback(
    async (source: "narration" | "qa_answer") => {
      if (!activeSession) return;
      let lineText = "";
      if (source === "narration") {
        if (eli5ForSlideIndex === slideIndex && eli5Script?.trim()) {
          lineText = eli5Script.trim();
        } else {
          lineText = (slide?.script ?? "").trim();
        }
      } else {
        lineText = (lastQa?.answer ?? "").trim();
      }
      if (!lineText) return;
      const t = getToken();
      if (!t) return;
      setBookmarkNotice(null);
      if (bookmarkErrorTimerRef.current) {
        clearTimeout(bookmarkErrorTimerRef.current);
        bookmarkErrorTimerRef.current = null;
      }
      setError(null);
      setBookmarkSaving(source);
      try {
        await apiCreateConceptBookmark(t, {
          sourceUploadId: activeSession.sourceUploadId,
          lineText,
          tutorSessionId: activeSession.id,
          slideIndex,
          slideTitle: slide?.title ?? "",
          subtitleSource: source,
        });
        setBookmarkNotice("Saved to Bookmarks — view under Bookmarks in the header.");
        window.setTimeout(() => setBookmarkNotice(null), 3200);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not save bookmark.";
        setError(msg);
        if (/already bookmarked/i.test(msg)) {
          bookmarkErrorTimerRef.current = setTimeout(() => {
            setError((cur) => (cur === msg ? null : cur));
            bookmarkErrorTimerRef.current = null;
          }, 4200);
        }
      } finally {
        setBookmarkSaving(null);
      }
    },
    [activeSession, slideIndex, slide?.title, eli5ForSlideIndex, eli5Script, lastQa],
  );

  const narrationBookmarkText =
    eli5ForSlideIndex === slideIndex && eli5Script?.trim()
      ? eli5Script.trim()
      : (slide?.script ?? "").trim();

  function clearAudioHandlers() {
    cancelSubtitleRaf();
    const a = audioRef.current;
    if (!a) return;
    a.onended = null;
    a.ontimeupdate = null;
    a.onloadedmetadata = null;
    a.onplay = null;
  }

  function bookmarkCurrentAudioProgress() {
    const a = audioRef.current;
    const s = activeSessionRef.current;
    if (!a || !s) return;
    if (audioRoleRef.current === "slide" && playingSlideRef.current !== null && !a.ended) {
      const key = `${s.id}:${playingSlideRef.current}`;
      narrationProgressRef.current[key] = a.currentTime;
    }
  }

  /** Stop all playback and revoke answer audio so Q&A recording starts from a clean state. */
  function haltAllMediaForQuestion() {
    setNarrationLoading(false);
    const a = audioRef.current;
    const s = activeSessionRef.current;

    if (a && s && audioRoleRef.current === "slide" && playingSlideRef.current !== null && !a.ended) {
      const idx = playingSlideRef.current;
      const key = `${s.id}:${idx}`;
      narrationProgressRef.current[key] = a.currentTime;
      lectureResumeRef.current = { slideIndex: idx, key, time: a.currentTime };
    }

    const au = answerBlobUrlRef.current;
    if (au) {
      URL.revokeObjectURL(au);
      answerBlobUrlRef.current = null;
    }
    setAnswerAudioUrl(null);
    lastAnswerTtsTextRef.current = "";
    answerResumeTimeRef.current = 0;
    setAnswerPaused(false);
    answerStepSyncActiveRef.current = false;
    qaAnswerWhiteboardRef.current?.fillAllBullets();

    cancelSubtitleRaf();
    clearAudioHandlers();
    audioRoleRef.current = null;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setPlayingSlide(null);
    setPlayingAnswer(false);
    setNarrationSubtitleLine("");
    setAnswerSubtitleLine("");
    setNarrationBulletIndex(null);
    setAnswerBulletIndex(null);
  }

  function pauseAnswerPlayback() {
    const a = audioRef.current;
    if (!a || audioRoleRef.current !== "answer") return;
    if (!playingAnswer) return;
    answerResumeTimeRef.current = a.currentTime;
    a.pause();
    cancelSubtitleRaf();
    setPlayingAnswer(false);
    setAnswerPaused(true);
  }

  /** Pause whatever is on the audio element but keep answer blob URLs for later replay. */
  function haltPlaybackForEli5() {
    const a = audioRef.current;
    const s = activeSessionRef.current;
    if (a && s && audioRoleRef.current === "slide" && playingSlideRef.current !== null && !a.ended) {
      const idx = playingSlideRef.current;
      narrationProgressRef.current[`${s.id}:${idx}`] = a.currentTime;
    }
    if (a && audioRoleRef.current === "answer") {
      answerResumeTimeRef.current = a.currentTime;
      setAnswerPaused(true);
      setPlayingAnswer(false);
    }
    lectureResumeRef.current = null;
    answerStepSyncActiveRef.current = false;
    qaAnswerWhiteboardRef.current?.fillAllBullets();
    cancelSubtitleRaf();
    clearAudioHandlers();
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    audioRoleRef.current = null;
    setPlayingSlide(null);
    setNarrationSubtitleLine("");
    setAnswerSubtitleLine("");
    setNarrationBulletIndex(null);
    setAnswerBulletIndex(null);
  }

  async function playOneShotAck(ackObjectUrl: string): Promise<void> {
    const a = audioRef.current;
    if (!a) {
      URL.revokeObjectURL(ackObjectUrl);
      return;
    }
    try {
      cancelSubtitleRaf();
      clearAudioHandlers();
      audioRoleRef.current = null;
      a.pause();
      a.src = ackObjectUrl;
      await new Promise<void>((resolve, reject) => {
        a.onended = () => {
          a.onended = null;
          a.onerror = null;
          resolve();
        };
        a.onerror = () => {
          a.onended = null;
          a.onerror = null;
          reject(new Error("Ack audio failed"));
        };
        void a.play().catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
      });
    } finally {
      URL.revokeObjectURL(ackObjectUrl);
      a.pause();
      a.onended = null;
      a.onerror = null;
      a.removeAttribute("src");
      a.load();
    }
  }

  async function startExplainLikeImFive() {
    const s = activeSession;
    const t = getToken();
    if (!s || !t || eli5Busy || questionSubmitting) return;
    const idx = slideIndex;
    const slide = s.slides[idx];
    if (!slide) return;
    setEli5Busy(true);
    setError(null);
    try {
      haltPlaybackForEli5();
      const eli5Promise = apiTutorSlideEli5(t, s.id, idx);
      const ackUrl = await apiFetchTutorTtsBlobUrl(t, ELI5_ACK_TEXT);
      const [eli5Res] = await Promise.all([eli5Promise, playOneShotAck(ackUrl)]);
      setEli5Script(eli5Res.script);
      setEli5ForSlideIndex(idx);
      const key = `${s.id}:${idx}`;
      narrationProgressRef.current[key] = 0;
      setNarrationUrls((prev) => {
        const k = `${key}:eli5`;
        if (!prev[k]) return prev;
        const next = { ...prev };
        URL.revokeObjectURL(next[k]!);
        delete next[k];
        return next;
      });
      await playNarration(idx, { scriptOverride: eli5Res.script, treatAsEli5: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare a simpler explanation.");
    } finally {
      setEli5Busy(false);
    }
  }

  async function playNarration(
    idx: number,
    opts?: { scriptOverride?: string; treatAsEli5?: boolean },
  ) {
    const s = activeSession;
    const t = getToken();
    if (!s || !t) return;
    const key = `${s.id}:${idx}`;
    const slideScript = s.slides[idx]?.script ?? "";
    const scriptText =
      opts?.scriptOverride !== undefined && opts.scriptOverride.length > 0
        ? opts.scriptOverride
        : eli5ForSlideIndex === idx && eli5Script
          ? eli5Script
          : slideScript;
    const isEli5Track =
      opts?.treatAsEli5 === true ||
      (eli5ForSlideIndex === idx && eli5Script !== null && scriptText === eli5Script);
    const audioKey = isEli5Track ? `${key}:eli5` : key;
    setNarrationLoading(true);
    setPlayingSlide(idx);
    setPlayingAnswer(false);
    setAnswerPaused(false);
    setAnswerSubtitleLine("");
    setError(null);
    const words = tokenizeScript(scriptText);
    setNarrationSubtitleLine("");
    setTutorView("lecture");
    setNarrationBulletIndex(null);
    setAnswerBulletIndex(null);
    const slideForSync = s.slides[idx];
    const points = slideForSync?.points ?? [];
    const segmentRanges = wordRangesForBulletSync(scriptText, points);
    const savedBeforeLoad = narrationProgressRef.current[audioKey] ?? 0;
    const useLectureStepSync = !isEli5Track && points.length > 0 && savedBeforeLoad <= 0.25;
    try {
      let url = narrationUrlsRef.current[audioKey];
      if (!url) {
        const gid = groupIdRef.current;
        const glive = groupSyncRef.current.live;
        url = isEli5Track
          ? glive && gid
            ? await apiFetchGroupTtsBlobUrl(t, gid, scriptText)
            : await apiFetchTutorTtsBlobUrl(t, scriptText)
          : glive && gid
            ? await apiFetchGroupSlideAudioBlobUrl(t, gid, idx)
            : await apiFetchTutorSlideAudioBlobUrl(t, s.id, idx);
        setNarrationUrls((prev) => ({ ...prev, [audioKey]: url! }));
      }
      const a = audioRef.current;
      if (a) {
        clearAudioHandlers();
        audioRoleRef.current = "slide";
        a.src = url;
        const saved = narrationProgressRef.current[audioKey] ?? 0;

        const onReady = () => {
          const dur = a.duration;
          if (saved > 0.2 && Number.isFinite(dur) && dur > 0 && saved < dur - 0.12) {
            a.currentTime = saved;
          }
          attachPlaybackSyncRaf(a, words, setNarrationSubtitleLine, {
            segmentRanges,
            setActiveSegment: setNarrationBulletIndex,
          });
        };

        await new Promise<void>((resolve, reject) => {
          if (a.readyState >= 1) {
            onReady();
            resolve();
          } else {
            a.onloadedmetadata = () => {
              a.onloadedmetadata = null;
              onReady();
              resolve();
            };
            a.onerror = () => {
              a.onloadedmetadata = null;
              reject(new Error("Could not load narration audio"));
            };
          }
        });

        a.ontimeupdate = () => {
          narrationProgressRef.current[audioKey] = a.currentTime;
        };
        a.onended = () => {
          lectureStepSyncActiveRef.current = false;
          clearAudioHandlers();
          audioRoleRef.current = null;
          setPlayingSlide(null);
          setNarrationSubtitleLine("");
          setNarrationBulletIndex(null);
          narrationProgressRef.current[audioKey] = 0;
          if (!autoAdvanceRef.current) return;
          const sess = activeSessionRef.current;
          if (!sess) return;
          const next = idx + 1;
          if (next < sess.slides.length) {
            setSlideIndex(next);
            void playNarration(next);
          }
        };

        if (useLectureStepSync) {
          lectureStepSyncActiveRef.current = true;
          lastHandwritingBulletRef.current = null;
          lectureWhiteboardRef.current?.reset();
        } else {
          lectureStepSyncActiveRef.current = false;
          lastHandwritingBulletRef.current = null;
          lectureWhiteboardRef.current?.reset();
          lectureWhiteboardRef.current?.fillAllBullets();
        }

        await a.play();
        if (
          groupSyncRef.current.host &&
          groupSyncRef.current.live &&
          !groupApplyingRemoteRef.current
        ) {
          emitHostLesson({ kind: "play", slideIndex: idx });
        }
      }
    } catch (e) {
      lectureStepSyncActiveRef.current = false;
      clearAudioHandlers();
      audioRoleRef.current = null;
      setPlayingSlide(null);
      setNarrationSubtitleLine("");
      setNarrationBulletIndex(null);
      setError(
        e instanceof Error
          ? e.message
          : "Could not play narration. Make sure the tutor voice helper is running, then try again.",
      );
    } finally {
      setNarrationLoading(false);
    }
  }

  async function resumeLectureAfterAnswer() {
    setTutorView("lecture");
    setAnswerBulletIndex(null);
    const saved = lectureResumeRef.current;
    lectureResumeRef.current = null;
    if (!saved) return;
    if (slideIndexRef.current !== saved.slideIndex) return;
    if (!narrationUrlsRef.current[saved.key]) return;
    narrationProgressRef.current[saved.key] = saved.time;
    await playNarration(saved.slideIndex);
  }

  function stopNarration() {
    if (
      groupSyncRef.current.host &&
      groupSyncRef.current.live &&
      !groupApplyingRemoteRef.current
    ) {
      emitHostLesson({ kind: "stop" });
    }
    bookmarkCurrentAudioProgress();
    lectureResumeRef.current = null;
    lectureStepSyncActiveRef.current = false;
    answerStepSyncActiveRef.current = false;
    qaAnswerWhiteboardRef.current?.fillAllBullets();
    const au = answerBlobUrlRef.current;
    if (au) {
      URL.revokeObjectURL(au);
      answerBlobUrlRef.current = null;
    }
    setAnswerAudioUrl(null);
    lastAnswerTtsTextRef.current = "";
    answerResumeTimeRef.current = 0;
    setAnswerPaused(false);
    const a = audioRef.current;
    clearAudioHandlers();
    audioRoleRef.current = null;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setPlayingSlide(null);
    setPlayingAnswer(false);
    setNarrationSubtitleLine("");
    setAnswerSubtitleLine("");
    setNarrationBulletIndex(null);
    setAnswerBulletIndex(null);
  }

  async function playAnswerTts(
    text: string,
    opts?: { onEnded?: () => void; bullets?: string[] },
  ) {
    const tok = getToken();
    if (!tok) return;
    const a = audioRef.current;
    if (!a) return;

    const answerBullets =
      opts?.bullets && opts.bullets.length > 0 ? opts.bullets : parseAnswerIntoBullets(text);
    const answerRanges = wordRangesForBulletSync(text, answerBullets);

    const applyQaAnswerHandwritingMode = (seekSeconds: number) => {
      const useSync = answerBullets.length > 0 && seekSeconds <= 0.25;
      answerStepSyncActiveRef.current = useSync;
      lastQaAnswerHandwritingRef.current = null;
      setAnswerBulletIndex(null);
      if (useSync) {
        qaAnswerWhiteboardRef.current?.reset();
      } else {
        qaAnswerWhiteboardRef.current?.fillAllBullets();
      }
    };

    const bufferedSame = !!answerBlobUrlRef.current && lastAnswerTtsTextRef.current === text;
    if (bufferedSame) {
      if (!a.paused && !a.ended) return;
      if (audioRoleRef.current === "slide") {
        a.pause();
        cancelSubtitleRaf();
      }
      clearAudioHandlers();
      setPlayingSlide(null);
      setNarrationSubtitleLine("");
      const words = tokenizeScript(text);
      setPlayingAnswer(true);
      setAnswerPaused(false);
      audioRoleRef.current = "answer";
      if (!a.src && answerBlobUrlRef.current) {
        a.src = answerBlobUrlRef.current;
      }
      const resumeT = answerResumeTimeRef.current;
      const seekTo = a.ended || resumeT < 0.12 ? 0 : resumeT;
      applyQaAnswerHandwritingMode(seekTo);
      const onReady = () => {
        const dur = a.duration;
        if (Number.isFinite(dur) && dur > 0.1) {
          a.currentTime = Math.min(Math.max(0, seekTo), dur - 0.05);
        } else if (seekTo > 0) {
          a.currentTime = seekTo;
        }
        attachPlaybackSyncRaf(a, words, setAnswerSubtitleLine, {
          segmentRanges: answerRanges,
          setActiveSegment: setAnswerBulletIndex,
        });
      };
      if (a.readyState >= 1) {
        onReady();
      } else {
        a.onloadedmetadata = () => {
          a.onloadedmetadata = null;
          onReady();
        };
      }
      a.ontimeupdate = () => {
        answerResumeTimeRef.current = a.currentTime;
      };
      a.onended = () => {
        clearAudioHandlers();
        audioRoleRef.current = null;
        answerStepSyncActiveRef.current = false;
        qaAnswerWhiteboardRef.current?.fillAllBullets();
        setPlayingAnswer(false);
        setAnswerPaused(false);
        setAnswerSubtitleLine("");
        setAnswerBulletIndex(null);
        answerResumeTimeRef.current = 0;
        opts?.onEnded?.();
      };
      try {
        await a.play();
      } catch {
        setPlayingAnswer(false);
        setAnswerPaused(true);
      }
      return;
    }

    const auOld = answerBlobUrlRef.current;
    if (auOld) {
      URL.revokeObjectURL(auOld);
      answerBlobUrlRef.current = null;
    }
    setAnswerAudioUrl(null);

    const aSlide = audioRef.current;
    if (aSlide && audioRoleRef.current === "slide") {
      aSlide.pause();
      cancelSubtitleRaf();
    }
    clearAudioHandlers();

    setPlayingSlide(null);
    setNarrationSubtitleLine("");
    const words = tokenizeScript(text);
    setAnswerSubtitleLine("");
    lastAnswerTtsTextRef.current = text;
    answerResumeTimeRef.current = 0;
    applyQaAnswerHandwritingMode(0);
    try {
      const gid = groupIdRef.current;
      const glive = groupSyncRef.current.live;
      const url =
        gid && glive
          ? await apiFetchGroupTtsBlobUrl(tok, gid, text)
          : await apiFetchTutorTtsBlobUrl(tok, text);
      answerBlobUrlRef.current = url;
      setAnswerAudioUrl(url);
      const ap = audioRef.current;
      if (ap) {
        audioRoleRef.current = "answer";
        setPlayingAnswer(true);
        setAnswerPaused(false);
        ap.src = url;
        const onReady = () => {
          attachPlaybackSyncRaf(ap, words, setAnswerSubtitleLine, {
            segmentRanges: answerRanges,
            setActiveSegment: setAnswerBulletIndex,
          });
        };
        if (ap.readyState >= 1) {
          onReady();
        } else {
          ap.onloadedmetadata = () => {
            ap.onloadedmetadata = null;
            onReady();
          };
        }
        ap.ontimeupdate = () => {
          answerResumeTimeRef.current = ap.currentTime;
        };
        ap.onended = () => {
          clearAudioHandlers();
          audioRoleRef.current = null;
          answerStepSyncActiveRef.current = false;
          qaAnswerWhiteboardRef.current?.fillAllBullets();
          setPlayingAnswer(false);
          setAnswerPaused(false);
          setAnswerSubtitleLine("");
          setAnswerBulletIndex(null);
          answerResumeTimeRef.current = 0;
          opts?.onEnded?.();
        };
        await ap.play();
      }
    } catch (e) {
      answerStepSyncActiveRef.current = false;
      qaAnswerWhiteboardRef.current?.fillAllBullets();
      setPlayingAnswer(false);
      setAnswerSubtitleLine("");
      setAnswerBulletIndex(null);
      lastAnswerTtsTextRef.current = "";
      setError(e instanceof Error ? e.message : "Could not play answer audio.");
      opts?.onEnded?.();
    }
  }

  function buildMediaRecorder(stream: MediaStream): MediaRecorder | null {
    if (typeof MediaRecorder === "undefined") return null;
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
    ];
    for (const mimeType of types) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try {
        return new MediaRecorder(stream, { mimeType });
      } catch {
        continue;
      }
    }
    try {
      return new MediaRecorder(stream);
    } catch {
      return null;
    }
  }

  async function toggleQuestionRecording() {
    if ((!camOn && !isGroupLive) || questionSubmitting) return;
    if (asking) {
      await finishQuestionRecording();
      return;
    }
    await startAskRecording();
  }

  async function startAskRecording() {
    if (typeof MediaRecorder === "undefined") {
      setError("This browser does not support recording your question here. Try a recent desktop browser.");
      return;
    }
    if (asking) return;
    setError(null);
    haltAllMediaForQuestion();
    setLastQa(null);
    recordChunksRef.current = [];
    stopQuestionMicStream();

    const attachAndStart = (stream: MediaStream, fromDedicatedMic: boolean): boolean => {
      const rec = buildMediaRecorder(stream);
      if (!rec) return false;
      try {
        rec.ondataavailable = (ev) => {
          if (ev.data.size) recordChunksRef.current.push(ev.data);
        };
        rec.start(200);
        recorderRef.current = rec;
        if (fromDedicatedMic) questionMicStreamRef.current = stream;
        setAsking(true);
        return true;
      } catch {
        return false;
      }
    };

    const combined = streamRef.current;
    if (combined?.getAudioTracks().length) {
      if (attachAndStart(combined, false)) {
        emitGroupQuestionStartedSignal();
        return;
      }
    }

    try {
      const audioOnly = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (attachAndStart(audioOnly, true)) {
        emitGroupQuestionStartedSignal();
        return;
      }
      audioOnly.getTracks().forEach((tr) => tr.stop());
    } catch {
      setError(
        isGroupLive
          ? "We could not use the microphone. Allow mic access for this site or try another browser."
          : "We could not use the microphone. Allow mic access for this site, turn the camera on first, or try another browser.",
      );
      return;
    }

    setError("Recording could not start. Try another browser or refresh the page.");
  }

  async function finishQuestionRecording() {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") {
      setAsking(false);
      stopQuestionMicStream();
      return;
    }
    const t = getToken();
    const s = activeSession;
    const idx = slideIndex;
    await new Promise<void>((resolve) => {
      rec.addEventListener("stop", () => resolve(), { once: true });
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
    setAsking(false);
    recorderRef.current = null;
    stopQuestionMicStream();
    if (!t || !s) return;
    await new Promise<void>((r) => setTimeout(r, 80));
    const chunks = recordChunksRef.current;
    recordChunksRef.current = [];
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    if (blob.size < 32) {
      setError("Recording too short — tap Record, speak, then tap Stop & send when you are done.");
      emitGroupQuestionAbortedSignal();
      void resumeLectureAfterAnswer();
      return;
    }
    setError(null);
    setQuestionSubmitting(true);
    setTutorView("qa");
    try {
      const gid = groupIdRef.current;
      const glive = groupSyncRef.current.live;
      const qa =
        gid && glive
          ? await apiGroupTutorAsk(t, { groupId: gid, slideIndex: idx, audio: blob })
          : await apiTutorAsk(t, { sessionId: s.id, slideIndex: idx, audio: blob });
      setLastQa({ question: qa.question, answer: qa.answer });
      const bullets = parseAnswerIntoBullets(qa.answer);
      await playAnswerTts(qa.answer, {
        bullets,
        onEnded: () => void resumeLectureAfterAnswer(),
      });
    } catch (e) {
      setTutorView("lecture");
      setError(e instanceof Error ? e.message : "Could not process your question.");
      emitGroupQuestionAbortedSignal();
      void resumeLectureAfterAnswer();
    } finally {
      setQuestionSubmitting(false);
    }
  }

  async function acceptGroupInvite() {
    const t = getToken();
    const id = groupIdRef.current;
    if (!t || !id || groupInviteBusy) return;
    setGroupInviteBusy(true);
    setError(null);
    try {
      await apiAcceptTutorGroup(t, id);
      await refreshGroupDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept invite.");
    } finally {
      setGroupInviteBusy(false);
    }
  }

  async function declineGroupInvite() {
    const t = getToken();
    const id = groupIdRef.current;
    if (!t || !id) return;
    try {
      await apiDeclineTutorGroup(t, id);
    } catch {
      /* still leave */
    }
    setGroupChatMessages([]);
    setGroupChatDraft("");
    setGroupId(null);
    setGroupDetail(null);
    setGroupUrlBootstrapped(false);
    router.replace("/tutor");
  }

  async function endGroupSessionForHost() {
    const t = getToken();
    const id = groupId;
    if (!t || !id || !isGroupHost || endGroupBusy) return;
    setEndGroupBusy(true);
    setError(null);
    try {
      await apiEndTutorGroup(t, id);
      setGroupChatMessages([]);
      setGroupChatDraft("");
      setGroupId(null);
      setGroupDetail(null);
      setGroupUrlBootstrapped(false);
      queueDashboardGroupEndedNotice("host");
      router.replace("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not end the group session.");
    } finally {
      setEndGroupBusy(false);
    }
  }

  function sendGroupChatMessage() {
    const text = groupChatDraft.trim();
    if (!text || groupChatSending) return;
    const sock = groupSocketRef.current;
    if (!sock?.connected) {
      setError("Reconnecting to the group… try again in a moment.");
      return;
    }
    setGroupChatSending(true);
    sock.emit(
      "group:chat_send",
      { text },
      (r: { ok?: boolean; error?: string }) => {
        setGroupChatSending(false);
        if (r?.ok) setGroupChatDraft("");
        else if (r?.error) setError(r.error);
      },
    );
  }

  const pendingInviteeCount =
    groupDetail?.inviteeUserIds.filter((uid) => !groupDetail.acceptedUserIds.includes(uid)).length ?? 0;

  const showGroupLobby = !!groupDetail && isGroupGathering && !needsGroupAccept;
  const showLessonGrid = !!activeSession && (!groupId || !isGroupGathering);
  const groupControlsLocked = isGroupLive && !isGroupHost;

  lessonHandlersRef.current = {
    playNarration: (i: number) => void playNarration(i),
    stopNarration,
    pauseAnswer: pauseAnswerPlayback,
    playAnswerTts: (text: string, bullets?: string[]) =>
      void playAnswerTts(text, bullets?.length ? { bullets } : undefined),
    setSlideIndex: (i: number) => setSlideIndex(i),
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />
      <main className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">AI tutor room</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Acadomi turns your own study notes into a calm, guided lesson you can listen to like a video call.
            Pick material you have already uploaded, open a session, and let the tutor talk you through each
            slide. Your camera helps us cheer you on when you stay with it—and gently nudge you when attention
            drifts. Ask a question out loud anytime; the tutor answers in plain language.
          </p>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {bookmarkNotice ? (
          <Alert className="border-primary/40 bg-primary/5">
            <AlertTitle className="text-primary">Bookmark</AlertTitle>
            <AlertDescription>{bookmarkNotice}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
          <div className="space-y-6">
            <Card className="border-border shadow-sm">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <GraduationCap className="size-5 text-primary" aria-hidden />
                  <CardTitle className="text-lg">New session</CardTitle>
                </div>
                <CardDescription>
                  Choose notes you have already added on the{" "}
                  <Link href="/upload" className="font-medium text-primary underline-offset-4 hover:underline">
                    Uploads
                  </Link>{" "}
                  page (only finished items appear here). Optional: narrow the topic so the lesson stays on what
                  matters to you. If your school runs the optional tutor helper app, keep that running so voice
                  and focus features work smoothly.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {loadingLists ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading…
                  </div>
                ) : completed.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No completed uploads yet. Process a file first, then return here.
                  </p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="tutor-upload">Material</Label>
                      <select
                        id="tutor-upload"
                        className={cn(
                          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                          "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        value={selectedUploadId}
                        onChange={(e) => setSelectedUploadId(e.target.value)}
                      >
                        {completed.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.title || u.fileMeta[0]?.originalName || "Untitled"} — {u.kind}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tutor-focus">Optional focus (chapter, exam topic…)</Label>
                      <input
                        id="tutor-focus"
                        className={cn(
                          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                          "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        value={topicFocus}
                        onChange={(e) => setTopicFocus(e.target.value)}
                        placeholder="e.g. Chapter 3 only"
                        maxLength={400}
                      />
                    </div>
                    <Button
                      type="button"
                      className="w-full"
                      disabled={creating || !selectedUploadId}
                      onClick={() => void onCreateSession()}
                    >
                      {creating ? (
                        <>
                          <Loader2 className="mr-2 size-4 animate-spin" />
                          Building slides…
                        </>
                      ) : (
                        "Start live session"
                      )}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Up to {maxSessions} saved sessions. Delete old ones to free a slot.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">Your sessions</CardTitle>
                <CardDescription>
                  Open a saved room to continue, or start fresh above. Delete old rooms anytime to make space.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {sessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sessions yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {sessions.map((s) => (
                      <li
                        key={s.id}
                        className={cn(
                          "flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between",
                          activeSession?.id === s.id && "border-primary ring-1 ring-primary/30",
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{s.displayTitle}</p>
                          <p className="text-xs text-muted-foreground">
                            {s.slides.length} slides ·{" "}
                            {new Date(s.updatedAt).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button size="sm" variant="secondary" onClick={() => void openSession(s)}>
                            Open
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void onDeleteSession(s.id)}
                            aria-label="Delete session"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {activeSession && !groupId ? (
              <Card className="border-border shadow-sm">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Users className="size-5 text-primary" aria-hidden />
                    <CardTitle className="text-lg">Study with friends</CardTitle>
                  </div>
                  <CardDescription>
                    Pick 1–3 friends and send invites. Everyone shares the same slides and audio; anyone can ask a
                    question and the whole group hears the answer. The lesson starts when every invited friend has
                    joined. Camera and focus tracking stay off during group study.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {friendsList.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Add friends on the Friends page so you can invite them here.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Invite up to 3 friends</p>
                      <ul className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border p-2">
                        {friendsList.map((f) => {
                          const id = f.user.id;
                          const checked = selectedGroupFriendIds.includes(id);
                          const atCap = selectedGroupFriendIds.length >= 3 && !checked;
                          return (
                            <li key={id}>
                              <label className="flex cursor-pointer items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  className="size-3.5 rounded border-input accent-primary"
                                  checked={checked}
                                  disabled={atCap}
                                  onChange={(e) => {
                                    setSelectedGroupFriendIds((prev) => {
                                      if (e.target.checked) {
                                        if (prev.includes(id)) return prev;
                                        if (prev.length >= 3) return prev;
                                        return [...prev, id];
                                      }
                                      return prev.filter((x) => x !== id);
                                    });
                                  }}
                                />
                                <span className="min-w-0">
                                  {f.user.firstName} {f.user.lastName}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  <Button
                    type="button"
                    className="w-full"
                    disabled={groupInviteBusy || selectedGroupFriendIds.length < 1 || friendsList.length === 0}
                    onClick={() => void createGroupWithSelectedFriends()}
                  >
                    {groupInviteBusy ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Sending…
                      </>
                    ) : (
                      "Send group invites"
                    )}
                  </Button>
                </CardContent>
              </Card>
            ) : null}
          </div>

          <div className="min-w-0 space-y-4">
            {needsGroupAccept && groupDetail ? (
              <Card className="border-violet-500/30 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Group study invite</CardTitle>
                  <CardDescription>
                    A friend invited you to: <strong>{groupDetail.displayTitle}</strong>. Accept to enter the room;
                    the lesson starts when everyone has joined.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button type="button" disabled={groupInviteBusy} onClick={() => void acceptGroupInvite()}>
                    {groupInviteBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                    Accept &amp; join room
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={groupInviteBusy}
                    onClick={() => void declineGroupInvite()}
                  >
                    Decline
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {showGroupLobby ? (
              <Card className="border-primary/25 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Waiting for everyone</CardTitle>
                  <CardDescription>
                    {groupDetail?.displayTitle}. The lesson begins when all invited friends have joined (you plus up
                    to three friends).
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
                  <Loader2 className="size-12 animate-spin text-primary" aria-hidden />
                  <p className="max-w-md text-sm text-muted-foreground">
                    {pendingInviteeCount > 0
                      ? `Still waiting on ${pendingInviteeCount} friend(s)…`
                      : "Syncing…"}
                  </p>
                  {groupDetail?.members?.length ? (
                    <ul className="w-full max-w-sm space-y-2 text-left text-sm">
                      {groupDetail.members.map((m) => (
                        <li
                          key={m.userId}
                          className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                        >
                          <span>
                            {m.firstName} {m.lastName}
                            {m.isHost ? (
                              <span className="ml-2 text-xs text-muted-foreground">(host)</span>
                            ) : null}
                          </span>
                          <Users className="size-4 text-muted-foreground" aria-hidden />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            {!activeSession && !groupId ? (
              <Card className="border-dashed border-border">
                <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
                  <Video className="size-10 opacity-50" />
                  <p className="text-sm">Create or open a session to see your lesson, narration, and focus tools.</p>
                </CardContent>
              </Card>
            ) : null}

            {showLessonGrid ? (
              <div
                className={
                  immersiveTeaching
                    ? "fixed inset-0 z-[100] flex flex-col overflow-hidden bg-background/97 shadow-[0_0_80px_-20px_rgba(0,0,0,0.35)] backdrop-blur-md"
                    : undefined
                }
              >
                {immersiveTeaching ? (
                  <header className="flex shrink-0 flex-col gap-3 border-b border-border/80 bg-gradient-to-r from-muted/40 via-background to-muted/30 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Live teaching
                      </p>
                      <p className="truncate text-sm font-semibold text-foreground">
                        {tutorView === "qa"
                          ? "Question & answer"
                          : `Slide ${slideIndex + 1} / ${activeSession.slides.length}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {tutorView === "lecture" ? (
                        <>
                          <div className="flex flex-wrap gap-1.5 border-r border-border/60 pr-2 sm:gap-2">
                            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                              <input
                                type="checkbox"
                                className="size-3 rounded border-input accent-primary"
                                checked={autoAdvanceNarration}
                                disabled={groupControlsLocked}
                                onChange={(e) => setAutoAdvanceNarration(e.target.checked)}
                              />
                              Auto-advance
                            </label>
                            {!isGroupLive ? (
                              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                                <input
                                  type="checkbox"
                                  className="size-3 rounded border-input accent-primary"
                                  checked={alertSounds}
                                  onChange={(e) => setAlertSounds(e.target.checked)}
                                />
                                Focus beeps
                              </label>
                            ) : null}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8"
                            disabled={slideIndex <= 0 || groupControlsLocked}
                            onClick={() => {
                              setTutorView("lecture");
                              stopNarration();
                              setSlideIndex((i) => {
                                const next = Math.max(0, i - 1);
                                emitHostLesson({ kind: "slide", slideIndex: next });
                                return next;
                              });
                            }}
                          >
                            <ChevronLeft className="mr-1 size-3.5" />
                            Prev
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8"
                            disabled={slideIndex >= activeSession.slides.length - 1 || groupControlsLocked}
                            onClick={() => {
                              setTutorView("lecture");
                              stopNarration();
                              setSlideIndex((i) => {
                                const next = Math.min(activeSession.slides.length - 1, i + 1);
                                emitHostLesson({ kind: "slide", slideIndex: next });
                                return next;
                              });
                            }}
                          >
                            Next
                            <ChevronRight className="ml-1 size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 bg-primary text-primary-foreground"
                            disabled={narrationLoading || !slide || eli5Busy || groupControlsLocked}
                            onClick={() => void playNarration(slideIndex)}
                          >
                            {narrationLoading && playingSlide === slideIndex ? (
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                            ) : (
                              <Play className="mr-1 size-3.5" />
                            )}
                            Play
                          </Button>
                          {!isGroupLive ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8"
                              disabled={
                                !slide || eli5Busy || narrationLoading || questionSubmitting || asking
                              }
                              onClick={() => void startExplainLikeImFive()}
                            >
                              {eli5Busy ? (
                                <Loader2 className="mr-1 size-3.5 animate-spin" />
                              ) : (
                                <Baby className="mr-1 size-3.5" />
                              )}
                              ELI5
                            </Button>
                          ) : null}
                          {playingSlide !== null || playingAnswer ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8"
                              disabled={groupControlsLocked && !playingAnswer}
                              onClick={() => {
                                if (playingAnswer) pauseAnswerPlayback();
                                else stopNarration();
                              }}
                            >
                              <Square className="mr-1 size-3.5" />
                              Pause
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            pauseAnswerPlayback();
                            setAnswerBulletIndex(null);
                            setTutorView("lecture");
                          }}
                        >
                          Back to slides
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={() => setImmersiveTeaching(false)}
                      >
                        <Minimize2 className="size-3.5" />
                        Exit full view
                      </Button>
                    </div>
                  </header>
                ) : null}
                <div
                  className={
                    immersiveTeaching
                      ? "flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-3 pb-6 pt-2 sm:px-5"
                      : undefined
                  }
                >
                  <>
                <div
                  className={cn(
                    "grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]",
                    immersiveTeaching &&
                      !isGroupLive &&
                      "gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,13rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]",
                  )}
                >
                  <Card
                    className={cn(
                      "min-w-0 border-border shadow-sm transition-shadow duration-500",
                      immersiveTeaching && "border-border/80 shadow-md",
                      tutorView === "lecture" &&
                        playingSlide === slideIndex &&
                        "ring-2 ring-primary/25 shadow-lg shadow-primary/10",
                      tutorView === "qa" &&
                        (playingAnswer || questionSubmitting) &&
                        "ring-2 ring-violet-500/30 shadow-lg shadow-violet-500/10",
                    )}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle className="text-lg leading-tight">
                          {tutorView === "qa" ? (
                            <span className="flex items-center gap-2">
                              <HelpCircle
                                className="size-5 shrink-0 text-violet-600 dark:text-violet-400"
                                aria-hidden
                              />
                              Your question
                            </span>
                          ) : (
                            <>Slide {slideIndex + 1} / {activeSession.slides.length}</>
                          )}
                        </CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                          {tutorView === "qa" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                pauseAnswerPlayback();
                                setAnswerBulletIndex(null);
                                setTutorView("lecture");
                              }}
                            >
                              Back to slides
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {activeSession.topicFocus ? `Focus: ${activeSession.topicFocus}` : "Full material"}
                            </span>
                          )}
                          {!immersiveTeaching ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="shrink-0"
                              title="Full-screen teaching view"
                              aria-label="Open full-screen teaching view"
                              onClick={() => setImmersiveTeaching(true)}
                            >
                              <Maximize2 className="size-4" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {tutorView === "qa" ? (
                        <div className="space-y-4">
                          {questionSubmitting && !lastQa ? (
                            <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
                              <div className="relative flex size-16 items-center justify-center">
                                <span className="absolute inline-flex size-14 animate-ping rounded-full bg-primary/25" />
                                <Loader2 className="relative size-10 animate-spin text-primary" aria-hidden />
                              </div>
                              <div className="space-y-1">
                                <p className="text-sm font-semibold text-foreground">Working on your answer…</p>
                                <p className="max-w-sm text-xs text-muted-foreground">
                                  Your question is on its way. Key points will appear here with the voice.
                                </p>
                              </div>
                            </div>
                          ) : null}
                          {lastQa ? (
                            <>
                              <TutorQaWhiteboard
                                ref={qaAnswerWhiteboardRef}
                                askerLabel={
                                  lastQa.askerName?.trim()
                                    ? `${lastQa.askerName.trim()} asked`
                                    : "You asked"
                                }
                                question={lastQa.question}
                                bullets={lastQaAnswerBullets}
                                presentation={immersiveTeaching ? "immersive" : "default"}
                                qaBulletRefs={qaBulletRefs}
                                answerBulletIndex={answerBulletIndex}
                                answerVisualActive={playingAnswer || answerPaused}
                                fillAnswerOutlineWhenIdle={!playingAnswer && !answerPaused}
                              />
                              {questionSubmitting && lastQa ? (
                                <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/35 bg-primary/5 px-3 py-3 text-sm text-muted-foreground">
                                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                                  Preparing voice…
                                </div>
                              ) : null}
                              {(playingAnswer || answerPaused) && answerSubtitleLine ? (
                                <div
                                  className={cn(
                                    "relative flex min-h-[3rem] items-center justify-center rounded-lg border border-dashed border-primary/35 bg-primary/5 px-2 py-2.5 text-center",
                                  )}
                                  aria-live="polite"
                                >
                                  <button
                                    type="button"
                                    className={cn(
                                      "absolute right-1.5 top-1.5 z-10 inline-flex size-8 items-center justify-center rounded-md border border-primary/25 bg-background/95 text-muted-foreground shadow-sm transition-colors",
                                      "hover:border-primary/50 hover:bg-accent hover:text-foreground",
                                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                      "disabled:pointer-events-none disabled:opacity-40",
                                    )}
                                    aria-label="Bookmark full tutor answer"
                                    title="Save the full answer text to Bookmarks"
                                    disabled={
                                      !activeSession ||
                                      !lastQa?.answer?.trim() ||
                                      bookmarkSaving !== null
                                    }
                                    onClick={() => void saveBookmarkFromSubtitle("qa_answer")}
                                  >
                                    {bookmarkSaving === "qa_answer" ? (
                                      <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                      <Plus className="size-4" />
                                    )}
                                  </button>
                                  <p className="max-w-full break-words pr-10 text-sm font-medium text-foreground">
                                    {answerSubtitleLine}
                                  </p>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : slide ? (
                        <div className="space-y-4">
                          <TutorLectureWhiteboard
                            ref={lectureWhiteboardRef}
                            title={slide.title}
                            points={slide.points}
                            presentation={immersiveTeaching ? "immersive" : "default"}
                            pointRefs={lecturePointRefs}
                            narrationBulletIndex={narrationBulletIndex}
                            narrationActive={playingSlide === slideIndex}
                          />
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-medium text-muted-foreground">What the tutor is saying</p>
                              {!isGroupLive && eli5ForSlideIndex === slideIndex && eli5Script ? (
                                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-100">
                                  Simple words mode
                                </span>
                              ) : null}
                            </div>
                            <div
                              className={cn(
                                "relative flex min-h-[3rem] items-center justify-center rounded-xl border px-2 py-2.5 text-center",
                                immersiveTeaching
                                  ? "border-emerald-900/20 bg-[#eef3ef] shadow-[inset_0_2px_8px_rgba(0,40,20,0.06)] dark:border-emerald-500/25 dark:bg-[#1a221e]"
                                  : "rounded-lg border-dashed border-border/80 bg-muted/20",
                                playingSlide === slideIndex && narrationSubtitleLine && "border-primary/40 bg-primary/5",
                                !isGroupLive &&
                                  eli5ForSlideIndex === slideIndex &&
                                  eli5Script &&
                                  "border-amber-500/30 bg-amber-500/5",
                              )}
                              aria-live="polite"
                            >
                              <button
                                type="button"
                                className={cn(
                                  "absolute right-1.5 top-1.5 z-10 inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-sm transition-colors",
                                  "hover:border-primary/40 hover:bg-accent hover:text-foreground",
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                  "disabled:pointer-events-none disabled:opacity-40",
                                )}
                                aria-label="Bookmark full narration for this slide"
                                title="Save full narration for this slide to Bookmarks"
                                disabled={
                                  !narrationBookmarkText ||
                                  !activeSession ||
                                  bookmarkSaving !== null
                                }
                                onClick={() => void saveBookmarkFromSubtitle("narration")}
                              >
                                {bookmarkSaving === "narration" ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Plus className="size-4" />
                                )}
                              </button>
                              <p className="w-full max-w-full break-words pr-11 text-sm font-medium leading-snug text-foreground sm:text-base">
                                {playingSlide === slideIndex && narrationSubtitleLine
                                  ? narrationSubtitleLine
                                  : playingSlide === slideIndex
                                    ? "…"
                                    : !isGroupLive && eli5ForSlideIndex === slideIndex && eli5Script
                                      ? "Tap Play — simpler explanation is ready (resets when you change slide)."
                                      : "Tap Play — subtitles and bullet focus follow the voice."}
                              </p>
                            </div>
                          </div>
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          "flex flex-col gap-3 border-t border-border pt-4",
                          immersiveTeaching && "hidden",
                        )}
                      >
                        {tutorView === "qa" ? (
                          <p className="text-xs text-muted-foreground">
                            The lesson slide returns automatically when the answer finishes. Use{" "}
                            <span className="font-medium text-foreground">Back to slides</span> anytime to read
                            your notes while audio is paused.
                          </p>
                        ) : null}
                        {tutorView === "lecture" ? (
                          <>
                            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                              <label className="flex cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="size-3.5 rounded border-input accent-primary"
                                  checked={autoAdvanceNarration}
                                  disabled={groupControlsLocked}
                                  onChange={(e) => setAutoAdvanceNarration(e.target.checked)}
                                />
                                Auto-advance slide when narration ends
                              </label>
                              {!isGroupLive ? (
                                <label className="flex cursor-pointer items-center gap-2">
                                  <input
                                    type="checkbox"
                                    className="size-3.5 rounded border-input accent-primary"
                                    checked={alertSounds}
                                    onChange={(e) => setAlertSounds(e.target.checked)}
                                  />
                                  Focus alert beeps until you are focused
                                </label>
                              ) : null}
                            </div>
                            {isGroupLive && groupControlsLocked ? (
                              <p className="text-xs text-muted-foreground">
                                The host controls slides and narration. You can still ask questions for everyone to
                                hear.
                              </p>
                            ) : null}
                            <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={slideIndex <= 0 || groupControlsLocked}
                          onClick={() => {
                            setTutorView("lecture");
                            stopNarration();
                            setSlideIndex((i) => {
                              const next = Math.max(0, i - 1);
                              emitHostLesson({ kind: "slide", slideIndex: next });
                              return next;
                            });
                          }}
                        >
                          <ChevronLeft className="mr-1 size-4" />
                          Prev
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={slideIndex >= activeSession.slides.length - 1 || groupControlsLocked}
                          onClick={() => {
                            setTutorView("lecture");
                            stopNarration();
                            setSlideIndex((i) => {
                              const next = Math.min(activeSession.slides.length - 1, i + 1);
                              emitHostLesson({ kind: "slide", slideIndex: next });
                              return next;
                            });
                          }}
                        >
                          Next
                          <ChevronRight className="ml-1 size-4" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-primary text-primary-foreground"
                          disabled={narrationLoading || !slide || eli5Busy || groupControlsLocked}
                          onClick={() => void playNarration(slideIndex)}
                        >
                          {narrationLoading && playingSlide === slideIndex ? (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                          ) : (
                            <Play className="mr-2 size-4" />
                          )}
                          Play narration
                        </Button>
                        {!isGroupLive ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={
                              !slide ||
                              eli5Busy ||
                              narrationLoading ||
                              questionSubmitting ||
                              asking
                            }
                            onClick={() => void startExplainLikeImFive()}
                            title="Stops current audio, then a short reply plays while a simpler script is generated"
                          >
                            {eli5Busy ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                              <Baby className="mr-2 size-4" />
                            )}
                            Explain like I&apos;m 5
                          </Button>
                        ) : null}
                        {playingSlide !== null || playingAnswer ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={groupControlsLocked && !playingAnswer}
                            onClick={() => {
                              if (playingAnswer) pauseAnswerPlayback();
                              else stopNarration();
                            }}
                          >
                            <Square className="mr-2 size-4" />
                            Pause playback
                          </Button>
                        ) : null}
                            </div>
                          </>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>

                  <div
                    className={cn(
                      "flex min-w-0 flex-col gap-4",
                      immersiveTeaching && !isGroupLive && "xl:max-w-[13rem] 2xl:max-w-[14rem]",
                    )}
                  >
                    {isGroupLive && groupDetail ? (
                      <>
                        <Card className="min-w-0 border-border shadow-sm">
                          <CardHeader className="pb-2">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Users className="size-5 shrink-0 text-primary" aria-hidden />
                                  <CardTitle className="text-base">In this session</CardTitle>
                                </div>
                                <CardDescription className="mt-1">
                                  Everyone here shares the same lesson and Q&amp;A. Chat below is cleared when the
                                  host ends the session.
                                </CardDescription>
                              </div>
                              {isGroupHost ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0 text-destructive hover:text-destructive"
                                  disabled={endGroupBusy}
                                  onClick={() => void endGroupSessionForHost()}
                                >
                                  {endGroupBusy ? (
                                    <Loader2 className="mr-2 size-4 animate-spin" />
                                  ) : null}
                                  End group session
                                </Button>
                              ) : null}
                            </div>
                          </CardHeader>
                          <CardContent>
                            <ul className="space-y-2">
                              {groupDetail.members.map((m) => (
                                <li
                                  key={m.userId}
                                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                                >
                                  <span className="min-w-0">
                                    {m.firstName} {m.lastName}
                                    {m.isHost ? (
                                      <span className="ml-2 text-xs text-muted-foreground">(host)</span>
                                    ) : null}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </CardContent>
                        </Card>

                        <Card className="min-w-0 flex flex-1 flex-col border-border shadow-sm">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-base">Group chat</CardTitle>
                            <CardDescription>
                              Messages are only kept for this live session and disappear after it ends.
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="flex flex-1 flex-col gap-3">
                            <div
                              ref={groupChatScrollRef}
                              className="max-h-64 min-h-[8rem] overflow-y-auto rounded-md border border-border bg-muted/20 p-2 text-sm"
                            >
                              {groupChatMessages.length === 0 ? (
                                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                                  No messages yet. Say hi or share a quick note about the lesson.
                                </p>
                              ) : (
                                <ul className="space-y-3">
                                  {groupChatMessages.map((msg) => {
                                    const mine = msg.userId === authUser?.id;
                                    return (
                                      <li
                                        key={msg.id}
                                        className={cn(
                                          "rounded-lg px-2 py-1.5",
                                          mine ? "bg-primary/10" : "bg-background/80",
                                        )}
                                      >
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          {msg.firstName} {msg.lastName}
                                          <span className="ml-2 font-normal normal-case text-muted-foreground/80">
                                            {new Date(msg.at).toLocaleTimeString(undefined, {
                                              hour: "numeric",
                                              minute: "2-digit",
                                            })}
                                          </span>
                                        </p>
                                        <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                                          {msg.text}
                                        </p>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                              <Textarea
                                className="min-h-[4.5rem] min-w-0 flex-1 resize-none"
                                placeholder="Write a message to the group…"
                                maxLength={500}
                                value={groupChatDraft}
                                onChange={(e) => setGroupChatDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    sendGroupChatMessage();
                                  }
                                }}
                              />
                              <Button
                                type="button"
                                className="shrink-0 sm:w-auto"
                                disabled={groupChatSending || !groupChatDraft.trim()}
                                onClick={() => sendGroupChatMessage()}
                              >
                                {groupChatSending ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <>
                                    <Send className="mr-2 size-4" />
                                    Send
                                  </>
                                )}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      </>
                    ) : (
                      <>
                        <Card
                          className={cn(
                            "min-w-0 overflow-hidden border-border shadow-sm",
                            focus?.alarm && "border-destructive ring-1 ring-destructive/40",
                            immersiveTeaching && "shadow-sm",
                          )}
                        >
                          <CardHeader className={cn("pb-2", immersiveTeaching && "space-y-0 pb-1.5")}>
                            <div className="flex items-center gap-2">
                              <ScanEye className={cn("text-primary", immersiveTeaching ? "size-4" : "size-5")} />
                              <CardTitle className={immersiveTeaching ? "text-sm" : "text-base"}>You</CardTitle>
                            </div>
                            <CardDescription className={immersiveTeaching ? "sr-only" : undefined}>
                              Turn your camera on so Acadomi can celebrate focus and offer gentle reminders.
                            </CardDescription>
                          </CardHeader>
                          <CardContent className={cn("space-y-3", immersiveTeaching && "space-y-2 pt-0")}>
                            <div
                              className={cn(
                                "relative w-full overflow-hidden rounded-md bg-black",
                                immersiveTeaching
                                  ? "mx-auto aspect-video max-h-[min(7rem,16vh)] max-w-[13rem]"
                                  : "aspect-video",
                              )}
                            >
                              <video
                                ref={videoRef}
                                className="h-full w-full object-cover"
                                playsInline
                                muted
                                autoPlay
                              />
                              {!camOn ? (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-xs text-white">
                                  Camera off
                                </div>
                              ) : null}
                            </div>
                            <canvas ref={canvasRef} className="hidden" aria-hidden />
                            <div className={cn("flex flex-wrap gap-2", immersiveTeaching && "justify-center")}>
                              {!camOn ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  className={immersiveTeaching ? "h-8 text-xs" : undefined}
                                  onClick={() => void startCam()}
                                >
                                  <Video className="mr-2 size-4" />
                                  Enable camera &amp; mic
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className={immersiveTeaching ? "h-8 text-xs" : undefined}
                                  onClick={() => void stopCam()}
                                >
                                  <VideoOff className="mr-2 size-4" />
                                  Stop camera
                                </Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>

                        <Card className={cn("border-border shadow-sm", immersiveTeaching && "shadow-sm")}>
                          <CardHeader className={cn("pb-2", immersiveTeaching && "space-y-0 pb-1.5")}>
                            <CardTitle className={immersiveTeaching ? "text-sm" : "text-base"}>Focus</CardTitle>
                            <CardDescription className={immersiveTeaching ? "sr-only" : undefined}>
                              Live readout of how present you look on camera. Numbers update as you learn; use them
                              as feedback, not a grade.
                            </CardDescription>
                          </CardHeader>
                          <CardContent className={cn("space-y-3", immersiveTeaching && "space-y-2 pt-0")}>
                            <div
                              className={cn(
                                "rounded-lg border border-border text-center text-sm font-semibold",
                                immersiveTeaching ? "px-2 py-2" : "px-3 py-3",
                                focusTone(focus),
                              )}
                            >
                              {focus ? (
                                <>
                                  <div
                                    className={cn("tracking-tight", immersiveTeaching ? "text-sm" : "text-lg")}
                                  >
                                    {focus.status}
                                  </div>
                                  {focus.focusVal !== null ? (
                                    <div
                                      className={cn(
                                        "mt-1 font-mono tabular-nums",
                                        immersiveTeaching ? "text-xl" : "text-2xl",
                                      )}
                                    >
                                      {focus.focusVal}
                                      <span className="ml-1 text-xs font-normal text-muted-foreground">/ 100</span>
                                    </div>
                                  ) : (
                                    <p className="mt-1 text-xs font-normal opacity-80">
                                      Calibrating…{" "}
                                      {focus.calibrationProgress != null
                                        ? `${Math.round(focus.calibrationProgress * 100)}%`
                                        : "hold still"}
                                    </p>
                                  )}
                                </>
                              ) : (
                                <span className="text-muted-foreground">Waiting for camera…</span>
                              )}
                            </div>
                            {focus && !focus.faceFound ? (
                              <p className="text-xs text-muted-foreground">
                                Stay centered in frame so we can estimate attention.
                              </p>
                            ) : null}
                            {focus && (focus.pitch != null || focus.ear != null) ? (
                              <div
                                className={cn(
                                  "overflow-y-auto rounded-md border border-border bg-muted/20 p-2",
                                  immersiveTeaching ? "max-h-24" : "max-h-48",
                                )}
                              >
                                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  Live metrics
                                </p>
                                <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-[11px] font-mono leading-tight">
                                  {(
                                    [
                                      ["Pitch°", focus.pitch],
                                      ["Yaw°", focus.yaw],
                                      ["Roll°", focus.roll],
                                      ["Δ pitch", focus.deltaPitch],
                                      ["Δ yaw", focus.deltaYaw],
                                      ["Baseline pitch", focus.baselinePitch],
                                      ["Baseline yaw", focus.baselineYaw],
                                      ["EAR", focus.ear],
                                      ["Baseline EAR", focus.baselineEar],
                                      ["Δ EAR", focus.deltaEar],
                                      ["Gaze var×10⁴", focus.gazeVariance],
                                      ["Blink Δt s", focus.timeSinceBlinkSec],
                                      ["Gaze move Δt s", focus.timeSinceGazeMoveSec],
                                      ["Pose score", focus.poseScore],
                                      ["Eye score", focus.eyeScore],
                                      ["Gaze score", focus.gazeScore],
                                      ["Raw focus", focus.rawFocus],
                                      ["Stare alarm", focus.stareAlarm],
                                    ] as const
                                  )
                                    .filter(([, v]) => v !== undefined && v !== null)
                                    .map(([k, v]) => (
                                      <React.Fragment key={k}>
                                        <dt className="text-muted-foreground">{k}</dt>
                                        <dd className="text-right text-foreground">{String(v)}</dd>
                                      </React.Fragment>
                                    ))}
                                </dl>
                              </div>
                            ) : null}
                          </CardContent>
                        </Card>
                      </>
                    )}
                  </div>
                </div>

                <Card className="border-border shadow-sm">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <Mic className="size-5 text-primary" />
                      <CardTitle className="text-lg">Ask a question</CardTitle>
                    </div>
                    <CardDescription>
                      Tap <strong>Record</strong> to start—narration and any answer audio stop so the mic is
                      clear. Speak your whole question, then tap <strong>Stop &amp; send</strong> to get the
                      tutor&apos;s reply.
                      {isGroupLive
                        ? " In group study, everyone sees the question and hears the answer—mic only, no camera required."
                        : " Use Chrome or Edge on a laptop if anything fails."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={asking ? "destructive" : "secondary"}
                        disabled={(!camOn && !isGroupLive) || questionSubmitting}
                        onClick={() => void toggleQuestionRecording()}
                      >
                        {questionSubmitting ? (
                          <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            Getting answer…
                          </>
                        ) : asking ? (
                          <>
                            <Square className="mr-2 size-4" />
                            Stop &amp; send
                          </>
                        ) : (
                          <>
                            <Mic className="mr-2 size-4" />
                            Record question
                          </>
                        )}
                      </Button>
                      {asking ? (
                        <span className="text-xs text-muted-foreground">Recording… tap Stop when finished.</span>
                      ) : null}
                    </div>
                    {lastQa ? (
                      <div className="space-y-3 rounded-lg border border-border bg-muted/15 p-4 text-sm">
                        {tutorView === "qa" ? (
                          <p className="text-xs text-muted-foreground">
                            The main card shows your question, outline, and captions while the tutor speaks.
                          </p>
                        ) : (
                          <>
                            <p>
                              <span className="font-medium text-foreground">
                                {lastQa.askerName?.trim()
                                  ? `${lastQa.askerName.trim()} asked: `
                                  : "You asked: "}
                              </span>
                              {lastQa.question}
                            </p>
                            <p>
                              <span className="font-medium text-foreground">Tutor: </span>
                              {playingAnswer ? (
                                <span className="text-muted-foreground">
                                  Playing audio… switch to the answer card for outline sync, or stay here for
                                  the full text when it finishes.
                                </span>
                              ) : (
                                lastQa.answer
                              )}
                            </p>
                          </>
                        )}
                        {(playingAnswer || answerPaused) && answerSubtitleLine && tutorView === "lecture" ? (
                          <div
                            className="relative flex min-h-[2.75rem] items-center justify-center rounded-lg border border-dashed border-primary/35 bg-primary/5 px-3 py-2 text-center"
                            aria-live="polite"
                          >
                            <button
                              type="button"
                              className={cn(
                                "absolute right-1.5 top-1.5 z-10 inline-flex size-8 items-center justify-center rounded-md border border-primary/25 bg-background/95 text-muted-foreground shadow-sm transition-colors",
                                "hover:border-primary/50 hover:bg-accent hover:text-foreground",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "disabled:pointer-events-none disabled:opacity-40",
                              )}
                              aria-label="Bookmark full tutor answer"
                              title="Save the full answer text to Bookmarks"
                              disabled={
                                !activeSession ||
                                !lastQa?.answer?.trim() ||
                                bookmarkSaving !== null
                              }
                              onClick={() => void saveBookmarkFromSubtitle("qa_answer")}
                            >
                              {bookmarkSaving === "qa_answer" ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Plus className="size-4" />
                              )}
                            </button>
                            <p className="max-w-full break-words pr-10 text-sm font-medium text-foreground">
                              {answerSubtitleLine}
                            </p>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          {playingAnswer ? (
                            <Button type="button" variant="outline" size="sm" onClick={pauseAnswerPlayback}>
                              <Square className="mr-2 size-4" />
                              Pause answer
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={questionSubmitting}
                              onClick={() =>
                                void playAnswerTts(lastQa.answer, { bullets: lastQaAnswerBullets })
                              }
                            >
                              <Volume2 className="mr-2 size-4" />
                              {answerPaused ? "Resume answer" : "Hear answer"}
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <audio ref={audioRef} className="hidden" />

                <div
                  className={cn(
                    "pointer-events-none fixed bottom-20 right-4 md:bottom-10 md:right-6 print:hidden",
                    immersiveTeaching ? "z-[110]" : "z-40",
                  )}
                >
                  <div className="pointer-events-auto flex flex-col items-center gap-1">
                    <span className="rounded-md bg-background/95 px-2 py-0.5 text-center text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border">
                      Ask
                    </span>
                    <Button
                      type="button"
                      title={asking ? "Stop recording and send question" : "Start recording your question"}
                      aria-label={
                        asking ? "Stop recording and send your question" : "Start recording your question"
                      }
                      variant={asking ? "destructive" : "default"}
                      size="icon"
                      className="size-14 rounded-full shadow-lg ring-2 ring-background"
                      disabled={(!camOn && !isGroupLive) || questionSubmitting}
                      onClick={() => void toggleQuestionRecording()}
                    >
                      {questionSubmitting ? (
                        <Loader2 className="size-6 animate-spin" aria-hidden />
                      ) : asking ? (
                        <Square className="size-6" aria-hidden />
                      ) : (
                        <Mic className="size-6" aria-hidden />
                      )}
                    </Button>
                  </div>
                </div>
              </>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
