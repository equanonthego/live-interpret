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
import { SOURCE_LANGUAGE } from "./interpret-config";
import type { PresentationContext } from "./glossary-extractor";

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
      allowedLanguages,
      geminiApiKey,
      presentationContext,
      presentationFile,
      handRaised: [],
    };
    this.sessions.set(sessionId, info);
    console.log(`[SessionManager] Created session ${sessionId} for organizer ${organizerIdentity} with allowed languages: ${allowedLanguages?.join(", ") || "all"}`);
    return info;
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
    // ids. This must hold regardless of what DEFAULT_INTERPRET_LANGUAGES or a
    // session's allowedLanguages happen to contain.
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
        await bridge.stop();
      }
      languageMap.clear();
      this.translations.delete(sessionId);
    }
    await this.stopQuestionBridge(sessionId);
    await this.stopHostTranscription(sessionId);
    this.sessions.delete(sessionId);
    console.log(
      `[SessionManager] Removed all bridges and session for ${sessionId}`
    );
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }
}

export default TranslationSessionManager;
