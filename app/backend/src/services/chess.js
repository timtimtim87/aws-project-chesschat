import { Chess } from "chess.js";

export function startNewGame(roomCode, whitePlayerId, blackPlayerId, options = {}) {
  const whiteSeconds = Number(options.timeWhiteSeconds || options.durationSeconds || 300);
  const blackSeconds = Number(options.timeBlackSeconds || options.durationSeconds || 300);
  const settings = {
    allow_takebacks: Boolean(options.allowTakebacks),
    takebacks_white_max: Number.isFinite(options.takebacksWhite) ? Number(options.takebacksWhite) : 0,
    takebacks_black_max: Number.isFinite(options.takebacksBlack) ? Number(options.takebacksBlack) : 0,
    initial_time_white: whiteSeconds,
    initial_time_black: blackSeconds
  };
  return {
    game_id: `${roomCode}-${Date.now()}`,
    board_fen: "start",
    moves: [],
    move_sans: [],
    move_fens: ["start"],
    clock_history: [{ time_white: whiteSeconds, time_black: blackSeconds, turn: "white" }],
    white_player_id: whitePlayerId,
    black_player_id: blackPlayerId,
    turn: "white",
    time_white: whiteSeconds,
    time_black: blackSeconds,
    started_at: Date.now(),
    last_move_at: Date.now(),
    reconnect_version: 0,
    disconnect_deadline_ms: null,
    disconnected_user_id: null,
    draw_offer: null,
    takebacks_white_used: 0,
    takebacks_black_used: 0,
    settings
  };
}

export function applyMove(fen, move) {
  const chess = new Chess(fen === "start" ? undefined : fen);
  let applied = null;
  try {
    applied = chess.move(move);
  } catch {
    return { ok: false };
  }

  if (!applied) {
    return { ok: false };
  }

  const isPromotion = Boolean(applied.promotion);
  const isCastle = applied.flags?.includes("k") || applied.flags?.includes("q");
  const isCapture = Boolean(applied.captured);
  const moveType = isPromotion ? "promotion" : isCastle ? "castle" : isCapture ? "capture" : "move";

  return {
    ok: true,
    newFen: chess.fen(),
    san: applied.san,
    moveType,
    isCheck: chess.inCheck(),
    pgn: chess.pgn(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw()
  };
}
