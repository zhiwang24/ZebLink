type RoomRole = "host" | "viewer";

type SignalEventType = "answer" | "ice-candidate" | "offer" | "user-joined" | "user-left";

type SignalEvent = {
  id: number;
  payload?: RTCIceCandidateInit | RTCSessionDescriptionInit;
  to: RoomRole;
  type: SignalEventType;
};

type JoinResult =
  | {
      peerPresent: boolean;
      role: RoomRole;
      roomFull: false;
    }
  | {
      roomFull: true;
    };

type PollResult = {
  events: SignalEvent[];
  peerPresent: boolean;
};

type RoomState = {
  events: SignalEvent[];
  hostClientId?: string;
  nextEventId: number;
  viewerClientId?: string;
};

type RoomStore = {
  emitSignal: (
    roomId: string,
    clientId: string,
    type: Exclude<SignalEventType, "user-joined" | "user-left">,
    payload: RTCIceCandidateInit | RTCSessionDescriptionInit,
  ) => Promise<void>;
  joinRoom: (roomId: string, clientId: string) => Promise<JoinResult>;
  leaveRoom: (roomId: string, clientId: string) => Promise<void>;
  pollEvents: (roomId: string, clientId: string, cursor: number) => Promise<PollResult>;
};

const ROOM_TTL_SECONDS = 60 * 15;
const MAX_STORED_EVENTS = 200;

function getRoleForClient(state: RoomState, clientId: string): RoomRole | null {
  if (state.hostClientId === clientId) {
    return "host";
  }

  if (state.viewerClientId === clientId) {
    return "viewer";
  }

  return null;
}

function getPeerPresent(state: RoomState, role: RoomRole): boolean {
  return role === "host" ? !!state.viewerClientId : !!state.hostClientId;
}

function createEmptyRoomState(): RoomState {
  return {
    events: [],
    nextEventId: 1,
  };
}

function getGlobalMemoryStore(): Map<string, RoomState> {
  const scopedGlobal = globalThis as typeof globalThis & {
    __cozycastRoomStore__?: Map<string, RoomState>;
  };

  if (!scopedGlobal.__cozycastRoomStore__) {
    scopedGlobal.__cozycastRoomStore__ = new Map<string, RoomState>();
  }

  return scopedGlobal.__cozycastRoomStore__;
}

function getRedisCredentials():
  | {
      token: string;
      url: string;
    }
  | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return { url, token };
}

async function executeRedisCommand<T>(command: unknown[]): Promise<T> {
  const credentials = getRedisCredentials();
  if (!credentials) {
    throw new Error("Redis credentials are missing");
  }

  const response = await fetch(credentials.url, {
    body: JSON.stringify(command),
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    cache: "no-store",
  });

  const data = (await response.json()) as { error?: string; result?: T };

  if (!response.ok || data.error) {
    throw new Error(data.error ?? `Redis command failed with ${response.status}`);
  }

  return data.result as T;
}

async function executeRedisPipeline<T>(commands: unknown[][]): Promise<Array<{ result?: T }>> {
  const credentials = getRedisCredentials();
  if (!credentials) {
    throw new Error("Redis credentials are missing");
  }

  const response = await fetch(`${credentials.url}/pipeline`, {
    body: JSON.stringify(commands),
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    cache: "no-store",
  });

  const data = (await response.json()) as Array<{ error?: string; result?: T }>;

  if (!response.ok) {
    throw new Error(`Redis pipeline failed with ${response.status}`);
  }

  const failedResult = data.find((entry) => entry.error);
  if (failedResult?.error) {
    throw new Error(failedResult.error);
  }

  return data;
}

function getRoomKeyPrefix(roomId: string): string {
  return `cozycast:room:${roomId}`;
}

async function pushRedisEvent(roomId: string, event: Omit<SignalEvent, "id">): Promise<void> {
  const prefix = getRoomKeyPrefix(roomId);
  const nextEventId = await executeRedisCommand<number>(["INCR", `${prefix}:event-seq`]);
  const serializedEvent = JSON.stringify({
    ...event,
    id: nextEventId,
  } satisfies SignalEvent);

  await executeRedisPipeline([
    ["RPUSH", `${prefix}:events`, serializedEvent],
    ["LTRIM", `${prefix}:events`, -MAX_STORED_EVENTS, -1],
    ["EXPIRE", `${prefix}:events`, ROOM_TTL_SECONDS],
    ["EXPIRE", `${prefix}:event-seq`, ROOM_TTL_SECONDS],
  ]);
}

async function loadRedisRoomState(roomId: string): Promise<RoomState> {
  const prefix = getRoomKeyPrefix(roomId);
  const [hostResult, viewerResult, eventsResult] = await executeRedisPipeline<string | string[]>([
    ["GET", `${prefix}:host`],
    ["GET", `${prefix}:viewer`],
    ["LRANGE", `${prefix}:events`, 0, -1],
  ]);

  const serializedEvents = Array.isArray(eventsResult.result) ? eventsResult.result : [];

  return {
    hostClientId: typeof hostResult.result === "string" ? hostResult.result : undefined,
    viewerClientId: typeof viewerResult.result === "string" ? viewerResult.result : undefined,
    events: serializedEvents
      .map((value) => {
        try {
          return JSON.parse(value) as SignalEvent;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is SignalEvent => entry !== null),
    nextEventId: 0,
  };
}

async function touchRedisMembership(roomId: string, role: RoomRole, clientId: string): Promise<void> {
  const prefix = getRoomKeyPrefix(roomId);
  const key = `${prefix}:${role}`;
  const storedClientId = await executeRedisCommand<string | null>(["GET", key]);

  if (storedClientId === clientId) {
    await executeRedisCommand(["EXPIRE", key, ROOM_TTL_SECONDS]);
  }
}

const memoryRoomStore: RoomStore = {
  async emitSignal(roomId, clientId, type, payload) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    const senderRole = getRoleForClient(room, clientId);
    if (!senderRole) {
      return;
    }

    const targetRole: RoomRole = senderRole === "host" ? "viewer" : "host";
    room.events.push({
      id: room.nextEventId++,
      payload,
      to: targetRole,
      type,
    });
    room.events = room.events.slice(-MAX_STORED_EVENTS);
    rooms.set(roomId, room);
  },

  async joinRoom(roomId, clientId) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId) ?? createEmptyRoomState();

    if (room.hostClientId === clientId) {
      rooms.set(roomId, room);
      return { peerPresent: !!room.viewerClientId, role: "host", roomFull: false };
    }

    if (room.viewerClientId === clientId) {
      rooms.set(roomId, room);
      return { peerPresent: !!room.hostClientId, role: "viewer", roomFull: false };
    }

    if (!room.hostClientId) {
      room.hostClientId = clientId;
      rooms.set(roomId, room);
      return { peerPresent: !!room.viewerClientId, role: "host", roomFull: false };
    }

    if (!room.viewerClientId) {
      room.viewerClientId = clientId;
      room.events.push({
        id: room.nextEventId++,
        to: "host",
        type: "user-joined",
      });
      room.events = room.events.slice(-MAX_STORED_EVENTS);
      rooms.set(roomId, room);
      return { peerPresent: true, role: "viewer", roomFull: false };
    }

    return { roomFull: true };
  },

  async leaveRoom(roomId, clientId) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const role = getRoleForClient(room, clientId);
    if (!role) {
      return;
    }

    if (role === "host") {
      room.hostClientId = undefined;
      if (room.viewerClientId) {
        room.events.push({
          id: room.nextEventId++,
          to: "viewer",
          type: "user-left",
        });
      }
    } else {
      room.viewerClientId = undefined;
      if (room.hostClientId) {
        room.events.push({
          id: room.nextEventId++,
          to: "host",
          type: "user-left",
        });
      }
    }

    room.events = room.events.slice(-MAX_STORED_EVENTS);

    if (!room.hostClientId && !room.viewerClientId) {
      rooms.delete(roomId);
      return;
    }

    rooms.set(roomId, room);
  },

  async pollEvents(roomId, clientId, cursor) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);

    if (!room) {
      return { events: [], peerPresent: false };
    }

    const role = getRoleForClient(room, clientId);
    if (!role) {
      return { events: [], peerPresent: false };
    }

    return {
      events: room.events.filter((event) => event.id > cursor && event.to === role),
      peerPresent: getPeerPresent(room, role),
    };
  },
};

const redisRoomStore: RoomStore = {
  async emitSignal(roomId, clientId, type, payload) {
    const room = await loadRedisRoomState(roomId);
    const senderRole = getRoleForClient(room, clientId);
    if (!senderRole) {
      return;
    }

    await touchRedisMembership(roomId, senderRole, clientId);
    await pushRedisEvent(roomId, {
      payload,
      to: senderRole === "host" ? "viewer" : "host",
      type,
    });
  },

  async joinRoom(roomId, clientId) {
    const prefix = getRoomKeyPrefix(roomId);
    const hostSet = await executeRedisCommand<string | null>([
      "SET",
      `${prefix}:host`,
      clientId,
      "EX",
      ROOM_TTL_SECONDS,
      "NX",
    ]);

    if (hostSet === "OK") {
      const room = await loadRedisRoomState(roomId);
      return { peerPresent: !!room.viewerClientId, role: "host", roomFull: false };
    }

    const currentHost = await executeRedisCommand<string | null>(["GET", `${prefix}:host`]);
    if (currentHost === clientId) {
      await executeRedisCommand(["EXPIRE", `${prefix}:host`, ROOM_TTL_SECONDS]);
      const room = await loadRedisRoomState(roomId);
      return { peerPresent: !!room.viewerClientId, role: "host", roomFull: false };
    }

    const viewerSet = await executeRedisCommand<string | null>([
      "SET",
      `${prefix}:viewer`,
      clientId,
      "EX",
      ROOM_TTL_SECONDS,
      "NX",
    ]);

    if (viewerSet === "OK") {
      await pushRedisEvent(roomId, {
        to: "host",
        type: "user-joined",
      });
      return { peerPresent: true, role: "viewer", roomFull: false };
    }

    const currentViewer = await executeRedisCommand<string | null>(["GET", `${prefix}:viewer`]);
    if (currentViewer === clientId) {
      await executeRedisCommand(["EXPIRE", `${prefix}:viewer`, ROOM_TTL_SECONDS]);
      const room = await loadRedisRoomState(roomId);
      return { peerPresent: !!room.hostClientId, role: "viewer", roomFull: false };
    }

    return { roomFull: true };
  },

  async leaveRoom(roomId, clientId) {
    const room = await loadRedisRoomState(roomId);
    const role = getRoleForClient(room, clientId);
    if (!role) {
      return;
    }

    const prefix = getRoomKeyPrefix(roomId);
    const roleKey = `${prefix}:${role}`;
    await executeRedisCommand(["DEL", roleKey]);

    if (role === "host" && room.viewerClientId) {
      await pushRedisEvent(roomId, {
        to: "viewer",
        type: "user-left",
      });
    }

    if (role === "viewer" && room.hostClientId) {
      await pushRedisEvent(roomId, {
        to: "host",
        type: "user-left",
      });
    }

    if (role === "host" && !room.viewerClientId) {
      await executeRedisPipeline([
        ["DEL", `${prefix}:events`],
        ["DEL", `${prefix}:event-seq`],
      ]);
    }

    if (role === "viewer" && !room.hostClientId) {
      await executeRedisPipeline([
        ["DEL", `${prefix}:events`],
        ["DEL", `${prefix}:event-seq`],
      ]);
    }
  },

  async pollEvents(roomId, clientId, cursor) {
    const room = await loadRedisRoomState(roomId);
    const role = getRoleForClient(room, clientId);
    if (!role) {
      return { events: [], peerPresent: false };
    }

    await touchRedisMembership(roomId, role, clientId);

    return {
      events: room.events.filter((event) => event.id > cursor && event.to === role),
      peerPresent: getPeerPresent(room, role),
    };
  },
};

export function getRoomStore(): RoomStore {
  return getRedisCredentials() ? redisRoomStore : memoryRoomStore;
}
