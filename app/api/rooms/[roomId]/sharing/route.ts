import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/room-store";

type SharingRequest = {
  active?: unknown;
  clientId?: unknown;
  connectionId?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;
  const body = (await request.json()) as SharingRequest;

  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  if (typeof body.connectionId !== "string" || !body.connectionId.trim()) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  }

  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
  }

  await getRoomStore().setSharingActive(roomId, body.clientId, body.connectionId, body.active);
  return NextResponse.json({ ok: true });
}
