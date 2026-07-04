import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/room-store";

type EmitEventRequest = {
  clientId?: unknown;
  payload?: unknown;
  type?: unknown;
};

type SupportedSignalType = "answer" | "ice-candidate" | "offer";

function isSupportedSignalType(value: unknown): value is SupportedSignalType {
  return value === "answer" || value === "ice-candidate" || value === "offer";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get("clientId");
  const cursor = Number(searchParams.get("cursor") ?? "0");

  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  if (Number.isNaN(cursor) || cursor < 0) {
    return NextResponse.json({ error: "cursor must be a positive number" }, { status: 400 });
  }

  const result = await getRoomStore().pollEvents(roomId, clientId, cursor);
  return NextResponse.json(result);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;
  const body = (await request.json()) as EmitEventRequest;

  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  if (!isSupportedSignalType(body.type)) {
    return NextResponse.json({ error: "Unsupported signal type" }, { status: 400 });
  }

  if (!body.payload || typeof body.payload !== "object") {
    return NextResponse.json({ error: "payload is required" }, { status: 400 });
  }

  await getRoomStore().emitSignal(
    roomId,
    body.clientId,
    body.type,
    body.payload as RTCIceCandidateInit | RTCSessionDescriptionInit,
  );

  return NextResponse.json({ ok: true });
}
