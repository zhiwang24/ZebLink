import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/room-store";

type JoinRequest = {
  clientId?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;
  const body = (await request.json()) as JoinRequest;

  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const result = await getRoomStore().joinRoom(roomId, body.clientId);
  return NextResponse.json(result);
}
