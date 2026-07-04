"use client";

import { useRouter } from "next/navigation";

function generateRoomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }

  return Math.random().toString(36).slice(2, 10);
}

export function CreateRoomButton() {
  const router = useRouter();

  return (
    <button
      className="primary-button"
      onClick={() => {
        router.push(`/room/${generateRoomId()}`);
      }}
      type="button"
    >
      Create Hangout
    </button>
  );
}
