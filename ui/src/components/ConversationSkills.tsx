import { useEffect, useRef, useState } from "react";
import type { WebSkillsResponse } from "../../../shared/protocol/web";
import { api, explainError } from "../api";

/** Workspace discovery and shared skill configuration, independent of model settings. */
export function ConversationSkills({ id, disabled }: { id: string; disabled: boolean }) {
  const [data, setData] = useState<import("../../../shared/protocol/v2/conversations").SkillList | null>(null);
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
        setData(current => current && ({ ...current, skills: current.skills.map(skill => skill.referenceId === path ? { ...skill, enabled: result.enabled } : skill) }));
        setNotice("Skill setting saved.");
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
  const skills = data?.skills ?? [];
  const visible = skills.filter(skill => [skill.name, skill.description].some(value => value.toLowerCase().includes(normalized)));
  return <section className="mt-4 space-y-3" aria-label="Skills">
    <p className="text-xs text-muted">Available in this conversation’s workspace. Configuration changes can affect other conversations. Reload after installing or editing skills.</p>
    <button className="button-secondary" disabled={disabled || busy} onClick={() => void change()}>Reload skills</button>
    {busy && <p role="status" className="text-xs text-muted">Loading or updating skills…</p>}
    {error && <p role="alert" className="notice">{error}</p>}{notice && <p role="status" className="text-xs text-muted">{notice}</p>}
    {data?.warnings.map((warning, index) => <p key={index} role="alert" className="notice">{warning}</p>)}
    {!!data?.omitted && <p className="text-xs text-muted">{data.omitted} additional skills are omitted from this list.</p>}
    {skills.length > 0 && <label className="block text-xs text-muted">Filter skills<input aria-label="Filter skills" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or description" /></label>}
    {data && !skills.length && <p className="text-xs text-muted">No skills found in this workspace.</p>}
    {skills.length > 0 && !visible.length && <p className="text-xs text-muted">No skills match this filter.</p>}
    {visible.map(skill => <article key={skill.referenceId} className="space-y-2 rounded-lg border border-line p-3" aria-label={skill.name}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-all text-sm font-medium">{skill.name}</h4><span className="text-xs text-muted">{skill.enabled ? "Enabled" : "Disabled"}</span></div>
      <p className="break-words text-xs text-muted">{skill.description}</p>
      <button className="button-secondary" aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} disabled={disabled || busy} onClick={() => void change(skill.referenceId, !skill.enabled)}>{skill.enabled ? "Disable" : "Enable"}</button>
    </article>)}
  </section>;
}
