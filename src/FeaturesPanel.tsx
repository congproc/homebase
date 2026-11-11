import {BarChart3, Box, Gauge, Plug, Terminal, Zap} from 'lucide-react';
import {Panel, Pill} from './components/panels';
import type {FeatureId, Features} from './lib/types';

const INFO: Record<FeatureId, {name: string; icon: React.ElementType; where: string; enable: string}> = {
  docker: {name: 'Containers', icon: Box, where: 'Containers page, Overview panel', enable: 'Install Docker Engine and add your account to the docker group.'},
  tmux: {name: 'Tmux sessions', icon: Terminal, where: 'Tmux page, Overview panel, “Start in tmux” for agents', enable: 'Install tmux (sudo apt install tmux).'},
  ai: {name: 'AI services', icon: Zap, where: 'AI services page, Overview panel', enable: 'Install Claude Code, Codex or Ollama.'},
  traffic: {name: 'Traffic', icon: BarChart3, where: 'Traffic page and security alerts', enable: 'Add your sites under "traffic.sites" in the config.'},
  energy: {name: 'Power monitor', icon: Plug, where: 'Energy page, Power card on Overview', enable: 'Add a Tapo P110 / P110M / P115 plug under "energy.tapo" in the config.'},
  gpu: {name: 'GPU', icon: Gauge, where: 'GPU card and charts on Resources', enable: 'Appears by itself when an NVIDIA, AMD or Intel GPU is present.'},
};

/** What the dashboard shows on this machine and why, so hidden features are never a mystery. */
export default function FeaturesPanel({features}: {features?: Features}) {
  if (!features) return null;
  const ids = Object.keys(INFO) as FeatureId[];
  const hidden = ids.filter(id => !features[id]?.on).length;
  return (
    <Panel title="Features on this machine" sub={hidden ? `${hidden} hidden because they don’t apply here` : 'Everything applies to this machine'}>
      <div className="feature-list">
        {ids.map(id => {
          const f = features[id], info = INFO[id], Icon = info.icon;
          if (!f) return null;
          return <div key={id} className={`feature-row${f.on ? '' : ' off'}`}>
            <span className="feature-icon"><Icon size={16} /></span>
            <div>
              <strong>{info.name}</strong>
              <small>{f.reason}{f.forced ? ` · ${f.on ? 'shown' : 'hidden'} by "features" in the config` : ''}</small>
              <small className="dim">{f.on ? info.where : f.forced ? `Remove "${id}" from "features" in the config to detect it again.` : info.enable}</small>
            </div>
            <Pill on={f.on}>{f.on ? 'Shown' : 'Hidden'}</Pill>
          </div>;
        })}
      </div>
      <p className="feature-foot">Detected automatically. To force one, add <code>{'"features": {"docker": false}'}</code> (or <code>true</code>) to <code>~/.config/homebase/config.json</code> and restart Homebase.</p>
    </Panel>
  );
}
