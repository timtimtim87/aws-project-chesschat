import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSocketContext } from "../context/AppSocketContext";

const mockSocketSend = vi.fn();
const mockAudioPlay = vi.fn(() => Promise.resolve());
let latestSocketListener = null;
let RoomPage = null;

vi.mock("../components/ChessBoardPanel", () => ({
  default: () => <div>ChessBoardMock</div>
}));

vi.mock("../components/VideoPanel", () => ({
  default: () => <div>VideoPanelMock</div>
}));

vi.mock("../services/chime", () => ({
  createMeetingSession: () => ({ audioVideo: {} }),
  listDevices: async () => ({ audioInputs: [], videoInputs: [] }),
  startMedia: async () => {},
  stopMedia: () => {}
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    accessToken: "token-1",
    user: { sub: "user-1" }
  })
}));

function renderRoom() {
  if (!RoomPage) {
    throw new Error("RoomPage module not loaded");
  }
  return render(
    <AppSocketContext.Provider
      value={{
        socketState: {
          status: "connected",
          reconnectAttempt: 0,
          retryInMs: 0,
          connectionSerial: 1
        },
        send: (type, payload = {}) => mockSocketSend(type, payload),
        subscribe: (listener) => {
          latestSocketListener = listener;
          return () => {
            latestSocketListener = null;
          };
        }
      }}
    >
      <MemoryRouter initialEntries={["/room/ab12cd34"]}>
        <Routes>
          <Route path="/room/:code" element={<RoomPage />} />
        </Routes>
      </MemoryRouter>
    </AppSocketContext.Provider>
  );
}

describe("RoomPage", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "Audio",
      class AudioMock {
        constructor(src = "") {
          this.src = src;
          this.autoplay = false;
          this.preload = "";
          this.volume = 1;
          this.currentTime = 0;
        }

        play() {
          return mockAudioPlay(this.src);
        }

        pause() {}
      }
    );
    const mod = await import("./RoomPage");
    RoomPage = mod.default;
  });

  beforeEach(() => {
    mockSocketSend.mockReset();
    mockAudioPlay.mockReset();
    latestSocketListener = null;
    localStorage.removeItem("chesschat_sound_enabled");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders reconnect paused toast from socket event", async () => {
    renderRoom();
    await waitFor(() => expect(mockSocketSend).toHaveBeenCalledWith("join_room", { roomCode: "AB12CD34" }));
    latestSocketListener({
      type: "reconnect_state",
      status: "paused",
      disconnectedUserId: "user-2",
      graceEndsAt: Date.now() + 5000
    });
    expect(await screen.findByText("Opponent disconnected. Waiting for reconnect.")).toBeInTheDocument();
  });

  it("shows and confirms resign modal", async () => {
    renderRoom();
    latestSocketListener({
      type: "game_started",
      gameId: "g-1",
      whitePlayerId: "user-1",
      blackPlayerId: "user-2",
      fen: "start",
      moves: [],
      moveSans: [],
      moveFens: ["start"],
      turn: "white",
      timeWhite: 300,
      timeBlack: 300,
      settings: { allow_takebacks: true, takebacks_white_max: 2, takebacks_black_max: 2 },
      serverTimestampMs: Date.now()
    });
    await userEvent.click(await screen.findByRole("button", { name: "Resign" }));
    expect(screen.getByText("Are you sure you want to resign this game?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm Resign" }));
    expect(mockSocketSend).toHaveBeenCalledWith("resign", { roomCode: "AB12CD34" });
  });

  it("renders room command and action controls", async () => {
    renderRoom();
    expect(await screen.findByRole("button", { name: "Return to Lobby" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Game" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Room" })).toBeInTheDocument();
  });

  it("renders game result modal", async () => {
    renderRoom();
    latestSocketListener({
      type: "game_ended",
      gameId: "g-1",
      winner: "user-1",
      result: "checkmate",
      pgn: "1. e4 e5"
    });
    expect(await screen.findByText("Game Result")).toBeInTheDocument();
    expect(screen.getByText("checkmate")).toBeInTheDocument();
  });

  it("plays mapped move sound when sound is enabled", async () => {
    renderRoom();
    latestSocketListener({
      type: "move_made",
      moveType: "capture",
      isCheck: false,
      fen: "fen-2",
      moves: ["e2e4"],
      moveSans: ["e4"],
      moveFens: ["start", "fen-2"],
      turn: "black",
      timeWhite: 299,
      timeBlack: 300
    });
    await waitFor(() => expect(mockAudioPlay).toHaveBeenCalledWith("/sounds/chesschat/capture.ogg"));
  });

  it("suppresses sound playback when sound preference is disabled", () => {
    localStorage.setItem("chesschat_sound_enabled", "false");
    renderRoom();
    latestSocketListener({
      type: "move_made",
      moveType: "move",
      isCheck: false,
      fen: "fen-2",
      moves: ["e2e4"],
      moveSans: ["e4"],
      moveFens: ["start", "fen-2"],
      turn: "black",
      timeWhite: 299,
      timeBlack: 300
    });
    expect(mockAudioPlay).not.toHaveBeenCalled();
  });
});
