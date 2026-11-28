import { Children, cloneElement, createElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { useTeam, type TeamMember } from './members';
import './member-select.css';

import gemini_color from './assets/brands/gemini-color.svg';
import claude_color from './assets/brands/claude-color.svg';
import openai from './assets/brands/openai.svg';
import deepseek_color from './assets/brands/deepseek-color.svg';
import cursor from './assets/brands/cursor.svg';
import qwen_color from './assets/brands/qwen-color.svg';
import kimi_color from './assets/brands/kimi-color.svg';
import minimax_color from './assets/brands/minimax-color.svg';
import zhipu_color from './assets/brands/zhipu-color.svg';
import grok from './assets/brands/grok.svg';
import qoder from './assets/brands/qoder-color.svg';
import opencode from './assets/brands/opencode.svg';

// Brand artwork from Lobe Icons, revision 05260484d9f4de68f90cc87a634ae68fa4043efd.
const brands: Record<string, string> = {
  gemini: gemini_color, antigravity: gemini_color, claude: claude_color,
  codex: openai, chatgpt: openai, openai, deepseek: deepseek_color, dsh: deepseek_color, cursor,
  qwen: qwen_color, kimi: kimi_color, minimax: minimax_color, glm: zhipu_color, zcode: zhipu_color, grok,
  qoder, qodercn: qoder, opencode,
};
const monochrome = new Set([openai, cursor, grok, opencode]);

function brand(member: TeamMember) {
  const candidates = [
    member.catalogId, member.executor.replace(/^acp[-:]/, ''), member.product, member.name,
  ];
  for (const candidate of candidates) {
    const key = candidate?.toLowerCase().trim();
    if (!key) continue;
    if (Object.hasOwn(brands, key)) return brands[key];
    const prefix = key.split(/[\s/·–—-]+/)[0];
    if (Object.hasOwn(brands, prefix)) return brands[prefix];
  }
  return undefined;
}

export function MemberSelect({ children, className = '', ...props }: ComponentProps<'select'>) {
  const team = useTeam();
  if (!globalThis.CSS?.supports('appearance', 'base-select')) {
    return <select {...props} className={className}>{children}</select>;
  }

  const options = Children.toArray(children);
  const members = options.map(option => {
    if (!isValidElement<{ value?: string }>(option) || option.type !== 'option') return undefined;
    const member = team.get(option.props.value ?? '');
    return member && { member, mark: brand(member) };
  });

  return <select {...props} className={`member-select ${className}`}>
    <button type="button">{createElement('selectedcontent')}</button>
    {options.map((option, index) => {
      const entry = members[index];
      if (!entry || !isValidElement<{ value?: string; children?: ReactNode; title?: string; 'aria-label'?: string }>(option)) return option;
      const label = Children.toArray(option.props.children).join('');
      const { member, mark } = entry;
      const onlyName = label === member?.name || label === member?.card.name || label === `交给 ${member?.name}`;
      const needsLabel = !onlyName || !mark || members.filter(item => item?.mark === mark).length > 1;
      return cloneElement(option, { title: label, 'aria-label': label }, <span className="member-select-choice">
        {mark ? (monochrome.has(mark)
          ? <span className="member-select-mark mono" aria-hidden="true" style={{ maskImage: `url(${JSON.stringify(mark)})` }} />
          : <img className="member-select-mark" src={mark} alt="" />)
          : <span className="member-select-mark initial" aria-hidden="true">{Array.from(member.name.trim())[0]?.toUpperCase() ?? '·'}</span>}
        <span className={needsLabel ? 'member-select-label' : 'member-select-name'}>{option.props.children}</span>
      </span>);
    })}
  </select>;
}
