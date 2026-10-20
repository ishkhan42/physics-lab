export const MAX_MODEL_TEXT_CHARS = 524288;

export function modelTextContent(text: string): { type: 'text'; text: string }[] {
  const content: { type: 'text'; text: string }[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_MODEL_TEXT_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    content.push({ type: 'text', text: text.slice(start, end) });
    start = end;
  }
  return content;
}
