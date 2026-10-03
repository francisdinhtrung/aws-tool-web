// Minimal, comment-preserving INI handling for ~/.aws/config and ~/.aws/credentials.
// Section names may contain dots (e.g. [profile my.dev]), which generic INI libs mangle.

const isComment = (l) => /^\s*[#;]/.test(l);
// Indented lines are sub-properties (e.g. "s3 =\n  max_concurrent_requests = 10").
const isNested = (l) => /^\s+\S/.test(l) && !isComment(l);

export function parseIni(text) {
  const sections = [{ name: null, lines: [] }];
  for (const line of (text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (m) sections.push({ name: m[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

export function readEntries(section) {
  const out = {};
  for (const l of section.lines) {
    if (!l.trim() || isComment(l) || isNested(l)) continue;
    const i = l.indexOf('=');
    if (i < 0) continue;
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

// Update a section in place: unchanged keys keep their original line (and nested
// sub-properties), removed keys are dropped, new keys are appended.
export function writeEntries(section, values) {
  const remaining = { ...values };
  const lines = [];
  let dropNested = false;
  for (const l of section.lines) {
    if (isNested(l)) {
      if (!dropNested) lines.push(l);
      continue;
    }
    dropNested = false;
    const i = l.indexOf('=');
    if (!l.trim() || isComment(l) || i < 0) {
      lines.push(l);
      continue;
    }
    const k = l.slice(0, i).trim();
    if (Object.prototype.hasOwnProperty.call(remaining, k)) {
      const v = remaining[k];
      delete remaining[k];
      lines.push(v === l.slice(i + 1).trim() ? l : `${k} = ${v}`);
    } else {
      dropNested = true;
    }
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const [k, v] of Object.entries(remaining)) lines.push(`${k} = ${v}`);
  lines.push('');
  section.lines = lines;
}

export function serializeIni(sections) {
  const out = [];
  let afterSection = false;
  for (const s of sections) {
    if (s.name !== null) {
      // Separate sections with a blank line, but leave the file header (comments before the first section) as is.
      if (afterSection && out[out.length - 1].trim()) out.push('');
      afterSection = true;
      out.push(`[${s.name}]`);
    }
    out.push(...s.lines);
  }
  let text = out.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  if (text && !text.endsWith('\n')) text += '\n';
  return text;
}
