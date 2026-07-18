/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use client";

import { useEffect, useState, useCallback, use, useRef, FormEvent } from "react";
import {
  LiveKitRoom,
  useLocalParticipant,
  useRoomContext,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track, RoomEvent } from "livekit-client";
import SessionQRCode from "@/components/SessionQRCode";
import { getLanguageByCode } from "@/lib/languages";
import { SOURCE_LANGUAGE } from "@/lib/interpret-config";

interface TranslationInfo {
  language: string;
  translatorIdentity: string;
  status: string;
  subscriberCount: number;
}

interface HostCaption {
  id: string;
  text: string;
  final: boolean;
}

function BroadcastControls({
  sessionId,
  onEndBroadcast,
}: {
  sessionId: string;
  onEndBroadcast: () => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [translations, setTranslations] = useState<TranslationInfo[]>([]);
  const [listenerCount, setListenerCount] = useState(0);
  const [hostCaptions, setHostCaptions] = useState<HostCaption[]>([]);
  const captionEndRef = useRef<HTMLDivElement | null>(null);

  // Track active attendees count without useRemoteParticipants hook overhead
  useEffect(() => {
    if (!room) return;

    const updateCount = () => {
      const count = Array.from(room.remoteParticipants.values()).filter(
        (p) =>
          !p.identity.startsWith("translator-") &&
          !p.identity.startsWith("host-transcriber-")
      ).length;
      setListenerCount(count);
    };

    updateCount();

    room.on(RoomEvent.ParticipantConnected, updateCount);
    room.on(RoomEvent.ParticipantDisconnected, updateCount);
    return () => {
      room.off(RoomEvent.ParticipantConnected, updateCount);
      room.off(RoomEvent.ParticipantDisconnected, updateCount);
    };
  }, [room]);

  // Custom audio mixer states
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [isTabAudioEnabled, setIsTabAudioEnabled] = useState(false);
  const [micVolume, setMicVolume] = useState(100);
  const [tabVolume, setTabVolume] = useState(100);
  const [isWakeLockActive, setIsWakeLockActive] = useState(false);

  // Manage Screen Wake Lock to prevent the phone/device from sleeping during broadcast
  useEffect(() => {
    if (typeof window === "undefined" || !("wakeLock" in navigator)) {
      return;
    }

    let wakeLock: any = null;

    async function requestWakeLock() {
      try {
        wakeLock = await (navigator as any).wakeLock.request("screen");
        setIsWakeLockActive(true);
        
        wakeLock.addEventListener("release", () => {
          setIsWakeLockActive(false);
        });
      } catch (err) {
        console.error("Failed to acquire Screen Wake Lock:", err);
      }
    }

    requestWakeLock();

    const handleVisibilityChange = async () => {
      if (document.visibilityState === "visible" && !wakeLock) {
        await requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (wakeLock) {
        wakeLock.release().catch((err: any) => {
          console.error("Failed to release Screen Wake Lock:", err);
        });
      }
    };
  }, []);

  // References to keep Web Audio API elements alive
  const audioContextRef = useRef<AudioContext | null>(null);
  const destinationNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const tabStreamRef = useRef<MediaStream | null>(null);
  const tabSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const tabGainNodeRef = useRef<GainNode | null>(null);
  const publishedTrackPubRef = useRef<any>(null);



  // 청자용 QR/링크의 origin. 발표자가 localhost로 열면 window.location.origin이
  // localhost라 QR에 그대로 박혀 청자 폰이 접속하지 못한다. 이 경우에만 서버의
  // 실제 LAN 주소를 받아와 대체한다. 터널/공개 도메인으로 연 경우엔
  // window.location.origin이 이미 올바르므로 그대로 쓴다.
  // localhost로 열었을 때만 서버의 LAN 주소를 비동기로 받아와 QR에 쓴다.
  // 그 외(터널/공개 도메인)에서는 window.location.origin이 이미 올바르다.
  const [lanOrigin, setLanOrigin] = useState<string | null>(null);
  useEffect(() => {
    const host = window.location.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1";
    if (!isLocal) return;
    fetch("/api/lan-address")
      .then((r) => r.json())
      .then((d) => {
        if (d.origin) setLanOrigin(d.origin);
      })
      .catch(() => {});
  }, []);

  const joinOrigin =
    lanOrigin ??
    (typeof window !== "undefined" ? window.location.origin : "");
  const joinUrl = joinOrigin
    ? `${joinOrigin}/session/${sessionId}/watch`
    : "";

  const fetchTranslations = useCallback(async () => {
    try {
      const res = await fetch(`/api/translate/status?sessionId=${sessionId}`);
      const data = await res.json();
      setTranslations(data.translations || []);
    } catch (err) {
      console.error("Failed to fetch translations:", err);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchTranslations();
    const interval = setInterval(fetchTranslations, 3000);
    return () => clearInterval(interval);
  }, [fetchTranslations]);

  // Host captions: transcribe the organizer's own speech (source language) and
  // show it on the control panel. Starts a transcribe-only bridge server-side
  // and listens for its transcription data messages.
  useEffect(() => {
    if (!room) return;

    const startHostTranscription = async () => {
      try {
        await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
      } catch (err) {
        console.error("Failed to start host transcription:", err);
      }
    };

    const setLanguageAttr = () => {
      if (room.localParticipant) {
        room.localParticipant
          .setAttributes({ language: SOURCE_LANGUAGE })
          .catch((err) =>
            console.error("Failed to set organizer language attribute:", err)
          );
      }
    };

    const handleData = (
      payload: Uint8Array,
      _participant: unknown,
      _kind: unknown,
      topic: string | undefined,
    ) => {
      if (topic !== "transcription") return;
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data.type !== "transcription" || data.language !== SOURCE_LANGUAGE) {
          return;
        }

        setHostCaptions((prev) => {
          const existing = prev.findIndex((c) => c.id === data.segmentId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = {
              ...updated[existing],
              text: updated[existing].text + data.text,
              final: data.final,
            };
            return updated;
          }
          return [
            ...prev,
            { id: data.segmentId, text: data.text, final: data.final },
          ].slice(-50);
        });
      } catch {
        // Not a JSON transcription message
      }
    };

    setLanguageAttr();
    startHostTranscription();
    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.Connected, setLanguageAttr);

    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.Connected, setLanguageAttr);
    };
  }, [room, sessionId]);

  // Auto-scroll host captions to the latest line
  useEffect(() => {
    captionEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [hostCaptions]);

  // Main AudioContext and track publishing lifecycle
  useEffect(() => {
    if (!room || !room.localParticipant) return;

    let active = true;
    let localPub: any = null;

    async function initAudio() {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass();
        audioContextRef.current = ctx;

        const dest = ctx.createMediaStreamDestination();
        destinationNodeRef.current = dest;

        const mixedTrack = dest.stream.getAudioTracks()[0];

        if (active && room.localParticipant) {
          const pub = await room.localParticipant.publishTrack(mixedTrack, {
            name: "broadcast-audio",
            source: Track.Source.Microphone,
          });
          publishedTrackPubRef.current = pub;
          localPub = pub;
          await pub.mute();
          console.log("Published and initially muted mixed audio track:", pub.trackSid);
        }
      } catch (err) {
        console.error("Failed to initialize client audio mixer:", err);
      }
    }

    initAudio();

    return () => {
      active = false;
      if (localPub && room.localParticipant) {
        room.localParticipant.unpublishTrack(localPub.track).catch((err) => {
          console.error("Failed to unpublish mixed track:", err);
        });
      }
      
      // Stop all streams and close AudioContext
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
      if (micSourceNodeRef.current) {
        micSourceNodeRef.current.disconnect();
        micSourceNodeRef.current = null;
      }
      if (micGainNodeRef.current) {
        micGainNodeRef.current.disconnect();
        micGainNodeRef.current = null;
      }
      if (tabStreamRef.current) {
        tabStreamRef.current.getTracks().forEach((track) => track.stop());
        tabStreamRef.current = null;
      }
      if (tabSourceNodeRef.current) {
        tabSourceNodeRef.current.disconnect();
        tabSourceNodeRef.current = null;
      }
      if (tabGainNodeRef.current) {
        tabGainNodeRef.current.disconnect();
        tabGainNodeRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      destinationNodeRef.current = null;
      publishedTrackPubRef.current = null;
    };
  }, [room, room?.localParticipant]);

  // Synchronize muted status of the published track with active inputs
  useEffect(() => {
    const pub = publishedTrackPubRef.current;
    if (!pub) return;

    const hasActiveInput = isMicEnabled || isTabAudioEnabled;
    if (hasActiveInput) {
      pub.unmute()
        .then(() => console.log("[BroadcastControls] Unmuted broadcast-audio track"))
        .catch((err: any) => console.error("Failed to unmute track:", err));
    } else {
      pub.mute()
        .then(() => console.log("[BroadcastControls] Muted broadcast-audio track"))
        .catch((err: any) => console.error("Failed to mute track:", err));
    }
  }, [isMicEnabled, isTabAudioEnabled]);

  const toggleMicrophone = async () => {
    const ctx = audioContextRef.current;
    const dest = destinationNodeRef.current;
    if (!ctx || !dest) return;

    if (isMicEnabled) {
      if (micSourceNodeRef.current) {
        micSourceNodeRef.current.disconnect();
        micSourceNodeRef.current = null;
      }
      if (micGainNodeRef.current) {
        micGainNodeRef.current.disconnect();
        micGainNodeRef.current = null;
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
      setIsMicEnabled(false);
    } else {
      try {
        await ctx.resume();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        micSourceNodeRef.current = source;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(micVolume / 100, ctx.currentTime);
        micGainNodeRef.current = gainNode;

        source.connect(gainNode);
        gainNode.connect(dest);

        setIsMicEnabled(true);
      } catch (err) {
        console.error("Failed to access microphone:", err);
        alert("마이크에 접근할 수 없습니다: " + (err as Error).message);
      }
    }
  };

  const toggleTabAudio = async () => {
    const ctx = audioContextRef.current;
    const dest = destinationNodeRef.current;
    if (!ctx || !dest) return;

    if (isTabAudioEnabled) {
      if (tabSourceNodeRef.current) {
        tabSourceNodeRef.current.disconnect();
        tabSourceNodeRef.current = null;
      }
      if (tabGainNodeRef.current) {
        tabGainNodeRef.current.disconnect();
        tabGainNodeRef.current = null;
      }
      if (tabStreamRef.current) {
        tabStreamRef.current.getTracks().forEach((track) => track.stop());
        tabStreamRef.current = null;
      }
      setIsTabAudioEnabled(false);
    } else {
      try {
        await ctx.resume();
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser" },
          audio: true,
        });

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          stream.getTracks().forEach((track) => track.stop());
          alert("오디오 트랙이 선택되지 않았습니다. 공유 창에서 '탭 오디오 공유' 체크박스를 켰는지 확인하세요.");
          return;
        }

        tabStreamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        tabSourceNodeRef.current = source;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(tabVolume / 100, ctx.currentTime);
        tabGainNodeRef.current = gainNode;

        source.connect(gainNode);
        gainNode.connect(dest);

        setIsTabAudioEnabled(true);

        const handleTrackEnded = () => {
          if (tabSourceNodeRef.current) {
            tabSourceNodeRef.current.disconnect();
            tabSourceNodeRef.current = null;
          }
          if (tabGainNodeRef.current) {
            tabGainNodeRef.current.disconnect();
            tabGainNodeRef.current = null;
          }
          stream.getTracks().forEach((track) => track.stop());
          tabStreamRef.current = null;
          setIsTabAudioEnabled(false);
        };

        audioTracks[0].onended = handleTrackEnded;
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.length > 0) {
          videoTracks[0].onended = handleTrackEnded;
        }
      } catch (err) {
        console.error("Failed to capture tab audio:", err);
        if ((err as Error).name !== "NotAllowedError") {
          alert("탭 오디오를 캡처할 수 없습니다: " + (err as Error).message);
        }
      }
    }
  };

  const handleMicVolumeChange = (vol: number) => {
    setMicVolume(vol);
    if (micGainNodeRef.current && audioContextRef.current) {
      micGainNodeRef.current.gain.setValueAtTime(vol / 100, audioContextRef.current.currentTime);
    }
  };

  const handleTabVolumeChange = (vol: number) => {
    setTabVolume(vol);
    if (tabGainNodeRef.current && audioContextRef.current) {
      tabGainNodeRef.current.gain.setValueAtTime(vol / 100, audioContextRef.current.currentTime);
    }
  };

  const isAudioActive = isMicEnabled || isTabAudioEnabled;
  let statusText = "음소거";
  if (isMicEnabled && isTabAudioEnabled) {
    statusText = "송출 중 (마이크 + 탭)";
  } else if (isMicEnabled) {
    statusText = "송출 중 (마이크)";
  } else if (isTabAudioEnabled) {
    statusText = "송출 중 (탭)";
  }

  return (
    <div className="container enter">
      {/* Header */}
      <div style={{ marginBottom: 48 }}>
        <h1 className="display display-lg" style={{ marginBottom: 8 }}>
          <em>방송</em> 중
        </h1>
        <p className="mono">{sessionId}</p>
      </div>

      {/* Audio Inputs */}
      <div style={{ marginBottom: 40 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className={`waveform ${isAudioActive ? "active" : "idle"}`}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="waveform-bar" />
              ))}
            </div>
            <span
              className="status"
              style={{ color: isAudioActive ? "var(--success)" : "var(--fg-ghost)" }}
            >
              <span className={`status-dot ${isAudioActive ? "pulse" : ""}`} />
              {statusText}
            </span>

            {isWakeLockActive && (
              <span
                className="status status--active"
                style={{
                  marginLeft: 12,
                  padding: "4px 8px",
                  background: "var(--success-soft)",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  fontSize: "11px",
                }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ marginRight: 4, verticalAlign: "middle" }}
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                화면 켜짐 유지
              </span>
            )}
          </div>

          <span className="mono">
            청취자 {listenerCount}명
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Microphone Box */}
          <div
            style={{
              padding: "16px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
              background: "var(--bg-elevated)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: "14px" }}>마이크</span>
              <button
                onClick={toggleMicrophone}
                className="btn"
                style={{
                  padding: "8px 16px",
                  fontSize: "12px",
                  border: isMicEnabled ? "1px solid var(--error)" : "none",
                  background: isMicEnabled ? "transparent" : "var(--accent)",
                  color: isMicEnabled ? "var(--error)" : "#fff",
                  cursor: "pointer",
                }}
              >
                {isMicEnabled ? "끄기" : "켜기"}
              </button>
            </div>
            {isMicEnabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="mono" style={{ width: "32px", fontSize: "11px" }}>Vol</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={micVolume}
                  onChange={(e) => handleMicVolumeChange(Number(e.target.value))}
                  style={{ flexGrow: 1, accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span className="mono" style={{ width: "40px", textAlign: "right", fontSize: "11px" }}>
                  {micVolume}%
                </span>
              </div>
            )}
          </div>

          {/* Browser Tab Audio Box */}
          <div
            style={{
              padding: "16px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
              background: "var(--bg-elevated)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: "14px" }}>브라우저 탭 오디오</span>
              <button
                onClick={toggleTabAudio}
                className="btn"
                style={{
                  padding: "8px 16px",
                  fontSize: "12px",
                  border: isTabAudioEnabled ? "1px solid var(--error)" : "none",
                  background: isTabAudioEnabled ? "transparent" : "var(--accent)",
                  color: isTabAudioEnabled ? "var(--error)" : "#fff",
                  cursor: "pointer",
                }}
              >
                {isTabAudioEnabled ? "공유 중지" : "탭 공유"}
              </button>
            </div>
            {isTabAudioEnabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="mono" style={{ width: "32px", fontSize: "11px" }}>Vol</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={tabVolume}
                  onChange={(e) => handleTabVolumeChange(Number(e.target.value))}
                  style={{ flexGrow: 1, accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span className="mono" style={{ width: "40px", textAlign: "right", fontSize: "11px" }}>
                  {tabVolume}%
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <hr className="rule" />

      {/* Host captions — the organizer's own speech, transcribed to Korean */}
      <div style={{ padding: "28px 0" }}>
        <span className="label" style={{ marginBottom: 16, display: "block" }}>
          내 음성 (한국어)
        </span>
        <div
          style={{
            maxHeight: 160,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            background: "var(--bg-elevated)",
            padding: "16px",
          }}
        >
          {hostCaptions.length === 0 ? (
            <p className="body-sm italic">
              마이크를 켜고 말하면 인식된 한국어가 여기에 표시됩니다
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {hostCaptions.map((c) => (
                <p
                  key={c.id}
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "15px",
                    lineHeight: 1.6,
                    color: c.final ? "var(--fg)" : "var(--fg-secondary)",
                    transition: "color 0.3s ease",
                  }}
                >
                  {c.text}
                </p>
              ))}
              <div ref={captionEndRef} />
            </div>
          )}
        </div>
      </div>

      <hr className="rule" />

      {/* QR code */}
      <div
        style={{
          padding: "32px 0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <span className="label">청중에게 공유</span>
        <SessionQRCode url={joinUrl} size={140} />
        <p className="mono" style={{ wordBreak: "break-all", textAlign: "center" }}>
          {joinUrl}
        </p>
      </div>

      <hr className="rule" />

      {/* Active translations */}
      <div style={{ padding: "28px 0" }}>
        <span className="label" style={{ marginBottom: 16, display: "block" }}>
          번역 · {translations.length}개
        </span>

        {translations.length === 0 ? (
          <p className="body-sm italic">
            아직 없습니다 — 청중이 요청하면 표시됩니다
          </p>
        ) : (
          translations.map((t) => {
            const lang = getLanguageByCode(t.language);
            return (
              <div key={t.language} className="lang-row">
                <div className="lang-row-left">
                  <span className="lang-flag">{lang?.flag || "🌐"}</span>
                  <span className="lang-name">
                    {lang?.name || t.language.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="lang-meta">
                    청취자 {t.subscriberCount}명
                  </span>
                  <span className={`status status--${t.status === "active" ? "active" : "waiting"}`}>
                    <span className="status-dot pulse" />
                    {t.status}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <hr className="rule" />

      {/* End */}
      <div style={{ paddingTop: 28 }}>
        <button
          className="btn-danger"
          onClick={async () => {
            onEndBroadcast();
            try {
              // Explicitly notify server that broadcast is ended to stop all translator bots
              await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
            } catch (err) {
              console.error("Failed to explicitly delete session on broadcast end:", err);
            }
            try {
              // Belt-and-suspenders: the DELETE above already tears down the
              // host-caption bridge via removeAllTranslations, but stop it
              // explicitly too in case that ordering ever changes.
              await fetch("/api/transcribe", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId }),
              });
            } catch (err) {
              console.error("Failed to explicitly stop host transcription on broadcast end:", err);
            }
            room.disconnect();
            window.location.href = "/";
          }}
          style={{ width: "100%" }}
        >
          방송 종료
        </button>
      </div>
    </div>
  );
}

export default function BroadcastPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: sessionId } = use(params);
  const [token, setToken] = useState("");
  const [livekitUrl, setLivekitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [passwordPromptRequired, setPasswordPromptRequired] = useState(false);
  const [localPassword, setLocalPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const isEndingRef = useRef(false);

  const handleEndBroadcast = useCallback(() => {
    isEndingRef.current = true;
  }, []);

  const fetchToken = useCallback(async (pass: string) => {
    try {
      const identity = `organizer-host`;
      const url = `/api/token?room=${sessionId}&identity=${identity}&role=organizer${pass ? `&password=${encodeURIComponent(pass)}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (res.status === 401) {
        setPasswordPromptRequired(true);
        return false;
      }
      
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to fetch token");
      }
      
      if (pass) {
        sessionStorage.setItem("broadcast_password", pass);
      }
      setToken(data.token);
      setLivekitUrl(data.serverUrl);
      setPasswordPromptRequired(false);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, [sessionId]);

  useEffect(() => {
    const cachedPass = sessionStorage.getItem("broadcast_password") || "";
    fetchToken(cachedPass);
  }, [fetchToken]);

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setVerifying(true);
    setPasswordError(null);
    const success = await fetchToken(localPassword);
    setVerifying(false);
    if (!success && !error) {
      setPasswordError("Incorrect password");
    }
  };

  if (passwordPromptRequired) {
    return (
      <div className="page enter">
        <div className="container" style={{ textAlign: "center" }}>
          <h1 className="display display-md" style={{ marginBottom: 12 }}>
            <em>비밀번호</em> 필요
          </h1>
          <p className="body-sm" style={{ marginBottom: 32 }}>
            이 방송 세션은 비밀번호로 보호되어 있습니다.
          </p>
          <form onSubmit={handlePasswordSubmit}>
            <div style={{ marginBottom: 20 }}>
              <input
                type="password"
                className="input-field"
                placeholder="비밀번호 입력"
                value={localPassword}
                onChange={(e) => setLocalPassword(e.target.value)}
                style={{ textAlign: "center" }}
                disabled={verifying}
                required
              />
            </div>
            {passwordError && (
              <p className="body-sm" style={{ color: "var(--error)", marginBottom: 20 }}>
                {passwordError}
              </p>
            )}
            <button
              type="submit"
              className="btn btn-dark"
              style={{ width: "100%" }}
              disabled={verifying}
            >
              {verifying ? "확인 중…" : "확인"}
            </button>
          </form>
          <button
            className="btn btn-ghost"
            onClick={() => (window.location.href = "/")}
            style={{ marginTop: 16 }}
          >
            취소
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="container" style={{ textAlign: "center" }}>
          <p className="display display-md" style={{ marginBottom: 16 }}>
            문제가 발생했습니다
          </p>
          <p className="body-sm" style={{ marginBottom: 32 }}>{error}</p>
          <button className="btn btn-outline" onClick={() => (window.location.href = "/")}>
            홈으로
          </button>
        </div>
      </div>
    );
  }

  if (!token || !livekitUrl) {
    return (
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="page page-top">
      <LiveKitRoom
        video={false}
        audio={false}
        token={token}
        serverUrl={livekitUrl}
        options={{ disconnectOnPageLeave: false }}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
        }}
        onDisconnected={() => {
          if (!isEndingRef.current) {
            setError("Disconnected from LiveKit room. Please check your credentials or network connection.");
          }
        }}
      >
        <BroadcastControls sessionId={sessionId} onEndBroadcast={handleEndBroadcast} />
      </LiveKitRoom>
    </div>
  );
}
