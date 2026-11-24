import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import type { AdapterContext } from '../../shared/types';
import { IMAGE_SEND_MAX } from '../../shared/attachments';
import { ocrImageLocal } from './windows-ocr';

/** Recheck stored copies before delivery; skip missing or unsupported pictures instead of poisoning the room turn. */
function images(context: AdapterContext) {
  const valid: NonNullable<AdapterContext['attachments']> = [];
  for (const item of (context.attachments ?? []).filter(item => item.kind === 'image' && item.size <= IMAGE_SEND_MAX)) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mime)) {
      context.emit('warning', `图片「${item.name}」的格式不受支持，已跳过。`, undefined, 'derived');
      continue;
    }
    try {
      const info = statSync(item.path);
      if (!info.isFile() || info.size !== item.size || info.size > IMAGE_SEND_MAX) throw new Error();
      accessSync(item.path, constants.R_OK);
      valid.push(item);
    } catch {
      context.emit('warning', `图片「${item.name}」已不存在或无法读取，已跳过。`, undefined, 'derived');
    }
  }
  return valid;
}

/** Codex app-server reads an explicitly attached local picture as part of this turn's input. */
export function codexImages(context: AdapterContext) {
  return images(context).map(item => ({ type: 'localImage' as const, path: item.path }));
}

/** ACP inline images are canonical base64; capability is checked on the actual connection, including reuse. */
export function acpPrompt(context: AdapterContext, text: string, supportsImages: boolean) {
  const attached = images(context);
  if (attached.length && !supportsImages) {
    const extracted = attached.slice(0, 4).map(item => ({ name: item.name, text: ocrImageLocal(item.path) }));
    const withText = extracted.filter(item => item.text.length > 0);
    if (withText.length) {
      context.emit('status', `当前连接为纯文本模型，已通过本地 OCR 提取 ${withText.length} 张图片的文字内容附给成员。`, undefined, 'derived');
      const blocks = withText.map(item => `--- 图片「${item.name}」本地 OCR 文字 ---\n${item.text}`).join('\n\n');
      const missingNote = withText.length < attached.length ? '\n（另有未识别出文字的图片，请勿猜测其画面内容。）' : '';
      return [{ type: 'text' as const, text: `${text}\n\n[本轮附件图片文字识别（Windows 本地 OCR，代码符号可能偶有轻微误差，请结合上下文理解）]\n${blocks}${missingNote}` }];
    }
    const note = '本次实际连接没有声明支持图片输入，且本地 OCR 未从图片中识别到可读文字。不要猜测图里有什么；需要时请用户描述。';
    context.emit('warning', note, undefined, 'derived');
    return [{ type: 'text' as const, text: `${text}\n\n[本轮附件投递说明]\n${note}` }];
  }
  return [{ type: 'text' as const, text }, ...attached.map(item => {
    let data: Buffer;
    try { data = readFileSync(item.path); } catch { throw new Error(`图片「${item.name}」无法读取，请重新添加。`); }
    if (data.length !== item.size) throw new Error(`图片「${item.name}」已改变，请重新添加。`);
    return { type: 'image' as const, mimeType: item.mime, data: data.toString('base64') };
  })];
}
