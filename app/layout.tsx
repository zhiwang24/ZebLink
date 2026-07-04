import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZebLink",
  description: "A minimal private watch hangout for two people.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
