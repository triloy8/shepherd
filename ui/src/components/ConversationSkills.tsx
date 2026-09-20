import { useEffect, useRef, useState } from "react";
import type { WebSkillsResponse } from "../../../shared/protocol/web";
import { api, explainError } from "../api";

/** Workspace discovery and shared skill configuration, independent of model settings. */
export function ConversationSkills({ id, disabled }: { id: string; disabled: boolean }) {
  const [data, setData] = useState<WebSkillsResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const mutation = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    const abort = new AbortController();
    setBusy(true); setData(null); setError(null); setNotice(null);
    void api.skills(id, abort.signal).then((value) => {
      if (generation.current === version) setData(value);
    }).catch((error) => {
      if (generation.current === version) setError(explainError(error));
    }).finally(() => { if (generation.current === version) setBusy(false); });
    return () => { generation.current++; abort.abort(); };
  }, [id]);

  async function change(path?: string, enabled?: boolean) {
    if (mutation.current || busy || disabled) return;
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    const version = generation.current;
    try {
      if (path !== undefined && enabled !== undefined) {
        const result = await api.setSkill(id, path, enabled);
        if (version !== generation.current) return;
        setData((current) => current && ({ data: current.data.map((entry) => ({ ...entry, skills: entry.skills.map((skill) => skill.path === path ? { ...skill, enabled: result.effectiveEnabled } : skill) })) }));
        setNotice(result.effectiveEnabled === enabled ? "Skill setting saved." : "Setting saved, but the effective state differs. A configuration policy may override it.");
      } else {
        const result = await api.reloadSkills(id);
        if (version !== generation.current) return;
        setData(result); setNotice("Skill discovery reloaded.");
      }
    } catch (error) {
      if (version === generation.current) {
        setData(null);
        setError(`${explainError(error)} Reload skills to check the current state before trying again.`);
      }
    } finally {
      mutation.current = false;
      if (version === generation.current) setBusy(false);
    }
  }
  const normalized = query.trim().toLowerCase();
  const count = data?.data.reduce((sum, entry) => sum + entry.skills.length, 0) ?? 0;
  const matches = (skill: { name: string; description: string; path: string; scope: string }) => [skill.name, skill.description, skill.path, skill.scope].some((value) => value.toLowerCase().includes(normalized));
  const visible = data?.data.some((entry) => entry.skills.some(matches));
  return <section className="mt-4 space-y-3" aria-label="Skills">
    <p className="text-xs text-muted">Available in this conversation’s workspace. Enable and disable changes update shared Codex configuration and can affect other conversations. Reload after installing or editing skills.</p>
    <button className="button-secondary" disabled={disabled || busy} onClick={() => void change()}>Reload skills</button>
    {busy && <p role="status" className="text-xs text-muted">Loading or updating skills…</p>}
    {error && <p role="alert" className="notice">{error}</p>}
    {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
    {count > 0 && <label className="block text-xs text-muted">Filter skills<input aria-label="Filter skills" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, description, scope, or path" /></label>}
    {data && count === 0 && <p className="text-xs text-muted">No skills found in this workspace.</p>}
    {count > 0 && !visible && <p className="text-xs text-muted">No skills match this filter.</p>}
    {data?.data.map((entry, index) => <div key={`${entry.cwd}:${index}`} className="space-y-3">
      <p className="break-all text-xs text-muted">Workspace: {entry.cwd}</p>
      {entry.errors.map((error, index) => <p key={`${error.path}:${index}`} role="alert" className="notice break-words">{error.path}: {error.message}</p>)}
      {entry.skills.filter(matches).map((skill) => <article key={skill.path} className="space-y-2 rounded-lg border border-line p-3" aria-label={`${skill.name} (${skill.scope})`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-all text-sm font-medium">{skill.name}</h4><span className="text-xs text-muted">{skill.scope} · {skill.enabled ? "Enabled" : "Disabled"}</span></div>
        <p className="break-words text-xs text-muted">{skill.description}</p>
        <details className="text-xs text-muted"><summary className="cursor-pointer">Skill path</summary><p className="mt-2 break-all">{skill.path}</p></details>
        <button className="button-secondary" aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name} (${skill.scope})`} disabled={disabled || busy} onClick={() => void change(skill.path, !skill.enabled)}>{skill.enabled ? "Disable" : "Enable"}</button>
      </article>)}
    </div>)}
  </section>;
}
