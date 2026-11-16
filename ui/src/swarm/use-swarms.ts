import { useCallback, useEffect, useRef, useState } from "react";
import type { SwarmGroup, SwarmSnapshot, SwarmEventData } from "../../../shared/protocol/swarm";
import { readEvents, explainError } from "../api";
import { swarms } from "./api";

export function useSwarms(selected: string | null) {
  const [listedFor, setListedFor] = useState<string | null | undefined>(undefined);
  const [groups, setGroups] = useState<SwarmGroup[]>([]);
  const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(false);
  const selection = useRef(selected); selection.current = selected;
  const generation = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++generation.current, id = selection.current;
    try {
      const list = await swarms.list(signal);
      if (signal?.aborted || version !== generation.current || selection.current !== id) return;
      setGroups(list.groups); setListedFor(id);
      const group = list.groups.find(g => g.managerThreadId === id && g.lifecycle === "active") ?? list.groups.filter(g => g.managerThreadId === id).at(-1);
      const current = group ? await swarms.read(group.id, signal) : null;
      if (signal?.aborted || version !== generation.current || selection.current !== id) return;
      setSnapshot(current); setError(null); setLoading(false);
    } catch (error) { if (!signal?.aborted && version === generation.current) { setError(explainError(error)); setLoading(false); } }
  }, []);
  useEffect(() => {
    const abort = new AbortController(); void refresh(abort.signal);
    return () => { abort.abort(); generation.current++; };
  }, [selected, refresh]);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => void refresh(abort.signal), 200); };
    const connect = async () => {
      const idle = new AbortController();
      let heartbeatTimer: ReturnType<typeof setTimeout>;
      const heartbeat = () => { clearTimeout(heartbeatTimer); heartbeatTimer = setTimeout(() => idle.abort(), 45_000); };
      heartbeat();
      const signal = AbortSignal.any([abort.signal, idle.signal]);
      try {
        const response = await fetch("/api/swarms/events", { signal, credentials: "omit", cache: "no-store" });
        if (!response.ok || !response.body) throw new Error("Roster stream unavailable.");
        if (abort.signal.aborted) return;
        setOnline(true); void refresh(abort.signal);
        // Every connection starts with a fresh snapshot; no worker-by-worker subscriptions.
        await readEvents<SwarmEventData>(response.body, soon, heartbeat, signal, ["swarm", "reset"]);
      } catch { /* Reconnect and obtain a complete snapshot after disconnect/restart. */ }
      finally { clearTimeout(heartbeatTimer!); }
      if (!abort.signal.aborted) { setOnline(false); timer = setTimeout(() => void connect(), 2000); }
    };
    void connect();
    const visible = () => { if (document.visibilityState === "visible") void refresh(abort.signal); };
    document.addEventListener("visibilitychange", visible);
    const poll = setInterval(visible, 60_000);
    return () => { abort.abort(); clearTimeout(timer); clearTimeout(debounce); clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  return { groups, listedFor, snapshot: snapshot?.group.managerThreadId === selected ? snapshot : null, error, loading, online, refresh };
}
