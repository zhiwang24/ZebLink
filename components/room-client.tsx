"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

type Role = "host" | "viewer";
type SignalType = "answer" | "ice-candidate" | "offer" | "user-joined" | "user-left";
type ResolutionOptionId = "540p" | "720p" | "1080p" | "1440p" | "2160p";

type RoomEvent = {
  id: number;
  payload?: RTCIceCandidateInit | RTCSessionDescriptionInit;
  type: SignalType;
};

type JoinResponse =
  | {
      peerPresent: boolean;
      role: Role;
      roomFull: false;
    }
  | {
      roomFull: true;
    };

type PollResponse = {
  events: RoomEvent[];
  peerPresent: boolean;
};

type ResolutionOption = {
  height: number;
  id: ResolutionOptionId;
  label: string;
  width: number;
};

type ShareProfile = {
  bitrate: number;
  contentHint: "motion";
  degradationPreference: RTCDegradationPreference;
  frameRate: number;
  height: number;
  width: number;
};

type DiagnosticsSnapshot = {
  captureFps: string;
  captureResolution: string;
  inboundBitrate: string;
  inboundFps: string;
  inboundResolution: string;
  outboundBitrate: string;
  outboundFps: string;
  outboundResolution: string;
  qualityLimitation: string;
};

const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { id: "540p", label: "540p", width: 960, height: 540 },
  { id: "720p", label: "720p", width: 1280, height: 720 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p", width: 2560, height: 1440 },
  { id: "2160p", label: "4K", width: 3840, height: 2160 },
];

const FRAME_RATE_OPTIONS = [15, 24, 30, 45, 60, 100, 120];
const DEFAULT_RESOLUTION_ID: ResolutionOptionId = "1080p";
const DEFAULT_FRAME_RATE = 60;

const POLL_INTERVAL_IDLE_MS = 1200;
const POLL_INTERVAL_CONNECTED_MS = 1200;
const POLL_INTERVAL_NEGOTIATION_MS = 250;
const STATS_POLL_INTERVAL_MS = 5000;

const EMPTY_DIAGNOSTICS: DiagnosticsSnapshot = {
  captureFps: "—",
  captureResolution: "—",
  inboundBitrate: "—",
  inboundFps: "—",
  inboundResolution: "—",
  outboundBitrate: "—",
  outboundFps: "—",
  outboundResolution: "—",
  qualityLimitation: "none",
};

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

function getResolutionOption(resolutionId: ResolutionOptionId): ResolutionOption {
  return (
    RESOLUTION_OPTIONS.find((option) => option.id === resolutionId) ??
    RESOLUTION_OPTIONS.find((option) => option.id === DEFAULT_RESOLUTION_ID) ??
    RESOLUTION_OPTIONS[0]
  );
}

function getTargetBitrate(width: number, height: number, frameRate: number): number {
  const estimatedBitrate = Math.round(width * height * frameRate * 0.1);
  return Math.min(Math.max(estimatedBitrate, 750_000), 50_000_000);
}

function getShareProfile(
  resolutionId: ResolutionOptionId,
  frameRate: number,
): ShareProfile {
  const resolution = getResolutionOption(resolutionId);
  return {
    bitrate: getTargetBitrate(resolution.width, resolution.height, frameRate),
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
    frameRate,
    height: resolution.height,
    width: resolution.width,
  };
}

function getDisplayMediaConstraints(profile: ShareProfile): DisplayMediaStreamOptions {
  return {
    video: {
      frameRate: {
        ideal: profile.frameRate,
        max: profile.frameRate,
      },
      width: {
        ideal: profile.width,
        max: profile.width,
      },
      height: {
        ideal: profile.height,
        max: profile.height,
      },
    },
    audio: true,
  };
}

function getClientStorageKey(roomId: string): string {
  return `zeblink:client:${roomId}`;
}

function getClientId(roomId: string): string {
  const storageKey = getClientStorageKey(roomId);
  const existingClientId = window.sessionStorage.getItem(storageKey);
  if (existingClientId) {
    return existingClientId;
  }

  const nextClientId = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, nextClientId);
  return nextClientId;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function formatResolution(width?: number, height?: number): string {
  if (!width || !height) {
    return "—";
  }

  return `${width}x${height}`;
}

function formatFps(value?: number): string {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return "—";
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} fps`;
}

function formatBitrate(bitsPerSecond?: number): string {
  if (typeof bitsPerSecond !== "number" || Number.isNaN(bitsPerSecond) || bitsPerSecond <= 0) {
    return "—";
  }

  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  }

  return `${Math.round(bitsPerSecond / 1000)} Kbps`;
}

function formatBudgetLabel(bitrate: number): string {
  return formatBitrate(bitrate);
}

function getRoleLabel(role: Role | null): string {
  if (role === "host") {
    return "Sharer";
  }

  if (role === "viewer") {
    return "Watcher";
  }

  return "Joining...";
}

function areDiagnosticsEqual(
  previous: DiagnosticsSnapshot,
  next: DiagnosticsSnapshot,
): boolean {
  return (
    previous.captureFps === next.captureFps &&
    previous.captureResolution === next.captureResolution &&
    previous.inboundBitrate === next.inboundBitrate &&
    previous.inboundFps === next.inboundFps &&
    previous.inboundResolution === next.inboundResolution &&
    previous.outboundBitrate === next.outboundBitrate &&
    previous.outboundFps === next.outboundFps &&
    previous.outboundResolution === next.outboundResolution &&
    previous.qualityLimitation === next.qualityLimitation
  );
}

const DiagnosticsPanel = memo(function DiagnosticsPanel({
  activeProfile,
  diagnostics,
}: {
  activeProfile: ShareProfile;
  diagnostics: DiagnosticsSnapshot;
}) {
  return (
    <div className="meta-grid diagnostics-grid">
      <div className="info-tile">
        <span className="tile-label">Target Profile</span>
        <strong>
          {activeProfile.width}x{activeProfile.height} @ {activeProfile.frameRate}fps
        </strong>
        <span className="tile-detail">
          {formatBudgetLabel(activeProfile.bitrate)} · prioritize FPS
        </span>
      </div>
      <div className="info-tile">
        <span className="tile-label">Capture Now</span>
        <strong>{diagnostics.captureResolution}</strong>
        <span className="tile-detail">{diagnostics.captureFps}</span>
      </div>
      <div className="info-tile">
        <span className="tile-label">Sent Now</span>
        <strong>{diagnostics.outboundResolution}</strong>
        <span className="tile-detail">
          {diagnostics.outboundFps} · {diagnostics.outboundBitrate}
        </span>
      </div>
      <div className="info-tile">
        <span className="tile-label">Received Now</span>
        <strong>{diagnostics.inboundResolution}</strong>
        <span className="tile-detail">
          {diagnostics.inboundFps} · {diagnostics.inboundBitrate}
        </span>
      </div>
      <div className="info-tile">
        <span className="tile-label">WebRTC Limiter</span>
        <strong>{diagnostics.qualityLimitation}</strong>
        <span className="tile-detail">Updates every 5s</span>
      </div>
    </div>
  );
});

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

async function optimizeScreenShareTrack(
  track: MediaStreamTrack,
  profile: ShareProfile,
): Promise<void> {
  track.contentHint = profile.contentHint;

  try {
    await track.applyConstraints({
      frameRate: profile.frameRate,
      width: profile.width,
      height: profile.height,
    });
  } catch {
    // Browsers may ignore optional display capture constraints.
  }
}

async function optimizeVideoSender(
  sender: RTCRtpSender,
  profile: ShareProfile,
): Promise<void> {
  if (!sender.track || sender.track.kind !== "video") {
    return;
  }

  const parameters = sender.getParameters();
  const encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  encodings[0] = {
    ...encodings[0],
    maxBitrate: profile.bitrate,
    maxFramerate: profile.frameRate,
  };

  parameters.encodings = encodings;
  parameters.degradationPreference = profile.degradationPreference;

  try {
    await sender.setParameters(parameters);
  } catch {
    // Sender tuning is best-effort because browser WebRTC support varies.
  }
}

export function RoomClient({
  iceServers,
  roomId,
}: {
  iceServers: RTCIceServer[];
  roomId: string;
}) {
  const [role, setRole] = useState<Role | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [peerPresent, setPeerPresent] = useState(false);
  const [localSharing, setLocalSharing] = useState(false);
  const [remoteViewing, setRemoteViewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomFull, setRoomFull] = useState(false);
  const [browserSupported, setBrowserSupported] = useState(true);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [selectedResolutionId, setSelectedResolutionId] =
    useState<ResolutionOptionId>(DEFAULT_RESOLUTION_ID);
  const [selectedFrameRate, setSelectedFrameRate] = useState(DEFAULT_FRAME_RATE);
  const [hostPreviewEnabled, setHostPreviewEnabled] = useState(true);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>(EMPTY_DIAGNOSTICS);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const roleRef = useRef<Role | null>(null);
  const peerPresentRef = useRef(false);
  const shareProfileRef = useRef<ShareProfile>(
    getShareProfile(DEFAULT_RESOLUTION_ID, DEFAULT_FRAME_RATE),
  );
  const clientIdRef = useRef<string | null>(null);
  const latestEventIdRef = useRef(0);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const disposedRef = useRef(false);
  const lastOutboundStatsRef = useRef<{ bytesSent: number; timestamp: number } | null>(null);
  const lastInboundStatsRef = useRef<{ bytesReceived: number; timestamp: number } | null>(null);
  const negotiationActiveRef = useRef(false);

  const updatePeerPresent = (value: boolean): void => {
    if (peerPresentRef.current === value) {
      return;
    }

    peerPresentRef.current = value;
    setPeerPresent(value);
  };

  const updateRole = (value: Role | null): void => {
    if (roleRef.current === value) {
      return;
    }

    roleRef.current = value;
    setRole(value);
  };

  const updateSignalingConnected = (value: boolean): void => {
    setSignalingConnected((currentValue) => (currentValue === value ? currentValue : value));
  };

  const setNegotiationActive = (value: boolean): void => {
    negotiationActiveRef.current = value;
  };

  const resetViewerPlayback = (): void => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    remoteStreamRef.current = null;
    setRemoteViewing(false);
  };

  const syncLocalPreview = (): void => {
    if (!localVideoRef.current) {
      return;
    }

    if (hostPreviewEnabled && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      void localVideoRef.current.play().catch(() => undefined);
      return;
    }

    localVideoRef.current.srcObject = null;
  };

  const cleanupPeerConnection = (): void => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    pendingIceCandidatesRef.current = [];
    lastOutboundStatsRef.current = null;
    lastInboundStatsRef.current = null;
    resetViewerPlayback();
  };

  const postSignal = async (
    type: Extract<SignalType, "answer" | "ice-candidate" | "offer">,
    payload: RTCIceCandidateInit | RTCSessionDescriptionInit,
  ): Promise<void> => {
    if (!clientIdRef.current) {
      return;
    }

    await requestJson<{ ok: true }>(`/api/rooms/${roomId}/events`, {
      body: JSON.stringify({
        clientId: clientIdRef.current,
        payload,
        type,
      }),
      method: "POST",
    });
  };

  const flushPendingIceCandidates = async (): Promise<void> => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection?.remoteDescription) {
      return;
    }

    while (pendingIceCandidatesRef.current.length > 0) {
      const candidate = pendingIceCandidatesRef.current.shift();
      if (!candidate) {
        break;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        setError("A network issue interrupted the stream. Refresh the hangout and reconnect.");
        setNegotiationActive(false);
        break;
      }
    }
  };

  const createPeerConnection = (): RTCPeerConnection => {
    cleanupPeerConnection();

    const peerConnection = new RTCPeerConnection({ iceServers });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      // Relay new ICE candidates through the room signaling API.
      void postSignal("ice-candidate", event.candidate.toJSON()).catch(() => {
        setError("The hangout service disconnected. Refresh the hangout and try again.");
      });
    };

    peerConnection.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream || !remoteVideoRef.current) {
        return;
      }

      remoteStreamRef.current = stream;
      remoteVideoRef.current.srcObject = stream;
      void remoteVideoRef.current.play().catch(() => undefined);
      setRemoteViewing(true);
      updatePeerPresent(true);

      stream.getTracks().forEach((track) => {
        track.onended = () => {
          setRemoteViewing(false);
          setError(null);
          resetViewerPlayback();
        };
      });
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;

      if (state === "connected") {
        updatePeerPresent(true);
        setError(null);
        setNegotiationActive(false);
      }

      if (state === "disconnected" && roleRef.current === "viewer") {
        resetViewerPlayback();
      }

      if (state === "failed") {
        if (roleRef.current === "viewer") {
          resetViewerPlayback();
        }
        setNegotiationActive(false);
        setError("The peer connection failed. Refresh the hangout and try joining again.");
      }
    };

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  };

  const beginHostOffer = async (): Promise<void> => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    setNegotiationActive(true);
    const peerConnection = createPeerConnection();
    const senderPromises = stream.getTracks().map(async (track) => {
      const sender = peerConnection.addTrack(track, stream);
      await optimizeVideoSender(sender, shareProfileRef.current);
    });
    await Promise.all(senderPromises);

    // The host creates and signals the WebRTC offer once a viewer is present.
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await postSignal("offer", offer);
  };

  const stopSharing = (): void => {
    cleanupPeerConnection();
    stopStream(localStreamRef.current);
    localStreamRef.current = null;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    setLocalSharing(false);
    setError(null);
  };

  const startSharing = async (): Promise<void> => {
    if (!browserSupported) {
      setError("This browser does not support screen sharing. Try a current Chromium or Firefox browser.");
      return;
    }

    try {
      stopSharing();

      const stream = await navigator.mediaDevices.getDisplayMedia(
        getDisplayMediaConstraints(shareProfileRef.current),
      );

      localStreamRef.current = stream;
      setLocalSharing(true);
      setError(null);

      syncLocalPreview();

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        await optimizeScreenShareTrack(videoTrack, shareProfileRef.current);

        videoTrack.onended = () => {
          stopSharing();
        };
      }

      if (peerPresentRef.current) {
        await beginHostOffer();
      }
    } catch (caughtError) {
      setNegotiationActive(false);
      const message =
        caughtError instanceof DOMException && caughtError.name === "NotAllowedError"
          ? "Screen sharing was denied. Allow access and try again."
          : "Screen sharing could not start. Refresh the hangout and try again.";
      setError(message);
    }
  };

  const handleRoomEvent = async (event: RoomEvent): Promise<void> => {
    if (event.type === "user-joined") {
      updatePeerPresent(true);

      if (roleRef.current === "host" && localStreamRef.current) {
        await beginHostOffer();
      }
      return;
    }

    if (event.type === "user-left") {
      updatePeerPresent(false);
      if (roleRef.current === "viewer") {
        cleanupPeerConnection();
      }
      return;
    }

    if (event.type === "offer") {
      if (roleRef.current !== "viewer" || !event.payload) {
        return;
      }

      try {
        setNegotiationActive(true);
        const peerConnection = createPeerConnection();
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(event.payload as RTCSessionDescriptionInit),
        );
        await flushPendingIceCandidates();

        // The viewer responds to the host offer with a WebRTC answer.
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await postSignal("answer", answer);
      } catch {
        setNegotiationActive(false);
        setError("The stream could not start. Refresh the hangout and try rejoining.");
      }
      return;
    }

    if (event.type === "answer") {
      if (roleRef.current !== "host" || !peerConnectionRef.current || !event.payload) {
        return;
      }

      try {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(event.payload as RTCSessionDescriptionInit),
        );
        await flushPendingIceCandidates();
      } catch {
        setNegotiationActive(false);
        setError("Your watcher could not connect. Refresh the hangout and try again.");
      }
      return;
    }

    if (event.type === "ice-candidate" && event.payload) {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection?.remoteDescription) {
        pendingIceCandidatesRef.current.push(event.payload as RTCIceCandidateInit);
        return;
      }

      try {
        await peerConnection.addIceCandidate(
          new RTCIceCandidate(event.payload as RTCIceCandidateInit),
        );
      } catch {
        setNegotiationActive(false);
        setError("A network issue interrupted the stream. Refresh the hangout and reconnect.");
      }
    }
  };

  const activeProfile = useMemo(
    () => getShareProfile(selectedResolutionId, selectedFrameRate),
    [selectedFrameRate, selectedResolutionId],
  );

  useEffect(() => {
    shareProfileRef.current = activeProfile;

    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (videoTrack) {
      void optimizeScreenShareTrack(videoTrack, activeProfile);
    }

    const sender = peerConnectionRef.current
      ?.getSenders()
      .find((candidate) => candidate.track?.kind === "video");
    if (sender) {
      void optimizeVideoSender(sender, activeProfile);
    }
  }, [activeProfile]);

  useEffect(() => {
    syncLocalPreview();
  }, [hostPreviewEnabled, localSharing]);

  useEffect(() => {
    if (!diagnosticsVisible) {
      return;
    }

    let cancelled = false;

    async function collectDiagnostics(): Promise<void> {
      const nextDiagnostics: DiagnosticsSnapshot = {
        ...EMPTY_DIAGNOSTICS,
      };

      const localVideoTrack = localStreamRef.current?.getVideoTracks()[0];
      if (localVideoTrack) {
        const settings = localVideoTrack.getSettings();
        nextDiagnostics.captureResolution = formatResolution(settings.width, settings.height);
        nextDiagnostics.captureFps = formatFps(settings.frameRate);
      }

      const peerConnection = peerConnectionRef.current;
      if (peerConnection) {
        try {
          const stats = await peerConnection.getStats();

          for (const stat of stats.values()) {
            if (stat.type === "outbound-rtp" && "kind" in stat && stat.kind === "video") {
              nextDiagnostics.outboundResolution = formatResolution(stat.frameWidth, stat.frameHeight);
              nextDiagnostics.outboundFps = formatFps(stat.framesPerSecond);
              nextDiagnostics.qualityLimitation =
                stat.qualityLimitationReason && stat.qualityLimitationReason !== "none"
                  ? stat.qualityLimitationReason
                  : "none";

              if (typeof stat.bytesSent === "number") {
                const lastSample = lastOutboundStatsRef.current;
                if (lastSample) {
                  const elapsedSeconds = (stat.timestamp - lastSample.timestamp) / 1000;
                  if (elapsedSeconds > 0) {
                    const bitsPerSecond =
                      ((stat.bytesSent - lastSample.bytesSent) * 8) / elapsedSeconds;
                    nextDiagnostics.outboundBitrate = formatBitrate(bitsPerSecond);
                  }
                }

                lastOutboundStatsRef.current = {
                  bytesSent: stat.bytesSent,
                  timestamp: stat.timestamp,
                };
              }
            }

            if (stat.type === "inbound-rtp" && "kind" in stat && stat.kind === "video") {
              nextDiagnostics.inboundResolution = formatResolution(stat.frameWidth, stat.frameHeight);
              nextDiagnostics.inboundFps = formatFps(stat.framesPerSecond);

              if (typeof stat.bytesReceived === "number") {
                const lastSample = lastInboundStatsRef.current;
                if (lastSample) {
                  const elapsedSeconds = (stat.timestamp - lastSample.timestamp) / 1000;
                  if (elapsedSeconds > 0) {
                    const bitsPerSecond =
                      ((stat.bytesReceived - lastSample.bytesReceived) * 8) / elapsedSeconds;
                    nextDiagnostics.inboundBitrate = formatBitrate(bitsPerSecond);
                  }
                }

                lastInboundStatsRef.current = {
                  bytesReceived: stat.bytesReceived,
                  timestamp: stat.timestamp,
                };
              }
            }
          }
        } catch {
          // Stats collection is diagnostic-only; ignore transient getStats failures.
        }
      }

      if (!cancelled) {
        setDiagnostics((currentValue) =>
          areDiagnosticsEqual(currentValue, nextDiagnostics) ? currentValue : nextDiagnostics,
        );
      }
    }

    void collectDiagnostics();
    const intervalId = window.setInterval(() => {
      void collectDiagnostics();
    }, STATS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeProfile, diagnosticsVisible, localSharing, remoteViewing, role]);

  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      "RTCPeerConnection" in window &&
      !!navigator.mediaDevices?.getDisplayMedia;

    setBrowserSupported(supported);
    setShareUrl(window.location.href);

    if (!supported) {
      return;
    }

    disposedRef.current = false;
    clientIdRef.current = getClientId(roomId);

    async function joinAndPoll(): Promise<void> {
      while (!disposedRef.current) {
        try {
          const joinResult = await requestJson<JoinResponse>(`/api/rooms/${roomId}/join`, {
            body: JSON.stringify({
              clientId: clientIdRef.current,
            }),
            method: "POST",
          });

          if ("roomFull" in joinResult && joinResult.roomFull) {
            setRoomFull(true);
            setError("This hangout already has two people. Ask your partner for a new link.");
            updateSignalingConnected(true);
            return;
          }

          setRoomFull(false);
          updateSignalingConnected(true);
          updateRole(joinResult.role);
          updatePeerPresent(joinResult.peerPresent);
          setError(null);
          break;
        } catch {
          updateSignalingConnected(false);
          setError("The hangout service is unavailable. Retrying...");
          await sleep(1000);
        }
      }

      while (!disposedRef.current && clientIdRef.current) {
        try {
          const pollResult = await requestJson<PollResponse>(
            `/api/rooms/${roomId}/events?clientId=${encodeURIComponent(clientIdRef.current)}&cursor=${latestEventIdRef.current}`,
            {
              method: "GET",
            },
          );

          updateSignalingConnected(true);
          updatePeerPresent(pollResult.peerPresent);

          for (const event of pollResult.events) {
            latestEventIdRef.current = Math.max(latestEventIdRef.current, event.id);
            await handleRoomEvent(event);
          }
        } catch {
          updateSignalingConnected(false);
          setError("The hangout service disconnected. Retrying...");
        }

        await sleep(
          negotiationActiveRef.current
            ? POLL_INTERVAL_NEGOTIATION_MS
            : peerPresentRef.current
              ? POLL_INTERVAL_CONNECTED_MS
              : POLL_INTERVAL_IDLE_MS,
        );
      }
    }

    void joinAndPoll();

    const handlePageHide = (): void => {
      const clientId = clientIdRef.current;
      if (!clientId) {
        return;
      }

      navigator.sendBeacon(
        `/api/rooms/${roomId}/leave`,
        JSON.stringify({
          clientId,
        }),
      );
    };

    window.addEventListener("pagehide", handlePageHide);

    return () => {
      disposedRef.current = true;
      window.removeEventListener("pagehide", handlePageHide);

      const clientId = clientIdRef.current;
      if (clientId) {
        void fetch(`/api/rooms/${roomId}/leave`, {
          body: JSON.stringify({
            clientId,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          keepalive: true,
          method: "POST",
        }).catch(() => undefined);
      }

      cleanupPeerConnection();
      stopStream(localStreamRef.current);
      localStreamRef.current = null;
    };
  }, [roomId]);

  const status = useMemo(() => {
    if (roomFull) {
      return "Hangout full";
    }

    if (!signalingConnected) {
      return "Connecting to hangout";
    }

    if (role === "viewer" && remoteViewing) {
      return "Watching live";
    }

    if (role === "host" && localSharing && peerPresent) {
      return "Sharing live";
    }

    if (!peerPresent) {
      return "Waiting for your partner";
    }

    return "Partner connected";
  }, [localSharing, peerPresent, remoteViewing, role, roomFull, signalingConnected]);

  const showHostScreen = role !== "viewer";
  const showViewerScreen = role === "viewer" || role === null;
  const showHostPreviewVideo = localSharing && (role !== "host" || hostPreviewEnabled);
  const showViewerVideo = remoteViewing;

  return (
    <main className="shell">
      <section className="room-card">
        <div className="room-header">
          <div>
            <p className="eyebrow">Private Hangout</p>
            <h1>ZebLink</h1>
            <p className="room-id">Hangout ID: {roomId}</p>
          </div>
          <div className="status-pill">{status}</div>
        </div>

        <div className="share-row">
          <label className="share-label" htmlFor="room-link">
            Share this hangout link
          </label>
          <div className="share-link-group">
            <input className="share-link" id="room-link" readOnly value={shareUrl} />
            <button
              className="secondary-button"
              disabled={!shareUrl}
              onClick={async () => {
                if (!shareUrl) {
                  return;
                }

                await navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              }}
              type="button"
            >
              {copied ? "Copied" : "Copy Link"}
            </button>
          </div>
        </div>

        <div className="meta-grid">
          <div className="info-tile">
            <span className="tile-label">Role</span>
            <strong>{getRoleLabel(role)}</strong>
          </div>
          <div className="info-tile">
            <span className="tile-label">Has Partner Connected</span>
            <strong>{peerPresent ? "Yes" : "Not yet"}</strong>
          </div>
          <div className="info-tile">
            <span className="tile-label">Sharing</span>
            <strong>{localSharing || remoteViewing ? "Live" : "Idle"}</strong>
          </div>
        </div>

        <div className="meta-grid diagnostics-grid">
          <div className="share-row">
            <label className="share-label" htmlFor="share-resolution">
              Target resolution
            </label>
            <div className="share-link-group">
              <select
                className="share-link share-select"
                disabled={role !== "host"}
                id="share-resolution"
                onChange={(event) => {
                  setSelectedResolutionId(event.target.value as ResolutionOptionId);
                }}
                value={selectedResolutionId}
              >
                {RESOLUTION_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.width}x{option.height}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="share-row">
            <label className="share-label" htmlFor="share-frame-rate">
              Target frame rate
            </label>
            <div className="share-link-group">
              <select
                className="share-link share-select"
                disabled={role !== "host"}
                id="share-frame-rate"
                onChange={(event) => {
                  setSelectedFrameRate(Number(event.target.value));
                }}
                value={selectedFrameRate}
              >
                {FRAME_RATE_OPTIONS.map((frameRate) => (
                  <option key={frameRate} value={frameRate}>
                    {frameRate} fps
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <p className="share-label">
          ZebLink now favors smoother motion first. If the browser cannot hold both targets, it
          should give up detail before it gives up FPS.
        </p>

        {error ? <p className="error-banner">{error}</p> : null}
        {!browserSupported ? (
          <p className="error-banner">
            Screen sharing is unsupported in this browser. Use a recent desktop browser.
          </p>
        ) : null}

        <div className={`video-grid ${showHostScreen !== showViewerScreen ? "video-grid-single" : ""}`}>
          {showHostScreen ? (
            <article className="video-card host-preview-card">
              <div className="video-card-header">
                <h2>Sharer Preview</h2>
                <p>{role === "host" ? "Only you can see this local preview" : "Visible to the sharer only"}</p>
              </div>
              {role === "host" ? (
                <button
                  aria-label={hostPreviewEnabled ? "Hide sharer preview" : "Show sharer preview"}
                  className="preview-toggle-button"
                  onClick={() => {
                    setHostPreviewEnabled((currentValue) => !currentValue);
                  }}
                  type="button"
                >
                  {hostPreviewEnabled ? "Hide Preview" : "Show Preview"}
                </button>
              ) : null}
              <video
                ref={localVideoRef}
                autoPlay
                className={`video-frame ${showHostPreviewVideo ? "" : "video-frame-hidden"}`}
                muted
                playsInline
              />
              {!showHostPreviewVideo ? (
                <div className="empty-state">
                  {role === "host"
                    ? hostPreviewEnabled
                      ? "Start sharing to preview your screen or tab here."
                      : "Preview hidden to reduce sharer load. Hover and click Show Preview to bring it back."
                    : "The sharer preview appears only on the sharer side."}
                </div>
              ) : null}
            </article>
          ) : null}

          {showViewerScreen ? (
            <article className="video-card">
              <div className="video-card-header">
                <h2>Watcher Stream</h2>
                <p>{role === "viewer" ? "Incoming stream from your partner" : "What the watcher will see"}</p>
              </div>
              <video
                ref={remoteVideoRef}
                autoPlay
                className={`video-frame ${showViewerVideo ? "" : "video-frame-hidden"}`}
                controls={role === "viewer"}
                playsInline
              />
              {!showViewerVideo ? (
                <div className="empty-state">
                  {role === "viewer"
                    ? "Waiting for your partner to start sharing."
                    : "Your connected partner will see the stream here after sharing starts."}
                </div>
              ) : null}
            </article>
          ) : null}
        </div>

        <div className="actions">
          <button
            className="primary-button"
            disabled={role !== "host" || roomFull || !browserSupported}
            onClick={() => {
              void startSharing();
            }}
            type="button"
          >
            Start Sharing
          </button>
          <button
            className="secondary-button"
            disabled={role !== "host" || !localSharing}
            onClick={stopSharing}
            type="button"
          >
            Stop Sharing
          </button>
        </div>

        <section className="diagnostics-section">
          <div className="diagnostics-toggle-row">
            <p className="diagnostics-heading">Connection diagnostics</p>
            <button
              className="secondary-button diagnostics-toggle-button diagnostics-toggle-button-subtle"
              id="diagnostics-toggle"
              onClick={() => {
                setDiagnosticsVisible((currentValue) => !currentValue);
              }}
              type="button"
            >
              {diagnosticsVisible ? "Hide" : "Show"}
            </button>
          </div>

          {diagnosticsVisible ? (
            <DiagnosticsPanel activeProfile={activeProfile} diagnostics={diagnostics} />
          ) : null}
        </section>
      </section>
    </main>
  );
}
