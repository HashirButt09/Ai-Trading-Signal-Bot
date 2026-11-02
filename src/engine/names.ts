import { STRATEGY_LABEL, type Signal } from './types.js';
import { CHART_NAME } from './chartpatterns.js';
import { PATTERN_INFO } from './patterns.js';

/** "Double top (1h)", "Hammer" or the playbook name for the original playbooks */
export function playName(s: Signal): string {
  if (s.pattern) {
    const n = (CHART_NAME as Record<string, string>)[s.pattern] ?? PATTERN_INFO[s.pattern]?.name ?? s.pattern;
    return s.patternTf && s.patternTf !== s.ltf ? `${n} (${s.patternTf})` : n;
  }
  return STRATEGY_LABEL[s.strategy];
}
