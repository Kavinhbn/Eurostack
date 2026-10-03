import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import "./site.css";

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
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable} ${GeistSans.className}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
