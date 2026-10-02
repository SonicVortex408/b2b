"use client";

import { useState } from "react";
import { useStore } from "@/store/useStore";

const DEMO = ["student@xie.demo", "faculty@xie.demo", "approver@xie.demo", "admin@xie.demo"];

/** Supabase Auth sign-in (replaces the demo role switcher when Supabase is configured). */
export function AuthControl() {
  const session = useStore((s) => s.session);
  const signIn = useStore((s) => s.signIn);
  const signOut = useStore((s) => s.signOut);
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(DEMO[0]);
  const [password, setPassword] = useState(process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session)
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="hidden text-right leading-tight sm:block">
          <b>{session.name}</b>
          <span className="block font-mono text-[10px] uppercase tracking-widest text-muted">{session.role}</span>
        </span>
        <button onClick={() => void signOut()} className="rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs">
          Sign out
        </button>
      </div>
    );

  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md border border-navy/30 px-3 py-1.5 text-sm font-semibold">
        Sign in
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-navy/40 p-4" onClick={() => setOpen(false)}>
          <form
            className="surface w-full max-w-sm space-y-3 rounded-2xl border p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const err = await signIn(email, password);
              setBusy(false);
              if (err) return setError(err);
              setOpen(false);
              toast({ title: "Signed in", body: email, tone: "ok" });
            }}
          >
            <h2 className="font-display text-xl font-bold">Sign in to XIE Spaces</h2>
            <div className="grid grid-cols-2 gap-1.5">
              {DEMO.map((d) => (
                <button type="button" key={d} onClick={() => setEmail(d)} className={`rounded-md border px-2 py-1.5 text-xs ${email === d ? "border-brand bg-brand text-white" : "border-[var(--line)]"}`}>
                  {d.split("@")[0]}
                </button>
              ))}
            </div>
            <label className="block text-xs">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" className="mt-1 w-full rounded-md border border-[var(--line)] bg-transparent px-2 py-2 text-sm" />
            </label>
            <label className="block text-xs">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Password</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" className="mt-1 w-full rounded-md border border-[var(--line)] bg-transparent px-2 py-2 text-sm" />
            </label>
            {error && <p className="text-xs text-busy">{error}</p>}
            <button disabled={busy} className="w-full rounded-md bg-brand py-2 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
