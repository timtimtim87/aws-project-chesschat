import { describe, expect, it } from "vitest";
import { resolveMoveSoundKey, resolveResultSoundKey, shouldPlayErrorSound } from "./gameSounds";

describe("gameSounds", () => {
  it("maps move event sounds with check priority", () => {
    expect(resolveMoveSoundKey({ moveType: "move", isCheck: false })).toBe("move");
    expect(resolveMoveSoundKey({ moveType: "capture", isCheck: false })).toBe("capture");
    expect(resolveMoveSoundKey({ moveType: "castle", isCheck: false })).toBe("castle");
    expect(resolveMoveSoundKey({ moveType: "promotion", isCheck: false })).toBe("promotion");
    expect(resolveMoveSoundKey({ moveType: "capture", isCheck: true })).toBe("check");
  });

  it("maps game end sounds", () => {
    expect(resolveResultSoundKey({ winner: "user-1", result: "checkmate" })).toBe("win");
    expect(resolveResultSoundKey({ winner: "draw", result: "stalemate" })).toBe("draw");
    expect(resolveResultSoundKey({ winner: "draw", result: "draw_agreed" })).toBe("draw");
  });

  it("limits error sounds to blocking gameplay errors", () => {
    expect(shouldPlayErrorSound({ code: "ILLEGAL_MOVE", retryable: false })).toBe(true);
    expect(shouldPlayErrorSound({ code: "SOCKET_RECONNECTING", retryable: true })).toBe(false);
    expect(shouldPlayErrorSound({ code: "INTERNAL_ERROR", retryable: false })).toBe(false);
  });
});
