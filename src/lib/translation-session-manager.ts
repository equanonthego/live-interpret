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
 * TranslationSessionManager: Singleton that enforces "max 1 Gemini Live API
 * session per language per room" constraint.
 *
 * Usage:
 *   const manager = TranslationSessionManager.getInstance();
 *   const bridge = await manager.getOrCreate(sessionId, targetLanguage, organizerIdentity);
 */

import { TranslationBridge, BridgeStatus } from "./translation-bridge";
import { SOURCE_LANGUAGE, MAX_CONCURRENT_LANGUAGES } from "./interpret-config";
import { canOpenLanguage, LanguageCapReachedError } from "./language-cap";
import { emptyUsage, mergeUsage, type UsageTotals } from "./usage-meter";
import type { PresentationContext } from "./glossary-extractor";
import { evaluateReap } from "./session-reaper";

// 세션 자동 종료 임계값. 발표자 이탈(심장박동 끊김)/무음 시 비용을 끊기 위함.
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90초 — 절전/닫힘/전원차단 감지
const IDLE_AUDIO_TIMEOUT_MS = 300_000; // 5분 — 무음 지속 감지
const REAP_INTERVAL_MS = 30_000; // 리퍼 점검 주기

export interface TranslationInfo {
  language: string;
  translatorIdentity: string;
  status: BridgeStatus;
  subscriberCount: number;
}

export interface HandRaise {
  identity: string;
  name?: string;
  language: string;
}

export interface SessionInfo {
  sessionId: string;
  organizerIdentity: string;
  createdAt: Date;
  // 발표자의 마지막 심장박동(status 폴링) 시각(ms). 리퍼가 이탈 판정에 쓴다.
  lastHeartbeatAt: number;
  allowedLanguages?: string[];
  // 이 세션의 통역을 돌릴 방송자 소유 Gemini 키. 서버 메모리에만 존재하며
  // 디스크·로그에 절대 기록하지 않는다.
  geminiApiKey: string;
  // 발표자료에서 추출한 제목·발표자·도메인 요약·용어집. 없을 수 있음.
  presentationContext?: PresentationContext;
  // 발표자료 원본 파일(전체보기 렌더용). 서버 메모리에만 보관.
  presentationFile?: { name: string; mime: string; bytes: Buffer };
  // 발언권을 쥔 청자 identity. 없으면(undefined) 강의자만 발언 중.
  currentSpeaker?: string;
  // 손든 청자 대기열 (순서대로).
  handRaised: HandRaise[];
  // 이미 해체된 브릿지들의 토큰 누계. 살아있는 브릿지 usage와 합쳐 세션 총량을
  // 낸다. 이게 없으면 청자가 나가 브릿지가 해체될 때 총량이 거꾸로 줄어든다.
  retiredUsage: UsageTotals;
}

export interface FloorState {
  currentSpeaker?: string;
  handRaised: HandRaise[];
}

const globalForSessionManager = global as unknown as {
  sessionManagerInstance: TranslationSessionManager;
};

class TranslationSessionManager {
  // Map<sessionId, Map<languageCode, TranslationBridge>>
  private translations: Map<string, Map<string, TranslationBridge>> = new Map();

  // Map<sessionId, TranslationBridge> — one host-caption (transcribe-only)
  // bridge per session, kept separate so it never appears in attendee lists.
  private hostTranscriptions: Map<string, TranslationBridge> = new Map();

  // Map<sessionId, SessionInfo>
  private sessions: Map<string, SessionInfo> = new Map();

  // Map<sessionId, TranslationBridge> — 질문자 언어 → ko. 질문하는 동안에만 존재.
  private questionBridges: Map<string, TranslationBridge> = new Map();

  // 유휴/이탈 세션을 주기적으로 종료하는 리퍼 타이머. 세션이 있을 때만 돈다.
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  static getInstance(): TranslationSessionManager {
    if (!globalForSessionManager.sessionManagerInstance) {
      globalForSessionManager.sessionManagerInstance = new TranslationSessionManager();
    }
    return globalForSessionManager.sessionManagerInstance;
  }

  private buildBridgeConfig(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const geminiApiKey = session?.geminiApiKey;
    if (!geminiApiKey) {
      throw new Error(`No Gemini API key stored for session ${sessionId}`);
    }
    return {
      geminiApiKey,
      livekitUrl: process.env.LIVEKIT_URL || "ws://localhost:7880",
      livekitApiKey: process.env.LIVEKIT_API_KEY!,
      livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
      presentationContext: session?.presentationContext,
    };
  }

  // Session management
  createSession(
    sessionId: string,
    organizerIdentity: string,
    allowedLanguages: string[] | undefined,
    geminiApiKey: string,
    presentationContext?: PresentationContext,
    presentationFile?: { name: string; mime: string; bytes: Buffer }
  ): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      organizerIdentity,
      createdAt: new Date(),
      lastHeartbeatAt: Date.now(),
      allowedLanguages,
      geminiApiKey,
      presentationContext,
      presentationFile,
      handRaised: [],
      retiredUsage: emptyUsage(),
    };
    this.sessions.set(sessionId, info);
    console.log(`[SessionManager] Created session ${sessionId} for organizer ${organizerIdentity} with allowed languages: ${allowedLanguages?.join(", ") || "all"}`);
    this.ensureReaper();
    return info;
  }

  /**
   * 발표자의 심장박동 갱신. 발표자 페이지가 주기적으로 호출하는 status 폴링에서
   * 불린다. 이 호출이 90초 넘게 끊기면(절전/닫힘/전원차단) 리퍼가 세션을 내린다.
   */
  touchHeartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastHeartbeatAt = Date.now();
  }

  /** 세션의 마지막 발화 활동 시각(ms) — 모든 브릿지 lastSpeechAt 중 최댓값,
   *  하한은 세션 생성 시각(아직 발화가 없으면 생성 시점부터 무음 타이머 시작). */
  private lastAudioAt(sessionId: string): number {
    let latest = 0;
    const langMap = this.translations.get(sessionId);
    if (langMap) for (const [, b] of langMap) latest = Math.max(latest, b.lastSpeechAt);
    const host = this.hostTranscriptions.get(sessionId);
    if (host) latest = Math.max(latest, host.lastSpeechAt);
    const q = this.questionBridges.get(sessionId);
    if (q) latest = Math.max(latest, q.lastSpeechAt);
    const created = this.sessions.get(sessionId)?.createdAt.getTime() ?? 0;
    return Math.max(latest, created);
  }

  /** 세션이 하나라도 있으면 리퍼를 켜고, 없으면 끈다. */
  private ensureReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => void this.reapIdleSessions(), REAP_INTERVAL_MS);
  }

  private stopReaperIfIdle(): void {
    if (this.reaperTimer && this.sessions.size === 0) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /** 유휴/이탈 세션을 종료한다. 리퍼 타이머가 주기적으로 호출. */
  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    // 순회 중 삭제하므로 스냅샷을 뜬다.
    for (const session of [...this.sessions.values()]) {
      const reason = evaluateReap({
        now,
        lastHeartbeatAt: session.lastHeartbeatAt,
        lastAudioAt: this.lastAudioAt(session.sessionId),
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
        idleAudioTimeoutMs: IDLE_AUDIO_TIMEOUT_MS,
      });
      if (reason) {
        console.log(
          `[SessionManager] Reaped session ${session.sessionId} (reason: ${reason})`
        );
        await this.removeAllTranslations(session.sessionId);
      }
    }
    this.stopReaperIfIdle();
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  // Floor control (발언권 이양) ---------------------------------------

  getFloorState(sessionId: string): FloorState {
    const session = this.sessions.get(sessionId);
    return {
      currentSpeaker: session?.currentSpeaker,
      handRaised: session?.handRaised ?? [],
    };
  }

  raiseHand(sessionId: string, entry: HandRaise): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.handRaised.some((h) => h.identity === entry.identity)) return;
    session.handRaised.push(entry);
  }

  lowerHand(sessionId: string, identity: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.handRaised = session.handRaised.filter((h) => h.identity !== identity);
  }

  setSpeaker(sessionId: string, identity: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.currentSpeaker = identity ?? undefined;
  }

  // Translation management
  async getOrCreate(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string
  ): Promise<TranslationBridge> {
    // SOURCE_LANGUAGE is reserved for the host-caption bridge (see
    // getOrCreateHostTranscription) — an attendee-facing bridge targeting the
    // same language would collide with it on destination routing and segment
    // ids. This must hold regardless of what a session's allowedLanguages
    // happen to contain.
    if (targetLanguage === SOURCE_LANGUAGE) {
      throw new Error(
        `Cannot create an attendee translation bridge for "${SOURCE_LANGUAGE}" — reserved for host transcription`
      );
    }

    // Check if we already have a bridge for this language
    let languageMap = this.translations.get(sessionId);
    if (languageMap) {
      const existingBridge = languageMap.get(targetLanguage);
      if (existingBridge && existingBridge.status === "active") {
        console.log(
          `[SessionManager] Reusing existing bridge for ${targetLanguage} in session ${sessionId}`
        );
        existingBridge.subscriberCount++;
        return existingBridge;
      }
      // If bridge exists but is in error/closed state, clean it up
      if (existingBridge && (existingBridge.status === "error" || existingBridge.status === "closed")) {
        console.log(
          `[SessionManager] Cleaning up stale bridge for ${targetLanguage}`
        );
        await existingBridge.stop();
        languageMap.delete(targetLanguage);
      }
    }

    // 동시 상한 게이트. 이 지점부터 languageMap.set(...)까지 await가 없어
    // 단일 스레드에서 원자적으로 실행되므로, 두 청자가 동시에 마지막 자리를
    // 요청해도 상한을 넘겨 브릿지가 초과 생성되지 않는다.
    const openLanguages = [...(this.translations.get(sessionId)?.keys() ?? [])];
    if (!canOpenLanguage(openLanguages, targetLanguage, MAX_CONCURRENT_LANGUAGES)) {
      throw new LanguageCapReachedError(openLanguages);
    }

    // Create a new bridge
    console.log(
      `[SessionManager] Creating new bridge for ${targetLanguage} in session ${sessionId}`
    );

    const bridge = new TranslationBridge(
      sessionId,
      targetLanguage,
      organizerIdentity,
      this.buildBridgeConfig(sessionId)
    );

    bridge.onStop = () => {
      const languageMap = this.translations.get(sessionId);
      if (languageMap) {
        languageMap.delete(targetLanguage);
        if (languageMap.size === 0) {
          this.translations.delete(sessionId);
          console.log(
            `[SessionManager] Cleaned up active translations for session ${sessionId} as all translation bridges stopped.`
          );
        }
      }
    };

    // Store the bridge before starting (to prevent race conditions)
    if (!languageMap) {
      languageMap = new Map();
      this.translations.set(sessionId, languageMap);
    }
    languageMap.set(targetLanguage, bridge);

    try {
      await bridge.start();
      bridge.subscriberCount = 1;
      return bridge;
    } catch (error) {
      // Clean up on failure
      languageMap.delete(targetLanguage);
      throw error;
    }
  }

  // Question bridge (질문자 언어 → ko) --------------------------------

  /**
   * 발언권을 받은 청자(questionerIdentity)의 오디오를 한국어로 통역하는
   * 브릿지를 세션당 1개 띄운다. 질문하는 동안에만 존재하고, stopQuestionBridge로
   * 종료된다. 일반 언어별 브릿지(translations map)와는 별도로 관리한다 —
   * targetLanguage가 항상 "ko"이고 source가 강의자가 아니라 질문자이기 때문.
   */
  async startQuestionBridge(
    sessionId: string,
    questionerIdentity: string
  ): Promise<TranslationBridge> {
    const existing = this.questionBridges.get(sessionId);
    if (existing) {
      await existing.stop();
      this.questionBridges.delete(sessionId);
    }

    const bridge = new TranslationBridge(
      sessionId,
      "ko",
      questionerIdentity,
      this.buildBridgeConfig(sessionId)
    );
    bridge.onStop = () => {
      if (this.questionBridges.get(sessionId) === bridge) {
        this.questionBridges.delete(sessionId);
      }
    };

    this.questionBridges.set(sessionId, bridge);
    try {
      await bridge.start();
      bridge.subscriberCount = 1;
      return bridge;
    } catch (error) {
      this.questionBridges.delete(sessionId);
      throw error;
    }
  }

  async stopQuestionBridge(sessionId: string): Promise<void> {
    const bridge = this.questionBridges.get(sessionId);
    if (!bridge) return;
    await bridge.stop();
    this.questionBridges.delete(sessionId);
  }

  /**
   * Start (or reuse) the host-caption bridge for a session. This transcribes
   * the organizer's own speech (SOURCE_LANGUAGE) and streams it back to them as
   * text, without publishing any translated audio track. Independent of the
   * attendee translation bridges.
   */
  async getOrCreateHostTranscription(
    sessionId: string
  ): Promise<TranslationBridge> {
    const existing = this.hostTranscriptions.get(sessionId);
    // "starting" must be treated as reusable too — otherwise two overlapping
    // calls (e.g. a React effect re-running before the first bridge.start()
    // resolves) each fall through and create a second bridge, orphaning the
    // first (leaked LiveKit connection + Gemini session, never stopped).
    if (existing && (existing.status === "active" || existing.status === "starting")) {
      return existing;
    }
    if (existing && (existing.status === "error" || existing.status === "closed")) {
      await existing.stop();
      this.hostTranscriptions.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    console.log(
      `[SessionManager] Creating host-caption bridge for session ${sessionId}`
    );

    const bridge = new TranslationBridge(
      sessionId,
      SOURCE_LANGUAGE,
      session.organizerIdentity,
      this.buildBridgeConfig(sessionId),
      true // transcribeOnly
    );

    bridge.onStop = () => {
      const current = this.hostTranscriptions.get(sessionId);
      if (current === bridge) {
        this.hostTranscriptions.delete(sessionId);
      }
    };

    this.hostTranscriptions.set(sessionId, bridge);

    try {
      await bridge.start();
      return bridge;
    } catch (error) {
      this.hostTranscriptions.delete(sessionId);
      throw error;
    }
  }

  async stopHostTranscription(sessionId: string): Promise<void> {
    const bridge = this.hostTranscriptions.get(sessionId);
    if (bridge) {
      await bridge.stop();
      this.hostTranscriptions.delete(sessionId);
      console.log(
        `[SessionManager] Stopped host-caption bridge for session ${sessionId}`
      );
    }
  }

  // 브릿지를 해체하기 직전에 그 usage를 세션 누계로 옮긴다. 반드시 bridge.stop()
  // 및 맵에서 제거하기 "전"에 호출해, 살아있는 브릿지 합산과 이중 계상되지 않게
  // 한다(옮긴 뒤엔 맵에서 사라지므로 getSessionUsage가 다시 세지 않는다).
  private flushBridgeUsage(sessionId: string, bridge: TranslationBridge): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.retiredUsage = mergeUsage(session.retiredUsage, bridge.usage);
  }

  /**
   * 세션의 현재까지 총 토큰 사용량 = 해체된 브릿지 누계(retiredUsage) +
   * 살아있는 모든 브릿지(청자 번역 + 호스트 자막 + 질문)의 usage 합.
   */
  getSessionUsage(sessionId: string): UsageTotals {
    const session = this.sessions.get(sessionId);
    let total = session ? session.retiredUsage : emptyUsage();

    const languageMap = this.translations.get(sessionId);
    if (languageMap) {
      for (const [, bridge] of languageMap) total = mergeUsage(total, bridge.usage);
    }
    const host = this.hostTranscriptions.get(sessionId);
    if (host) total = mergeUsage(total, host.usage);
    const question = this.questionBridges.get(sessionId);
    if (question) total = mergeUsage(total, question.usage);

    return total;
  }

  getActiveTranslations(sessionId: string): TranslationInfo[] {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return [];

    const result: TranslationInfo[] = [];
    for (const [language, bridge] of languageMap) {
      result.push({
        language,
        translatorIdentity: bridge.identity,
        status: bridge.status,
        subscriberCount: bridge.subscriberCount,
      });
    }
    return result;
  }

  /**
   * Decrement subscriber count for a language. If the last subscriber
   * leaves, stop the bridge and tear down the Gemini session.
   */
  async unsubscribe(
    sessionId: string,
    targetLanguage: string
  ): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return;

    const bridge = languageMap.get(targetLanguage);
    if (!bridge) return;

    bridge.subscriberCount = Math.max(0, bridge.subscriberCount - 1);
    console.log(
      `[SessionManager] Unsubscribed from ${targetLanguage} in session ${sessionId} (${bridge.subscriberCount} remaining)`
    );

    if (bridge.subscriberCount === 0) {
      console.log(
        `[SessionManager] No more subscribers for ${targetLanguage}, tearing down bridge`
      );
      this.flushBridgeUsage(sessionId, bridge);
      await bridge.stop();
      languageMap.delete(targetLanguage);

      // Clean up the session map if no bridges remain
      if (languageMap.size === 0) {
        this.translations.delete(sessionId);
      }
    }
  }

  async removeTranslation(
    sessionId: string,
    targetLanguage: string
  ): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return;

    const bridge = languageMap.get(targetLanguage);
    if (bridge) {
      this.flushBridgeUsage(sessionId, bridge);
      await bridge.stop();
      languageMap.delete(targetLanguage);
      console.log(
        `[SessionManager] Removed bridge for ${targetLanguage} in session ${sessionId}`
      );
    }
  }

  async removeAllTranslations(sessionId: string): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (languageMap) {
      for (const [, bridge] of languageMap) {
        this.flushBridgeUsage(sessionId, bridge);
        await bridge.stop();
      }
      languageMap.clear();
      this.translations.delete(sessionId);
    }
    await this.stopQuestionBridge(sessionId);
    await this.stopHostTranscription(sessionId);
    this.sessions.delete(sessionId);
    this.stopReaperIfIdle();
    console.log(
      `[SessionManager] Removed all bridges and session for ${sessionId}`
    );
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }
}

export default TranslationSessionManager;
