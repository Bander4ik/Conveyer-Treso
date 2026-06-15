import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "./_sidebar";

export const metadata: Metadata = {
  title: "Conveyer Treso",
  description: "Mystical animated-stills video pipeline — script in, finished MP4 out.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 px-8 py-8 max-w-5xl">{children}</main>
        </div>
      </body>
    </html>
  );
}
