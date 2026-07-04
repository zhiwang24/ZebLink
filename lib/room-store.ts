type RoomRole = "host" | "viewer";
type PreferredRoomRole = RoomRole | null;

type SignalEventType = "answer" | "ice-candidate" | "offer" | "user-joined" | "user-left";

type SignalEvent = {
  id: number;
  payload?: RTCIceCandidateInit | RTCSessionDescriptionInit;
  to: RoomRole;
  type: SignalEventType;
};

type JoinResult =
  | {
      cursor: number;
      peerPresent: boolean;
      sharingActive: boolean;
      role: RoomRole;
      roomFull: false;
    }
  | {
      preferredRoleUnavailable: RoomRole;
      roomFull: false;
    }
  | {
      roomFull: true;
    };

type PollResult = {
  events: SignalEvent[];
  peerPresent: boolean;
  sharingActive: boolean;
};

type RoomState = {
  events: SignalEvent[];
  hostClientId?: string;
  hostConnectionId?: string;
  hostSharingActive: boolean;
  nextEventId: number;
  viewerClientId?: string;
  viewerConnectionId?: string;
};

type RoomStore = {
  emitSignal: (
    roomId: string,
    clientId: string,
    connectionId: string,
    type: Exclude<SignalEventType, "user-joined" | "user-left">,
    payload: RTCIceCandidateInit | RTCSessionDescriptionInit,
  ) => Promise<void>;
  joinRoom: (
    roomId: string,
    clientId: string,
    connectionId: string,
    preferredRole: PreferredRoomRole,
  ) => Promise<JoinResult>;
  leaveRoom: (roomId: string, clientId: string, connectionId: string) => Promise<void>;
  pollEvents: (
    roomId: string,
    clientId: string,
    connectionId: string,
    cursor: number,
  ) => Promise<PollResult>;
  setSharingActive: (
    roomId: string,
    clientId: string,
    connectionId: string,
    active: boolean,
  ) => Promise<void>;
};

const ROOM_TTL_SECONDS = 60 * 15;
const MAX_STORED_EVENTS = 200;

function getPeerRole(role: RoomRole): RoomRole {
  return role === "host" ? "viewer" : "host";
}

function matchesMembership(
  storedClientId: string | undefined,
  storedConnectionId: string | undefined,
  clientId: string,
  connectionId: string,
): boolean {
  if (storedClientId !== clientId) {
    return false;
  }

  return !storedConnectionId || storedConnectionId === connectionId;
}

function getRoleForClient(state: RoomState, clientId: string, connectionId: string): RoomRole | null {
  if (matchesMembership(state.hostClientId, state.hostConnectionId, clientId, connectionId)) {
    return "host";
  }

  if (matchesMembership(state.viewerClientId, state.viewerConnectionId, clientId, connectionId)) {
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
    hostSharingActive: false,
    nextEventId: 1,
  };
}

function getLatestEventCursor(events: SignalEvent[]): number {
  return events.length > 0 ? events[events.length - 1].id : 0;
}

function appendUserJoinedEvent(room: RoomState): void {
  room.events.push({
    id: room.nextEventId++,
    to: "host",
    type: "user-joined",
  });
  room.events = room.events.slice(-MAX_STORED_EVENTS);
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
  const [
    hostResult,
    hostConnectionResult,
    viewerResult,
    viewerConnectionResult,
    sharingResult,
    eventsResult,
  ] = await executeRedisPipeline<
    string | string[]
  >([
    ["GET", `${prefix}:host`],
    ["GET", `${prefix}:host:connection`],
    ["GET", `${prefix}:viewer`],
    ["GET", `${prefix}:viewer:connection`],
    ["GET", `${prefix}:sharing-active`],
    ["LRANGE", `${prefix}:events`, 0, -1],
  ]);

  const serializedEvents = Array.isArray(eventsResult.result) ? eventsResult.result : [];

  return {
    hostClientId: typeof hostResult.result === "string" ? hostResult.result : undefined,
    hostConnectionId:
      typeof hostConnectionResult.result === "string" ? hostConnectionResult.result : undefined,
    hostSharingActive: sharingResult.result === "1",
    viewerClientId: typeof viewerResult.result === "string" ? viewerResult.result : undefined,
    viewerConnectionId:
      typeof viewerConnectionResult.result === "string"
        ? viewerConnectionResult.result
        : undefined,
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

function getConnectionKey(prefix: string, role: RoomRole): string {
  return `${prefix}:${role}:connection`;
}

async function touchRedisMembership(
  roomId: string,
  role: RoomRole,
  clientId: string,
  connectionId: string,
): Promise<void> {
  const prefix = getRoomKeyPrefix(roomId);
  const key = `${prefix}:${role}`;
  const connectionKey = getConnectionKey(prefix, role);
  const [storedClientIdResult, storedConnectionIdResult] = await executeRedisPipeline<string>([
    ["GET", key],
    ["GET", connectionKey],
  ]);
  const storedClientId =
    typeof storedClientIdResult.result === "string" ? storedClientIdResult.result : null;
  const storedConnectionId =
    typeof storedConnectionIdResult.result === "string" ? storedConnectionIdResult.result : null;

  if (matchesMembership(storedClientId ?? undefined, storedConnectionId ?? undefined, clientId, connectionId)) {
    const commands: unknown[][] = [["EXPIRE", key, ROOM_TTL_SECONDS]];
    if (storedConnectionId) {
      commands.push(["EXPIRE", connectionKey, ROOM_TTL_SECONDS]);
    }
    await executeRedisPipeline(commands);
  }
}

const memoryRoomStore: RoomStore = {
  async emitSignal(roomId, clientId, connectionId, type, payload) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    const senderRole = getRoleForClient(room, clientId, connectionId);
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

  async joinRoom(roomId, clientId, connectionId, preferredRole) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId) ?? createEmptyRoomState();

    if (room.hostClientId === clientId && preferredRole === "viewer") {
      if (room.viewerClientId && room.viewerClientId !== clientId) {
        return {
          preferredRoleUnavailable: "viewer",
          roomFull: false,
        };
      }

      room.hostClientId = undefined;
      room.hostConnectionId = undefined;
      room.hostSharingActive = false;
      room.viewerClientId = clientId;
      room.viewerConnectionId = connectionId;
      rooms.set(roomId, room);
      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: false,
        sharingActive: room.hostSharingActive,
        role: "viewer",
        roomFull: false,
      };
    }

    if (room.viewerClientId === clientId && preferredRole === "host") {
      if (room.hostClientId && room.hostClientId !== clientId) {
        return {
          preferredRoleUnavailable: "host",
          roomFull: false,
        };
      }

      room.viewerClientId = undefined;
      room.viewerConnectionId = undefined;
      room.hostClientId = clientId;
      room.hostConnectionId = connectionId;
      room.hostSharingActive = false;
      rooms.set(roomId, room);
      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: false,
        sharingActive: room.hostSharingActive,
        role: "host",
        roomFull: false,
      };
    }

    if (room.hostClientId === clientId) {
      room.hostConnectionId = connectionId;
      rooms.set(roomId, room);
      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: !!room.viewerClientId,
        sharingActive: room.hostSharingActive,
        role: "host",
        roomFull: false,
      };
    }

    if (room.viewerClientId === clientId) {
      room.viewerConnectionId = connectionId;
      if (room.hostClientId) {
        appendUserJoinedEvent(room);
      }

      rooms.set(roomId, room);
      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: !!room.hostClientId,
        sharingActive: room.hostSharingActive,
        role: "viewer",
        roomFull: false,
      };
    }

    if (preferredRole) {
      const preferredRoleKey = preferredRole === "host" ? "hostClientId" : "viewerClientId";
      const peerRoleKey = preferredRole === "host" ? "viewerClientId" : "hostClientId";

      if (!room[preferredRoleKey]) {
        room[preferredRoleKey] = clientId;
        if (preferredRole === "host") {
          room.hostConnectionId = connectionId;
        } else {
          room.viewerConnectionId = connectionId;
        }
        if (preferredRole === "viewer" && room.hostClientId) {
          appendUserJoinedEvent(room);
        }

        rooms.set(roomId, room);
        return {
          cursor: getLatestEventCursor(room.events),
          peerPresent: !!room[peerRoleKey],
          sharingActive: room.hostSharingActive,
          role: preferredRole,
          roomFull: false,
        };
      }

      return {
        preferredRoleUnavailable: preferredRole,
        roomFull: false,
      };
    }

    if (!room.hostClientId) {
      room.hostClientId = clientId;
      room.hostConnectionId = connectionId;
      rooms.set(roomId, room);
      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: !!room.viewerClientId,
        sharingActive: room.hostSharingActive,
        role: "host",
        roomFull: false,
      };
    }

    if (!room.viewerClientId) {
      room.viewerClientId = clientId;
      room.viewerConnectionId = connectionId;
      appendUserJoinedEvent(room);
      rooms.set(roomId, room);
      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: true,
        sharingActive: room.hostSharingActive,
        role: "viewer",
        roomFull: false,
      };
    }

    return { roomFull: true };
  },

  async leaveRoom(roomId, clientId, connectionId) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const role = getRoleForClient(room, clientId, connectionId);
    if (!role) {
      return;
    }

    if (role === "host") {
      room.hostClientId = undefined;
      room.hostConnectionId = undefined;
      room.hostSharingActive = false;
      if (room.viewerClientId) {
        room.events.push({
          id: room.nextEventId++,
          to: "viewer",
          type: "user-left",
        });
      }
    } else {
      room.viewerClientId = undefined;
      room.viewerConnectionId = undefined;
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

  async pollEvents(roomId, clientId, connectionId, cursor) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);

    if (!room) {
      return { events: [], peerPresent: false, sharingActive: false };
    }

    const role = getRoleForClient(room, clientId, connectionId);
    if (!role) {
      return { events: [], peerPresent: false, sharingActive: room.hostSharingActive };
    }

    return {
      events: room.events.filter((event) => event.id > cursor && event.to === role),
      peerPresent: getPeerPresent(room, role),
      sharingActive: room.hostSharingActive,
    };
  },

  async setSharingActive(roomId, clientId, connectionId, active) {
    const rooms = getGlobalMemoryStore();
    const room = rooms.get(roomId);
    if (
      !room ||
      !matchesMembership(room.hostClientId, room.hostConnectionId, clientId, connectionId)
    ) {
      return;
    }

    room.hostSharingActive = active;
    rooms.set(roomId, room);
  },
};

const redisRoomStore: RoomStore = {
  async emitSignal(roomId, clientId, connectionId, type, payload) {
    const room = await loadRedisRoomState(roomId);
    const senderRole = getRoleForClient(room, clientId, connectionId);
    if (!senderRole) {
      return;
    }

    await touchRedisMembership(roomId, senderRole, clientId, connectionId);
    await pushRedisEvent(roomId, {
      payload,
      to: senderRole === "host" ? "viewer" : "host",
      type,
    });
  },

  async joinRoom(roomId, clientId, connectionId, preferredRole) {
    const prefix = getRoomKeyPrefix(roomId);
    const room = await loadRedisRoomState(roomId);

    if (room.hostClientId === clientId && preferredRole === "viewer") {
      if (room.viewerClientId && room.viewerClientId !== clientId) {
        return {
          preferredRoleUnavailable: "viewer",
          roomFull: false,
        };
      }

      await executeRedisPipeline([
        ["DEL", `${prefix}:host`],
        ["DEL", getConnectionKey(prefix, "host")],
        ["SET", `${prefix}:viewer`, clientId, "EX", ROOM_TTL_SECONDS],
        ["SET", getConnectionKey(prefix, "viewer"), connectionId, "EX", ROOM_TTL_SECONDS],
        ["SET", `${prefix}:sharing-active`, "0", "EX", ROOM_TTL_SECONDS],
      ]);

      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: false,
        sharingActive: false,
        role: "viewer",
        roomFull: false,
      };
    }

    if (room.viewerClientId === clientId && preferredRole === "host") {
      if (room.hostClientId && room.hostClientId !== clientId) {
        return {
          preferredRoleUnavailable: "host",
          roomFull: false,
        };
      }

      await executeRedisPipeline([
        ["DEL", `${prefix}:viewer`],
        ["DEL", getConnectionKey(prefix, "viewer")],
        ["SET", `${prefix}:host`, clientId, "EX", ROOM_TTL_SECONDS],
        ["SET", getConnectionKey(prefix, "host"), connectionId, "EX", ROOM_TTL_SECONDS],
        ["SET", `${prefix}:sharing-active`, "0", "EX", ROOM_TTL_SECONDS],
      ]);

      return {
        cursor: getLatestEventCursor(room.events),
        peerPresent: false,
        sharingActive: false,
        role: "host",
        roomFull: false,
      };
    }

    if (preferredRole) {
      const preferredSet = await executeRedisCommand<string | null>([
        "SET",
        `${prefix}:${preferredRole}`,
        clientId,
        "EX",
        ROOM_TTL_SECONDS,
        "NX",
      ]);

      if (preferredSet === "OK") {
        await executeRedisCommand([
          "SET",
          getConnectionKey(prefix, preferredRole),
          connectionId,
          "EX",
          ROOM_TTL_SECONDS,
        ]);
        if (preferredRole === "viewer") {
          const currentHost = await executeRedisCommand<string | null>(["GET", `${prefix}:host`]);
          if (currentHost) {
            await pushRedisEvent(roomId, {
              to: "host",
              type: "user-joined",
            });
          }
        }

        const refreshedRoom = await loadRedisRoomState(roomId);
        return {
          cursor: getLatestEventCursor(refreshedRoom.events),
          peerPresent: getPeerPresent(refreshedRoom, preferredRole),
          sharingActive: refreshedRoom.hostSharingActive,
          role: preferredRole,
          roomFull: false,
        };
      }

      const currentPreferred = await executeRedisCommand<string | null>([
        "GET",
        `${prefix}:${preferredRole}`,
      ]);
      if (currentPreferred === clientId) {
        await executeRedisPipeline([
          ["EXPIRE", `${prefix}:${preferredRole}`, ROOM_TTL_SECONDS],
          ["SET", getConnectionKey(prefix, preferredRole), connectionId, "EX", ROOM_TTL_SECONDS],
        ]);
        if (preferredRole === "viewer" && room.hostClientId) {
          await pushRedisEvent(roomId, {
            to: "host",
            type: "user-joined",
          });
        }
        const refreshedRoom = await loadRedisRoomState(roomId);
        return {
          cursor: getLatestEventCursor(refreshedRoom.events),
          peerPresent: getPeerPresent(refreshedRoom, preferredRole),
          sharingActive: refreshedRoom.hostSharingActive,
          role: preferredRole,
          roomFull: false,
        };
      }

      return {
        preferredRoleUnavailable: preferredRole,
        roomFull: false,
      };
    }

    const hostSet = await executeRedisCommand<string | null>([
      "SET",
      `${prefix}:host`,
      clientId,
      "EX",
      ROOM_TTL_SECONDS,
      "NX",
    ]);

    if (hostSet === "OK") {
      await executeRedisCommand([
        "SET",
        getConnectionKey(prefix, "host"),
        connectionId,
        "EX",
        ROOM_TTL_SECONDS,
      ]);
      const refreshedRoom = await loadRedisRoomState(roomId);
      return {
        cursor: getLatestEventCursor(refreshedRoom.events),
        peerPresent: !!refreshedRoom.viewerClientId,
        sharingActive: refreshedRoom.hostSharingActive,
        role: "host",
        roomFull: false,
      };
    }

    const currentHost = await executeRedisCommand<string | null>(["GET", `${prefix}:host`]);
    if (currentHost === clientId) {
      await executeRedisPipeline([
        ["EXPIRE", `${prefix}:host`, ROOM_TTL_SECONDS],
        ["SET", getConnectionKey(prefix, "host"), connectionId, "EX", ROOM_TTL_SECONDS],
      ]);
      const refreshedRoom = await loadRedisRoomState(roomId);
      return {
        cursor: getLatestEventCursor(refreshedRoom.events),
        peerPresent: !!refreshedRoom.viewerClientId,
        sharingActive: refreshedRoom.hostSharingActive,
        role: "host",
        roomFull: false,
      };
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
      await executeRedisCommand([
        "SET",
        getConnectionKey(prefix, "viewer"),
        connectionId,
        "EX",
        ROOM_TTL_SECONDS,
      ]);
      await pushRedisEvent(roomId, {
        to: "host",
        type: "user-joined",
      });
      const refreshedRoom = await loadRedisRoomState(roomId);
      return {
        cursor: getLatestEventCursor(refreshedRoom.events),
        peerPresent: true,
        sharingActive: refreshedRoom.hostSharingActive,
        role: "viewer",
        roomFull: false,
      };
    }

    const currentViewer = await executeRedisCommand<string | null>(["GET", `${prefix}:viewer`]);
    if (currentViewer === clientId) {
      await executeRedisPipeline([
        ["EXPIRE", `${prefix}:viewer`, ROOM_TTL_SECONDS],
        ["SET", getConnectionKey(prefix, "viewer"), connectionId, "EX", ROOM_TTL_SECONDS],
      ]);
      if (room.hostClientId) {
        await pushRedisEvent(roomId, {
          to: "host",
          type: "user-joined",
        });
      }
      const refreshedRoom = await loadRedisRoomState(roomId);
      return {
        cursor: getLatestEventCursor(refreshedRoom.events),
        peerPresent: !!refreshedRoom.hostClientId,
        sharingActive: refreshedRoom.hostSharingActive,
        role: "viewer",
        roomFull: false,
      };
    }

    return { roomFull: true };
  },

  async leaveRoom(roomId, clientId, connectionId) {
    const room = await loadRedisRoomState(roomId);
    const role = getRoleForClient(room, clientId, connectionId);
    if (!role) {
      return;
    }

    const prefix = getRoomKeyPrefix(roomId);
    const roleKey = `${prefix}:${role}`;
    await executeRedisPipeline([["DEL", roleKey], ["DEL", getConnectionKey(prefix, role)]]);

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
        ["DEL", `${prefix}:sharing-active`],
        ["DEL", `${prefix}:events`],
        ["DEL", `${prefix}:event-seq`],
      ]);
    }

    if (role === "viewer" && !room.hostClientId) {
      await executeRedisPipeline([
        ["DEL", `${prefix}:sharing-active`],
        ["DEL", `${prefix}:events`],
        ["DEL", `${prefix}:event-seq`],
      ]);
    }
  },

  async pollEvents(roomId, clientId, connectionId, cursor) {
    const room = await loadRedisRoomState(roomId);
    const role = getRoleForClient(room, clientId, connectionId);
    if (!role) {
      return { events: [], peerPresent: false, sharingActive: room.hostSharingActive };
    }

    await touchRedisMembership(roomId, role, clientId, connectionId);

    return {
      events: room.events.filter((event) => event.id > cursor && event.to === role),
      peerPresent: getPeerPresent(room, role),
      sharingActive: room.hostSharingActive,
    };
  },

  async setSharingActive(roomId, clientId, connectionId, active) {
    const room = await loadRedisRoomState(roomId);
    if (!matchesMembership(room.hostClientId, room.hostConnectionId, clientId, connectionId)) {
      return;
    }

    const prefix = getRoomKeyPrefix(roomId);
    await executeRedisCommand([
      "SET",
      `${prefix}:sharing-active`,
      active ? "1" : "0",
      "EX",
      ROOM_TTL_SECONDS,
    ]);
  },
};

export function getRoomStore(): RoomStore {
  return getRedisCredentials() ? redisRoomStore : memoryRoomStore;
}
