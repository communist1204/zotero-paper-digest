const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = ['Sources.gs', 'Code.gs'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
const previous = '# 今日精选｜2030-01-02\n\n原报告\n';
const report = '# 今日精选｜2030-01-03\n\n## 1. Demo Paper\n\n[官网](https://example.org/paper)';
const demoPaper = {id: 'demo:paper', title: 'Demo Paper', track: '图像', venue: 'Demo 2026', source_url: 'https://example.org/paper'};

function fixture() {
  const context = vm.createContext({Utilities: {newBlob: value => ({getBytes: () => Buffer.from(value)})}});
  vm.runInContext(source, context);
  const calls = [];
  const note = {date: '2030-01-02', ackDate: '2030-01-02', checked: true};
  const files = {today: previous, history: '# 历史\n', archive: '# 归档\n', recent: '# 候选\n', preferences: '# 偏好\n',
    index: JSON.stringify({version: 1, offsets: {}, editions: [], pool: [], exclusions: [], keep: true})};
  const view = Object.fromEntries(Object.keys(files).map(name => [name, {read: () => files[name],
    write(value) { calls.push('write:' + name); files[name] = value; }}]));
  let job;
  const ports = {
    note: () => note, load: () => job, save: value => { job = value; },
    view() { calls.push('drive'); return view; },
    candidates(state) { calls.push('sources'); state.pool.push(demoPaper); return [demoPaper]; },
    generate(date) { calls.push('gemini'); return {date, report, papers: [demoPaper]}; }
  };
  return {context, calls, note, files, ports, view, tick: (date, time) => context.paperRun_(ports, date, time, '08:15')};
}

test('no Drive access or generation without acknowledgment or before release time', () => {
  const f = fixture();
  f.note.checked = false;
  assert.match(f.tick('2030-01-03', '09:00'), /等待 Zotero 签到/);
  f.note.checked = true;
  assert.match(f.tick('2030-01-02', '09:00'), /等待次日/);
  assert.match(f.tick('2030-01-03', '08:14'), /等待次日/);
  assert.deepEqual(f.calls, []);
});

test('publishes current issue last, retains the archive, and never generates twice', () => {
  const f = fixture();
  assert.match(f.tick('2030-01-03', '08:15'), /本期已发布/);
  assert.equal(f.calls.at(-1), 'write:today');
  assert.equal(f.files.today, report);
  assert.ok(f.files.archive.startsWith('# 归档\n'));
  assert.ok(f.files.archive.includes(report));
  const index = JSON.parse(f.files.index);
  assert.equal(index.keep, true);
  assert.equal(index.pool.length, 0);
  assert.equal(index.editions.length, 1);
  assert.equal(index.pending, undefined);
  assert.match(f.tick('2030-01-03', '09:00'), /等待 Zotero 同步/);
  assert.equal(f.calls.filter(x => x === 'gemini').length, 1);
});

test('a failed history write resumes the saved edition without another model request', () => {
  const f = fixture();
  const write = f.view.history.write;
  f.view.history.write = () => { throw Error('simulated write failure'); };
  assert.throws(() => f.tick('2030-01-03', '08:15'), /simulated write failure/);
  assert.equal(f.files.today, previous);
  assert.ok(JSON.parse(f.files.index).pending);
  f.view.history.write = write;
  assert.match(f.tick('2030-01-03', '08:20'), /本期已发布/);
  assert.equal(f.calls.filter(x => x === 'gemini').length, 1);
  assert.equal(f.files.archive.match(/<!-- paper-workflow:2030-01-03 -->/g).length, 1);
});

test('an ambiguous model failure requires a conscious retry and preserves Today', () => {
  const f = fixture();
  f.ports.generate = () => { f.calls.push('gemini'); throw Error('simulated model failure'); };
  assert.throws(() => f.tick('2030-01-03', '08:15'), /simulated model failure/);
  assert.match(f.tick('2030-01-03', '08:20'), /手动允许重试/);
  assert.equal(f.calls.filter(x => x === 'gemini').length, 1);
  assert.equal(f.files.today, previous);
});

test('a canceled acknowledgment prevents a pending model call', () => {
  const f = fixture();
  f.ports.candidates = () => { f.note.checked = false; return [demoPaper]; };
  assert.match(f.tick('2030-01-03', '08:15'), /签到或当前期号已变更/);
  assert.ok(!f.calls.includes('gemini'));
  assert.equal(f.files.today, previous);
});

test('candidate ranking keeps private preference text out of model input', () => {
  const f = fixture();
  const publicPapers = [
    {...demoPaper, abstract: 'Public abstract about inverse problems'},
    {...demoPaper, id: 'demo:other', title: 'Embodied robotics', abstract: 'Public robotics abstract', track: '具身', venue: 'Other 2026'},
    {...demoPaper, id: 'demo:depth', title: 'Depth estimation', abstract: 'Public depth abstract', track: '三维'}
  ];
  f.context.gather_ = () => publicPapers;
  const privateText = '- 优先关键词：inverse problems, private keyword\n- 排除关键词：unseen keyword';
  const selected = f.context.paperCandidates_(JSON.parse(f.files.index), privateText);
  assert.equal(selected.length, 3);
  assert.equal(selected.find(paper => paper.id === demoPaper.id).score, 3);
  assert.ok(!JSON.stringify(selected).includes('private keyword'));
});

test('conference discovery accepts official paths and keeps OpenReview IDs case-sensitive', () => {
  const f = fixture();
  const html = '<a href="/content/CVPR2026/html/Example_3D_Reconstruction_CVPR_2026_paper.html">3D Reconstruction</a>';
  const papers = f.context.parseArchiveIndex_(html, ['cvf', 'CVPR 2026', 'https://openaccess.thecvf.com/CVPR2026?day=all']);
  assert.equal(papers.length, 1);
  assert.match(papers[0].source_url, /^https:\/\/openaccess\.thecvf\.com\//);
  assert.equal(f.context.conflict_({id: 'openreview:aBc', title: 'One'}, {id: 'openreview:AbC', title: 'Two'}), false);
});

test('bootstrap only creates missing Drive files and prints a matching unsigned note heading', () => {
  const {context} = fixture();
  const logs = [];
  const files = new Map();
  const folder = {
    getFilesByName(name) {
      let found = files.get(name);
      return {hasNext: () => !!found, next() { const result = found; found = null; return result; }};
    },
    createFile(name, value) {
      const file = {getId: () => 'file-' + name, getBlob: () => ({getDataAsString: () => value})};
      files.set(name, file);
      return file;
    }
  };
  context.PropertiesService = {getScriptProperties: () => ({getProperty: name => name === 'DRIVE_FOLDER_ID' ? 'test-folder' : null})};
  context.DriveApp = {getFolderById(id) { assert.equal(id, 'test-folder'); return folder; }};
  context.MimeType = {PLAIN_TEXT: 'text/plain'};
  context.LockService = {getScriptLock: () => ({waitLock() {}, releaseLock() {}})};
  context.Utilities.formatDate = () => '2030-01-02';
  context.console = {log: value => logs.push(JSON.parse(value))};
  context.setupPaperLibrary();
  context.Utilities.formatDate = () => '2030-01-03';
  context.setupPaperLibrary();
  assert.equal(files.size, 6);
  assert.deepEqual(logs[0], logs[1]);
  assert.equal(logs[1].DRIVE_TODAY_FILE_ID, 'file-今日精选.md');
  assert.equal(logs[1].zoteroHeading, '今日精选｜2030-01-02');
});
