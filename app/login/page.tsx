"use client";

import Link from "next/link";
import { useState } from "react";

/** Sign-in for a private deployment (only reachable when APP_PASSWORD is set). */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (res?.ok) {
      const next = new URLSearchParams(window.location.search).get("next");
      // only ever follow a same-site path
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
      return;
    }
    setError(res?.status === 401 ? "Wrong password" : "Could not sign in");
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xs flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">
        Ever<span className="text-cyan-400">play</span>
      </h1>
      <p className="text-sm text-zinc-400">This is a private app. Enter the password to continue.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-500"
        />
        <button
          disabled={busy || !password}
          className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium hover:bg-cyan-500 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>
      <Link href="/welcome" className="text-xs text-zinc-500 hover:text-cyan-300">
        ← What is Everplay?
      </Link>
    </main>
  );
}
