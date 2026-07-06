export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const TOKEN_KEY = "acadomi_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export type UserDTO = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

export type UploadDTO = {
  id: string;
  kind: "pdf" | "image" | "audio";
  title: string;
  userPrompt: string;
  extractedText: string;
  processedContent: string;
  fileMeta: { originalName: string; mimeType: string }[];
  status: "processing" | "completed" | "failed";
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    const err = (data as { error?: string }).error ?? res.statusText;
    throw new Error(err);
  }
  return data as T;
}

export async function apiRegister(body: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}): Promise<{ token: string; user: UserDTO }> {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiLogin(body: {
  email: string;
  password: string;
}): Promise<{ token: string; user: UserDTO }> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiMe(token: string): Promise<{ user: UserDTO }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiUpdateProfile(
  token: string,
  body: {
    firstName?: string;
    lastName?: string;
    currentPassword?: string;
    newPassword?: string;
  },
): Promise<{ user: UserDTO }> {
  const res = await fetch(`${API_BASE}/api/auth/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiListUploads(
  token: string,
): Promise<{ uploads: UploadDTO[]; maxUploads: number }> {
  const res = await fetch(`${API_BASE}/api/uploads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiCreateUpload(
  token: string,
  type: "pdf" | "image" | "audio",
  prompt: string,
  files: File[],
  title?: string,
): Promise<{ upload: UploadDTO }> {
  const fd = new FormData();
  fd.append("type", type);
  fd.append("prompt", prompt);
  fd.append("title", title ?? "");
  for (const f of files) {
    fd.append("files", f);
  }
  const res = await fetch(`${API_BASE}/api/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  return parseJson(res);
}

export async function apiDeleteUpload(
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/uploads/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export type PodcastLineDTO = { speaker: string; text: string };

export type PodcastDTO = {
  id: string;
  sourceUploadId: string;
  title: string;
  script: PodcastLineDTO[];
  mimeType: string;
  durationMs: number;
  byteLength: number;
  createdAt: string;
};

export async function apiListPodcasts(
  token: string,
): Promise<{ podcasts: PodcastDTO[]; maxPodcasts: number }> {
  const res = await fetch(`${API_BASE}/api/podcasts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiGeneratePodcast(
  token: string,
  uploadId: string,
): Promise<{ podcast: PodcastDTO }> {
  const res = await fetch(`${API_BASE}/api/podcasts/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ uploadId }),
  });
  return parseJson(res);
}

export async function apiDeletePodcast(
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/podcasts/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export type CheatSheetListItemDTO = {
  id: string;
  sourceUploadId: string;
  topic: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
};

export type CheatSheetFullDTO = CheatSheetListItemDTO & { markdown: string };

export async function apiListCheatSheets(
  token: string,
): Promise<{ sheets: CheatSheetListItemDTO[]; maxSheets: number }> {
  const res = await fetch(`${API_BASE}/api/cheat-sheets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiGetCheatSheet(
  token: string,
  id: string,
): Promise<{ sheet: CheatSheetFullDTO }> {
  const res = await fetch(`${API_BASE}/api/cheat-sheets/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiGenerateCheatSheet(
  token: string,
  uploadId: string,
  topic: string,
): Promise<{ sheet: CheatSheetFullDTO }> {
  const res = await fetch(`${API_BASE}/api/cheat-sheets/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ uploadId, topic }),
  });
  return parseJson(res);
}

export async function apiDeleteCheatSheet(
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/cheat-sheets/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

/** Caller should `URL.revokeObjectURL` when the URL is no longer needed. */
export async function apiFetchPodcastAudioBlobUrl(
  token: string,
  podcastId: string,
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/podcasts/${podcastId}/audio`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export type RoleReversalVisualHintsDTO = {
  radar?: { label: string; value: number }[];
  barCompare?: { label: string; you: number; ideal: number }[];
};

export type RoleReversalEvaluationDTO = {
  scoreClarity: number;
  scoreConcepts: number;
  scoreFluency: number;
  totalScore: number;
  feedback: string;
  topicUnderstanding: string;
  weakness: string;
  strength: string;
  visualHints?: RoleReversalVisualHintsDTO;
};

export type RoleReversalSessionDTO = {
  id: string;
  topic: string;
  sourceUploadId: string;
  transcript: string;
  attemptCount: number;
  evaluation: RoleReversalEvaluationDTO;
  createdAt: string;
  updatedAt: string;
};

export async function apiListRoleReversalSessions(
  token: string,
): Promise<{ sessions: RoleReversalSessionDTO[]; maxSessions: number }> {
  const res = await fetch(`${API_BASE}/api/role-reversal`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiEvaluateRoleReversal(
  token: string,
  params: {
    topic: string;
    uploadId: string;
    audio: Blob;
    sessionId?: string;
  },
): Promise<{ session: RoleReversalSessionDTO }> {
  const fd = new FormData();
  fd.append("topic", params.topic);
  fd.append("uploadId", params.uploadId);
  fd.append("audio", params.audio, "explanation.webm");
  if (params.sessionId) fd.append("sessionId", params.sessionId);
  const res = await fetch(`${API_BASE}/api/role-reversal/evaluate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  return parseJson(res);
}

export async function apiDeleteRoleReversalSession(
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/role-reversal/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export type BookmarkMaterialSummaryDTO = {
  uploadId: string;
  title: string;
  kind: string;
  bookmarkCount: number;
  lastBookmarkAt: string;
};

export type ConceptBookmarkDTO = {
  id: string;
  sourceUploadId: string;
  lineText: string;
  tutorSessionId: string | null;
  slideIndex: number | null;
  slideTitle: string;
  subtitleSource: "narration" | "qa_answer";
  createdAt: string;
  updatedAt: string;
};

export async function apiListBookmarkMaterials(
  token: string,
): Promise<{ materials: BookmarkMaterialSummaryDTO[]; maxBookmarks: number }> {
  const res = await fetch(`${API_BASE}/api/bookmarks/materials`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiListBookmarksForUpload(
  token: string,
  uploadId: string,
): Promise<{ bookmarks: ConceptBookmarkDTO[] }> {
  const q = new URLSearchParams({ uploadId });
  const res = await fetch(`${API_BASE}/api/bookmarks?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiCreateConceptBookmark(
  token: string,
  body: {
    sourceUploadId: string;
    lineText: string;
    tutorSessionId?: string;
    slideIndex?: number | null;
    slideTitle?: string;
    subtitleSource?: "narration" | "qa_answer";
  },
): Promise<{ bookmark: ConceptBookmarkDTO }> {
  const res = await fetch(`${API_BASE}/api/bookmarks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiDeleteConceptBookmark(
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/bookmarks/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

/** Caller must `URL.revokeObjectURL` when done. */
export async function apiFetchBookmarkRecapBlobUrl(
  token: string,
  bookmarkId: string,
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/bookmarks/${bookmarkId}/recap/tts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function apiBookmarkChat(
  token: string,
  bookmarkId: string,
  body: {
    message: string;
    history?: { role: "user" | "assistant"; content: string }[];
  },
): Promise<{ reply: string }> {
  const res = await fetch(`${API_BASE}/api/bookmarks/${bookmarkId}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export type FriendUserDTO = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

export type FriendInviteListItemDTO = {
  id: string;
  status: string;
  user: FriendUserDTO;
  createdAt: string;
};

export type FriendEntryDTO = {
  inviteId: string;
  since: string;
  user: FriendUserDTO;
};

export async function apiSearchFriendsByEmail(
  token: string,
  emailQuery: string,
): Promise<{ users: FriendUserDTO[] }> {
  const q = new URLSearchParams({ email: emailQuery.trim() });
  const res = await fetch(`${API_BASE}/api/friends/search?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiSendFriendInvite(
  token: string,
  body: { toUserId?: string; toEmail?: string },
): Promise<{ invite: { id: string; status: string; to: FriendUserDTO; createdAt: string } }> {
  const res = await fetch(`${API_BASE}/api/friends/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiListIncomingFriendInvites(
  token: string,
): Promise<{ invites: FriendInviteListItemDTO[] }> {
  const res = await fetch(`${API_BASE}/api/friends/invites/incoming`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiListOutgoingFriendInvites(
  token: string,
): Promise<{ invites: FriendInviteListItemDTO[] }> {
  const res = await fetch(`${API_BASE}/api/friends/invites/outgoing`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiAcceptFriendInvite(
  token: string,
  inviteId: string,
): Promise<{ invite: { id: string; status: string; friend: FriendUserDTO } }> {
  const res = await fetch(`${API_BASE}/api/friends/invites/${inviteId}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiDeclineFriendInvite(
  token: string,
  inviteId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/friends/invites/${inviteId}/decline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiCancelOutgoingFriendInvite(
  token: string,
  inviteId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/friends/invites/${inviteId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiListFriends(token: string): Promise<{ friends: FriendEntryDTO[] }> {
  const res = await fetch(`${API_BASE}/api/friends`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export type TutorSlideDTO = {
  title: string;
  points: string[];
  script: string;
};

export type TutorSessionDTO = {
  id: string;
  sourceUploadId: string;
  topicFocus: string;
  displayTitle: string;
  slides: TutorSlideDTO[];
  status: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type TutorFocusDTO = {
  faceFound: boolean;
  focusVal: number | null;
  status: string;
  alarm: boolean;
  isCalibrated: boolean;
  /** Live telemetry from MediaPipe / head pose / EAR (when present) */
  pitch?: number;
  yaw?: number;
  roll?: number;
  deltaPitch?: number;
  deltaYaw?: number;
  baselinePitch?: number;
  baselineYaw?: number;
  baselineEar?: number;
  ear?: number;
  deltaEar?: number;
  gazeVariance?: number;
  timeSinceBlinkSec?: number;
  timeSinceGazeMoveSec?: number;
  poseScore?: number;
  eyeScore?: number;
  gazeScore?: number;
  rawFocus?: number;
  calibrationProgress?: number;
  stareAlarm?: boolean;
};

export async function apiListTutorSessions(
  token: string,
): Promise<{ sessions: TutorSessionDTO[]; maxSessions: number }> {
  const res = await fetch(`${API_BASE}/api/tutor/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiGetTutorSession(
  token: string,
  id: string,
): Promise<{ session: TutorSessionDTO }> {
  const res = await fetch(`${API_BASE}/api/tutor/sessions/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiCreateTutorSession(
  token: string,
  body: { uploadId: string; topicFocus?: string },
): Promise<{ session: TutorSessionDTO }> {
  const res = await fetch(`${API_BASE}/api/tutor/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiDeleteTutorSession(
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/tutor/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiTutorFocusReset(
  token: string,
  sessionId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/tutor/sessions/${sessionId}/focus/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiTutorFocusAnalyze(
  token: string,
  sessionId: string,
  frameBlob: Blob,
): Promise<TutorFocusDTO> {
  const fd = new FormData();
  fd.append("frame", frameBlob, "frame.jpg");
  const res = await fetch(`${API_BASE}/api/tutor/sessions/${sessionId}/focus/analyze`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  return parseJson(res);
}

/** Caller should revoke the object URL when done. */
/** Gemini: simpler spoken script for one slide ("explain like I'm five"). */
export async function apiTutorSlideEli5(
  token: string,
  sessionId: string,
  slideIndex: number,
): Promise<{ script: string }> {
  const res = await fetch(
    `${API_BASE}/api/tutor/sessions/${sessionId}/slides/${slideIndex}/eli5`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return parseJson(res);
}

export async function apiFetchTutorSlideAudioBlobUrl(
  token: string,
  sessionId: string,
  slideIndex: number,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/tutor/sessions/${sessionId}/slides/${slideIndex}/tts`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Short arbitrary text (e.g. answer) → MP3 blob URL. Caller must revoke. */
export async function apiFetchTutorTtsBlobUrl(token: string, text: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/tutor/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function apiTutorAsk(
  token: string,
  params: { sessionId: string; slideIndex: number; audio: Blob },
): Promise<{ question: string; answer: string }> {
  const fd = new FormData();
  fd.append("slideIndex", String(params.slideIndex));
  const ext = params.audio.type.split(";")[0].split("/")[1] || "webm";
  fd.append("audio", params.audio, `question.${ext}`);
  const res = await fetch(`${API_BASE}/api/tutor/sessions/${params.sessionId}/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  return parseJson(res);
}

/* —— Tutor group study —— */

export type TutorGroupMemberDTO = {
  userId: string;
  firstName: string;
  lastName: string;
  isHost: boolean;
};

export type TutorGroupDetailDTO = {
  id: string;
  tutorSessionId: string;
  hostUserId: string;
  inviteeUserIds: string[];
  acceptedUserIds: string[];
  status: string;
  displayTitle: string;
  members: TutorGroupMemberDTO[];
  isHost: boolean;
  youAccepted: boolean;
};

export type TutorGroupInviteCardDTO = {
  id: string;
  hostName: string;
  displayTitle: string;
  tutorSessionId: string;
};

export type TutorGroupChatMessageDTO = {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  text: string;
  at: string;
};

export async function apiCreateTutorGroup(
  token: string,
  body: { tutorSessionId: string; friendUserIds: string[] },
): Promise<{ group: TutorGroupDetailDTO }> {
  const res = await fetch(`${API_BASE}/api/tutor/group`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function apiListTutorGroupInvitesMine(
  token: string,
): Promise<{ invites: TutorGroupInviteCardDTO[] }> {
  const res = await fetch(`${API_BASE}/api/tutor/group/invites/mine`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiGetTutorGroup(
  token: string,
  groupId: string,
): Promise<{ group: TutorGroupDetailDTO }> {
  const res = await fetch(`${API_BASE}/api/tutor/group/${groupId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiAcceptTutorGroup(
  token: string,
  groupId: string,
): Promise<{ ok: boolean; group: { id: string; status: string; members: TutorGroupMemberDTO[] } }> {
  const res = await fetch(`${API_BASE}/api/tutor/group/${groupId}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiDeclineTutorGroup(token: string, groupId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/tutor/group/${groupId}/decline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiEndTutorGroup(token: string, groupId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/tutor/group/${groupId}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiGetTutorGroupSession(
  token: string,
  groupId: string,
): Promise<{ session: TutorSessionDTO }> {
  const res = await fetch(`${API_BASE}/api/tutor/group/${groupId}/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res);
}

export async function apiFetchGroupSlideAudioBlobUrl(
  token: string,
  groupId: string,
  slideIndex: number,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/tutor/group/${groupId}/slides/${slideIndex}/tts`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function apiFetchGroupTtsBlobUrl(token: string, groupId: string, text: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/tutor/group/${groupId}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function apiGroupTutorAsk(
  token: string,
  params: { groupId: string; slideIndex: number; audio: Blob },
): Promise<{ question: string; answer: string }> {
  const fd = new FormData();
  fd.append("slideIndex", String(params.slideIndex));
  const ext = params.audio.type.split(";")[0].split("/")[1] || "webm";
  fd.append("audio", params.audio, `question.${ext}`);
  const res = await fetch(`${API_BASE}/api/tutor/group/${params.groupId}/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  return parseJson(res);
}
