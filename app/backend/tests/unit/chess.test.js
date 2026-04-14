import test from "node:test";
import assert from "node:assert/strict";
import { applyMove, startNewGame } from "../../src/services/chess.js";

test("startNewGame initializes expected structure", () => {
  const game = startNewGame("AB12CD34", "white", "black", 300);
  assert.equal(game.board_fen, "start");
  assert.equal(game.turn, "white");
  assert.equal(game.time_white, 300);
  assert.equal(game.time_black, 300);
  assert.deepEqual(game.moves, []);
  assert.deepEqual(game.move_sans, []);
});

test("applyMove accepts legal moves and returns SAN/FEN", () => {
  const result = applyMove("start", "e2e4");
  assert.equal(result.ok, true);
  assert.equal(typeof result.newFen, "string");
  assert.equal(result.san, "e4");
  assert.equal(result.moveType, "move");
  assert.equal(result.isCheck, false);
  assert.equal(result.isCheckmate, false);
});

test("applyMove rejects illegal moves", () => {
  const result = applyMove("start", "e2e5");
  assert.equal(result.ok, false);
});

test("applyMove classifies captures", () => {
  const first = applyMove("start", "e2e4");
  assert.equal(first.ok, true);
  const second = applyMove(first.newFen, "d7d5");
  assert.equal(second.ok, true);
  const capture = applyMove(second.newFen, "e4d5");
  assert.equal(capture.ok, true);
  assert.equal(capture.moveType, "capture");
});

test("applyMove classifies kingside and queenside castling", () => {
  const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const kingSide = applyMove(fen, "e1g1");
  assert.equal(kingSide.ok, true);
  assert.equal(kingSide.moveType, "castle");

  const queenSide = applyMove(fen, "e1c1");
  assert.equal(queenSide.ok, true);
  assert.equal(queenSide.moveType, "castle");
});

test("applyMove classifies promotions", () => {
  const fen = "8/P7/8/8/8/8/8/k6K w - - 0 1";
  const promotion = applyMove(fen, "a7a8q");
  assert.equal(promotion.ok, true);
  assert.equal(promotion.moveType, "promotion");
});

test("applyMove sets isCheck when move gives check", () => {
  const fen = "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1";
  const check = applyMove(fen, "e2e7");
  assert.equal(check.ok, true);
  assert.equal(check.isCheck, true);
});
