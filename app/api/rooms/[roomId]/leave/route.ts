import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/room-store";

type LeaveRequest = {
  clientId?: unknown;
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

  await getRoomStore().leaveRoom(roomId, body.clientId);
  return NextResponse.json({ ok: true });
}
