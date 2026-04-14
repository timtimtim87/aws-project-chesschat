import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ChessBoardPanel from "../components/ChessBoardPanel";
import VideoPanel from "../components/VideoPanel";
import { useAuth } from "../context/AuthContext";
import { useAppSocket } from "../context/AppSocketContext";
import { createMeetingSession, listDevices, startMedia, stopMedia } from "../services/chime";
import { appStateReducer, initialAppState } from "../state/appState";
import { resolveMoveSoundKey, resolveResultSoundKey, shouldPlayErrorSound } from "../utils/gameSounds";
import { isValidRoomCode } from "../utils/roomCode";

const LAST_ROOM_CODE_KEY = "chesschat_last_room_code";
const SOUND_ENABLED_KEY = "chesschat_sound_enabled";
const SOUND_FILE_BY_KEY = {
  move: "/sounds/chesschat/move.ogg",
  capture: "/sounds/chesschat/capture.ogg",
  castle: "/sounds/chesschat/castle.ogg",
  promotion: "/sounds/chesschat/promotion.ogg",
  check: "/sounds/chesschat/check.ogg",
  win: "/sounds/chesschat/win.ogg",
  draw: "/sounds/chesschat/draw.ogg",
  error: "/sounds/chesschat/error.ogg"
};

function roomDebug(message, context = {}) {
  console.info("[room-debug]", message, context);
}

function normalizeError(payload) {
  return {
    code: payload?.code || "INTERNAL_ERROR",
    message: payload?.message || "Unexpected error.",
    retryable: Boolean(payload?.retryable),
    context: payload?.context || null
  };
}

function normalizeParticipants(participants) {
  return (participants || []).map((participant) => ({
    userId: participant.userId || participant,
    connected: typeof participant.connected === "boolean" ? participant.connected : true,
    username: participant.username || null,
    displayName: participant.displayName || null
  }));
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatPlayerName(playerId, currentUserId) {
  if (!playerId) {
    return "Waiting...";
  }
  if (playerId === currentUserId) {
    return "You";
  }
  if (playerId.length <= 10) {
    return playerId;
  }
  return `${playerId.slice(0, 6)}...${playerId.slice(-4)}`;
}

function displayNameFromParticipant(participant, fallbackPlayerId, currentUserId) {
  if (!fallbackPlayerId) {
    return "Waiting...";
  }
  if (fallbackPlayerId === currentUserId) {
    return "You";
  }
  return participant?.displayName || participant?.username || formatPlayerName(fallbackPlayerId, currentUserId);
}

export default function RoomPage() {
  const { code } = useParams();
  const roomCode = useMemo(() => (code || "").toUpperCase(), [code]);
  const { accessToken, user } = useAuth();
  const { socketState, send, subscribe } = useAppSocket();
  const navigate = useNavigate();

  const [state, dispatch] = useReducer(appStateReducer, {
    ...initialAppState,
    room_state: {
      ...initialAppState.room_state,
      code: roomCode
    }
  });

  const meetingSessionRef = useRef(null);
  const observerRef = useRef(null);
  const audioElementRef = useRef(null);
  const localTileIdRef = useRef(null);
  const remoteTileIdRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const reconnectVersionRef = useRef(0);
  const autoJoinMeetingIdRef = useRef(null);
  const soundPlayersRef = useRef({});
  const [clockNowMs, setClockNowMs] = useState(Date.now());
  const [confirmResignOpen, setConfirmResignOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem(SOUND_ENABLED_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const soundEnabledRef = useRef(soundEnabled);
  const [gameSettings, setGameSettings] = useState({
    timeWhiteSeconds: 300,
    timeBlackSeconds: 300,
    allowTakebacks: true,
    takebacksWhite: 2,
    takebacksBlack: 2
  });
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));

  useEffect(() => {
    if (isValidRoomCode(roomCode)) {
      sessionStorage.setItem(LAST_ROOM_CODE_KEY, roomCode);
    }
  }, [roomCode]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    const players = {};
    for (const [key, file] of Object.entries(SOUND_FILE_BY_KEY)) {
      const audio = new Audio(file);
      audio.preload = "auto";
      audio.volume = key === "win" ? 0.62 : 0.72;
      players[key] = audio;
    }
    soundPlayersRef.current = players;
    return () => {
      for (const player of Object.values(players)) {
        player.pause();
      }
      soundPlayersRef.current = {};
    };
  }, []);

  function playSound(key) {
    if (!soundEnabledRef.current) {
      return;
    }
    const player = soundPlayersRef.current[key];
    if (!player) {
      return;
    }
    player.currentTime = 0;
    try {
      const result = player.play();
      if (result?.catch) {
        result.catch(() => null);
      }
    } catch {
      // Ignore browser/media API playback exceptions.
    }
  }

  function toggleSoundEnabled() {
    setSoundEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SOUND_ENABLED_KEY, String(next));
      } catch {
        // Ignore localStorage failures to keep UI responsive.
      }
      return next;
    });
  }

  function stopMeetingSession() {
    const session = meetingSessionRef.current;
    if (!session) {
      return;
    }

    if (observerRef.current) {
      session.audioVideo.removeObserver(observerRef.current);
      observerRef.current = null;
    }
    if (localTileIdRef.current) {
      session.audioVideo.unbindVideoElement(localTileIdRef.current);
      localTileIdRef.current = null;
    }
    if (remoteTileIdRef.current) {
      session.audioVideo.unbindVideoElement(remoteTileIdRef.current);
      remoteTileIdRef.current = null;
    }
    stopMedia(session.audioVideo);
    remoteTileIdRef.current = null;
    meetingSessionRef.current = null;
    dispatch({ type: "MEDIA_STOPPED" });
    roomDebug("media_stopped");
  }

  useEffect(() => {
    if (state.toast_error) {
      const timer = setTimeout(() => {
        dispatch({ type: "CLEAR_TOAST_ERROR" });
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [state.toast_error]);

  useEffect(() => {
    const timer = setInterval(() => {
      setClockNowMs(Date.now());
    }, 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function onResize() {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    audioElementRef.current = new Audio();
    audioElementRef.current.autoplay = true;

    dispatch({ type: "INIT_AUTH", isAuthenticated: Boolean(accessToken), userId: user?.sub });

    if (!accessToken) {
      navigate("/", { replace: true });
      return;
    }

    dispatch({ type: "ROOM_INIT", roomCode });
  }, [accessToken, navigate, roomCode, user?.sub]);

  useEffect(() => {
    const unsubscribe = subscribe((payload) => {
        switch (payload.type) {
          case "room_joined":
            roomDebug("event_room_joined", {
              roomCode: payload.roomCode,
              participants: payload.participants?.length || 0,
              hasActiveGame: Boolean(payload.activeGame)
            });
            reconnectVersionRef.current = payload.activeGame?.reconnectVersion || reconnectVersionRef.current;
            dispatch({
              type: "ROOM_JOINED",
              hostUserId: payload.hostUserId || null,
              participants: normalizeParticipants(payload.participants),
              activeGame: payload.activeGame || null
            });
            break;
          case "participant_joined":
            roomDebug("event_participant_joined", { participants: payload.participants?.length || 0 });
            dispatch({ type: "PARTICIPANT_JOINED", participants: normalizeParticipants(payload.participants) });
            break;
          case "participant_left":
            roomDebug("event_participant_left", { participants: payload.participants?.length || 0 });
            dispatch({ type: "PARTICIPANT_LEFT", participants: normalizeParticipants(payload.participants) });
            break;
          case "reconnect_state":
            if (
              typeof payload.reconnectVersion === "number" &&
              payload.reconnectVersion < reconnectVersionRef.current
            ) {
              return;
            }
            reconnectVersionRef.current =
              typeof payload.reconnectVersion === "number" ? payload.reconnectVersion : reconnectVersionRef.current;
            dispatch({
              type: "RECONNECT_STATE",
              status: payload.status,
              disconnectedUserId: payload.disconnectedUserId,
              graceEndsAt: payload.graceEndsAt,
              reconnectVersion: payload.reconnectVersion
            });
            if (payload.status === "paused") {
              dispatch({
                type: "SET_TOAST_ERROR",
                error: {
                  code: "GAME_PAUSED",
                  message: "Opponent disconnected. Waiting for reconnect.",
                  retryable: true,
                  context: {
                    disconnectedUserId: payload.disconnectedUserId,
                    graceEndsAt: payload.graceEndsAt
                  }
                }
              });
            }
            if (payload.status === "restored") {
              dispatch({ type: "CLEAR_TOAST_ERROR" });
              dispatch({
                type: "SET_TOAST_ERROR",
                error: {
                  code: "RECONNECT_RESTORED",
                  message: "Opponent reconnected. Game resumed.",
                  retryable: false,
                  context: null
                }
              });
            }
            break;
          case "video_ready":
            roomDebug("event_video_ready", {
              meetingId: payload.meetingData?.MeetingId || payload.meetingData?.meetingId
            });
            dispatch({
              type: "VIDEO_READY",
              credentials: {
                meetingData: payload.meetingData,
                attendeeData: payload.attendeeData
              }
            });
            dispatch({ type: "CLEAR_TOAST_ERROR" });
            break;
          case "game_started":
            roomDebug("event_game_started", {
              gameId: payload.gameId,
              whitePlayerId: payload.whitePlayerId,
              blackPlayerId: payload.blackPlayerId,
              turn: payload.turn
            });
            reconnectVersionRef.current += 1;
            dispatch({
              type: "GAME_STARTED",
              game: {
                gameId: payload.gameId,
                whitePlayerId: payload.whitePlayerId,
                blackPlayerId: payload.blackPlayerId,
                fen: payload.fen,
                moves: payload.moves || [],
                moveSans: payload.moveSans || [],
                moveFens: payload.moveFens || ["start"],
                turn: payload.turn,
                timeWhite: payload.timeWhite,
                timeBlack: payload.timeBlack,
                drawOffer: payload.drawOffer || null,
                settings: payload.settings || null,
                takebacksWhiteUsed: payload.takebacksWhiteUsed || 0,
                takebacksBlackUsed: payload.takebacksBlackUsed || 0,
                serverTimestampMs: payload.serverTimestampMs || Date.now()
              }
            });
            dispatch({ type: "CLEAR_TOAST_ERROR" });
            break;
          case "move_made":
            roomDebug("event_move_made", {
              move: payload.move || null,
              turn: payload.turn
            });
            playSound(resolveMoveSoundKey(payload));
            dispatch({
              type: "MOVE_MADE",
              fen: payload.fen,
              moves: payload.moves,
              moveSans: payload.moveSans,
              moveFens: payload.moveFens,
              turn: payload.turn,
              timeWhite: payload.timeWhite,
              timeBlack: payload.timeBlack,
              drawOffer: payload.drawOffer,
              takebacksWhiteUsed: payload.takebacksWhiteUsed,
              takebacksBlackUsed: payload.takebacksBlackUsed,
              serverTimestampMs: payload.serverTimestampMs
            });
            break;
          case "takeback_applied":
            dispatch({
              type: "TAKEBACK_APPLIED",
              fen: payload.fen,
              moves: payload.moves,
              moveSans: payload.moveSans,
              moveFens: payload.moveFens,
              turn: payload.turn,
              timeWhite: payload.timeWhite,
              timeBlack: payload.timeBlack,
              drawOffer: payload.drawOffer,
              takebacksWhiteUsed: payload.takebacksWhiteUsed,
              takebacksBlackUsed: payload.takebacksBlackUsed,
              serverTimestampMs: payload.serverTimestampMs
            });
            break;
          case "draw_offer_pending":
            dispatch({
              type: "DRAW_OFFER_STATE",
              drawOffer: {
                offeredByUserId: payload.offeredByUserId
              }
            });
            break;
          case "draw_offer_state":
            dispatch({
              type: "DRAW_OFFER_STATE",
              drawOffer: payload.drawOffer
                ? {
                    offeredByUserId: payload.drawOffer.offered_by_user_id || payload.drawOffer.offeredByUserId
                  }
                : null
            });
            break;
          case "game_ended":
            reconnectVersionRef.current += 1;
            playSound(resolveResultSoundKey(payload));
            dispatch({
              type: "GAME_ENDED",
              result: {
                gameId: payload.gameId,
                winner: payload.winner,
                result: payload.result,
                pgn: payload.pgn
              }
            });
            dispatch({
              type: "SET_TOAST_ERROR",
              error: {
                code: "GAME_ENDED",
                message: `Game ended: ${payload.result}`,
                retryable: false,
                context: { gameId: payload.gameId }
              }
            });
            break;
          case "error": {
            const normalized = normalizeError(payload);
            roomDebug("event_error", {
              code: normalized.code,
              message: normalized.message,
              retryable: normalized.retryable
            });
            if (shouldPlayErrorSound(normalized)) {
              playSound("error");
            }
            if (normalized.retryable) {
              dispatch({ type: "SET_TOAST_ERROR", error: normalized });
            } else {
              dispatch({ type: "SET_BLOCKING_ERROR", error: normalized });
            }
            break;
          }
          default:
            break;
        }
    });
    return unsubscribe;
  }, [subscribe, roomCode]);

  useEffect(() => {
    roomDebug("socket_state", socketState);
    dispatch({
      type: "SOCKET_STATE",
      status: socketState.status,
      reconnectAttempt: socketState.reconnectAttempt,
      retryInMs: socketState.retryInMs
    });

    if (socketState.status === "reconnecting") {
      dispatch({
        type: "SET_TOAST_ERROR",
        error: {
          code: "SOCKET_RECONNECTING",
          message: "Connection lost. Reconnecting...",
          retryable: true,
          context: { roomCode }
        }
      });
    }
    if (socketState.status === "connected") {
      dispatch({ type: "CLEAR_BLOCKING_ERROR" });
    }
  }, [socketState, roomCode]);

  useEffect(() => {
    if (!accessToken || socketState.status !== "connected") {
      return;
    }
    roomDebug("socket_join_room", { roomCode, connectionSerial: socketState.connectionSerial });
    send("join_room", { roomCode });
  }, [accessToken, roomCode, send, socketState.connectionSerial, socketState.status]);

  useEffect(() => {
    return () => {
      send("leave_room", { roomCode });
      stopMeetingSession();
    };
  }, [roomCode, send]);

  const game = state.game_state.game;
  const myColor = game
    ? game.whitePlayerId === user?.sub
      ? "white"
      : "black"
    : "white";

  const isMyTurn = game
    ? (game.turn === "white" && game.whitePlayerId === user?.sub) ||
      (game.turn === "black" && game.blackPlayerId === user?.sub)
    : false;

  const connectedPlayers = state.room_state.participants.filter((participant) => participant.connected).length;
  const isHost = !state.room_state.hostUserId || state.room_state.hostUserId === user?.sub;
  const drawOfferBy = game?.drawOffer?.offeredByUserId || game?.drawOffer?.offered_by_user_id || null;
  const drawOfferPending = Boolean(drawOfferBy);
  const myUsedTakebacks = myColor === "white" ? game?.takebacksWhiteUsed || 0 : game?.takebacksBlackUsed || 0;
  const myMaxTakebacks =
    myColor === "white" ? game?.settings?.takebacks_white_max || 0 : game?.settings?.takebacks_black_max || 0;
  const canRequestTakeback =
    Boolean(game) &&
    Boolean(game.settings?.allow_takebacks) &&
    myUsedTakebacks < myMaxTakebacks &&
    !isMyTurn;
  const canOfferDraw = Boolean(game) && !drawOfferPending;
  const canAcceptDraw = Boolean(game) && drawOfferPending && drawOfferBy !== user?.sub;
  const canStartGame = !game && connectedPlayers >= 2 && state.media_state.started && isHost;

  function startGame() {
    setSettingsModalOpen(true);
  }

  function confirmStartGame() {
    roomDebug("action_start_game", { roomCode, settings: gameSettings });
    send("start_game", { roomCode, settings: gameSettings });
    setSettingsModalOpen(false);
  }

  function resign() {
    setConfirmResignOpen(true);
  }

  function confirmResign() {
    setConfirmResignOpen(false);
    send("resign", { roomCode });
  }

  function onMove(move) {
    roomDebug("action_make_move", {
      roomCode,
      move,
      gameActive: Boolean(game),
      isMyTurn
    });
    send("make_move", { roomCode, move });
  }

  function requestTakeback() {
    send("request_takeback", { roomCode });
  }

  function offerDraw() {
    send("offer_draw", { roomCode });
  }

  function acceptDraw() {
    send("accept_draw", { roomCode });
  }

  async function joinMedia() {
    const videoCredentials = state.media_state.credentials;
    if (!videoCredentials || meetingSessionRef.current) {
      return;
    }

    try {
      dispatch({ type: "CLEAR_BLOCKING_ERROR" });
      dispatch({ type: "MEDIA_CONNECTING" });

      const session = createMeetingSession({
        meetingData: videoCredentials.meetingData,
        attendeeData: videoCredentials.attendeeData
      });
      const audioVideo = session.audioVideo;
      meetingSessionRef.current = session;

      const observer = {
        videoTileDidUpdate: (tileState) => {
          roomDebug("media_video_tile_update", {
            tileId: tileState.tileId,
            localTile: Boolean(tileState.localTile),
            boundAttendeeId: tileState.boundAttendeeId || null
          });
          if (!tileState.boundAttendeeId || !tileState.tileId) {
            return;
          }

          if (tileState.localTile) {
            localTileIdRef.current = tileState.tileId;
            if (localVideoRef.current) {
              audioVideo.bindVideoElement(tileState.tileId, localVideoRef.current);
            }
            return;
          }

          const remoteTileId = remoteTileIdRef.current;
          if (!remoteTileId || remoteTileId === tileState.tileId) {
            remoteTileIdRef.current = tileState.tileId;
            if (remoteVideoRef.current) {
              audioVideo.bindVideoElement(tileState.tileId, remoteVideoRef.current);
            }
            dispatch({ type: "MEDIA_STARTED", message: "Media connected." });
          }
        },
        videoTileWasRemoved: (tileId) => {
          roomDebug("media_video_tile_removed", { tileId });
          if (localTileIdRef.current === tileId) {
            localTileIdRef.current = null;
          }
          if (remoteTileIdRef.current === tileId) {
            audioVideo.unbindVideoElement(tileId);
            remoteTileIdRef.current = null;
            dispatch({ type: "MEDIA_STARTED", message: "Connected. Waiting for remote video..." });
          }
        },
        audioVideoDidStop: (sessionStatus) => {
          roomDebug("media_audio_video_stopped", { statusCode: sessionStatus.statusCode() });
          dispatch({
            type: "SET_BLOCKING_ERROR",
            error: {
              code: "MEDIA_STOPPED",
              message: `Media stopped: ${sessionStatus.statusCode()}`,
              retryable: true,
              context: null
            }
          });
        }
      };
      observerRef.current = observer;
      audioVideo.addObserver(observer);
      audioVideo.bindAudioElement(audioElementRef.current);

      const devices = await listDevices(audioVideo);
      const audioInputDeviceId = devices.audioInputs[0]?.deviceId;
      const videoInputDeviceId = devices.videoInputs[0]?.deviceId;

      if (!audioInputDeviceId || !videoInputDeviceId) {
        throw new Error("No camera/microphone device detected.");
      }

      await startMedia(audioVideo, { audioInputDeviceId, videoInputDeviceId });
      dispatch({ type: "MEDIA_STARTED", message: "Connected. Waiting for remote video..." });
      roomDebug("media_started", {
        audioInputDeviceId: Boolean(audioInputDeviceId),
        videoInputDeviceId: Boolean(videoInputDeviceId)
      });
    } catch (error) {
      roomDebug("media_start_failed", { message: error.message || "unknown" });
      stopMeetingSession();
      dispatch({
        type: "SET_BLOCKING_ERROR",
        error: {
          code: "MEDIA_START_FAILED",
          message: error.message || "Unable to start media.",
          retryable: true,
          context: { roomCode }
        }
      });
    }
  }

  useEffect(() => {
    const meetingId = state.media_state.credentials?.meetingData?.MeetingId;
    if (!meetingId) {
      autoJoinMeetingIdRef.current = null;
      return;
    }
    if (autoJoinMeetingIdRef.current === meetingId) {
      return;
    }
    if (meetingSessionRef.current || state.media_state.started) {
      return;
    }

    autoJoinMeetingIdRef.current = meetingId;
    joinMedia().catch(() => null);
  }, [state.media_state.credentials, state.media_state.started]);

  function toggleMic() {
    const session = meetingSessionRef.current;
    if (!session) {
      return;
    }
    if (state.media_state.micMuted) {
      session.audioVideo.realtimeUnmuteLocalAudio();
      dispatch({ type: "MEDIA_MIC_TOGGLED", micMuted: false });
      return;
    }
    session.audioVideo.realtimeMuteLocalAudio();
    dispatch({ type: "MEDIA_MIC_TOGGLED", micMuted: true });
  }

  function toggleCamera() {
    const session = meetingSessionRef.current;
    if (!session) {
      return;
    }
    if (state.media_state.cameraOn) {
      session.audioVideo.stopLocalVideoTile();
      dispatch({ type: "MEDIA_CAMERA_TOGGLED", cameraOn: false });
      return;
    }
    session.audioVideo.startLocalVideoTile();
    dispatch({ type: "MEDIA_CAMERA_TOGGLED", cameraOn: true });
  }

  const socketSubtitle =
    state.socket_state.status === "reconnecting"
      ? `Reconnecting (attempt ${state.socket_state.reconnectAttempt})...`
      : `Socket ${state.socket_state.status}`;

  const reconnectLabel =
    state.room_state.reconnect.status === "paused"
      ? `Paused: waiting for ${state.room_state.reconnect.disconnectedUserId} until ${new Date(
          state.room_state.reconnect.graceEndsAt
        ).toLocaleTimeString()}`
      : null;

  const derivedClocks = useMemo(() => {
    if (!game) {
      return { white: 0, black: 0 };
    }

    const paused = state.room_state.reconnect.status === "paused";
    if (paused) {
      return { white: game.timeWhite, black: game.timeBlack };
    }

    const elapsed = Math.max(0, (clockNowMs - (game.serverTimestampMs || clockNowMs)) / 1000);
    if (game.turn === "white") {
      return {
        white: Math.max(0, game.timeWhite - elapsed),
        black: game.timeBlack
      };
    }
    return {
      white: game.timeWhite,
      black: Math.max(0, game.timeBlack - elapsed)
    };
  }, [game, clockNowMs, state.room_state.reconnect.status]);

  const participantsById = new Map(state.room_state.participants.map((participant) => [participant.userId, participant]));
  const fallbackIds = state.room_state.participants.map((participant) => participant.userId);
  const whitePlayerId = game?.whitePlayerId || fallbackIds[0] || user?.sub || null;
  const blackPlayerId =
    game?.blackPlayerId || fallbackIds.find((playerId) => playerId !== whitePlayerId) || null;

  const whiteIsLocal = whitePlayerId === user?.sub;
  const blackIsLocal = blackPlayerId === user?.sub;
  const whiteConnected = whitePlayerId ? (participantsById.get(whitePlayerId)?.connected ?? true) : false;
  const blackConnected = blackPlayerId ? (participantsById.get(blackPlayerId)?.connected ?? true) : false;
  const whiteClock = game ? formatClock(derivedClocks.white) : "--:--";
  const blackClock = game ? formatClock(derivedClocks.black) : "--:--";
  const statusLabel = game
    ? `Turn: ${game.turn === "white" ? "White" : "Black"}`
    : connectedPlayers < 2
      ? "Waiting for opponent"
      : "Ready to start";
  const whiteDisplayName = displayNameFromParticipant(participantsById.get(whitePlayerId), whitePlayerId, user?.sub);
  const blackDisplayName = displayNameFromParticipant(participantsById.get(blackPlayerId), blackPlayerId, user?.sub);
  const winnerLabel =
    !state.game_state.lastResult?.winner || state.game_state.lastResult.winner === "draw"
      ? "Draw"
      : displayNameFromParticipant(
          participantsById.get(state.game_state.lastResult.winner),
          state.game_state.lastResult.winner,
          user?.sub
        );

  const unsupportedMobile = viewport.width < 360 || viewport.height < 640;
  if (unsupportedMobile) {
    return (
      <main className="room-shell app-shell">
        <div className="room-command-bar">
          <button className="button-ghost" onClick={() => navigate("/lobby")}>
            Return to Lobby
          </button>
        </div>
        <section className="mobile-fallback-card surface-glass">
          <h1>Desktop recommended</h1>
          <p>Chess-Chat currently works best on desktop. Mobile app coming soon.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="room-shell app-shell">
      <div className="room-command-bar">
        <button className="button-ghost" onClick={() => navigate("/lobby")}>
          Return to Lobby
        </button>
      </div>

      <section className="room-status-strip surface-glass">
        <div>
          <p className="room-code-line">Room {roomCode}</p>
          <h1>{statusLabel}</h1>
        </div>
        <div className="room-status-meta">
          <p className="socket-status">{socketSubtitle}</p>
          {reconnectLabel ? <p className="socket-status">{reconnectLabel}</p> : null}
        </div>
      </section>

      {state.blocking_error ? (
        <section className="error-banner surface-danger" role="alert">
          <strong>{state.blocking_error.code}</strong>
          <span>{state.blocking_error.message}</span>
          <button className="button-ghost" onClick={() => dispatch({ type: "CLEAR_BLOCKING_ERROR" })}>
            Dismiss
          </button>
        </section>
      ) : null}

      {state.toast_error ? (
        <section className="error-toast" role="status">
          <span>{state.toast_error.message}</span>
        </section>
      ) : null}

      <section className="room-grid">
        <aside className="room-side room-side-left">
          <VideoPanel
            playerName={whiteDisplayName}
            playerRole="White"
            clock={whiteClock}
            connected={whiteConnected}
            isLocalPlayer={whiteIsLocal || (!game && !blackIsLocal)}
            videoRef={whiteIsLocal || (!game && !blackIsLocal) ? localVideoRef : remoteVideoRef}
            canJoinMedia={Boolean(state.media_state.credentials)}
            mediaStarted={state.media_state.started}
            onJoinMedia={joinMedia}
            onToggleMic={toggleMic}
            onToggleCamera={toggleCamera}
            isMicMuted={state.media_state.micMuted}
            isCameraOn={state.media_state.cameraOn}
            mediaStatus={state.media_state.message}
            error={state.blocking_error?.code?.startsWith("MEDIA") ? state.blocking_error.message : ""}
          />
        </aside>

        <section className="game-panel surface-glass">
          <div className="game-header-row">
            <p className="turn-pill">{statusLabel}</p>
          </div>

          <div className="board-wrap">
            <ChessBoardPanel
              fen={game?.fen || "start"}
              myColor={myColor}
              isMyTurn={isMyTurn}
              onMove={onMove}
            />
          </div>

          <div className="clock-row">
            <p>
              <span className="status-dot is-online" />
              White {whiteClock}
            </p>
            <p>
              <span className="status-dot is-online" />
              Black {blackClock}
            </p>
          </div>

          <div className="room-action-row">
            <button className="button-ghost" onClick={toggleSoundEnabled}>
              Sound {soundEnabled ? "On" : "Off"}
            </button>
            <button className="button-primary" onClick={startGame} disabled={!canStartGame}>
              Start Game
            </button>
            <button className="button-secondary" onClick={offerDraw} disabled={!canOfferDraw}>
              Offer Draw
            </button>
            <button className="button-secondary" onClick={acceptDraw} disabled={!canAcceptDraw}>
              Accept Draw
            </button>
            <button className="button-secondary" onClick={requestTakeback} disabled={!canRequestTakeback}>
              Takeback
            </button>
            <button className="button-danger" onClick={resign} disabled={!game}>
              Resign
            </button>
            <button className="button-secondary" onClick={() => navigate("/lobby")}>
              New Room
            </button>
          </div>
        </section>

        <aside className="room-side room-side-right">
          <VideoPanel
            playerName={blackDisplayName}
            playerRole="Black"
            clock={blackClock}
            connected={blackConnected}
            isLocalPlayer={blackIsLocal}
            videoRef={blackIsLocal ? localVideoRef : remoteVideoRef}
            canJoinMedia={Boolean(state.media_state.credentials)}
            mediaStarted={state.media_state.started}
            onJoinMedia={joinMedia}
            onToggleMic={toggleMic}
            onToggleCamera={toggleCamera}
            isMicMuted={state.media_state.micMuted}
            isCameraOn={state.media_state.cameraOn}
            mediaStatus={state.media_state.message}
            error={state.blocking_error?.code?.startsWith("MEDIA") ? state.blocking_error.message : ""}
          />
        </aside>
      </section>

      {confirmResignOpen ? (
        <section className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card surface-glass">
            <h3>Confirm Resign</h3>
            <p>Are you sure you want to resign this game?</p>
            <div className="room-action-row">
              <button className="button-secondary" onClick={() => setConfirmResignOpen(false)}>
                Cancel
              </button>
              <button className="button-danger" onClick={confirmResign}>
                Confirm Resign
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {settingsModalOpen ? (
        <section className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card surface-glass">
            <h3>Game Settings</h3>
            <p>Host controls final settings before game start.</p>
            <div className="form-row" style={{ marginBottom: 10 }}>
              <label>
                White time (sec)
                <input
                  type="number"
                  min={30}
                  value={gameSettings.timeWhiteSeconds}
                  onChange={(e) =>
                    setGameSettings((prev) => ({ ...prev, timeWhiteSeconds: Number(e.target.value || 300) }))
                  }
                />
              </label>
              <label>
                Black time (sec)
                <input
                  type="number"
                  min={30}
                  value={gameSettings.timeBlackSeconds}
                  onChange={(e) =>
                    setGameSettings((prev) => ({ ...prev, timeBlackSeconds: Number(e.target.value || 300) }))
                  }
                />
              </label>
            </div>
            <label className="preview-toggle-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={gameSettings.allowTakebacks}
                onChange={(e) =>
                  setGameSettings((prev) => ({ ...prev, allowTakebacks: e.target.checked }))
                }
              />
              Allow takebacks
            </label>
            <div className="form-row">
              <label>
                White takebacks
                <input
                  type="number"
                  min={0}
                  value={gameSettings.takebacksWhite}
                  onChange={(e) =>
                    setGameSettings((prev) => ({ ...prev, takebacksWhite: Number(e.target.value || 0) }))
                  }
                  disabled={!gameSettings.allowTakebacks}
                />
              </label>
              <label>
                Black takebacks
                <input
                  type="number"
                  min={0}
                  value={gameSettings.takebacksBlack}
                  onChange={(e) =>
                    setGameSettings((prev) => ({ ...prev, takebacksBlack: Number(e.target.value || 0) }))
                  }
                  disabled={!gameSettings.allowTakebacks}
                />
              </label>
            </div>
            <div className="room-action-row" style={{ marginTop: 12 }}>
              <button className="button-secondary" onClick={() => setSettingsModalOpen(false)}>
                Cancel
              </button>
              <button className="button-primary" onClick={confirmStartGame}>
                Confirm + Start
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {state.game_state.lastResult ? (
        <section className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card surface-glass">
            <h3>Game Result</h3>
            <p><strong>Result:</strong> {state.game_state.lastResult.result}</p>
            <p><strong>Winner:</strong> {winnerLabel}</p>
            {state.game_state.lastResult.pgn ? (
              <p className="result-pgn"><strong>PGN:</strong> {state.game_state.lastResult.pgn}</p>
            ) : null}
            <div className="room-action-row">
              <button className="button-secondary" onClick={() => navigate("/lobby")}>
                Create New Room
              </button>
              <button className="button-ghost" onClick={() => dispatch({ type: "GAME_ENDED", result: null })}>
                Close
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
