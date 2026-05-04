import { v4 as uuidv4 } from "uuid";
import { InboundEvent, OutboundEvent } from "./events.js";
import { config } from "../config.js";
import { verifyAccessToken } from "../middleware/auth.js";
import {
  createRoomIfAvailable,
  clearReconnectDeadline,
  deleteConnection,
  enqueueGameFinalizationJob,
  getExpiredReconnectDeadlines,
  getConnection,
  getExpiringRooms,
  getRoom,
  mutateRoom,
  popGameFinalizationJob,
  pushGameFinalizationDeadLetter,
  removeRoomFromExpiryIndex,
  setReconnectDeadline,
  setConnection,
  deleteRoom
} from "../services/redis.js";
import { createAttendee, createMeeting, deleteMeeting } from "../services/chime.js";
import { applyMove, startNewGame } from "../services/chess.js";
import { ensureUser, getUser, saveGameAndUpdateStats } from "../services/dynamodb.js";
import {
  emitAppError,
  emitGameEnded,
  emitGamePersistFailed,
  emitGamePersistRetried,
  emitGamePersistSucceeded,
  emitGameStarted,
  emitWsConnectionClosed,
  emitWsConnectionOpened
} from "../services/metrics.js";
import { buildWsError, normalizeWsPayload } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { registerSocket, sendToConnection, unregisterSocket } from "./state.js";
import { forfeitWinnerFromDisconnect, reconnectPauseState, reconnectRestoredState } from "./reconnect.js";
import { normalizeRoomCode, validateInboundEnvelope, validateRoomCodeForEvent } from "./validation.js";

function send(ws, payload) {
  const normalizedPayload =
    payload?.type === OutboundEvent.ERROR
      ? normalizeWsPayload(payload)
      : payload?.code && !payload?.type
        ? buildWsError(payload.code, {
            message: payload.message,
            retryable: payload.retryable,
            context: payload.context
          })
        : payload;
  ws.send(JSON.stringify(normalizedPayload));
}

function broadcastToRoom(room, payload) {
  Object.values(room.participants).forEach((participant) => {
    if (participant.connectionId) {
      sendToConnection(participant.connectionId, payload);
    }
  });
}

function connectedParticipantIds(room) {
  return Object.values(room.participants)
    .filter((participant) => participant.connected)
    .map((participant) => participant.userId);
}

function participantPresence(room) {
  return Object.values(room.participants).map((participant) => ({
    userId: participant.userId,
    connected: Boolean(participant.connected),
    username: participant.username || null,
    displayName: participant.displayName || null
  }));
}

async function resolveParticipantProfile(ws) {
  await ensureUser({
    userId: ws.userId,
    email: ws.email || "",
    username: undefined,
    displayName: undefined
  });
  const profile = await getUser(ws.userId);
  const displayName =
    profile?.display_name ||
    profile?.username ||
    ws.cognitoUsername ||
    ws.userId.slice(0, 12);
  return {
    username: profile?.username || null,
    displayName
  };
}

function activeGameSnapshot(room) {
  if (!room.active_game) {
    return null;
  }
  return {
    gameId: room.active_game.game_id,
    whitePlayerId: room.active_game.white_player_id,
    blackPlayerId: room.active_game.black_player_id,
    fen: room.active_game.board_fen,
    moves: [...room.active_game.moves],
    moveSans: [...(room.active_game.move_sans || [])],
    moveFens: [...(room.active_game.move_fens || ["start"])],
    turn: room.active_game.turn,
    timeWhite: room.active_game.time_white,
    timeBlack: room.active_game.time_black,
    drawOffer: room.active_game.draw_offer || null,
    settings: room.active_game.settings || null,
    takebacksWhiteUsed: room.active_game.takebacks_white_used || 0,
    takebacksBlackUsed: room.active_game.takebacks_black_used || 0,
    disconnectDeadlineMs: room.active_game.disconnect_deadline_ms || null,
    disconnectedUserId: room.active_game.disconnected_user_id || null,
    reconnectVersion: room.active_game.reconnect_version || 0,
    serverTimestampMs: Date.now()
  };
}

function roomJoinedPayload(room, roomCode) {
  return {
    type: OutboundEvent.ROOM_JOINED,
    roomCode,
    hostUserId: room.host_user_id || null,
    participants: participantPresence(room),
    expiresAt: room.expiresAt,
    activeGame: activeGameSnapshot(room)
  };
}

const FINALIZATION_MAX_ATTEMPTS = 5;
const FINALIZATION_BACKOFF_BASE_MS = 250;
const FINALIZATION_IDLE_SLEEP_MS = 500;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseStartSettings(raw, defaultDurationSeconds) {
  const settings = raw && typeof raw === "object" ? raw : {};
  const timeWhiteSeconds = Number(settings.timeWhiteSeconds || defaultDurationSeconds);
  const timeBlackSeconds = Number(settings.timeBlackSeconds || defaultDurationSeconds);
  const allowTakebacks = Boolean(settings.allowTakebacks);
  const takebacksWhite = Math.max(0, Number(settings.takebacksWhite ?? 0));
  const takebacksBlack = Math.max(0, Number(settings.takebacksBlack ?? 0));
  return {
    timeWhiteSeconds: Number.isFinite(timeWhiteSeconds) ? timeWhiteSeconds : defaultDurationSeconds,
    timeBlackSeconds: Number.isFinite(timeBlackSeconds) ? timeBlackSeconds : defaultDurationSeconds,
    allowTakebacks,
    takebacksWhite: Number.isFinite(takebacksWhite) ? takebacksWhite : 0,
    takebacksBlack: Number.isFinite(takebacksBlack) ? takebacksBlack : 0
  };
}

function buildGameRecord(roomCode, game, result, winnerPlayerId, now = Date.now()) {
  return {
    game_id: game.game_id,
    ended_at: new Date(now).toISOString(),
    room_code: roomCode,
    white_player_id: game.white_player_id,
    black_player_id: game.black_player_id,
    winner: winnerPlayerId,
    result: result.reason,
    total_moves: game.moves.length,
    duration_seconds: Math.floor((now - game.started_at) / 1000),
    time_white_remaining: Math.floor(game.time_white),
    time_black_remaining: Math.floor(game.time_black),
    move_list_uci: [...(game.moves || [])],
    move_list_san: [...(game.move_sans || [])],
    fen_history: [...(game.move_fens || ["start"])],
    pgn_notation: result.pgn || "",
    started_at: new Date(game.started_at).toISOString()
  };
}

function resolveWinnerId(game, winner) {
  if (winner === "white") return game.white_player_id;
  if (winner === "black") return game.black_player_id;
  return "draw";
}

function buildEndGameMeta(roomCode, game, result, nextRoom) {
  const winnerPlayerId = resolveWinnerId(game, result.winner);
  const gameRecord = buildGameRecord(roomCode, game, result, winnerPlayerId);
  const reconnectVersion = (game.reconnect_version || 0) + 1;

  nextRoom.games_played.push({
    game_id: game.game_id,
    winner: winnerPlayerId,
    result: result.reason,
    ended_at: Date.now()
  });
  nextRoom.active_game = null;

  return {
    winnerPlayerId,
    gameRecord,
    whitePlayerId: game.white_player_id,
    blackPlayerId: game.black_player_id,
    finalizationJob: buildFinalizationJob({
      roomCode,
      gameRecord,
      whitePlayerId: game.white_player_id,
      blackPlayerId: game.black_player_id,
      winnerPlayerId
    }),
    event: {
      type: OutboundEvent.GAME_ENDED,
      gameId: game.game_id,
      winner: winnerPlayerId,
      result: result.reason,
      pgn: result.pgn || "",
      reconnectVersion
    }
  };
}

export function buildFinalizationJob({ roomCode, gameRecord, whitePlayerId, blackPlayerId, winnerPlayerId }) {
  return {
    gameId: gameRecord.game_id,
    roomCode,
    gameRecord,
    whitePlayerId,
    blackPlayerId,
    winnerPlayerId,
    queuedAt: Date.now()
  };
}

export async function enqueueFinalizationJob(job, deps = {}) {
  const enqueue = deps.enqueue || enqueueGameFinalizationJob;
  const logger = deps.logFn || log;

  await enqueue(job);
  logger("info", "game_finalization_job_enqueued", {
    roomCode: job.roomCode,
    gameId: job.gameId
  });
}

export async function persistFinalizationJob(job, deps = {}) {
  const persist = deps.persist || saveGameAndUpdateStats;
  const emitSucceeded = deps.emitSucceeded || emitGamePersistSucceeded;
  const logger = deps.logFn || log;

  const persisted = await persist(
    job.gameRecord,
    job.whitePlayerId,
    job.blackPlayerId,
    job.winnerPlayerId
  );

  await emitSucceeded();
  logger("info", "game_finalization_persisted", {
    gameId: job.gameId,
    roomCode: job.roomCode,
    duplicate: persisted.duplicate === true
  });
}

export async function processFinalizationJob(job, deps = {}) {
  const persist = deps.persist || persistFinalizationJob;
  const emitRetried = deps.emitRetried || emitGamePersistRetried;
  const emitFailed = deps.emitFailed || emitGamePersistFailed;
  const emitError = deps.emitError || emitAppError;
  const pushDeadLetter = deps.pushDeadLetter || pushGameFinalizationDeadLetter;
  const waitFn = deps.waitFn || wait;
  const logger = deps.logFn || log;
  let lastError = null;

  for (let attempt = 1; attempt <= FINALIZATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      await persist(job);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < FINALIZATION_MAX_ATTEMPTS) {
        await emitRetried();
        const backoffMs = FINALIZATION_BACKOFF_BASE_MS * attempt;
        logger("warn", "game_finalization_retry_scheduled", {
          gameId: job.gameId,
          roomCode: job.roomCode,
          attempt,
          backoffMs,
          error: error.message
        });
        await waitFn(backoffMs);
      }
    }
  }

  await pushDeadLetter({
    ...job,
    failedAt: new Date().toISOString(),
    attempts: FINALIZATION_MAX_ATTEMPTS,
    error: lastError?.message || "unknown_error"
  });
  await emitFailed();
  await emitError();
  logger("error", "game_finalization_deadlettered", {
    gameId: job.gameId,
    roomCode: job.roomCode,
    attempts: FINALIZATION_MAX_ATTEMPTS,
    error: lastError?.message || "unknown_error"
  });
}

function startFinalizationWorker() {
  (async () => {
    // Runs for process lifetime and drains queued game finalization jobs.
    while (true) {
      try {
        const job = await popGameFinalizationJob();
        if (!job) {
          await wait(FINALIZATION_IDLE_SLEEP_MS);
          continue;
        }
        await processFinalizationJob(job);
      } catch (error) {
        log("error", "game_finalization_worker_failed", { error: error.message });
        await emitAppError();
        await wait(FINALIZATION_IDLE_SLEEP_MS);
      }
    }
  })().catch(() => null);
}

async function endGame(roomCode, result) {
  const mutation = await mutateRoom(roomCode, (nextRoom) => {
    if (!nextRoom.active_game) {
      return { error: { code: "NO_ACTIVE_GAME" } };
    }

    const game = nextRoom.active_game;
    const meta = buildEndGameMeta(roomCode, game, result, nextRoom);
    return { room: nextRoom, meta };
  });

  if (!mutation.ok) {
    if (mutation.reason !== "aborted" || mutation.error?.code !== "NO_ACTIVE_GAME") {
      log("warn", "end_game_mutation_failed", { roomCode, reason: mutation.reason, error: mutation.error?.code });
    }
    return;
  }

  const { event, finalizationJob } = mutation.meta;
  await clearReconnectDeadline(roomCode);
  broadcastToRoom(mutation.room, event);
  try {
    await enqueueFinalizationJob(finalizationJob);
  } catch (error) {
    await emitGamePersistFailed();
    await emitAppError();
    log("error", "game_finalization_enqueue_failed", {
      roomCode,
      gameId: finalizationJob.gameId,
      error: error.message
    });
  }
  await emitGameEnded();
}

async function deleteMeetingWithRetry(meetingId, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await deleteMeeting(meetingId);
      return { ok: true };
    } catch (error) {
      lastError = error;
      await wait(100 * attempt);
    }
  }
  return { ok: false, error: lastError };
}

async function beginRoomTerminalState(roomCode) {
  const mutation = await mutateRoom(roomCode, (nextRoom) => {
    if (nextRoom.terminal) {
      return { room: nextRoom, meta: { alreadyTerminal: true, meetingId: nextRoom.chime_meeting?.meetingId || null } };
    }

    nextRoom.terminal = true;
    return {
      room: nextRoom,
      meta: {
        alreadyTerminal: false,
        meetingId: nextRoom.chime_meeting?.meetingId || null
      }
    };
  });

  if (!mutation.ok) {
    return { ok: false, reason: mutation.reason };
  }

  return {
    ok: true,
    alreadyTerminal: mutation.meta.alreadyTerminal,
    meetingId: mutation.meta.meetingId
  };
}

async function finalizeRoomTeardown(roomCode, reason = "teardown") {
  const terminal = await beginRoomTerminalState(roomCode);
  if (!terminal.ok) {
    return;
  }

  await deleteRoom(roomCode);

  if (terminal.meetingId) {
    const meetingResult = await deleteMeetingWithRetry(terminal.meetingId);
    if (!meetingResult.ok) {
      log("error", "room_lifecycle_transition", {
        roomCode,
        transition: "meeting_delete_failed",
        meetingId: terminal.meetingId,
        error: meetingResult.error?.message || "unknown_error"
      });
    }
  }

  log("info", "room_lifecycle_transition", {
    roomCode,
    transition: "room_final_teardown_complete",
    reason
  });
}

async function handleJoinRoom(ws, roomCode) {
  const profile = await resolveParticipantProfile(ws);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await getRoom(roomCode);

    if (!room) {
      const initialRoom = {
        room_code: roomCode,
        host_user_id: ws.userId,
        status: "waiting",
        participants: {
          [ws.userId]: {
            userId: ws.userId,
            username: profile.username,
            displayName: profile.displayName,
            connectionId: ws.connectionId,
            joinedAt: Date.now(),
            connected: true
          }
        },
        created_at: Date.now(),
        expiresAt: Date.now() + config.app.roomTtlSeconds * 1000,
        games_played: [],
        active_game: null,
        terminal: false,
        chime_meeting: null
      };

      const createResult = await createRoomIfAvailable(roomCode, initialRoom);
      if (!createResult.created) {
        continue;
      }

      await setConnection(ws.connectionId, { userId: ws.userId, roomCode });
      log("info", "room_join_transition", {
        roomCode,
        userId: ws.userId,
        transition: "room_created_waiting",
        connectedCount: 1
      });
      send(ws, roomJoinedPayload(initialRoom, roomCode));
      return;
    }

    const joinMutation = await mutateRoom(roomCode, (nextRoom) => {
      if (nextRoom.terminal) {
        return {
          error: { type: OutboundEvent.ERROR, code: "ROOM_TERMINATED", message: "Room is no longer available." }
        };
      }
      const participantIds = Object.keys(nextRoom.participants);
      if (!nextRoom.participants[ws.userId] && participantIds.length >= 2) {
        return {
          error: { type: OutboundEvent.ERROR, code: "ROOM_FULL", message: "Room already has two players." }
        };
      }

      const wasConnected = nextRoom.participants[ws.userId]?.connected;
      nextRoom.participants[ws.userId] = {
        userId: ws.userId,
        username: profile.username,
        displayName: profile.displayName,
        connectionId: ws.connectionId,
        joinedAt: nextRoom.participants[ws.userId]?.joinedAt || Date.now(),
        connected: true
      };
      const connectedCount = connectedParticipantIds(nextRoom).length;
      nextRoom.status = connectedCount === 2 ? "both_connected" : "waiting";

      let reconnectEvent = null;
      if (
        nextRoom.active_game &&
        nextRoom.active_game.disconnect_deadline_ms &&
        !wasConnected &&
        connectedCount === 2
      ) {
        if (
          nextRoom.active_game.disconnected_user_id !== ws.userId ||
          Date.now() > nextRoom.active_game.disconnect_deadline_ms
        ) {
          return {
            error: {
              type: OutboundEvent.ERROR,
              code: "RECONNECT_WINDOW_EXPIRED",
              message: "Reconnect window expired. Create a new room code."
            }
          };
        }
        nextRoom.active_game.reconnect_version = (nextRoom.active_game.reconnect_version || 0) + 1;
        nextRoom.active_game.disconnect_deadline_ms = null;
        nextRoom.active_game.disconnected_user_id = null;
        reconnectEvent = reconnectRestoredState({
          roomCode,
          reconnectVersion: nextRoom.active_game.reconnect_version
        });
      }

      return {
        room: nextRoom,
        meta: {
          reconnectEvent
        }
      };
    });

    if (!joinMutation.ok) {
      if (joinMutation.reason === "aborted" && joinMutation.error) {
        send(ws, joinMutation.error);
        return;
      }
      continue;
    }

    const joinedRoom = joinMutation.room;
    await setConnection(ws.connectionId, { userId: ws.userId, roomCode });
    await clearReconnectDeadline(roomCode);
    const joinedConnectedCount = connectedParticipantIds(joinedRoom).length;
    log("info", "room_join_transition", {
      roomCode,
      userId: ws.userId,
      transition: "participant_joined",
      roomStatus: joinedRoom.status,
      connectedCount: joinedConnectedCount,
      hasMeeting: Boolean(joinedRoom.chime_meeting)
    });

    broadcastToRoom(joinedRoom, {
      type: OutboundEvent.PARTICIPANT_JOINED,
      userId: ws.userId,
      roomCode,
      participants: participantPresence(joinedRoom)
    });

    broadcastToRoom(joinedRoom, roomJoinedPayload(joinedRoom, roomCode));

    if (joinedRoom.active_game) {
      sendToConnection(ws.connectionId, {
        type: OutboundEvent.DRAW_OFFER_STATE,
        roomCode,
        drawOffer: joinedRoom.active_game.draw_offer || null
      });
    }

    if (joinMutation.meta?.reconnectEvent) {
      broadcastToRoom(joinedRoom, joinMutation.meta.reconnectEvent);
      log("info", "reconnect_state_transition", {
        roomCode,
        transition: "restored",
        reconnectVersion: joinMutation.meta.reconnectEvent.reconnectVersion
      });
    }

    if (joinedRoom.status !== "both_connected" || joinedRoom.chime_meeting) {
      return;
    }

    let meeting;
    let attendees;
    const participants = Object.values(joinedRoom.participants);
    try {
      log("info", "video_meeting_transition", {
        roomCode,
        transition: "meeting_create_started",
        participantCount: participants.length
      });
      meeting = await createMeeting(roomCode);
      log("info", "video_meeting_transition", {
        roomCode,
        transition: "meeting_create_succeeded",
        meetingId: meeting.MeetingId
      });
      attendees = await Promise.all(
        participants.map((participant) => createAttendee(meeting.MeetingId, participant.userId))
      );
      log("info", "video_meeting_transition", {
        roomCode,
        transition: "attendees_created",
        attendeeCount: attendees.length,
        meetingId: meeting.MeetingId
      });
    } catch (error) {
      log("error", "video_meeting_transition", {
        roomCode,
        transition: "meeting_or_attendee_creation_failed",
        error: error.message
      });
      send(ws, buildWsError("INTERNAL_ERROR", { message: "Unable to initialize video meeting right now." }));
      return;
    }

    const videoMutation = await mutateRoom(roomCode, (nextRoom) => {
      if (nextRoom.chime_meeting || nextRoom.status !== "both_connected") {
        return { error: { code: "VIDEO_ALREADY_BOUND" } };
      }
      nextRoom.chime_meeting = {
        meetingId: meeting.MeetingId,
        meetingData: meeting
      };
      return { room: nextRoom };
    });

    if (!videoMutation.ok) {
      await deleteMeeting(meeting.MeetingId).catch(() => null);
      log("warn", "video_meeting_transition", {
        roomCode,
        transition: "meeting_deleted_after_bind_conflict",
        meetingId: meeting.MeetingId
      });
      return;
    }

    Object.values(videoMutation.room.participants).forEach((participant) => {
      const attendee = attendees.find((item) => item.ExternalUserId === participant.userId);
      sendToConnection(participant.connectionId, {
        type: OutboundEvent.VIDEO_READY,
        meetingData: meeting,
        attendeeData: attendee
      });
    });
    log("info", "video_meeting_transition", {
      roomCode,
      transition: "video_ready_broadcast",
      meetingId: meeting.MeetingId,
      recipientCount: Object.keys(videoMutation.room.participants).length
    });
    return;
  }

  send(ws, {
    ...buildWsError("ROOM_UPDATE_CONFLICT", { message: "Concurrent room update detected. Please try joining again." }),
    context: { roomCode }
  });
}

async function handleStartGame(ws, roomCode, rawSettings = null) {
  const parsedSettings = parseStartSettings(rawSettings, config.app.gameDurationSeconds);
  const mutation = await mutateRoom(roomCode, (nextRoom) => {
    const players = Object.keys(nextRoom.participants);
    if (players.length !== 2) {
      return {
        error: {
          type: OutboundEvent.ERROR,
          code: "WAITING_FOR_PLAYER",
          message: "Waiting for second player."
        }
      };
    }

    if (nextRoom.active_game) {
      return {
        error: {
          type: OutboundEvent.ERROR,
          code: "GAME_ALREADY_ACTIVE",
          message: "Game already in progress."
        }
      };
    }

    if (nextRoom.host_user_id && nextRoom.host_user_id !== ws.userId) {
      return {
        error: {
          type: OutboundEvent.ERROR,
          code: "UNAUTHORIZED",
          message: "Only the room host can start the game."
        }
      };
    }

    const [whitePlayerId, blackPlayerId] =
      Math.random() < 0.5 ? [players[0], players[1]] : [players[1], players[0]];
    nextRoom.active_game = startNewGame(roomCode, whitePlayerId, blackPlayerId, parsedSettings);

    return {
      room: nextRoom,
      meta: {
        type: OutboundEvent.GAME_STARTED,
        gameId: nextRoom.active_game.game_id,
        whitePlayerId,
        blackPlayerId,
        fen: nextRoom.active_game.board_fen,
        moves: [...nextRoom.active_game.moves],
        moveSans: [...(nextRoom.active_game.move_sans || [])],
        moveFens: [...(nextRoom.active_game.move_fens || ["start"])],
        turn: nextRoom.active_game.turn,
        timeWhite: nextRoom.active_game.time_white,
        timeBlack: nextRoom.active_game.time_black,
        drawOffer: null,
        settings: nextRoom.active_game.settings,
        takebacksWhiteUsed: 0,
        takebacksBlackUsed: 0,
        serverTimestampMs: Date.now()
      }
    };
  });

  if (!mutation.ok) {
    if (mutation.reason === "not_found") {
      send(ws, buildWsError("ROOM_NOT_FOUND", { context: { roomCode } }));
      return;
    }
    if (mutation.reason === "aborted" && mutation.error) {
      send(ws, mutation.error);
      return;
    }
    send(ws, {
      ...buildWsError("ROOM_UPDATE_CONFLICT"),
      context: { roomCode }
    });
    return;
  }

  log("info", "game_transition", {
    roomCode,
    transition: "game_started",
    whitePlayerId: mutation.meta.whitePlayerId,
    blackPlayerId: mutation.meta.blackPlayerId,
    turn: mutation.meta.turn
  });
  broadcastToRoom(mutation.room, mutation.meta);
  await emitGameStarted();
}

async function handleMakeMove(ws, roomCode, move) {
  const mutation = await mutateRoom(roomCode, (nextRoom) => {
    if (!nextRoom.active_game) {
      return {
        error: { type: OutboundEvent.ERROR, code: "NO_ACTIVE_GAME", message: "No active game in this room." }
      };
    }

    const game = nextRoom.active_game;
    if (game.disconnect_deadline_ms) {
      return {
        error: {
          type: OutboundEvent.ERROR,
          code: "GAME_PAUSED",
          message: "Game is paused while waiting for reconnect.",
          retryable: true,
          context: {
            disconnectedUserId: game.disconnected_user_id,
            graceEndsAt: game.disconnect_deadline_ms
          }
        }
      };
    }

    const expectedPlayer = game.turn === "white" ? game.white_player_id : game.black_player_id;
    if (expectedPlayer !== ws.userId) {
      return { error: { type: OutboundEvent.ERROR, code: "NOT_YOUR_TURN", message: "Wait for your turn." } };
    }

    const elapsed = (Date.now() - game.last_move_at) / 1000;
    if (game.turn === "white") {
      game.time_white = Math.max(0, game.time_white - elapsed);
    } else {
      game.time_black = Math.max(0, game.time_black - elapsed);
    }

    const applied = applyMove(game.board_fen, move);
    if (!applied.ok) {
      return { error: { type: OutboundEvent.ERROR, code: "ILLEGAL_MOVE", message: "Illegal move." } };
    }

    game.board_fen = applied.newFen;
    game.moves.push(move);
    game.move_sans = game.move_sans || [];
    game.move_sans.push(applied.san);
    game.move_fens = game.move_fens || ["start"];
    game.move_fens.push(applied.newFen);
    game.turn = game.turn === "white" ? "black" : "white";
    game.last_move_at = Date.now();
    game.clock_history = game.clock_history || [];
    game.clock_history.push({
      time_white: game.time_white,
      time_black: game.time_black,
      turn: game.turn
    });

    const timeoutReached = game.time_white <= 0 || game.time_black <= 0;
    const gameEnded = applied.isCheckmate || applied.isStalemate || applied.isDraw || timeoutReached;

    if (gameEnded) {
      const winner = timeoutReached
        ? game.time_white <= 0 ? "black" : "white"
        : applied.isCheckmate
          ? game.turn === "white" ? "black" : "white"
          : "draw";
      const reason = timeoutReached ? "timeout"
        : applied.isCheckmate ? "checkmate"
        : applied.isStalemate ? "stalemate"
        : "draw";
      const { finalizationJob, event } = buildEndGameMeta(
        roomCode,
        game,
        { winner, reason, pgn: applied.pgn },
        nextRoom
      );
      return { room: nextRoom, meta: { event, finalizationJob } };
    }

    nextRoom.active_game = game;
    return {
      room: nextRoom,
      meta: {
        event: {
          type: OutboundEvent.MOVE_MADE,
          move,
          moveSan: applied.san,
          moveType: applied.moveType,
          isCheck: applied.isCheck,
          moves: [...game.moves],
          moveSans: [...(game.move_sans || [])],
          moveFens: [...(game.move_fens || ["start"])],
          fen: game.board_fen,
          turn: game.turn,
          timeWhite: game.time_white,
          timeBlack: game.time_black,
          drawOffer: game.draw_offer || null,
          takebacksWhiteUsed: game.takebacks_white_used || 0,
          takebacksBlackUsed: game.takebacks_black_used || 0,
          serverTimestampMs: Date.now()
        }
      }
    };
  });

  if (!mutation.ok) {
    if (mutation.reason === "aborted" && mutation.error) {
      send(ws, mutation.error);
      return;
    }
    send(ws, {
      ...buildWsError("ROOM_UPDATE_CONFLICT", { message: "Concurrent room update detected. Please retry your move." }),
      context: { roomCode, move }
    });
    return;
  }

  if (mutation.meta.finalizationJob) {
    try {
      await enqueueFinalizationJob(mutation.meta.finalizationJob);
    } catch (error) {
      await emitGamePersistFailed();
      await emitAppError();
      log("error", "game_finalization_enqueue_failed", {
        roomCode,
        gameId: mutation.meta.finalizationJob.gameId,
        error: error.message
      });
    }
    await emitGameEnded();
  }

  broadcastToRoom(mutation.room, mutation.meta.event);
}

async function handleResign(ws, roomCode) {
  const room = await getRoom(roomCode);
  if (!room?.active_game) {
    return;
  }

  const game = room.active_game;
  const winner = ws.userId === game.white_player_id ? "black" : "white";
  await endGame(roomCode, { winner, reason: "resign", pgn: "" });
}

function playerColor(game, userId) {
  if (game.white_player_id === userId) return "white";
  if (game.black_player_id === userId) return "black";
  return null;
}

async function handleRequestTakeback(ws, roomCode) {
  const mutation = await mutateRoom(roomCode, (nextRoom) => {
    if (!nextRoom.active_game) {
      return {
        error: { type: OutboundEvent.ERROR, code: "NO_ACTIVE_GAME", message: "No active game in this room." }
      };
    }
    const game = nextRoom.active_game;
    if (!game.settings?.allow_takebacks) {
      return {
        error: { type: OutboundEvent.ERROR, code: "TAKEBACK_NOT_ALLOWED", message: "Takebacks are disabled." }
      };
    }
    if (!game.moves?.length) {
      return {
        error: { type: OutboundEvent.ERROR, code: "TAKEBACK_NOT_ALLOWED", message: "No moves to take back." }
      };
    }
    const color = playerColor(game, ws.userId);
    if (!color) {
      return {
        error: { type: OutboundEvent.ERROR, code: "UNAUTHORIZED", message: "Only players in this game can request takeback." }
      };
    }

    const maxTakebacks = color === "white" ? game.settings.takebacks_white_max : game.settings.takebacks_black_max;
    const usedTakebacks = color === "white" ? game.takebacks_white_used : game.takebacks_black_used;
    if (usedTakebacks >= maxTakebacks) {
      return {
        error: { type: OutboundEvent.ERROR, code: "TAKEBACK_LIMIT_REACHED", message: "No takebacks remaining." }
      };
    }

    const lastMoveWasWhite = (game.moves.length % 2) === 1;
    const lastMover = lastMoveWasWhite ? game.white_player_id : game.black_player_id;
    if (lastMover !== ws.userId) {
      return {
        error: {
          type: OutboundEvent.ERROR,
          code: "TAKEBACK_WINDOW_CLOSED",
          message: "Takeback is only allowed before opponent responds."
        }
      };
    }

    const removedMove = game.moves.pop();
    const removedSan = (game.move_sans || []).pop();
    if (game.move_fens?.length > 1) {
      game.move_fens.pop();
    }
    game.board_fen = game.move_fens?.[game.move_fens.length - 1] || "start";
    if (game.clock_history?.length > 1) {
      game.clock_history.pop();
    }
    const previousClock = game.clock_history?.[game.clock_history.length - 1];
    if (previousClock) {
      game.time_white = previousClock.time_white;
      game.time_black = previousClock.time_black;
      game.turn = previousClock.turn;
    } else {
      game.turn = color;
    }
    if (color === "white") {
      game.takebacks_white_used = (game.takebacks_white_used || 0) + 1;
    } else {
      game.takebacks_black_used = (game.takebacks_black_used || 0) + 1;
    }
    game.last_move_at = Date.now();

    return {
      room: nextRoom,
      meta: {
        event: {
          type: OutboundEvent.TAKEBACK_APPLIED,
          roomCode,
          byUserId: ws.userId,
          removedMove: removedMove || null,
          removedSan: removedSan || null,
          fen: game.board_fen,
          moves: [...(game.moves || [])],
          moveSans: [...(game.move_sans || [])],
          moveFens: [...(game.move_fens || ["start"])],
          turn: game.turn,
          timeWhite: game.time_white,
          timeBlack: game.time_black,
          drawOffer: game.draw_offer || null,
          takebacksWhiteUsed: game.takebacks_white_used || 0,
          takebacksBlackUsed: game.takebacks_black_used || 0,
          serverTimestampMs: Date.now()
        }
      }
    };
  });

  if (!mutation.ok) {
    if (mutation.reason === "aborted" && mutation.error) {
      send(ws, mutation.error);
      return;
    }
    send(ws, buildWsError("ROOM_UPDATE_CONFLICT", { context: { roomCode } }));
    return;
  }

  broadcastToRoom(mutation.room, mutation.meta.event);
}

async function handleOfferDraw(ws, roomCode) {
  const mutation = await mutateRoom(roomCode, (nextRoom) => {
    if (!nextRoom.active_game) {
      return {
        error: { type: OutboundEvent.ERROR, code: "NO_ACTIVE_GAME", message: "No active game in this room." }
      };
    }
    const game = nextRoom.active_game;
    if (game.draw_offer) {
      return {
        error: { type: OutboundEvent.ERROR, code: "DRAW_ALREADY_PENDING", message: "Draw offer already pending." }
      };
    }
    game.draw_offer = {
      offered_by_user_id: ws.userId,
      created_at: Date.now()
    };
    return {
      room: nextRoom,
      meta: {
        event: {
          type: OutboundEvent.DRAW_OFFER_PENDING,
          roomCode,
          offeredByUserId: ws.userId
        },
        stateEvent: {
          type: OutboundEvent.DRAW_OFFER_STATE,
          roomCode,
          drawOffer: game.draw_offer
        }
      }
    };
  });

  if (!mutation.ok) {
    if (mutation.reason === "aborted" && mutation.error) {
      send(ws, mutation.error);
      return;
    }
    send(ws, buildWsError("ROOM_UPDATE_CONFLICT", { context: { roomCode } }));
    return;
  }

  broadcastToRoom(mutation.room, mutation.meta.event);
  broadcastToRoom(mutation.room, mutation.meta.stateEvent);
}

async function handleAcceptDraw(ws, roomCode) {
  const room = await getRoom(roomCode);
  if (!room?.active_game?.draw_offer) {
    send(ws, buildWsError("DRAW_NOT_PENDING", { message: "No draw offer pending." }));
    return;
  }
  if (room.active_game.draw_offer.offered_by_user_id === ws.userId) {
    send(ws, buildWsError("DRAW_NOT_PENDING", { message: "You cannot accept your own draw offer." }));
    return;
  }
  broadcastToRoom(room, {
    type: OutboundEvent.DRAW_ACCEPTED,
    roomCode,
    acceptedByUserId: ws.userId
  });
  await endGame(roomCode, { winner: "draw", reason: "draw_agreed", pgn: "" });
}

async function handleLeaveRoom(ws) {
  const connection = await getConnection(ws.connectionId);
  if (!connection) {
    return;
  }

  const room = await getRoom(connection.roomCode);
  if (!room) {
    await deleteConnection(ws.connectionId);
    return;
  }

  const mutation = await mutateRoom(connection.roomCode, (nextRoom) => {
    if (!nextRoom.participants[ws.userId]) {
      return { error: { code: "PARTICIPANT_NOT_FOUND" } };
    }

    nextRoom.participants[ws.userId].connected = false;
    nextRoom.participants[ws.userId].connectionId = null;
    const connectedIds = connectedParticipantIds(nextRoom);
    nextRoom.status = connectedIds.length === 2 ? "both_connected" : "waiting";

    let reconnectEvent = null;
    let reconnectDeadlineMs = null;
    if (
      nextRoom.active_game &&
      connectedIds.length === 1 &&
      !nextRoom.active_game.disconnect_deadline_ms
    ) {
      nextRoom.active_game.reconnect_version = (nextRoom.active_game.reconnect_version || 0) + 1;
      const pauseState = reconnectPauseState({
        roomCode: connection.roomCode,
        disconnectedUserId: ws.userId,
        reconnectGraceSeconds: config.app.reconnectGraceSeconds,
        reconnectVersion: nextRoom.active_game.reconnect_version
      });
      reconnectDeadlineMs = pauseState.reconnectDeadlineMs;
      nextRoom.active_game.disconnect_deadline_ms = reconnectDeadlineMs;
      nextRoom.active_game.disconnected_user_id = ws.userId;
      reconnectEvent = pauseState.event;
    }

    return {
      room: nextRoom,
      meta: {
        reconnectEvent,
        reconnectDeadlineMs,
        shouldTeardown: connectedIds.length === 0 && !nextRoom.active_game
      }
    };
  });

  if (mutation.ok) {
    if (mutation.meta?.reconnectDeadlineMs) {
      await setReconnectDeadline(connection.roomCode, mutation.meta.reconnectDeadlineMs);
    } else {
      await clearReconnectDeadline(connection.roomCode);
    }

    broadcastToRoom(mutation.room, {
      type: OutboundEvent.PARTICIPANT_LEFT,
      userId: ws.userId,
      roomCode: connection.roomCode,
      participants: participantPresence(mutation.room)
    });

    broadcastToRoom(mutation.room, roomJoinedPayload(mutation.room, connection.roomCode));

    if (mutation.meta?.reconnectEvent) {
      broadcastToRoom(mutation.room, mutation.meta.reconnectEvent);
      log("info", "reconnect_state_transition", {
        roomCode: connection.roomCode,
        transition: "paused",
        disconnectedUserId: ws.userId,
        reconnectVersion: mutation.meta.reconnectEvent.reconnectVersion,
        graceEndsAt: mutation.meta.reconnectEvent.graceEndsAt
      });
    }

    if (mutation.meta?.shouldTeardown) {
      await finalizeRoomTeardown(connection.roomCode, "all_participants_disconnected");
    }
  }

  await deleteConnection(ws.connectionId);
}

async function handleRoomExpiry(roomCode) {
  const room = await getRoom(roomCode);
  if (!room) {
    await removeRoomFromExpiryIndex(roomCode);
    return;
  }

  log("info", "room_lifecycle_transition", {
    roomCode,
    transition: "room_expiry_detected",
    hadActiveGame: Boolean(room.active_game)
  });

  if (room.active_game) {
    await endGame(roomCode, { winner: "draw", reason: "room_expired", pgn: "" });
  }
  await finalizeRoomTeardown(roomCode, "room_expired");
}

async function handleReconnectTimeout(roomCode) {
  const room = await getRoom(roomCode);
  if (!room?.active_game || !room.active_game.disconnect_deadline_ms) {
    await clearReconnectDeadline(roomCode);
    return;
  }

  const connectedCount = connectedParticipantIds(room).length;
  if (connectedCount === 2) {
    const staleMutation = await mutateRoom(roomCode, (nextRoom) => {
      if (!nextRoom.active_game) {
        return { room: nextRoom };
      }
      nextRoom.active_game.disconnect_deadline_ms = null;
      nextRoom.active_game.disconnected_user_id = null;
      return { room: nextRoom };
    });
    if (staleMutation.ok) {
      log("info", "reconnect_state_transition", {
        roomCode,
        transition: "stale_deadline_cleared"
      });
    }
    await clearReconnectDeadline(roomCode);
    return;
  }

  if (Date.now() < room.active_game.disconnect_deadline_ms) {
    return;
  }

  const disconnectedUserId = room.active_game.disconnected_user_id;
  if (!disconnectedUserId) {
    await clearReconnectDeadline(roomCode);
    return;
  }

  const winner = forfeitWinnerFromDisconnect(room.active_game, disconnectedUserId);

  log("info", "reconnect_state_transition", {
    roomCode,
    transition: "forfeit_disconnect",
    disconnectedUserId,
    winner
  });
  await endGame(roomCode, { winner, reason: "forfeit_disconnect", pgn: "" });
  await finalizeRoomTeardown(roomCode, "reconnect_timeout");
}

export function installWebSocketServer(wss) {
  startFinalizationWorker();

  wss.on("connection", async (ws, req) => {
    const requestUrl = new URL(req.url, "https://placeholder");
    const token = requestUrl.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Unauthorized");
      return;
    }

    let auth;
    try {
      auth = await verifyAccessToken(token);
    } catch {
      ws.close(4001, "Unauthorized");
      return;
    }

    ws.connectionId = uuidv4();
    ws.sessionId = uuidv4();
    ws.userId = auth.sub;
    ws.cognitoUsername = auth["cognito:username"] || "";
    ws.email = auth.email || "";
    ws.isAlive = true;

    registerSocket(ws.connectionId, ws);
    emitWsConnectionOpened().catch(() => null);

    log("info", "ws_connected", {
      connectionId: ws.connectionId,
      sessionId: ws.sessionId,
      userId: ws.userId
    });

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, buildWsError("BAD_JSON"));
        await emitAppError();
        return;
      }

      try {
        const envelopeValidation = validateInboundEnvelope(message);
        if (!envelopeValidation.ok) {
          send(ws, envelopeValidation.error);
          await emitAppError();
          return;
        }

        const roomValidation = validateRoomCodeForEvent(message);
        if (!roomValidation.ok) {
          send(ws, roomValidation.error);
          await emitAppError();
          return;
        }

        const roomCode = roomValidation.roomCode ?? normalizeRoomCode(message.roomCode);
        switch (message.type) {
          case InboundEvent.JOIN_ROOM:
            await handleJoinRoom(ws, roomCode);
            break;
          case InboundEvent.LEAVE_ROOM:
            await handleLeaveRoom(ws);
            break;
          case InboundEvent.START_GAME:
            await handleStartGame(ws, roomCode, message.settings || null);
            break;
          case InboundEvent.MAKE_MOVE:
            await handleMakeMove(ws, roomCode, message.move);
            break;
          case InboundEvent.RESIGN:
            await handleResign(ws, roomCode);
            break;
          case InboundEvent.REQUEST_TAKEBACK:
            await handleRequestTakeback(ws, roomCode);
            break;
          case InboundEvent.OFFER_DRAW:
            await handleOfferDraw(ws, roomCode);
            break;
          case InboundEvent.ACCEPT_DRAW:
            await handleAcceptDraw(ws, roomCode);
            break;
          case InboundEvent.HEARTBEAT:
            send(ws, { type: OutboundEvent.HEARTBEAT_ACK });
            break;
          default:
            send(ws, buildWsError("UNKNOWN_EVENT", { context: { eventType: message.type } }));
            await emitAppError();
        }
      } catch (error) {
        log("error", "websocket_message_handler_failed", {
          connectionId: ws.connectionId,
          sessionId: ws.sessionId,
          userId: ws.userId,
          error: error.message
        });
        send(ws, buildWsError("INTERNAL_ERROR"));
        await emitAppError();
      }
    });

    ws.on("close", async () => {
      await handleLeaveRoom(ws).catch(() => null);
      unregisterSocket(ws.connectionId);
      emitWsConnectionClosed().catch(() => null);
      log("info", "ws_disconnected", {
        connectionId: ws.connectionId,
        sessionId: ws.sessionId,
        userId: ws.userId
      });
    });
  });

  setInterval(async () => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });

    const expiringRoomCodes = await getExpiringRooms(Date.now() + 60_000);
    const reconnectDeadlineRooms = await getExpiredReconnectDeadlines(Date.now());
    await Promise.all(expiringRoomCodes.map((roomCode) => handleRoomExpiry(roomCode)));
    await Promise.all(reconnectDeadlineRooms.map((roomCode) => handleReconnectTimeout(roomCode)));
  }, config.app.heartbeatIntervalMs);
}
