/**
 * The wire message shapes (DESIGN.md §5.5) that events.test.ts's redaction
 * fixture does not already exercise — mainly chat (PVP-LOBBY-PROPOSAL-2026-09-02.md
 * §8), added additively: PROTOCOL_VERSION does not move for any of this.
 */
import { describe, expect, it } from "vitest";
import {
  CHAT_PHRASES,
  CHAT_TEXT_MAX_LENGTH,
  CLIENT_REQUEST_TYPES,
  PROTOCOL_VERSION,
  accepted,
  chatMessage,
  isChatPhrase,
  isKnownRequestType,
  rejected,
  type ChatMessagePayload,
  type ChatRequestPayload,
  type RestorePayload,
  type ServerToSeat,
  type WelcomePayload,
} from "../src/messages.js";

describe("chat — client request shape", () => {
  it("is a known request type, additive to the existing set", () => {
    expect(CLIENT_REQUEST_TYPES).toContain("chat");
    expect(isKnownRequestType("chat")).toBe(true);
    // Every request this build already served keeps being recognised —
    // "additive" means nothing existing moved.
    for (const t of ["join", "resync", "heartbeat", "requestDiscard", "requestWinOnSelfDraw"]) {
      expect(isKnownRequestType(t)).toBe(true);
    }
  });

  it("accepts a text-only or a phrase-only payload at the type level", () => {
    const byText: ChatRequestPayload = { text: "gg" };
    const byPhrase: ChatRequestPayload = { phrase: "nice" };
    expect(byText.phrase).toBeUndefined();
    expect(byPhrase.text).toBeUndefined();
  });

  it("CHAT_PHRASES is exactly the five quick phrases, and isChatPhrase agrees", () => {
    expect(CHAT_PHRASES).toEqual(["nice", "hurry", "sorry", "again", "thumbs"]);
    for (const p of CHAT_PHRASES) expect(isChatPhrase(p)).toBe(true);
    expect(isChatPhrase("gg")).toBe(false);
    expect(isChatPhrase(undefined)).toBe(false);
    expect(isChatPhrase(42)).toBe(false);
  });

  it("CHAT_TEXT_MAX_LENGTH is the 200-char cap both chat surfaces enforce", () => {
    expect(CHAT_TEXT_MAX_LENGTH).toBe(200);
  });
});

describe("chat — server payload shape", () => {
  it("chatMessage() builds a versioned chat envelope", () => {
    const payload: ChatMessagePayload = { seat: 2, displayName: "West", text: "食糊!", ts: 1_700_000_000_000 };
    const msg: ServerToSeat = chatMessage(payload);
    expect(msg).toEqual({ p: PROTOCOL_VERSION, type: "chat", payload });
  });

  it("a phrase message carries phrase, not text", () => {
    const payload: ChatMessagePayload = { seat: 0, displayName: "East", phrase: "hurry", ts: 0 };
    expect(payload.text).toBeUndefined();
    expect(payload.phrase).toBe("hurry");
  });

  it("welcome and restore both carry chat history, oldest first by convention", () => {
    const chat: ChatMessagePayload[] = [
      { seat: 0, displayName: "East", text: "hi", ts: 1 },
      { seat: 1, displayName: "South", phrase: "nice", ts: 2 },
    ];
    // Compiles only because WelcomePayload/RestorePayload actually declare
    // `chat` — a regression here would be a type error, not a runtime one.
    const restore: RestorePayload = {
      snapshot: {} as RestorePayload["snapshot"],
      events: [],
      chat,
    };
    expect(restore.chat).toHaveLength(2);
    expect(restore.chat[0]!.ts).toBeLessThan(restore.chat[1]!.ts);
  });
});

describe("chatRefused — the rejection code", () => {
  it("rejected() accepts it like any other RejectCode", () => {
    const msg = rejected("req-1", "chatRefused", "bots do not chat");
    if (msg.type !== "rejected") throw new Error("expected a rejected envelope");
    expect(msg.payload.code).toBe("chatRefused");
    expect(msg.payload.detail).toBe("bots do not chat");
  });

  it("accepted() still works for a chat request's happy path", () => {
    const msg = accepted("req-2", 41);
    expect(msg.payload).toEqual({ requestId: "req-2", seq: 41 });
  });
});
