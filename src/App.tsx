/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
  type AudioVideoFacade,
  type AudioVideoObserver,
  type VideoTileState,
} from "amazon-chime-sdk-js";
import {
  AlertCircle,
  Calendar,
  CalendarPlus,
  Camera,
  CameraOff,
  Check,
  Clock,
  Copy,
  Link2,
  LogIn,
  Mail,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
  Zap,
} from "lucide-react";

const API_URL =
  "https://xxrloagqdjupnoozcohrm36a5i0ougyt.lambda-url.ap-south-1.on.aws/";

type ConnectionStatus = "Idle" | "Joining" | "Connected" | "Error";

interface TileItem {
  tileId: number;
  isLocal: boolean;
  attendeeId: string;
  label: string;
}

interface AttendeePresence {
  attendeeId: string;
  externalUserId: string;
  label: string;
}

interface MemberInvite {
  email: string;
  status: "pending" | "sending" | "sent" | "error";
  errorMessage?: string;
}

interface MeetingItem {
  id: string;
  title: string;
  roomCode: string;
  scheduledTime: string; // ISO datetime-local string or ""
  createdAt: string;
  members: MemberInvite[];
}

const STORAGE_KEY = "chime_meet_saved_meetings_v2";

function generateMeetingCode(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const part = (len: number) =>
    Array.from({ length: len }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join("");
  return `${part(3)}-${part(4)}-${part(3)}`;
}

function buildMeetingLink(roomCode: string): string {
  if (typeof window === "undefined") {
    return `?room=${encodeURIComponent(roomCode)}`;
  }
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(
    roomCode.trim()
  )}`;
}

function extractRoomCodeFromInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    if (
      trimmed.includes("?room=") ||
      trimmed.includes("&room=") ||
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://")
    ) {
      const url = new URL(
        trimmed.startsWith("http")
          ? trimmed
          : `https://example.com/${trimmed.replace(/^\//, "")}`
      );
      const roomParam = url.searchParams.get("room")?.trim();
      if (roomParam) return roomParam;
    }
  } catch {
    const match = trimmed.match(/[?&]room=([^&#\s]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1].trim());
    }
  }
  return trimmed;
}

function formatExternalUserId(
  externalUserId?: string | null,
  fallbackId?: string | null
): string {
  if (externalUserId && externalUserId.trim().length > 0) {
    const withoutHash = externalUserId.split("#")[0];
    const cleaned = withoutHash.replace(/-[0-9a-f]{8}$/i, "");
    return cleaned || withoutHash || externalUserId;
  }
  if (fallbackId) {
    return `Attendee ${fallbackId.slice(0, 6)}`;
  }
  return "Remote Attendee";
}

function getRoomFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get("room")?.trim();
  return roomParam || "";
}

function formatScheduledTime(isoValue: string): string {
  if (!isoValue) return "Instant / Anytime";
  try {
    const d = new Date(isoValue);
    if (Number.isNaN(d.getTime())) return isoValue;
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoValue;
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default function App() {
  const initialUrlRoom = getRoomFromUrl();

  const [roomName, setRoomName] = useState<string>(
    initialUrlRoom || "test"
  );
  const [userName, setUserName] = useState<string>("guest");
  const [status, setStatus] = useState<ConnectionStatus>("Idle");
  const [errorText, setErrorText] = useState<string>("");
  const [activeMeetingId, setActiveMeetingId] = useState<string>("");
  const [copiedRoomCode, setCopiedRoomCode] = useState<string | null>(null);
  const [inMeetingView, setInMeetingView] = useState<boolean>(
    Boolean(initialUrlRoom)
  );

  // Single-email invite inside active room bar
  const [inviteEmail, setInviteEmail] = useState<string>("");
  const [inviteSending, setInviteSending] = useState<boolean>(false);
  const [inviteSuccess, setInviteSuccess] = useState<string>("");
  const [inviteError, setInviteError] = useState<string>("");

  // Multiple meetings creator & scheduler state
  const [meetings, setMeetings] = useState<MeetingItem[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignore storage errors
    }
    return [];
  });

  const [newMeetingTitle, setNewMeetingTitle] = useState<string>("");
  const [newMeetingCode, setNewMeetingCode] = useState<string>(() =>
    generateMeetingCode()
  );
  const [newMeetingTime, setNewMeetingTime] = useState<string>("");
  const [newMemberInput, setNewMemberInput] = useState<string>("");
  const [draftMembers, setDraftMembers] = useState<string[]>([]);
  const [creatorFeedback, setCreatorFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [creatingMeeting, setCreatingMeeting] = useState<boolean>(false);

  // Per-meeting additional member email input map
  const [meetingMemberInputs, setMeetingMemberInputs] = useState<
    Record<string, string>
  >({});
  const [meetingFeedbackMap, setMeetingFeedbackMap] = useState<
    Record<string, { type: "success" | "error"; text: string }>
  >({});

  // Chime media states
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isCameraOn, setIsCameraOn] = useState<boolean>(false);
  const [tiles, setTiles] = useState<TileItem[]>([]);
  const [attendees, setAttendees] = useState<Record<string, AttendeePresence>>(
    {}
  );

  const sessionRef = useRef<DefaultMeetingSession | null>(null);
  const audioVideoRef = useRef<AudioVideoFacade | null>(null);
  const observerRef = useRef<AudioVideoObserver | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const videoElementsMapRef = useRef<Map<number, HTMLVideoElement>>(new Map());
  const activeCameraIdRef = useRef<string | null>(null);
  const activeMicIdRef = useRef<string | null>(null);
  const localAttendeeIdRef = useRef<string | null>(null);
  const autoJoinedUrlRoomRef = useRef<boolean>(false);
  const meetingStageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(meetings));
    } catch {
      // Ignore storage quota errors
    }
  }, [meetings]);

  const cleanupMeeting = useCallback(async (nextStatus?: ConnectionStatus) => {
    const av = audioVideoRef.current;
    if (av) {
      try {
        if (observerRef.current) {
          av.removeObserver(observerRef.current);
        }
      } catch {
        // Ignore observer removal errors
      }
      try {
        av.stopLocalVideoTile();
      } catch {
        // Ignore local video tile stop errors
      }
      try {
        await av.stopAudioInput();
      } catch {
        // Ignore audio input stop errors
      }
      try {
        await av.stopVideoInput();
      } catch {
        // Ignore video input stop errors
      }
      try {
        av.stop();
      } catch {
        // Ignore stop errors
      }
      try {
        av.unbindAudioElement();
      } catch {
        // Ignore audio unbind errors
      }
    }

    videoElementsMapRef.current.clear();
    observerRef.current = null;
    audioVideoRef.current = null;
    sessionRef.current = null;
    activeCameraIdRef.current = null;
    activeMicIdRef.current = null;
    localAttendeeIdRef.current = null;

    setTiles([]);
    setAttendees({});
    setActiveMeetingId("");
    setIsMuted(false);
    setIsCameraOn(false);
    if (nextStatus) {
      setStatus(nextStatus);
    }
  }, []);

  const joinRoomByCode = useCallback(
    async (targetRoomRaw: string, customUserName?: string) => {
      const trimmedRoom = extractRoomCodeFromInput(targetRoomRaw) || "test";
      const trimmedUser = (customUserName ?? userName).trim() || "guest";

      setRoomName(trimmedRoom);
      setInMeetingView(true);
      setErrorText("");
      setStatus("Joining");

      // Scroll meeting room stage into view smoothly
      setTimeout(() => {
        meetingStageRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);

      try {
        await cleanupMeeting();
        setStatus("Joining");

        try {
          const url = new URL(window.location.href);
          url.searchParams.set("room", trimmedRoom);
          window.history.replaceState({}, "", url.toString());
        } catch {
          // Ignore history errors in restricted iframes
        }

        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            room: trimmedRoom,
            user: trimmedUser,
          }),
        });

        const rawResponseText = await response.text();
        let parsed: unknown = rawResponseText;

        try {
          parsed = JSON.parse(rawResponseText);
          if (typeof parsed === "string") {
            parsed = JSON.parse(parsed);
          }
        } catch {
          // Keep rawResponseText so it can be shown as the raw response error below
        }

        let payload = parsed as Record<string, unknown> | null;
        if (
          payload &&
          typeof payload === "object" &&
          !payload.Meeting &&
          typeof payload.body === "string"
        ) {
          try {
            const inner = JSON.parse(payload.body);
            if (inner && typeof inner === "object") {
              payload = inner as Record<string, unknown>;
            }
          } catch {
            // Ignore inner parse error
          }
        }

        const Meeting = payload?.Meeting as Record<string, unknown> | undefined;
        const Attendee = payload?.Attendee as
          | Record<string, unknown>
          | undefined;

        if (!Meeting || !Attendee) {
          setStatus("Error");
          setErrorText(
            rawResponseText ||
              JSON.stringify(parsed, null, 2) ||
              "Invalid server response: missing Meeting or Attendee."
          );
          return;
        }

        localAttendeeIdRef.current =
          typeof Attendee.AttendeeId === "string" ? Attendee.AttendeeId : null;
        setActiveMeetingId(
          typeof Meeting.MeetingId === "string" ? Meeting.MeetingId : ""
        );

        // Request browser permissions beforehand if possible, without blocking meeting join if denied/busy
        if (navigator.mediaDevices?.getUserMedia) {
          try {
            const permStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: true,
            });
            permStream.getTracks().forEach((track) => track.stop());
          } catch {
            try {
              const audioPermStream = await navigator.mediaDevices.getUserMedia(
                {
                  audio: true,
                }
              );
              audioPermStream.getTracks().forEach((track) => track.stop());
            } catch {
              // Continue so the user still enters the meeting room even if permissions need a button click
            }
          }
        }

        // Remove EventIngestionUrl and TenantIds array from Meeting payload so Chime SDK's
        // internal EventReporter does not throw "TypeError: Unhandled type received while flattening attributes"
        const sanitizedMeeting = { ...Meeting };
        delete sanitizedMeeting.TenantIds;
        if (
          sanitizedMeeting.MediaPlacement &&
          typeof sanitizedMeeting.MediaPlacement === "object"
        ) {
          const placement = {
            ...(sanitizedMeeting.MediaPlacement as Record<string, unknown>),
          };
          delete placement.EventIngestionUrl;
          sanitizedMeeting.MediaPlacement = placement;
        }

        const logger = new ConsoleLogger("Chime", LogLevel.OFF);
        const config = new MeetingSessionConfiguration(
          sanitizedMeeting,
          Attendee
        );
        config.connectionTimeoutMs = 30000;
        const session = new DefaultMeetingSession(
          config,
          logger,
          new DefaultDeviceController(logger)
        );
        const audioVideo = session.audioVideo;

        sessionRef.current = session;
        audioVideoRef.current = audioVideo;

        const mics = await audioVideo.listAudioInputDevices();
        const cams = await audioVideo.listVideoInputDevices();

        if (!mics || mics.length === 0 || !cams || cams.length === 0) {
          const missing: string[] = [];
          if (!mics || mics.length === 0) missing.push("microphone");
          if (!cams || cams.length === 0) missing.push("camera");
          await cleanupMeeting("Error");
          setErrorText(
            `No ${missing.join(
              " or "
            )} input devices found. Please connect a microphone and camera, allow permissions, and click Join.`
          );
          return;
        }

        // Start microphone input
        const micDeviceId = mics[0]?.deviceId || "default";
        activeMicIdRef.current = micDeviceId;
        try {
          await audioVideo.startAudioInput(micDeviceId);
          setIsMuted(false);
        } catch {
          setIsMuted(true);
        }

        // Start camera input if deviceId is available and not locked
        let localVideoStarted = false;
        const camDeviceId = cams[0]?.deviceId;
        if (camDeviceId) {
          activeCameraIdRef.current = camDeviceId;
          try {
            await audioVideo.startVideoInput(camDeviceId);
            localVideoStarted = true;
            setIsCameraOn(true);
          } catch {
            setIsCameraOn(false);
          }
        } else {
          setIsCameraOn(false);
        }

        if (audioElementRef.current) {
          try {
            await audioVideo.bindAudioElement(audioElementRef.current);
          } catch {
            // Ignore audio element bind restriction until user interaction
          }
        }

        audioVideo.realtimeSubscribeToAttendeeIdPresence(
          (presentAttendeeId, present, externalUserId) => {
            setAttendees((prev) => {
              const next = { ...prev };
              if (!present) {
                delete next[presentAttendeeId];
              } else {
                const isSelf = presentAttendeeId === localAttendeeIdRef.current;
                next[presentAttendeeId] = {
                  attendeeId: presentAttendeeId,
                  externalUserId: externalUserId || "",
                  label: isSelf
                    ? "You"
                    : formatExternalUserId(externalUserId, presentAttendeeId),
                };
              }
              return next;
            });
          }
        );

        const observer: AudioVideoObserver = {
          audioVideoDidStart: () => {
            setStatus("Connected");
            if (localVideoStarted) {
              audioVideo.startLocalVideoTile();
            }
          },
          audioVideoDidStop: (sessionStatus) => {
            const statusCode = sessionStatus?.statusCode?.();
            setTiles([]);
            setAttendees({});
            if (sessionStatus?.isFailure?.()) {
              void cleanupMeeting("Error");
              setErrorText(
                `Meeting connection closed or expired (code ${statusCode}). Click "Join" to reconnect to this meeting room.`
              );
            } else {
              setStatus((prev) => (prev === "Error" ? "Error" : "Idle"));
            }
          },
          videoTileDidUpdate: (tileState: VideoTileState) => {
            if (
              tileState.tileId === null ||
              tileState.isContent ||
              !tileState.boundAttendeeId
            ) {
              return;
            }

            const tileId = tileState.tileId;
            const isLocal = Boolean(tileState.localTile);
            const attendeeId = tileState.boundAttendeeId;
            const label = isLocal
              ? "You"
              : formatExternalUserId(
                  tileState.boundExternalUserId,
                  tileState.boundAttendeeId
                );

            setTiles((prev) => {
              const existingByTileIdx = prev.findIndex(
                (t) => t.tileId === tileId || t.attendeeId === attendeeId
              );
              if (existingByTileIdx !== -1) {
                const updated = [...prev];
                updated[existingByTileIdx] = {
                  tileId,
                  isLocal,
                  attendeeId,
                  label,
                };
                return updated;
              }

              if (prev.length >= 4) {
                if (isLocal) {
                  return [
                    { tileId, isLocal, attendeeId, label },
                    ...prev.slice(0, 3),
                  ];
                }
                return prev;
              }

              const next = [...prev, { tileId, isLocal, attendeeId, label }];
              next.sort((a, b) =>
                a.isLocal === b.isLocal
                  ? a.tileId - b.tileId
                  : a.isLocal
                  ? -1
                  : 1
              );
              return next;
            });

            const existingVideoEl = videoElementsMapRef.current.get(tileId);
            if (existingVideoEl) {
              audioVideo.bindVideoElement(tileId, existingVideoEl);
            }
          },
          videoTileWasRemoved: (tileId: number) => {
            videoElementsMapRef.current.delete(tileId);
            setTiles((prev) => prev.filter((t) => t.tileId !== tileId));
          },
        };

        observerRef.current = observer;
        audioVideo.addObserver(observer);

        audioVideo.start();
      } catch (err: unknown) {
        await cleanupMeeting("Error");
        const message =
          err instanceof Error
            ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`
            : typeof err === "string"
            ? err
            : JSON.stringify(err, null, 2);
        setErrorText(
          message || "An unexpected error occurred while joining the meeting."
        );
      }
    },
    [cleanupMeeting, userName]
  );

  // When page loads with ?room=<code_from_link>, auto-fill AND automatically enter & connect to that meeting room
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room")?.trim();
    if (roomParam) {
      setRoomName(roomParam);
      setInMeetingView(true);
      if (!autoJoinedUrlRoomRef.current) {
        autoJoinedUrlRoomRef.current = true;
        void joinRoomByCode(roomParam, "guest");
      }
    }
    return () => {
      void cleanupMeeting();
    };
  }, [cleanupMeeting, joinRoomByCode]);

  // Helper to send a single email invite via API_URL
  const sendInviteRequest = async (
    targetEmail: string,
    targetRoom: string,
    senderName: string
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "invite",
          email: targetEmail.trim(),
          room: targetRoom.trim(),
          fromName: senderName.trim() || "guest",
        }),
      });

      const rawText = await response.text();
      let data: Record<string, unknown> | null = null;
      try {
        let parsed: unknown = JSON.parse(rawText);
        if (typeof parsed === "string") {
          parsed = JSON.parse(parsed);
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          !("ok" in parsed) &&
          !("error" in parsed) &&
          typeof (parsed as Record<string, unknown>).body === "string"
        ) {
          parsed = JSON.parse(
            (parsed as Record<string, unknown>).body as string
          );
        }
        if (parsed && typeof parsed === "object") {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        return {
          ok: false,
          error: rawText || `Request failed with status ${response.status}`,
        };
      }

      if (data?.ok === true) {
        return { ok: true };
      }
      if (data?.error) {
        return {
          ok: false,
          error:
            typeof data.error === "string"
              ? data.error
              : JSON.stringify(data.error),
        };
      }
      return {
        ok: false,
        error: rawText || `Failed to send invite (status ${response.status})`,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to send invite.",
      };
    }
  };

  // Single email invite handler
  const handleSendInvite = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (inviteSending) return;

    setInviteSuccess("");
    setInviteError("");

    const trimmedEmail = inviteEmail.trim();
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
      setInviteError("Please enter a valid email address.");
      return;
    }

    const cleanRoom = extractRoomCodeFromInput(roomName) || "test";
    setInviteSending(true);
    const result = await sendInviteRequest(trimmedEmail, cleanRoom, userName);
    setInviteSending(false);

    if (result.ok) {
      setInviteSuccess("Invite sent");
      setInviteEmail("");
    } else {
      setInviteError(result.error || "Failed to send invite.");
    }
  };

  // Start an instant meeting immediately in one click
  const handleStartInstantMeeting = async () => {
    const instantCode = generateMeetingCode();
    const newInstantMeeting: MeetingItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: `Instant Meeting (${instantCode})`,
      roomCode: instantCode,
      scheduledTime: "",
      createdAt: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      members: [],
    };
    setMeetings((prev) => [newInstantMeeting, ...prev]);
    await joinRoomByCode(instantCode);
  };

  // Add member email(s) to the New Meeting draft list
  const handleAddDraftMember = () => {
    setCreatorFeedback(null);
    const raw = newMemberInput.trim();
    if (!raw) return;

    const candidates = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const invalid = candidates.filter((c) => !isValidEmail(c));
    if (invalid.length > 0) {
      setCreatorFeedback({
        type: "error",
        text: `Invalid email address: ${invalid.join(", ")}`,
      });
      return;
    }

    setDraftMembers((prev) => {
      const existing = new Set(prev);
      candidates.forEach((c) => existing.add(c));
      return Array.from(existing);
    });
    setNewMemberInput("");
  };

  const handleRemoveDraftMember = (emailToRemove: string) => {
    setDraftMembers((prev) => prev.filter((item) => item !== emailToRemove));
  };

  // Create a new meeting link (with optional scheduled time & member emails)
  const handleCreateMeeting = async (
    e: React.FormEvent,
    joinImmediately = false
  ) => {
    e.preventDefault();
    if (creatingMeeting) return;
    setCreatorFeedback(null);

    let finalMembers = [...draftMembers];
    if (newMemberInput.trim()) {
      const extraCandidates = newMemberInput
        .trim()
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const invalidExtra = extraCandidates.filter((c) => !isValidEmail(c));
      if (invalidExtra.length > 0) {
        setCreatorFeedback({
          type: "error",
          text: `Invalid email address: ${invalidExtra.join(", ")}`,
        });
        return;
      }
      const setAll = new Set(finalMembers);
      extraCandidates.forEach((c) => setAll.add(c));
      finalMembers = Array.from(setAll);
      setNewMemberInput("");
    }

    const code = newMeetingCode.trim() || generateMeetingCode();
    const title =
      newMeetingTitle.trim() || `Meeting ${meetings.length + 1} (${code})`;

    const meetingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const initialMemberObjects: MemberInvite[] = finalMembers.map((email) => ({
      email,
      status: "sending",
    }));

    const createdMeeting: MeetingItem = {
      id: meetingId,
      title,
      roomCode: code,
      scheduledTime: newMeetingTime,
      createdAt: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      members: initialMemberObjects,
    };

    setMeetings((prev) => [createdMeeting, ...prev]);

    if (status !== "Connected" && status !== "Joining") {
      setRoomName(code);
    }

    setNewMeetingTitle("");
    setNewMeetingTime("");
    setNewMeetingCode(generateMeetingCode());
    setDraftMembers([]);

    if (finalMembers.length > 0) {
      setCreatingMeeting(true);
      const results = await Promise.all(
        finalMembers.map(async (email) => {
          const res = await sendInviteRequest(email, code, userName);
          return { email, ...res };
        })
      );
      setCreatingMeeting(false);

      const sentCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);

      setMeetings((prev) =>
        prev.map((m) => {
          if (m.id !== meetingId) return m;
          return {
            ...m,
            members: m.members.map((mem) => {
              const match = results.find((r) => r.email === mem.email);
              if (!match) return mem;
              return {
                email: mem.email,
                status: match.ok ? "sent" : "error",
                errorMessage: match.error,
              };
            }),
          };
        })
      );

      if (failed.length === 0) {
        setCreatorFeedback({
          type: "success",
          text: `Invite sent (${sentCount} member${
            sentCount === 1 ? "" : "s"
          }) for meeting ${code}`,
        });
      } else {
        setCreatorFeedback({
          type: "error",
          text:
            failed[0].error ||
            `Sent ${sentCount}/${finalMembers.length} invites. Some failed.`,
        });
      }
    } else {
      setCreatorFeedback({
        type: "success",
        text: `Meeting link created (${code}).`,
      });
    }

    if (joinImmediately) {
      await joinRoomByCode(code);
    }
  };

  // Add and invite a member to an existing created meeting card
  const handleInviteMemberToExistingMeeting = async (
    meeting: MeetingItem,
    e: React.FormEvent
  ) => {
    e.preventDefault();
    const rawInput = (meetingMemberInputs[meeting.id] || "").trim();
    if (!rawInput) return;

    const emails = rawInput
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const invalid = emails.filter((em) => !isValidEmail(em));
    if (invalid.length > 0) {
      setMeetingFeedbackMap((prev) => ({
        ...prev,
        [meeting.id]: {
          type: "error",
          text: `Invalid email: ${invalid.join(", ")}`,
        },
      }));
      return;
    }

    setMeetingMemberInputs((prev) => ({ ...prev, [meeting.id]: "" }));
    setMeetingFeedbackMap((prev) => {
      const next = { ...prev };
      delete next[meeting.id];
      return next;
    });

    setMeetings((prev) =>
      prev.map((m) => {
        if (m.id !== meeting.id) return m;
        const existingEmails = new Set(m.members.map((x) => x.email));
        const updatedMembers = m.members.map((x) =>
          emails.includes(x.email)
            ? { ...x, status: "sending" as const, errorMessage: undefined }
            : x
        );
        emails.forEach((em) => {
          if (!existingEmails.has(em)) {
            updatedMembers.push({ email: em, status: "sending" });
          }
        });
        return { ...m, members: updatedMembers };
      })
    );

    const results = await Promise.all(
      emails.map(async (email) => {
        const res = await sendInviteRequest(email, meeting.roomCode, userName);
        return { email, ...res };
      })
    );

    const allOk = results.every((r) => r.ok);
    const firstErr = results.find((r) => !r.ok)?.error;

    setMeetings((prev) =>
      prev.map((m) => {
        if (m.id !== meeting.id) return m;
        return {
          ...m,
          members: m.members.map((mem) => {
            const match = results.find((r) => r.email === mem.email);
            if (!match) return mem;
            return {
              email: mem.email,
              status: match.ok ? "sent" : "error",
              errorMessage: match.error,
            };
          }),
        };
      })
    );

    setMeetingFeedbackMap((prev) => ({
      ...prev,
      [meeting.id]: allOk
        ? { type: "success", text: "Invite sent" }
        : { type: "error", text: firstErr || "Failed to send invite" },
    }));
  };

  const handleDeleteMeeting = (id: string) => {
    setMeetings((prev) => prev.filter((m) => m.id !== id));
  };

  const handleCopyLinkForRoom = async (targetRoomCode: string) => {
    const cleanRoom = extractRoomCodeFromInput(targetRoomCode) || "test";
    const inviteUrl = buildMeetingLink(cleanRoom);

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedRoomCode(cleanRoom);
      setTimeout(() => setCopiedRoomCode(null), 2500);
    } catch {
      const input = document.createElement("input");
      input.value = inviteUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopiedRoomCode(cleanRoom);
      setTimeout(() => setCopiedRoomCode(null), 2500);
    }
  };

  const handleJoin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (status === "Joining") return;
    await joinRoomByCode(roomName);
  };

  const handleLeave = async () => {
    setErrorText("");
    await cleanupMeeting("Idle");
  };

  const handleToggleMute = async () => {
    const av = audioVideoRef.current;
    if (!av) return;

    if (isMuted) {
      // Ensure audio input is started in case permissions were granted after initial load
      try {
        const mics = await av.listAudioInputDevices();
        const micId = activeMicIdRef.current || mics[0]?.deviceId || "default";
        await av.startAudioInput(micId);
      } catch {
        // Ignore if already started
      }
      const unmuted = av.realtimeUnmuteLocalAudio();
      if (unmuted) {
        setIsMuted(false);
      }
    } else {
      av.realtimeMuteLocalAudio();
      setIsMuted(true);
    }
  };

  const handleToggleCamera = async () => {
    const av = audioVideoRef.current;
    if (!av) return;

    try {
      if (isCameraOn) {
        av.stopLocalVideoTile();
        await av.stopVideoInput();
        setIsCameraOn(false);
      } else {
        if (navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
          stream.getTracks().forEach((t) => t.stop());
        }
        const cams = await av.listVideoInputDevices();
        const deviceId = activeCameraIdRef.current || cams[0]?.deviceId;
        if (!deviceId) {
          setErrorText("No camera device available to start video.");
          return;
        }
        activeCameraIdRef.current = deviceId;
        await av.startVideoInput(deviceId);
        av.startLocalVideoTile();
        setIsCameraOn(true);
        setErrorText("");
      }
    } catch (err: unknown) {
      setErrorText(
        err instanceof Error ? `Camera error: ${err.message}` : String(err)
      );
    }
  };

  const isConnected = status === "Connected";
  const isJoining = status === "Joining";
  const isBusyOrConnected = isJoining || isConnected;
  const currentCleanRoom = extractRoomCodeFromInput(roomName) || "test";

  const attendeeList = Object.values(attendees);

  const gridColsClass =
    tiles.length <= 1
      ? "grid-cols-1 max-w-3xl mx-auto"
      : "grid-cols-1 md:grid-cols-2";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Hidden audio element required by Amazon Chime SDK */}
      <audio ref={audioElementRef} className="hidden" autoPlay playsInline />

      {/* Top Bar */}
      <header className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-9 h-9 rounded-lg bg-indigo-600/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Video className="w-5 h-5" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white whitespace-nowrap">
              Chime Meet
            </span>
          </div>

          {/* Status line (Idle, Joining, Connected, Error) */}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div className="flex items-center gap-2 text-slate-400">
              <span>Status:</span>
              <span
                data-testid="status-line"
                className={`font-mono font-medium tabular-nums ${
                  status === "Connected"
                    ? "text-emerald-400"
                    : status === "Joining"
                    ? "text-amber-400"
                    : status === "Error"
                    ? "text-rose-400"
                    : "text-slate-300"
                }`}
              >
                {status}
              </span>
            </div>

            {activeMeetingId && (
              <>
                <span className="text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span
                  className="text-xs text-slate-400 font-mono tabular-nums"
                  title={`AWS Chime Meeting ID: ${activeMeetingId}`}
                >
                  Room: {currentCleanRoom} ({activeMeetingId.slice(0, 8)})
                </span>
              </>
            )}

            <span className="text-slate-700" aria-hidden="true">
              ·
            </span>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 font-mono tabular-nums">
              <Users className="w-3.5 h-3.5 text-slate-500" />
              <span>
                {attendeeList.length} in room · {tiles.length} / 4 video tiles
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-6 flex flex-col gap-6">
        {/* Clearly visible error box showing full error text */}
        {errorText && (
          <section
            role="alert"
            aria-live="assertive"
            className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-rose-200"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-4 mb-1">
                  <h2 className="text-sm font-semibold text-rose-300">
                    Meeting Error
                  </h2>
                  <button
                    type="button"
                    onClick={() => setErrorText("")}
                    className="text-xs text-rose-300/80 hover:text-rose-100 underline cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap break-words text-rose-100/90 bg-slate-950/60 border border-rose-500/20 rounded-lg p-3 overflow-x-auto">
                  {errorText}
                </pre>
              </div>
            </div>
          </section>
        )}

        {/* Active Meeting Room Stage (shown at the top when joining/connected or when opened via ?room= link) */}
        <div
          ref={meetingStageRef}
          className={`flex flex-col gap-4 ${
            inMeetingView || isBusyOrConnected ? "order-1" : "order-2"
          }`}
        >
          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 flex flex-col gap-4">
            {/* Active Room Control Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold text-white">
                  Meeting Room:{" "}
                  <span className="font-mono text-indigo-300">
                    {currentCleanRoom}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyLinkForRoom(currentCleanRoom)}
                  className="h-8 px-3 rounded-lg border border-slate-800 bg-slate-950 hover:bg-slate-800 text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {copiedRoomCode === currentCleanRoom ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Link Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-slate-400" />
                      <span>Copy Meeting Link</span>
                    </>
                  )}
                </button>
              </div>

              {/* Audio / Video / Join / Leave Controls */}
              <div className="flex flex-wrap items-center gap-2.5">
                {!isConnected && (
                  <button
                    type="button"
                    onClick={() => void handleJoin()}
                    disabled={isJoining}
                    className="h-9 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    <span>{isJoining ? "Joining Room..." : "Join Room Now"}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleToggleMute()}
                  disabled={!isConnected}
                  aria-pressed={isMuted}
                  className={`h-9 px-3.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0 ${
                    isMuted
                      ? "bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25"
                      : "bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800"
                  }`}
                >
                  {isMuted ? (
                    <>
                      <MicOff className="w-3.5 h-3.5 text-amber-400" />
                      <span>Unmute Mic</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Mute Mic</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void handleToggleCamera()}
                  disabled={!isConnected}
                  aria-pressed={!isCameraOn}
                  className={`h-9 px-3.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0 ${
                    !isCameraOn
                      ? "bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25"
                      : "bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800"
                  }`}
                >
                  {isCameraOn ? (
                    <>
                      <Camera className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Camera Off</span>
                    </>
                  ) : (
                    <>
                      <CameraOff className="w-3.5 h-3.5 text-amber-400" />
                      <span>Camera On</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void handleLeave()}
                  disabled={!isBusyOrConnected}
                  className="h-9 px-4 rounded-lg bg-rose-600/90 hover:bg-rose-500 active:bg-rose-700 disabled:bg-slate-800/70 disabled:text-slate-500 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>Leave</span>
                </button>
              </div>
            </div>

            {/* Active participants roster */}
            {isConnected && attendeeList.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className="font-medium text-slate-300">
                  Participants in room ({attendeeList.length}):
                </span>
                {attendeeList.map((att, idx) => (
                  <React.Fragment key={att.attendeeId}>
                    {idx > 0 && <span aria-hidden="true">·</span>}
                    <span className="text-slate-200">{att.label}</span>
                  </React.Fragment>
                ))}
              </div>
            )}

            {/* Responsive Video Grid (up to 4 tiles) */}
            {tiles.length === 0 ? (
              <div className="min-h-[340px] rounded-xl border border-slate-800/80 bg-slate-950/60 flex flex-col items-center justify-center p-8 text-center">
                <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-indigo-400 mb-4">
                  <Video className="w-6 h-6" />
                </div>
                <h2 className="text-base font-semibold text-slate-200 mb-1">
                  {status === "Joining"
                    ? `Joining meeting room "${currentCleanRoom}"...`
                    : status === "Connected"
                    ? `Connected to "${currentCleanRoom}" (${
                        attendeeList.length
                      } participant${attendeeList.length === 1 ? "" : "s"} in room)`
                    : `Meeting Room: ${currentCleanRoom}`}
                </h2>
                <p className="text-sm text-slate-400 max-w-md mb-4">
                  {status === "Joining"
                    ? "Connecting to Amazon Chime audio & video session..."
                    : status === "Connected"
                    ? "You are in the meeting room with audio active. Click 'Camera On' above to turn on your video tile."
                    : "Click 'Join Room Now' to connect your microphone and camera to this room."}
                </p>
                {!isConnected && !isJoining && (
                  <button
                    type="button"
                    onClick={() => void handleJoin()}
                    className="h-10 px-5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>Join Room Now ({currentCleanRoom})</span>
                  </button>
                )}
              </div>
            ) : (
              <div
                className={`grid ${gridColsClass} gap-4 auto-rows-fr w-full`}
              >
                {tiles.map((tile) => (
                  <div
                    key={tile.tileId}
                    className="relative aspect-video rounded-xl overflow-hidden bg-slate-950 border border-slate-800 shadow-sm flex items-center justify-center"
                  >
                    <video
                      ref={(el) => {
                        if (el) {
                          videoElementsMapRef.current.set(tile.tileId, el);
                          if (audioVideoRef.current) {
                            audioVideoRef.current.bindVideoElement(
                              tile.tileId,
                              el
                            );
                          }
                        } else {
                          videoElementsMapRef.current.delete(tile.tileId);
                        }
                      }}
                      autoPlay
                      playsInline
                      muted={tile.isLocal}
                      className="w-full h-full object-cover bg-slate-950"
                    />

                    {/* Bottom scrim and attendee label */}
                    <div
                      className="
                      absolute inset-x-0 bottom-0 p-3
                      bg-gradient-to-t from-black/80 via-black/40 to-transparent
                      flex items-center justify-between gap-2 pointer-events-none
                    "
                    >
                      <span className="text-sm font-medium text-white truncate">
                        {tile.isLocal ? "You" : tile.label}
                      </span>
                      {tile.isLocal && isMuted && (
                        <span className="text-xs text-amber-300 flex items-center gap-1">
                          <MicOff className="w-3.5 h-3.5" />
                          <span>Muted</span>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Invite by email bar inside room */}
            <div className="pt-3 border-t border-slate-800/80">
              <form
                onSubmit={handleSendInvite}
                className="flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <label
                  htmlFor="invite-email-input"
                  className="text-xs font-medium text-slate-300 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Mail className="w-3.5 h-3.5 text-slate-400" />
                  <span>Invite by email</span>
                </label>
                <div className="flex flex-1 items-center gap-2.5 max-w-md">
                  <input
                    id="invite-email-input"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => {
                      setInviteEmail(e.target.value);
                      if (inviteSuccess) setInviteSuccess("");
                      if (inviteError) setInviteError("");
                    }}
                    placeholder="colleague@example.com"
                    className="flex-1 h-9 px-3 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={inviteSending}
                    className="h-9 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-800 disabled:opacity-50 text-slate-100 text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{inviteSending ? "Sending..." : "Send invite"}</span>
                  </button>
                </div>
                {inviteSuccess && (
                  <span className="text-xs font-medium text-emerald-400">
                    {inviteSuccess}
                  </span>
                )}
                {inviteError && (
                  <span className="text-xs font-medium text-rose-400">
                    {inviteError}
                  </span>
                )}
              </form>
            </div>
          </section>
        </div>

        {/* UNIFIED SECTION: Instant Meeting, Join by Link/Code, and Create/Schedule Meeting Links */}
        <div
          className={`flex flex-col gap-6 ${
            inMeetingView || isBusyOrConnected ? "order-2" : "order-1"
          }`}
        >
          <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 sm:p-6 space-y-6">
            {/* Top row of Unified Section: Display Name + Instant Meeting + Join by Link/Code */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    Meetings Hub — Instant Join & Create Meeting Links
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Start an instant meeting, join with a meeting link/code, or schedule multiple meeting links and invite members by email.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
                {/* Your Name */}
                <div className="lg:col-span-3">
                  <label
                    htmlFor="your-name-input"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Your name
                  </label>
                  <input
                    id="your-name-input"
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="guest"
                    className="w-full h-10 px-3.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  />
                </div>

                {/* Instant Meeting Button */}
                <div className="lg:col-span-3">
                  <button
                    type="button"
                    onClick={() => void handleStartInstantMeeting()}
                    disabled={isJoining}
                    className="w-full h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Zap className="w-4 h-4" />
                    <span>Start Instant Meeting</span>
                  </button>
                </div>

                {/* Join with Meeting Link or Room Code */}
                <form
                  onSubmit={handleJoin}
                  className="lg:col-span-6 flex items-end gap-2.5"
                >
                  <div className="flex-1">
                    <label
                      htmlFor="room-name-input"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Room name or meeting link
                    </label>
                    <input
                      id="room-name-input"
                      type="text"
                      value={roomName}
                      onChange={(e) => setRoomName(e.target.value)}
                      placeholder="Paste meeting link (?room=...) or room code"
                      className="w-full h-10 px-3.5 rounded-lg bg-slate-950 border border-slate-800 text-sm font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isJoining}
                    className="h-10 px-5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>{isJoining ? "Joining..." : "Join"}</span>
                  </button>
                </form>
              </div>
            </div>

            {/* Divider inside the single unified section */}
            <div className="border-t border-slate-800/80 pt-5">
              <div className="flex items-center gap-2 mb-4">
                <CalendarPlus className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-white">
                  Create & Schedule Meeting Link (Add Member Emails)
                </h3>
              </div>

              <form
                onSubmit={(e) => void handleCreateMeeting(e, false)}
                className="space-y-4"
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Meeting Title */}
                  <div>
                    <label
                      htmlFor="new-meeting-title"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Meeting title
                    </label>
                    <input
                      id="new-meeting-title"
                      type="text"
                      value={newMeetingTitle}
                      onChange={(e) => setNewMeetingTitle(e.target.value)}
                      placeholder="e.g. Design Review, Team Sync"
                      className="w-full h-10 px-3 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    />
                  </div>

                  {/* Schedule Date & Time */}
                  <div>
                    <label
                      htmlFor="new-meeting-time"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Schedule date & time (optional)
                    </label>
                    <div className="relative">
                      <input
                        id="new-meeting-time"
                        type="datetime-local"
                        value={newMeetingTime}
                        onChange={(e) => setNewMeetingTime(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors [color-scheme:dark]"
                      />
                    </div>
                  </div>

                  {/* Auto-generated Meeting Link Preview */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-medium text-slate-300">
                        Generated meeting link
                      </label>
                      <button
                        type="button"
                        onClick={() => setNewMeetingCode(generateMeetingCode())}
                        className="text-xs text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Regenerate</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-10 px-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center gap-2 min-w-0">
                        <Link2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        <span className="text-xs font-mono text-slate-200 truncate">
                          {buildMeetingLink(newMeetingCode)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCopyLinkForRoom(newMeetingCode)}
                        className="h-10 px-3 rounded-lg border border-slate-800 bg-slate-950 hover:bg-slate-800 text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        {copiedRoomCode === newMeetingCode ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Add Member Emails & Create Buttons */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                  <div className="lg:col-span-7">
                    <label
                      htmlFor="add-member-email"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Add member emails to receive the meeting link
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="add-member-email"
                        type="text"
                        value={newMemberInput}
                        onChange={(e) => {
                          setNewMemberInput(e.target.value);
                          if (creatorFeedback) setCreatorFeedback(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddDraftMember();
                          }
                        }}
                        placeholder="alice@example.com, bob@example.com"
                        className="flex-1 h-10 px-3 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                      />
                      <button
                        type="button"
                        onClick={handleAddDraftMember}
                        className="h-10 px-3.5 rounded-lg border border-slate-800 bg-slate-950 hover:bg-slate-800 text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <UserPlus className="w-3.5 h-3.5 text-indigo-400" />
                        <span>Add Member</span>
                      </button>
                    </div>

                    {draftMembers.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {draftMembers.map((email) => (
                          <div
                            key={email}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-xs text-slate-200"
                          >
                            <Mail className="w-3 h-3 text-slate-400" />
                            <span>{email}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveDraftMember(email)}
                              className="text-slate-500 hover:text-rose-400 cursor-pointer"
                              aria-label={`Remove ${email}`}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="lg:col-span-5 flex flex-wrap items-center lg:justify-end gap-2.5 lg:pt-6">
                    <button
                      type="submit"
                      disabled={creatingMeeting}
                      className="h-10 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white text-xs sm:text-sm font-medium inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Plus className="w-4 h-4" />
                      <span>
                        {creatingMeeting
                          ? "Creating & Sending..."
                          : "Create & Send Link"}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={creatingMeeting}
                      onClick={(e) => void handleCreateMeeting(e, true)}
                      className="h-10 px-4 rounded-lg border border-indigo-500/40 bg-indigo-950/40 hover:bg-indigo-900/50 text-indigo-200 text-xs sm:text-sm font-medium inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <LogIn className="w-4 h-4" />
                      <span>Create, Send & Join Now</span>
                    </button>
                  </div>
                </div>

                {creatorFeedback && (
                  <p
                    className={`text-xs font-medium ${
                      creatorFeedback.type === "success"
                        ? "text-emerald-400"
                        : "text-rose-400"
                    }`}
                  >
                    {creatorFeedback.text}
                  </p>
                )}
              </form>
            </div>

            {/* Multiple Created & Scheduled Meetings List inside the same unified hub */}
            {meetings.length > 0 && (
              <div className="border-t border-slate-800/80 pt-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-white">
                    Your Scheduled & Created Meetings ({meetings.length})
                  </h3>
                  <span className="text-xs text-slate-400">
                    Click Join on any meeting to enter its room
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {meetings.map((meeting) => {
                    const isThisMeetingActive =
                      isConnected && currentCleanRoom === meeting.roomCode;
                    const fb = meetingFeedbackMap[meeting.id];

                    return (
                      <div
                        key={meeting.id}
                        className={`rounded-lg border p-4 flex flex-col justify-between gap-3 transition-colors ${
                          isThisMeetingActive
                            ? "border-indigo-500/60 bg-indigo-950/20"
                            : "border-slate-800 bg-slate-950/70"
                        }`}
                      >
                        <div>
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="text-sm font-semibold text-white truncate">
                                  {meeting.title}
                                </h4>
                                <span
                                  aria-hidden="true"
                                  className="text-slate-600"
                                >
                                  ·
                                </span>
                                <span className="text-xs font-mono text-indigo-300 tabular-nums">
                                  {meeting.roomCode}
                                </span>
                              </div>

                              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1">
                                <span className="inline-flex items-center gap-1 text-slate-300">
                                  {meeting.scheduledTime ? (
                                    <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                                  ) : (
                                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                                  )}
                                  <span className="tabular-nums">
                                    {formatScheduledTime(meeting.scheduledTime)}
                                  </span>
                                </span>
                              </div>

                              <div className="text-xs text-slate-500 font-mono truncate mt-1">
                                {buildMeetingLink(meeting.roomCode)}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyLinkForRoom(meeting.roomCode)
                                }
                                className="h-8 px-2.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-medium inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                              >
                                {copiedRoomCode === meeting.roomCode ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5 text-slate-400" />
                                    <span>Copy Link</span>
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  void joinRoomByCode(meeting.roomCode)
                                }
                                disabled={isJoining || isThisMeetingActive}
                                className={`h-8 px-3 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed whitespace-nowrap ${
                                  isThisMeetingActive
                                    ? "bg-emerald-600/20 border border-emerald-500/40 text-emerald-300"
                                    : "bg-indigo-600 hover:bg-indigo-500 text-white"
                                }`}
                              >
                                <LogIn className="w-3.5 h-3.5" />
                                <span>
                                  {isThisMeetingActive
                                    ? "In Room"
                                    : isConnected
                                    ? "Switch Room"
                                    : "Join Room"}
                                </span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDeleteMeeting(meeting.id)}
                                className="h-8 w-8 rounded-lg border border-slate-800 bg-slate-900 hover:bg-rose-950/50 hover:border-rose-500/40 text-slate-400 hover:text-rose-300 inline-flex items-center justify-center cursor-pointer"
                                title="Delete meeting"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Members list */}
                          {meeting.members.length > 0 && (
                            <div className="mt-2.5 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                              <span className="text-slate-400 font-medium">
                                Members:
                              </span>
                              {meeting.members.map((mem, i) => (
                                <React.Fragment key={mem.email}>
                                  {i > 0 && (
                                    <span
                                      aria-hidden="true"
                                      className="text-slate-700"
                                    >
                                      ·
                                    </span>
                                  )}
                                  <span className="inline-flex items-center gap-1">
                                    <span className="text-slate-200">
                                      {mem.email}
                                    </span>
                                    <span
                                      className={
                                        mem.status === "sent"
                                          ? "text-emerald-400"
                                          : mem.status === "error"
                                          ? "text-rose-400"
                                          : "text-amber-400"
                                      }
                                      title={mem.errorMessage}
                                    >
                                      (
                                      {mem.status === "sent"
                                        ? "Invite sent"
                                        : mem.status === "sending"
                                        ? "Sending..."
                                        : "Failed"}
                                      )
                                    </span>
                                  </span>
                                </React.Fragment>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Add & invite more members to this scheduled meeting */}
                        <form
                          onSubmit={(e) =>
                            void handleInviteMemberToExistingMeeting(meeting, e)
                          }
                          className="pt-2 border-t border-slate-800/60 flex flex-wrap items-center gap-2"
                        >
                          <input
                            type="text"
                            value={meetingMemberInputs[meeting.id] || ""}
                            onChange={(e) =>
                              setMeetingMemberInputs((prev) => ({
                                ...prev,
                                [meeting.id]: e.target.value,
                              }))
                            }
                            placeholder="Add member email(s) to send link..."
                            className="flex-1 min-w-[160px] h-8 px-2.5 rounded-md bg-slate-900 border border-slate-800 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
                          />
                          <button
                            type="submit"
                            className="h-8 px-3 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <Send className="w-3 h-3" />
                            <span>Send Link</span>
                          </button>
                          {fb && (
                            <span
                              className={`text-xs font-medium ${
                                fb.type === "success"
                                  ? "text-emerald-400"
                                  : "text-rose-400"
                              }`}
                            >
                              {fb.text}
                            </span>
                          )}
                        </form>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
