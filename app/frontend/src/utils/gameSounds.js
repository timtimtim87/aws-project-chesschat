const DRAW_RESULTS = new Set(["stalemate", "draw", "draw_agreed", "insufficient_material", "threefold_repetition"]);

const BLOCKING_GAMEPLAY_ERROR_CODES = new Set([
  "ILLEGAL_MOVE",
  "NOT_YOUR_TURN",
  "NO_ACTIVE_GAME",
  "DRAW_ALREADY_PENDING",
  "DRAW_NOT_PENDING",
  "TAKEBACK_NOT_ALLOWED",
  "TAKEBACK_LIMIT_REACHED"
]);

export function resolveMoveSoundKey(payload) {
  if (payload?.isCheck) {
    return "check";
  }
  if (payload?.moveType === "capture") {
    return "capture";
  }
  if (payload?.moveType === "castle") {
    return "castle";
  }
  if (payload?.moveType === "promotion") {
    return "promotion";
  }
  return "move";
}

export function resolveResultSoundKey(payload) {
  if (payload?.winner === "draw" || DRAW_RESULTS.has(payload?.result)) {
    return "draw";
  }
  return "win";
}

export function shouldPlayErrorSound(error) {
  if (!error || error.retryable) {
    return false;
  }
  return BLOCKING_GAMEPLAY_ERROR_CODES.has(error.code);
}
