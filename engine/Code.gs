const PAPER_FILES = Object.freeze({
  today: '今日精选.md', history: '历史索引.md', recent: '近期推荐与候选.md',
  archive: '图文归档.md', preferences: '选读偏好.md', index: '论文去重数据.json'
});
const PAPER_JOB = 'PAPER_GENERATOR_JOB';
const PAPER_SOURCE = 'zotero-paper-workflow';

function setupPaperLibrary() {
  return paperLocked_(() => {
    const config = paperConfig_();
    const date = Utilities.formatDate(new Date(), config.zone, 'yyyy-MM-dd');
    const contents = {
      today: '# 今日精选｜' + date + '\n\n欢迎使用论文精选。确认已准备好阅读后，在 Zotero 里给这条笔记添加签到标签。首期最早在签到后的次日生成。\n',
      history: '# 历史索引\n', recent: '# 近期推荐与候选\n', archive: '# 图文归档\n',
      preferences: '# 选读偏好\n\n- 优先关键词：\n- 排除关键词：\n\n关键词用中文逗号、英文逗号或分号分隔，与公开论文题名及摘要按字面匹配。\n',
      index: JSON.stringify({version: 1, offsets: {}, editions: [], pool: [], exclusions: []})
    };
    const files = paperFiles_(config.folderId, contents);
    const currentDate = paperDateFromReport_(files.today.read());
    paperReadIndex_(files.index.read());
    console.log(JSON.stringify({DRIVE_TODAY_FILE_ID: files.today.id, zoteroHeading: '今日精选｜' + currentDate}));
  });
}

function verifyPaperGenerator() {
  const config = paperConfig_();
  const note = paperReadZotero_(config);
  const view = paperFiles_(config.folderId);
  const date = paperDateFromReport_(view.today.read());
  if (note.date !== date) throw Error('Zotero 和 Drive 当前期号不一致。请先完成同步或核对初始笔记标题。');
  const candidates = paperCandidates_(paperReadIndex_(view.index.read()), view.preferences.read());
  console.log(JSON.stringify({issue: date, acknowledged: note.checked, candidates: candidates.length,
    venues: [...new Set(candidates.map(paper => paper.venue))], modelConfigured: !!config.geminiKey}));
}

function installPaperGenerator() {
  return paperLocked_(() => {
    const config = paperConfig_();
    paperRequireModel_(config);
    const note = paperReadZotero_(config);
    const view = paperFiles_(config.folderId);
    if (note.date !== paperDateFromReport_(view.today.read())) throw Error('Zotero 和 Drive 当前期号不一致。');
    paperReadIndex_(view.index.read());
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'paperGeneratorTick')) {
      ScriptApp.newTrigger('paperGeneratorTick').timeBased().everyMinutes(5).create();
    }
    console.log('生成触发器已安装。');
  });
}

function pausePaperGenerator() {
  return paperLocked_(() => {
    for (const trigger of ScriptApp.getProjectTriggers()) {
      if (trigger.getHandlerFunction() === 'paperGeneratorTick') ScriptApp.deleteTrigger(trigger);
    }
  });
}

function retryPaperGeneration() {
  return paperLocked_(() => {
    const props = PropertiesService.getScriptProperties();
    const job = JSON.parse(props.getProperty(PAPER_JOB) || 'null');
    if (job && job.attempted) {
      job.attempted = false;
      props.setProperty(PAPER_JOB, JSON.stringify(job));
    }
    console.log('已允许下一个符合条件的检查重试。');
  });
}

function paperGeneratorTick() {
  return paperLocked_(() => {
    const config = paperConfig_();
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const ports = {
      note: () => paperReadZotero_(config),
      load: () => JSON.parse(props.getProperty(PAPER_JOB) || 'null'),
      save: job => job ? props.setProperty(PAPER_JOB, JSON.stringify(job)) : props.deleteProperty(PAPER_JOB),
      view: () => paperFiles_(config.folderId),
      candidates: paperCandidates_,
      generate: (date, papers) => {
        paperRequireModel_(config);
        const result = checkCodeLinks_(generate_(papers, config.geminiKey, config.model));
        return makeEdition_(date, result);
      }
    };
    const status = paperRun_(ports, Utilities.formatDate(now, config.zone, 'yyyy-MM-dd'),
      Utilities.formatDate(now, config.zone, 'HH:mm'), config.releaseTime);
    console.log(status);
    return status;
  });
}

function paperRun_(ports, today, time, releaseTime) {
  const note = ports.note();
  let job = ports.load();
  if (!note.checked) {
    if (job && (!job.request || job.previous !== note.date)) ports.save(null);
    return '等待 Zotero 签到。';
  }
  if (!job || job.previous !== note.date) {
    const observed = note.ackDate;
    job = {previous: note.date, ackDate: observed && observed >= note.date && observed <= today ? observed : today};
    ports.save(job);
  }
  const due = new Date(job.ackDate + 'T00:00:00Z');
  due.setUTCDate(due.getUTCDate() + 1);
  if (today < due.toISOString().slice(0, 10) || time < releaseTime) return '已签到，等待次日生成时间。';

  const view = ports.view();
  const previous = view.today.read();
  const date = paperDateFromReport_(previous);
  if (date > job.previous) return '新一期已发布，等待 Zotero 同步。';
  if (date !== job.previous) throw Error('Drive 和已签到的 Zotero 期号不一致。');
  if (!job.request) {
    job.request = today;
    ports.save(job);
  }

  let indexText = view.index.read();
  const state = paperReadIndex_(indexText);
  const saved = state.editions.find(edition => edition.date === job.request);
  let edition = state.pending;
  if (edition && (edition.date !== job.request || edition.source !== PAPER_SOURCE)) throw Error('去重索引里有其他待处理稿件。');
  if (saved) {
    if (saved.source !== PAPER_SOURCE || edition) throw Error('本期去重记录与当前流程冲突。');
    edition = saved;
  }
  if (!edition) {
    if (job.attempted) return '上次模型请求结果不明。检查执行日志后可手动允许重试。';
    const candidates = ports.candidates(state, view.preferences.read());
    if (!paperStillChecked_(ports, job) || view.today.read() !== previous) return '签到或当前期号已变更。';
    job.attempted = true;
    ports.save(job);
    edition = {...ports.generate(job.request, candidates), source: PAPER_SOURCE};
    state.pool = state.pool.filter(paper => !edition.papers.some(selected => conflict_(selected, paper)));
    state.pending = edition;
    indexText = paperWrite_(view.index, indexText, JSON.stringify(state));
  }

  if (paperDateFromReport_(edition.report) !== job.request || !edition.papers.length) throw Error('暂存报告校验失败。');
  if (!paperStillChecked_(ports, job) || view.today.read() !== previous) return '签到或当前期号已变更。';
  const summary = edition.papers.map(paper => '- [' + paper.title + '](' + paper.source_url + ') · ' + paper.venue).join('\n');
  paperAppend_(view.archive, job.request, edition.report);
  paperAppend_(view.history, job.request, '## ' + job.request + '\n\n' + summary);
  const remaining = state.pool.slice(-40).map(paper => '- [' + paper.title + '](' + paper.source_url + ') · ' + paper.track).join('\n');
  paperAppend_(view.recent, job.request, '## ' + job.request + '\n\n' + summary + '\n\n### 候选池\n\n' + (remaining || '暂无候选。'));
  if (!saved) {
    state.editions.push(edition);
    delete state.pending;
    paperWrite_(view.index, indexText, JSON.stringify(state));
  }
  if (!paperStillChecked_(ports, job)) return '发布前签到状态已变更。';
  paperWrite_(view.today, previous, edition.report);
  return '本期已发布到 Drive，等待 Zotero 同步。';
}

function paperStillChecked_(ports, job) {
  const note = ports.note();
  return note.date === job.previous && note.checked;
}

function paperConfig_() {
  const props = PropertiesService.getScriptProperties();
  const get = name => String(props.getProperty(name) || '').trim();
  const config = {folderId: get('DRIVE_FOLDER_ID'), userId: get('ZOTERO_USER_ID'), noteKey: get('ZOTERO_NOTE_KEY'),
    zoteroKey: get('ZOTERO_READ_KEY'), geminiKey: get('GEMINI_API_KEY'),
    freeTier: get('GEMINI_FREE_TIER_CONFIRMED') === 'yes', model: get('GEMINI_MODEL') || 'gemini-3.1-flash-lite',
    zone: get('PAPER_TIME_ZONE') || 'Asia/Shanghai', releaseTime: get('PAPER_RELEASE_TIME') || '08:15',
    tag: get('PAPER_ACK_TAG') || '精选：本期看过'};
  if (!/^[\w-]+$/.test(config.folderId)) throw Error('请配置 DRIVE_FOLDER_ID，仅填文件夹 ID。');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.releaseTime)) throw Error('PAPER_RELEASE_TIME 须使用 HH:mm 格式。');
  if (!/^gemini-[a-z0-9.-]+$/.test(config.model)) throw Error('GEMINI_MODEL 格式无效。');
  return config;
}

function paperRequireModel_(config) {
  if (!config.geminiKey || !config.freeTier) throw Error('请先核对未关联结算，再设置 GEMINI_API_KEY 和 GEMINI_FREE_TIER_CONFIRMED=yes。');
}

function paperReadZotero_(config) {
  if (!/^\d+$/.test(config.userId) || !/^[A-Z0-9]{8}$/.test(config.noteKey) || !config.zoteroKey) {
    throw Error('请配置 ZOTERO_USER_ID、ZOTERO_NOTE_KEY 和 ZOTERO_READ_KEY。');
  }
  const response = UrlFetchApp.fetch('https://api.zotero.org/users/' + config.userId + '/items/' + config.noteKey, {
    headers: {'Zotero-API-Key': config.zoteroKey, 'Zotero-API-Version': '3'}, muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw Error('Zotero 签到读取失败 HTTP ' + response.getResponseCode());
  const note = JSON.parse(response.getContentText()).data;
  if (!note || note.key !== config.noteKey || note.itemType !== 'note' || note.parentItem || note.deleted ||
      !Array.isArray(note.tags) || typeof note.note !== 'string') throw Error('Zotero 目标须为个人文库中的有效顶层笔记。');
  const date = paperDateFromReport_('# ' + htmlText_(note.note));
  const edited = new Date(note.dateModified || '');
  return {date, checked: note.tags.some(tag => tag.tag === config.tag),
    ackDate: !isNaN(edited.getTime()) ? Utilities.formatDate(edited, config.zone, 'yyyy-MM-dd') : null};
}

function paperDateFromReport_(content) {
  const found = /^# 今日精选\s*[｜|]\s*(\d{4}-\d{2}-\d{2})(?!\d)/m.exec(content);
  const parsed = found && new Date(found[1] + 'T00:00:00Z');
  if (!found || isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== found[1]) {
    throw Error('无法识别期号。首行应为 # 今日精选｜YYYY-MM-DD。');
  }
  return found[1];
}

function paperFiles_(folderId, contents) {
  const folder = DriveApp.getFolderById(folderId);
  return Object.fromEntries(Object.entries(PAPER_FILES).map(([key, name]) => {
    const matches = folder.getFilesByName(name);
    let file;
    if (matches.hasNext()) {
      file = matches.next();
      if (matches.hasNext()) throw Error('文件夹中有同名文件：' + name);
    } else if (contents) {
      file = folder.createFile(name, contents[key], MimeType.PLAIN_TEXT);
    } else {
      throw Error('缺少 ' + name + '，请先运行 setupPaperLibrary。');
    }
    return [key, {id: file.getId(), read: () => file.getBlob().getDataAsString('UTF-8'), write: value => file.setContent(value)}];
  }));
}

function paperReadIndex_(text) {
  const index = JSON.parse(text);
  if (!index || index.version !== 1 || !index.offsets || !Array.isArray(index.editions) ||
      !Array.isArray(index.pool) || !Array.isArray(index.exclusions)) throw Error('去重数据结构无效。');
  return index;
}

function paperCandidates_(state, preferences) {
  merge_(state, gather_(state));
  const seen = new Set(state.exclusions.concat(...state.editions.map(edition => edition.papers)).flatMap(keys_));
  const terms = label => ((new RegExp('^\\s*-\\s*' + label + '[：:]([^\\n]*)', 'm').exec(preferences) || [])[1] || '')
    .split(/[，,；;]/).map(term => term.trim().toLowerCase()).filter(Boolean).slice(0, 30);
  const preferred = terms('优先关键词');
  const excluded = terms('排除关键词');
  const candidates = state.pool.flatMap(paper => {
    const searchable = (paper.title + ' ' + (paper.abstract || '')).toLowerCase();
    if (keys_(paper).some(key => seen.has(key)) || excluded.some(term => searchable.includes(term))) return [];
    return [{...paper, score: (paper.score || 0) + 3 * preferred.filter(term => searchable.includes(term)).length}];
  });
  const shortlist = batch_(candidates);
  checkCoverage_(shortlist);
  return shortlist;
}

function paperAppend_(file, date, body) {
  const before = file.read();
  const marker = '<!-- paper-workflow:' + date + ' -->';
  const block = marker + '\n\n' + body.trim() + '\n\n<!-- /paper-workflow:' + date + ' -->';
  if (before.includes(marker)) {
    if (!before.includes(block)) throw Error('历史文件中已有不同的同一期内容。');
    return;
  }
  paperWrite_(file, before, before.trimEnd() + '\n\n' + block + '\n');
}

function paperWrite_(file, before, after) {
  if (Utilities.newBlob(after).getBytes().length > 8500000) throw Error('文件接近容量上限，请先备份并整理归档。');
  if (file.read() !== before) throw Error('Drive 文件刚被其他流程修改，已停下。');
  file.write(after);
  if (file.read() !== after) throw Error('Drive 写入后校验失败。');
  return after;
}

function paperLocked_(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return action(); } finally { lock.releaseLock(); }
}
