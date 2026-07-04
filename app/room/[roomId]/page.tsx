import { RoomClient } from "@/components/room-client";
import { getIceServersFromEnv } from "@/lib/ice-servers";

type RoomPageProps = {
  params: Promise<{
    roomId: string;
  }>;
};

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomId } = await params;

  return <RoomClient iceServers={getIceServersFromEnv()} roomId={roomId} />;
}
