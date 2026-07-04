import { NextResponse } from "next/server";
import { getRoomStore } from "@/lib/room-store";

type JoinRequest = {
  clientId?: unknown;
  connectionId?: unknown;
  preferredRole?: unknown;
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

  if (typeof body.connectionId !== "string" || !body.connectionId.trim()) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  }

  const preferredRole =
    body.preferredRole === "host" || body.preferredRole === "viewer"
      ? body.preferredRole
      : null;

  const result = await getRoomStore().joinRoom(
    roomId,
    body.clientId,
    body.connectionId,
    preferredRole,
  );
  return NextResponse.json(result);
}
