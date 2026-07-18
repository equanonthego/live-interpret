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

/**
 * TranslationBridge: Connects a LiveKit room to a Gemini Live API WebSocket
 * for real-time audio translation.
 *
 * Each bridge instance:
 * 1. Joins the LiveKit room as a bot participant (e.g., "translator-es")
 * 2. Subscribes to the organizer's audio track
 * 3. Pipes PCM audio frames to Gemini Live API via WebSocket
 * 4. Receives translated audio back and publishes it as a new track
 */

import {
  Room,
  RoomEvent,
  LocalAudioTrack,
  AudioSource,
  AudioFrame,
  TrackPublishOptions,
  TrackSource,
  RemoteTrackPublication,
  RemoteParticipant,
  RemoteAudioTrack,
  TrackKind,
  AudioStream,
} from "@livekit/rtc-node";
import WebSocket from "ws";
import { GEMINI_LIVE_MODEL, GEMINI_VOICE } from "./interpret-config";
import type { PresentationContext } from "./glossary-extractor";

export type BridgeStatus = "starting" | "active" | "error" | "closed";

export class TranslationBridge {
  private room: Room | null = null;
  private geminiWs: WebSocket | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private publishedTrackSid: string = "";
  private transcriptionSegmentId: number = 0;
  private framesSentToGemini: number = 0;
  private framesReceivedFromGemini: number = 0;
  private resumptionHandle: string | null = null;
  private isReconnecting: boolean = false;
  private pendingInterimText: string = "";
  private interimTimeout: NodeJS.Timeout | null = null;

  public readonly targetLanguage: string;
  public readonly sessionId: string;
  public readonly identity: string;
  public status: BridgeStatus = "starting";
  public subscriberCount: number = 0;
  public onStop?: () => void;

  // Gemini Live API config
  private readonly geminiApiKey: string;
  private readonly geminiModel: string = GEMINI_LIVE_MODEL;
  private readonly sampleRate: number = 24000; // Gemini outputs 24kHz
  private readonly inputSampleRate: number = 16000; // Gemini Live 네이티브 입력 rate (참조 플레이그라운드와 동일). 이전 48000은 지연 유발 의심.
  private readonly channels: number = 1;

  // LiveKit config
  private readonly livekitUrl: string;
  private readonly livekitApiKey: string;
  private readonly livekitApiSecret: string;

  private geminiSetupComplete: boolean = false;
  private sourceIdentity: string;
  private lastAudioFrameTime: number = 0;
  private captureChain: Promise<void> = Promise.resolve();
  // 브릿지당 Gemini로 향하는 오디오 리더는 항상 1개만 유지한다. 리더가 2개
  // 이상 살아 있으면 같은 오디오가 겹침·실시간의 2배 속도로 공급돼 번역이
  // 엉뚱해지고(오인식) Gemini 입력 큐가 쌓여 지연이 계속 커진다.
  // activePipeSid로 같은 트랙 중복을 막고, pipeGeneration으로 새 트랙 교체 시
  // 이전 리더 루프를 무효화한다.
  private activePipeSid: string | null = null;
  private pipeGeneration = 0;

  // When true, this bridge only transcribes the organizer's own speech (no
  // translated audio track is published). Used for the host's Korean captions.
  private readonly transcribeOnly: boolean;

  // 발표자료에서 추출한 맥락/용어집. 있으면 systemInstruction으로 주입한다.
  private readonly presentationContext?: PresentationContext;

  constructor(
    sessionId: string,
    targetLanguage: string,
    sourceIdentity: string,
    config: {
      geminiApiKey: string;
      livekitUrl: string;
      livekitApiKey: string;
      livekitApiSecret: string;
      presentationContext?: PresentationContext;
    },
    transcribeOnly: boolean = false
  ) {
    this.sessionId = sessionId;
    this.targetLanguage = targetLanguage;
    this.sourceIdentity = sourceIdentity;
    this.transcribeOnly = transcribeOnly;
    this.identity = transcribeOnly
      ? `host-transcriber-${targetLanguage}`
      : `translator-${targetLanguage}`;
    this.geminiApiKey = config.geminiApiKey;
    this.livekitUrl = config.livekitUrl;
    this.livekitApiKey = config.livekitApiKey;
    this.livekitApiSecret = config.livekitApiSecret;
    this.presentationContext = config.presentationContext;
  }

  async start(): Promise<void> {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Starting bridge for session ${this.sessionId}`
    );

    try {
      // 1. Generate token and join LiveKit room
      await this.joinLiveKitRoom();

      // 2. Connect to Gemini Live API
      await this.connectGemini();

      // 3. Subscribe to organizer's audio and wire up the pipeline
      await this.subscribeToOrganizer();

      this.status = "active";
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Bridge is active`
      );
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Failed to start:`,
        error
      );
      this.status = "error";
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Stopping bridge`
    );
    this.status = "closed";

    if (this.interimTimeout) {
      clearTimeout(this.interimTimeout);
      this.interimTimeout = null;
    }
    this.pendingInterimText = "";

    if (this.geminiWs) {
      this.geminiWs.close();
      this.geminiWs = null;
    }

    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }

    this.audioSource = null;
    this.localTrack = null;
    this.geminiSetupComplete = false;

    if (this.onStop) {
      this.onStop();
    }
  }

  private async joinLiveKitRoom(): Promise<void> {
    // Generate a token for the bot participant using the server SDK
    const { AccessToken } = await import("livekit-server-sdk");

    const at = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
      identity: this.identity,
      name: `Translator (${this.targetLanguage.toUpperCase()})`,
    });

    at.addGrant({
      roomJoin: true,
      room: this.sessionId,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    // Create and connect to the room
    this.room = new Room();

    this.room.on(RoomEvent.Disconnected, () => {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Disconnected from room`
      );
      this.status = "closed";
    });

    this.room.on(
      RoomEvent.ParticipantDisconnected,
      (participant: RemoteParticipant) => {
        if (participant.identity === this.sourceIdentity) {
          console.log(
            `[TranslationBridge:${this.targetLanguage}] Source speaker ${this.sourceIdentity} disconnected, stopping bridge`
          );
          this.stop().catch((err) => {
            console.error(
              `[TranslationBridge:${this.targetLanguage}] Error stopping bridge after organizer disconnect:`,
              err
            );
          });
        }
      }
    );

    await this.room.connect(this.livekitUrl, token, {
      autoSubscribe: false,
      dynacast: false,
    });

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Joined room as ${this.identity}`
    );

    // Transcription-only bridges (host captions) never publish audio — they
    // exist purely to stream the organizer's own speech back as text.
    if (this.transcribeOnly) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] transcribeOnly mode — skipping audio track publish`
      );
      return;
    }

    // Create an AudioSource to publish translated audio
    // Gemini outputs 24kHz mono PCM
    this.audioSource = new AudioSource(this.sampleRate, this.channels);
    this.localTrack = LocalAudioTrack.createAudioTrack(
      `translated-audio-${this.targetLanguage}`,
      this.audioSource
    );

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await this.room.localParticipant!.publishTrack(
      this.localTrack,
      publishOptions
    );

    // Save published track SID for transcription
    const pubs = this.room.localParticipant!.trackPublications;
    for (const [, pub] of pubs) {
      if (pub.track === this.localTrack) {
        this.publishedTrackSid = pub.sid || "";
        break;
      }
    }

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Published translated audio track (sid: ${this.publishedTrackSid || 'pending'})`
    );
  }

  private async connectGemini(): Promise<void> {
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.geminiApiKey}`;

    return new Promise<void>((resolve, reject) => {
      this.geminiWs = new WebSocket(wsUrl);

      this.geminiWs.on("open", () => {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket connected`
        );
        this.sendGeminiSetup();
      });

      this.geminiWs.on("message", (data: WebSocket.Data) => {
        this.handleGeminiMessage(data);
        if (!this.geminiSetupComplete) {
          // Wait for setup complete message
          // resolve will be called in handleGeminiMessage
        }
      });

      this.geminiWs.on("error", (error) => {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket error:`,
          error
        );
        if (!this.geminiSetupComplete) {
          reject(error);
        }
      });

      this.geminiWs.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket closed`,
          { code, reason: reasonStr }
        );
        if (!this.geminiSetupComplete) {
          reject(new Error(`Gemini WebSocket closed before setup: code=${code} reason=${reasonStr}`));
        } else if (this.status === "active") {
          // Auto-reconnect on GoAway or unexpected closure
          console.log(
            `[TranslationBridge:${this.targetLanguage}] Reconnecting Gemini WebSocket...`
          );
          this.geminiSetupComplete = false;
          this.reconnectGemini();
        }
      });

      // Store resolve for use when setup complete arrives
      const checkSetup = setInterval(() => {
        if (this.geminiSetupComplete) {
          clearInterval(checkSetup);
          resolve();
        }
      }, 100);

      // Timeout after 15 seconds
      setTimeout(() => {
        if (!this.geminiSetupComplete) {
          clearInterval(checkSetup);
          reject(new Error("Gemini setup timeout"));
        }
      }, 15000);
    });
  }

  /**
   * Reconnect the Gemini WebSocket after a GoAway or unexpected closure.
   * Reuses the existing LiveKit room + audio pipeline.
   */
  private async reconnectGemini(): Promise<void> {
    if (this.isReconnecting) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Reconnection already in progress. Skipping duplicate request.`
      );
      return;
    }
    this.isReconnecting = true;

    try {
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.geminiApiKey}`;
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Reconnecting Gemini WebSocket with handle: ${this.resumptionHandle || "none"}...`
      );

      const nextWs = new WebSocket(wsUrl);
      let nextSetupComplete = false;

      nextWs.on("open", () => {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini reconnect WebSocket opened`
        );
        this.sendGeminiSetup(nextWs);
      });

      nextWs.on("message", (data: WebSocket.Data) => {
        try {
          if (!nextSetupComplete) {
            const msg = JSON.parse(data.toString());
            if (msg.setupComplete) {
              console.log(
                `[TranslationBridge:${this.targetLanguage}] Gemini reconnect setup complete`
              );
              nextSetupComplete = true;
              this.geminiSetupComplete = true;

              const oldWs = this.geminiWs;
              this.geminiWs = nextWs;
              this.isReconnecting = false;

              if (oldWs) {
                console.log(
                  `[TranslationBridge:${this.targetLanguage}] Gracefully closing old Gemini WebSocket`
                );
                oldWs.removeAllListeners();
                oldWs.close();
              }
              return;
            }
          }
          this.handleGeminiMessage(data);
        } catch (error) {
          console.error(
            `[TranslationBridge:${this.targetLanguage}] Error handling reconnect message:`,
            error
          );
        }
      });

      nextWs.on("error", (error) => {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Gemini reconnect error:`,
          error
        );
      });

      nextWs.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini reconnect WebSocket closed`,
          { code, reason: reasonStr }
        );

        if (this.geminiWs === nextWs) {
          this.geminiSetupComplete = false;
          if (this.status === "active") {
            setTimeout(() => {
              this.reconnectGemini();
            }, 1000);
          }
        } else {
          this.isReconnecting = false;
          if (this.status === "active") {
            setTimeout(() => {
              this.reconnectGemini();
            }, 2000);
          }
        }
      });
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Gemini reconnect initialization failed:`,
        error
      );
      this.isReconnecting = false;
      if (this.status === "active") {
        setTimeout(() => {
          this.reconnectGemini();
        }, 5000);
      }
    }
  }

  // presentationContext가 있으면 번역용 systemInstruction 텍스트를 만든다.
  // title·presenter는 표시 전용이라 주입하지 않는다. 내용이 비면 undefined.
  private buildSystemInstruction():
    | { parts: { text: string }[] }
    | undefined {
    const ctx = this.presentationContext;
    if (!ctx) return undefined;
    // 클라이언트가 넘긴 컨텍스트는 형식이 어긋날 수 있으므로 방어적으로 읽는다.
    const summary =
      typeof ctx.domainSummary === "string" ? ctx.domainSummary.trim() : "";
    const terms = (Array.isArray(ctx.glossary) ? ctx.glossary : []).filter(
      (g) => g?.term?.trim() && g?.note?.trim()
    );
    if (!summary && terms.length === 0) return undefined;

    const lines: string[] = ["You are translating a live lecture."];
    if (summary) lines.push(`Domain: ${summary}`);
    if (terms.length > 0) {
      lines.push(
        "Glossary (translate these terms consistently and accurately):"
      );
      for (const t of terms) lines.push(`- ${t.term}: ${t.note}`);
    }
    return { parts: [{ text: lines.join("\n") }] };
  }

  private sendGeminiSetup(ws: WebSocket = this.geminiWs!): void {
    const systemInstruction = this.buildSystemInstruction();
    const setupMessage = {
      setup: {
        model: `models/${this.geminiModel}`,
        outputAudioTranscription: {},
        ...(systemInstruction ? { systemInstruction } : {}),
        // 컨텍스트 창 압축을 공격적으로(누적 0) 설정한다. 이게 없으면 모델이
        // 세션 내내 컨텍스트를 누적해 매 번역이 점점 느려지고 지연이 크게
        // 쌓인다(실측 ~15초). AI Studio 플레이그라운드의 저지연(2~3초) 참조
        // 설정과 동일하게 맞춘다: 각 발화를 사실상 독립적으로 즉시 번역.
        contextWindowCompression: {
          triggerTokens: 0,
          slidingWindow: { targetTokens: 0 },
        },
        generationConfig: {
          responseModalities: ["AUDIO"],
          // 통역 음성을 한 목소리로 고정한다. 지정하지 않으면 모델이 발화마다
          // 남/여 목소리를 오가며 바꿔 듣기 불편하다.
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: GEMINI_VOICE },
            },
          },
          translationConfig: {
            targetLanguageCode: this.targetLanguage,
            echoTargetLanguage: true,
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
          },
        },
        sessionResumption: this.resumptionHandle
          ? { handle: this.resumptionHandle }
          : {},
      },
    };

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Sending Gemini setup (resuming: ${!!this.resumptionHandle}):`,
      JSON.stringify(setupMessage, null, 2)
    );

    ws.send(JSON.stringify(setupMessage));
  }

  private handleGeminiMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Log all messages before setup is complete for debugging
      if (!this.geminiSetupComplete) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini message (pre-setup):`,
          JSON.stringify(message).slice(0, 500)
        );
      }

      // Handle setup complete
      if (message.setupComplete) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini setup complete`
        );
        this.geminiSetupComplete = true;
        return;
      }

      // Handle session resumption update
      if (message.sessionResumptionUpdate) {
        const update = message.sessionResumptionUpdate;
        if (update.resumable && update.newHandle) {
          this.resumptionHandle = update.newHandle;
          console.log(
            `[TranslationBridge:${this.targetLanguage}] Received sessionResumptionUpdate with newHandle: ${this.resumptionHandle}`
          );
        }
      }

      // Handle GoAway message
      if (message.goAway) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Received goAway message from Gemini. Time left: ${message.goAway.timeLeft || "unknown"}. Initiating graceful session resumption...`
        );
        this.reconnectGemini().catch((err) => {
          console.error(
            `[TranslationBridge:${this.targetLanguage}] Error during goAway reconnection:`,
            err
          );
        });
      }

      // Handle audio response
      const serverContent = message?.serverContent;
      const parts = serverContent?.modelTurn?.parts;

      // Transcription-only bridges discard generated audio — captions only.
      if (parts?.length && !this.transcribeOnly) {
        for (const part of parts) {
          if (part.inlineData?.data) {
            this.framesReceivedFromGemini++;
            if (this.framesReceivedFromGemini <= 3 || this.framesReceivedFromGemini % 100 === 0) {
              console.log(
                `[TranslationBridge:${this.targetLanguage}] Received audio frame #${this.framesReceivedFromGemini} from Gemini (${part.inlineData.data.length} bytes base64)`
              );
            }
            // Queue frame for sequential capture (avoid promise pile-up)
            this.queueAudioFrame(part.inlineData.data);
          }
        }
      }

      // 모든 브릿지는 출력 transcription(번역 결과)을 자막으로 쓴다. 호스트
      // 자막 브릿지는 target=ko라, 어떤 언어가 들어오든 한국어로 번역된 결과가
      // 나온다: 발표자의 한국어는 echoTargetLanguage로 그대로 반영되고,
      // 학생이 다른 언어로 질문하면 한국어로 번역돼 강연자가 이해할 수 있다.
      // (소스 언어는 고정하지 않고 자동 감지 — 청자는 원 언어대로 골라 듣는다.)
      if (serverContent?.outputTranscription?.text) {
        const text = serverContent.outputTranscription.text;
        const isInterim = !serverContent.turnComplete;

        if (isInterim) {
          this.handleInterimTranscription(text);
        } else {
          if (this.interimTimeout) {
            clearTimeout(this.interimTimeout);
            this.interimTimeout = null;
          }
          const finalText = this.pendingInterimText + text;
          this.pendingInterimText = "";
          console.log(
            `[TranslationBridge:${this.targetLanguage}] Final Transcription:`,
            finalText.slice(0, 100)
          );
          this.publishTranscriptionText(finalText, false);
        }
      }

      // If turn is complete, flush remaining interim buffer and advance the segment id
      if (serverContent?.turnComplete) {
        if (this.interimTimeout) {
          clearTimeout(this.interimTimeout);
          this.interimTimeout = null;
        }
        if (this.pendingInterimText) {
          this.publishTranscriptionText(this.pendingInterimText, false);
          this.pendingInterimText = "";
        }
        this.transcriptionSegmentId++;
      }
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error parsing Gemini message:`,
        error
      );
    }
  }

  /**
   * Queue an audio frame for sequential capture.
   * Chains each captureFrame call to avoid promise pile-up.
   */
  private queueAudioFrame(base64Audio: string): void {
    this.captureChain = this.captureChain.then(() =>
      this.publishTranslatedAudio(base64Audio)
    );
  }

  private async publishTranslatedAudio(base64Audio: string): Promise<void> {
    if (!this.audioSource || this.status === "closed") return;

    try {
      const pcmBuffer = Buffer.from(base64Audio, "base64");
      const int16 = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.byteLength / 2
      );

      const frame = new AudioFrame(int16, this.sampleRate, this.channels, int16.length);
      await this.audioSource.captureFrame(frame);

      const now = Date.now();
      if (this.lastAudioFrameTime && now - this.lastAudioFrameTime > 2000) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Audio resumed after ${now - this.lastAudioFrameTime}ms gap (frame #${this.framesReceivedFromGemini})`
        );
      }
      this.lastAudioFrameTime = now;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("InvalidState") || msg.includes("closed")) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] AudioSource closed — stopping capture`
        );
        this.audioSource = null;
      } else {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Error capturing audio frame:`,
          error
        );
      }
    }
  }

  private async subscribeToOrganizer(): Promise<void> {
    if (!this.room) return;

    // 리스너는 여기서 정확히 한 번만 등록한다. 이전 구조는 발표자가 이미
    // 방에 있으면 별도 메서드에서 TrackSubscribed 리스너를 또 등록해, 같은
    // 구독 이벤트에 파이핑이 중복 실행될 수 있었다(→ 오디오 2배 공급).

    // 발표자가 (나중에) 오디오를 발행하면 구독
    this.room.on(
      RoomEvent.TrackPublished,
      (
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        if (
          participant.identity === this.sourceIdentity &&
          publication.kind === TrackKind.KIND_AUDIO
        ) {
          publication.setSubscribed(true);
        }
      }
    );

    // 구독되면 Gemini로 파이핑 (pipeTrackToGemini가 단일 리더를 보장)
    this.room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteAudioTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        if (
          participant.identity === this.sourceIdentity &&
          publication.kind === TrackKind.KIND_AUDIO
        ) {
          this.pipeTrackToGemini(track);
        }
      }
    );

    // 발표자가 이미 방에 있으면 기존 오디오 발행을 구독한다
    // (autoSubscribe가 꺼져 있어 수동 구독 필요. TrackSubscribed 이벤트가
    // 위 리스너를 통해 파이핑으로 이어진다.)
    for (const [, participant] of this.room.remoteParticipants) {
      if (participant.identity === this.sourceIdentity) {
        for (const [, publication] of participant.trackPublications) {
          if (publication.kind === TrackKind.KIND_AUDIO) {
            publication.setSubscribed(true);
          }
        }
        return;
      }
    }

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Waiting for source speaker ${this.sourceIdentity}...`
    );
  }

  private pipeTrackToGemini(track: RemoteAudioTrack): void {
    // 같은 트랙(SID)이 다시 오면 무시한다. 다른 트랙이 오면(재발행 등)
    // 세대(generation)를 올려 이전 리더 루프를 무효화하고 교체한다.
    if (track.sid && track.sid === this.activePipeSid) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Track ${track.sid} already piped — skipping duplicate`
      );
      return;
    }
    const gen = ++this.pipeGeneration;
    this.activePipeSid = track.sid ?? null;

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Subscribed to organizer audio track ${track.sid ?? "(no sid)"}, piping to Gemini (gen ${gen})`
    );

    const audioStream = new AudioStream(track, {
      sampleRate: this.inputSampleRate,
      numChannels: this.channels,
      frameSizeMs: 100,
    });

    // Process frames as they arrive via ReadableStream reader
    const reader = audioStream.getReader();
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        // 새 리더로 교체됐으면(세대 불일치) 이 루프는 조용히 종료한다.
        if (done || gen !== this.pipeGeneration) break;
        this.sendAudioToGemini(value);
      }
    };

    readLoop().catch((err: Error) => {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Audio stream error:`,
        err
      );
    });
  }

  private sendAudioToGemini(frame: AudioFrame): void {
    if (
      !this.geminiWs ||
      this.geminiWs.readyState !== WebSocket.OPEN ||
      !this.geminiSetupComplete
    ) {
      return;
    }

    try {
      // Convert AudioFrame's Int16Array data to base64
      const int16Data = frame.data;
      const buffer = Buffer.from(int16Data.buffer, int16Data.byteOffset, int16Data.byteLength);
      const base64 = buffer.toString("base64");

      this.framesSentToGemini++;
      if (this.framesSentToGemini <= 3 || this.framesSentToGemini % 500 === 0) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Sent audio frame #${this.framesSentToGemini} to Gemini (${base64.length} bytes base64, ${int16Data.length} samples)`
        );
      }

      const message = {
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
            data: base64,
          },
        },
      };

      this.geminiWs.send(JSON.stringify(message));
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error sending audio to Gemini:`,
        error
      );
    }
  }

  private handleInterimTranscription(text: string): void {
    this.pendingInterimText += text;

    if (!this.interimTimeout) {
      this.interimTimeout = setTimeout(() => {
        this.flushInterimTranscription();
      }, 150); // Throttle interim text updates to 150ms
    }
  }

  private flushInterimTranscription(): void {
    this.interimTimeout = null;
    if (this.pendingInterimText && this.status === "active") {
      this.publishTranscriptionText(this.pendingInterimText, true);
      this.pendingInterimText = "";
    }
  }

  private async publishTranscriptionText(text: string, interim: boolean): Promise<void> {
    if (!this.room || !this.room.localParticipant) return;

    try {
      // Find all remote participants who have set their 'language' attribute to this.targetLanguage
      const destinationIdentities = Array.from(this.room.remoteParticipants.values())
        .filter((p) => p.attributes?.language === this.targetLanguage)
        .map((p) => p.identity);

      // If no one is listening to this language, skip publishing to save bandwidth
      if (destinationIdentities.length === 0) {
        return;
      }

      const payload = JSON.stringify({
        type: "transcription",
        language: this.targetLanguage,
        segmentId: `${this.targetLanguage}-${this.transcriptionSegmentId}`,
        text,
        final: !interim,
        timestamp: Date.now(),
      });

      await this.room.localParticipant.publishData(
        new TextEncoder().encode(payload),
        {
          reliable: !interim, // reliable only for final transcripts, lossy for interim
          topic: "transcription",
          destination_identities: destinationIdentities,
        }
      );
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error publishing transcription:`,
        error
      );
    }
  }
}
