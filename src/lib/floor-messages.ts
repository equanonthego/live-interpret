// 강의자↔청자 발언권 신호 (LiveKit data, topic "floor")
export const FLOOR_TOPIC = "floor";

export type FloorMessage =
  | { type: "raise-hand"; identity: string; name?: string; language: string }
  | { type: "lower-hand"; identity: string }
  | { type: "grant"; identity: string } // 이 청자에게 발언권 부여
  | { type: "revoke"; identity: string }; // 발언권 회수
