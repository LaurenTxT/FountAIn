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

// Brand artwork from Lobe Icons, revision 05260484d9f4de68f90cc87a634ae68fa4043efd.
const brands: Record<string, string> = {
  gemini: gemini_color, antigravity: gemini_color, claude: claude_color,
  codex: openai, deepseek: deepseek_color, dsh: deepseek_color, cursor,
  qwen: qwen_color, kimi: kimi_color, minimax: minimax_color, glm: zhipu_color, grok,
};

function brand(member: TeamMember) {
  return brands[member.id] ?? brands[member.executor.replace(/^acp:/, '')];
}

export function MemberSelect({ children, className = '', ...props }: ComponentProps<'select'>) {
  const team = useTeam();
  if (!globalThis.CSS?.supports('appearance', 'base-select')) {
    return <select {...props} className={className}>{children}</select>;
  }

  const options = Children.toArray(children);
  const usedBrands = options.map(option => {
    if (!isValidElement<{ value?: string }>(option) || option.type !== 'option') return undefined;
    const member = team.get(option.props.value ?? '');
    return member && brand(member);
  });

  return <select {...props} className={`member-select ${className}`}>
    <button type="button">{createElement('selectedcontent')}</button>
    {options.map((option, index) => {
      const mark = usedBrands[index];
      if (!mark || !isValidElement<{ value?: string; children?: ReactNode; title?: string; 'aria-label'?: string }>(option)) return option;
      const label = Children.toArray(option.props.children).join('');
      const member = team.get(option.props.value ?? '');
      const onlyName = label === member?.name || label === member?.card.name || label === `交给 ${member?.name}`;
      const needsLabel = !onlyName || usedBrands.indexOf(mark) !== usedBrands.lastIndexOf(mark);
      return cloneElement(option, { title: label, 'aria-label': label }, <>
        <span className="member-select-mark"><img src={mark} alt="" /></span>
        <span className={needsLabel ? undefined : 'member-select-name'}>{option.props.children}</span>
      </>);
    })}
  </select>;
}
