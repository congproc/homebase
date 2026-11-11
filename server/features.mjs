// Which optional parts of the dashboard apply to this machine. A feature is shown when it is detected
// (tool installed, something configured, hardware present); "features": {"<id>": true|false} in the config
// forces it on or off. Detection looks at installation, not momentary state, so a stopped Docker daemon or an
// idle Ollama doesn't make a page vanish and reappear.

export const FEATURE_IDS = ['docker', 'tmux', 'ai', 'traffic', 'energy', 'gpu'];

/** Validated overrides from config: only known ids with boolean values. */
export function parseOverrides(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => FEATURE_IDS.includes(k) && typeof v === 'boolean'));
}

/** Detection facts → {id: {on, detected, forced, reason}}. */
export function resolveFeatures(detected, overrides = {}) {
  return Object.fromEntries(FEATURE_IDS.map(id => {
    const d = detected[id] || {detected: false, reason: 'Not detected'};
    const forced = typeof overrides[id] === 'boolean';
    return [id, {on: forced ? overrides[id] : !!d.detected, detected: !!d.detected, forced, reason: d.reason}];
  }));
}

const list = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];

/** Builds the detection facts from what the status collector already gathered. */
export function detectFeatures({which, containers, ollamaOnline, gpu, sites, plugHost}) {
  const ai = [which.claude && 'Claude Code', which.codex && 'Codex', (which.ollama || ollamaOnline) && 'Ollama'].filter(Boolean);
  const gpus = gpu?.available ? gpu.items || [] : [];
  return {
    docker: {detected: which.docker, reason: !which.docker ? 'Docker is not installed' : containers.available ? 'Docker is installed' : `Docker is installed but not usable: ${containers.error || 'no answer'}`},
    tmux: {detected: which.tmux, reason: which.tmux ? 'tmux is installed' : 'tmux is not installed'},
    ai: {detected: ai.length > 0, reason: ai.length ? `${list(ai)} found` : 'No Claude Code, Codex or Ollama found'},
    traffic: {detected: sites > 0, reason: sites ? `${sites} site${sites === 1 ? '' : 's'} configured` : 'No sites under "traffic.sites" in the config'},
    energy: {detected: !!plugHost, reason: plugHost ? `Tapo plug at ${plugHost}` : 'No smart plug under "energy.tapo" in the config'},
    gpu: {detected: gpus.length > 0, reason: gpus.length ? list(gpus.map(g => g.name)) : 'No supported GPU found'},
  };
}
