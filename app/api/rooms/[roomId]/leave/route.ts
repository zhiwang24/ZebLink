import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/room-store";

type LeaveRequest = {
  clientId?: unknown;
  connectionId?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;
  const body = (await request.json()) as LeaveRequest;

  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  if (typeof body.connectionId !== "string" || !body.connectionId.trim()) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  }

  await getRoomStore().leaveRoom(roomId, body.clientId, body.connectionId);
  return NextResponse.json({ ok: true });
}
