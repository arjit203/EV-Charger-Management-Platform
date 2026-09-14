import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { SocketProvider } from "@/context/SocketContext";
import { AppShell } from "@/components/layout/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EV-CMS",
  description: "EV Charging Management Platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* SocketProvider sits INSIDE AuthProvider: the socket authenticates with the
            logged-in user's JWT, so it cannot open until the session is known. */}
        {/* MODULE 15 — the CMS shell mounts ONCE, here, and decides for itself whether to
            draw chrome: sidebar + topbar for staff, and `children` untouched for the auth
            routes and for DRIVERS, whose pages this module deliberately does not restructure.
            Putting it at the root is what lets every staff page inherit the console without
            editing twenty page files. */}
        <AuthProvider>
          <SocketProvider>
            <AppShell>{children}</AppShell>
          </SocketProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
