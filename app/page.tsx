import { CreateRoomButton } from "@/components/create-room-button";

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero-card">
        <p className="eyebrow">Private watch hangout</p>
        <h1>ZebLink</h1>
        <p className="hero-copy">
          Share a screen or tab with one other person using a private hangout link built for just
          the two of you.
        </p>
        <CreateRoomButton />
      </section>
    </main>
  );
}
