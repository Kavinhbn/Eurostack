import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rackwise | Evidence-led Eurorack planning",
  description: "A source-grounded agent for Eurorack fit, power, depth, and compatibility checks.",
  icons: {
    icon: "/rackwise-mark.svg",
    shortcut: "/rackwise-mark.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
