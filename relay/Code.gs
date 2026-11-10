const RELAY_DEFAULT_ACK_TAG = '精选：本期看过';
const RELAY_TRIGGER = 'paperRelayTick';

function relayStatus() {
  const ports = relayPorts_();
  const note = ports.readNote();
  const issue = relayMarkdown_(ports.readDrive(), ports.ackTag);
  const status = {
    noteDate: relayNoteDate_(note.note),
    driveDate: issue.date,
    checked: note.tags.some(tag => tag.tag === ports.ackTag),
    reportHasCards: issue.complete
  };
  console.log(JSON.stringify(status));
  return status;
}

function installPaperRelay() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const status = relayStatus();
    if (status.noteDate > status.driveDate) throw Error('Zotero 期号晚于 Drive，请核对两个目标。');
    if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === RELAY_TRIGGER)) {
      ScriptApp.newTrigger(RELAY_TRIGGER).timeBased().everyMinutes(5).create();
    }
  } finally {
    lock.releaseLock();
  }
}

function pausePaperRelay() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    for (const trigger of ScriptApp.getProjectTriggers()) {
      if (trigger.getHandlerFunction() === RELAY_TRIGGER) ScriptApp.deleteTrigger(trigger);
    }
  } finally {
    lock.releaseLock();
  }
}

function paperRelayTick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    console.log(relayTick_(relayPorts_()));
  } finally {
    lock.releaseLock();
  }
}

function relayTick_(ports) {
  const note = ports.readNote();
  const noteDate = relayNoteDate_(note.note);
  if (!note.tags.some(tag => tag.tag === ports.ackTag)) {
    return 'paused: waiting for Zotero acknowledgment';
  }

  // The generator enforces the schedule and only writes the current report as its final step.
  const issue = relayMarkdown_(ports.readDrive(), ports.ackTag);
  if (issue.date <= noteDate || !issue.complete) return 'waiting: no newer complete Drive issue';
  const tags = note.tags.filter(tag => tag.tag !== ports.ackTag);
  if (!ports.writeNote(note.version, relayWrapNote_(issue.html, note.note), tags)) {
    return 'retrying: the Zotero note changed or is locked';
  }
  return 'published: Zotero updated and acknowledgment reset';
}

function relayWrapNote_(html, previous) {
  const schema = String(previous).match(/^\s*<div\b[^>]*\bdata-schema-version=["'](\d+)["'][^>]*>/i);
  return '<div data-schema-version="' + (schema ? schema[1] : '9') + '">' + html + '</div>';
}

function relayNoteDate_(html) {
  const plain = String(html).replace(/<[^>]*>/g, ' ').replace(/&#(?:xFF5C|65372);/gi, '｜').trim();
  return relayDate_(plain, 'Zotero 笔记标题');
}

function relayDate_(value, label) {
  const match = value.match(/^今日精选\s*[｜|]\s*(\d{4}-\d{2}-\d{2})(?=$|\s)/);
  const date = match && new Date(match[1] + 'T00:00:00Z');
  if (!date || isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) {
    throw Error(label + '必须以“今日精选｜YYYY-MM-DD”开头，且期号必须为有效日期。');
  }
  return match[1];
}

function relayMarkdown_(markdown, ackTag) {
  const text = String(markdown).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimStart();
  const heading = text.match(/^# ([^\n]+)(?:\n|$)/);
  if (!heading) throw Error('Drive 的今日精选缺少 Markdown 一级标题。');
  const title = heading[1].trim();
  const date = relayDate_(title, 'Drive 报告标题');
  const blocks = text.slice(heading[0].length).split(/^[ \t]*```[^\n]*$/m);
  if (blocks.length % 2 === 0) throw Error('Drive 报告有未闭合的代码块。');
  const plain = blocks.filter((_, index) => index % 2 === 0).join('\n');
  const cards = [...plain.matchAll(/^## (\d+)(?:\.[ \t]+|[ \t]*·[ \t]*)[^\n]+$/gm)];
  const complete = cards.length > 0 && cards.every((card, index) => {
    const body = plain.slice(card.index + card[0].length, cards[index + 1]?.index);
    return Number(card[1]) === index + 1 && /\]\(https:\/\/[^\s<>"'()]+\)/.test(body);
  });
  const instructions = '<p>浏览完本期后，给这条笔记添加“' + relayEscape_(ackTag) +
    '”标签。若已分配数字快捷键，可在条目列表选中笔记后按对应数字。想读哪篇，再打开原文收藏。</p>';
  const html = blocks.map((block, index) => index % 2
    ? '<pre>' + relayEscape_(block.trim()) + '</pre>'
    : block.split('\n').filter(line => line.trim()).map(relayLine_).join('')).join('');
  return {date, complete, html: '<h1>' + relayInline_(title) + '</h1>' + instructions + html};
}

function relayLine_(line) {
  const header = line.match(/^(#{1,6})\s+(.+)$/);
  if (header) return '<h' + header[1].length + '>' + relayInline_(header[2]) + '</h' + header[1].length + '>';
  return '<p>' + relayInline_(line.replace(/^\s*[-*]\s+/, '• ')) + '</p>';
}

function relayInline_(value) {
  const tokens = /\[([^\]\n]+)\]\((https:\/\/[^\s<>"'()]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let html = '';
  let end = 0;
  for (const match of value.matchAll(tokens)) {
    html += relayEscape_(value.slice(end, match.index));
    if (match[2]) html += '<a href="' + relayEscape_(match[2]) + '">' + relayEscape_(match[1]) + '</a>';
    else if (match[3]) html += '<code>' + relayEscape_(match[3]) + '</code>';
    else html += '<strong>' + relayEscape_(match[4]) + '</strong>';
    end = match.index + match[0].length;
  }
  return html + relayEscape_(value.slice(end));
}

function relayEscape_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relayPorts_() {
  const props = PropertiesService.getScriptProperties();
  const value = name => (props.getProperty(name) || '').trim();
  const userId = value('ZOTERO_USER_ID');
  const noteKey = value('ZOTERO_NOTE_KEY');
  const key = value('ZOTERO_WRITE_KEY');
  const driveId = value('DRIVE_TODAY_FILE_ID');
  if (!/^\d+$/.test(userId)) throw Error('请设置数字类型的 ZOTERO_USER_ID。');
  if (!/^[A-Z0-9]{8}$/.test(noteKey)) throw Error('请设置 8 位 ZOTERO_NOTE_KEY。');
  if (!key) throw Error('请设置 ZOTERO_WRITE_KEY。');
  if (!/^[A-Za-z0-9_-]+$/.test(driveId)) throw Error('请将 DRIVE_TODAY_FILE_ID 设置为文件 ID，而不是链接。');

  const url = 'https://api.zotero.org/users/' + userId + '/items/' + noteKey + '?format=json';
  const headers = {'Zotero-API-Key': key, 'Zotero-API-Version': '3'};
  return {
    ackTag: value('PAPER_ACK_TAG') || RELAY_DEFAULT_ACK_TAG,
    readDrive: () => DriveApp.getFileById(driveId).getBlob().getDataAsString('UTF-8'),
    readNote() {
      const response = UrlFetchApp.fetch(url, {headers, muteHttpExceptions: true});
      const code = response.getResponseCode();
      if (code !== 200) throw Error('读取 Zotero 笔记失败，HTTP ' + code);
      const item = JSON.parse(response.getContentText()).data;
      if (!item || item.key !== noteKey || item.itemType !== 'note' || item.parentItem || item.deleted ||
          typeof item.note !== 'string' || !Number.isInteger(item.version) || !Array.isArray(item.tags)) {
        throw Error('目标必须是个人文库中的独立 Zotero 笔记。');
      }
      return item;
    },
    writeNote(version, html, tags) {
      const response = UrlFetchApp.fetch(url, {method: 'patch', contentType: 'application/json',
        headers: {...headers, 'If-Unmodified-Since-Version': String(version)},
        payload: JSON.stringify({note: html, tags}), muteHttpExceptions: true});
      const code = response.getResponseCode();
      if (code === 409 || code === 412) return false;
      if (code !== 204) throw Error('更新 Zotero 笔记失败，HTTP ' + code);
      return true;
    }
  };
}
