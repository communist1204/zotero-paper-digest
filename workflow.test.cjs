const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function script(context, relativePath) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'), context);
}

test('an empty library bootstraps and the first checked-in report mirrors to the original note', () => {
  const files = new Map();
  const folder = {
    getFilesByName(name) {
      const matches = files.has(name) ? [files.get(name)] : [];
      return {hasNext: () => matches.length > 0, next: () => matches.shift()};
    },
    createFile(name, initial) {
      let text = initial;
      const file = {
        getId: () => 'file-' + files.size,
        getBlob: () => ({getDataAsString: () => text}),
        setContent: (value) => { text = value; }
      };
      files.set(name, file);
      return file;
    }
  };
  const logs = [];
  const first = '2030-01-01';
  const next = '2030-01-02';
  const engine = vm.createContext({
    DriveApp: {getFolderById: () => folder},
    MimeType: {PLAIN_TEXT: 'text/plain'},
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    PropertiesService: {getScriptProperties: () => ({getProperty: name => name === 'DRIVE_FOLDER_ID' ? 'private-folder' : null})},
    Utilities: {formatDate: () => first, newBlob: text => ({getBytes: () => Buffer.from(text)})},
    console: {log: value => logs.push(value)}
  });
  script(engine, 'engine/Sources.gs');
  script(engine, 'engine/Code.gs');
  engine.setupPaperLibrary();
  engine.setupPaperLibrary();
  assert.equal(files.size, 6);
  const heading = JSON.parse(logs[0]).zoteroHeading;
  assert.equal(heading, `今日精选｜${first}`);

  const tag = '精选：本期看过';
  const zotero = {version: 1, note: `<div data-schema-version="9"><p>${heading}</p></div>`, tags: [{tag: '入口'}]};
  const paper = {id: 'sample:one', title: 'Example paper', venue: 'Example venue', track: '图像',
    source_url: 'https://example.org/paper', pdf_url: 'https://example.org/paper.pdf'};
  const card = {reason: '理由', difficulty: '中等', prerequisites: '先修', thought: '想法', math: '练习',
    diagram: '输入 → 输出', writing: '写法', read: '阅读'};
  let job;
  let generations = 0;
  const view = () => engine.paperFiles_('private-folder');
  const ports = {
    note: () => ({date: first, ackDate: first, checked: zotero.tags.some(t => t.tag === tag)}),
    load: () => job, save: value => { job = value; },
    view, candidates: () => [paper],
    generate(date) { generations++; return engine.makeEdition_(date, [{paper, card}]); }
  };
  assert.match(engine.paperRun_(ports, first, '12:00', '08:15'), /等待 Zotero 签到/);
  zotero.tags.push({tag});
  assert.match(engine.paperRun_(ports, first, '12:00', '08:15'), /等待次日/);
  assert.match(engine.paperRun_(ports, next, '08:14', '08:15'), /等待次日/);
  assert.equal(generations, 0);
  assert.match(engine.paperRun_(ports, next, '08:15', '08:15'), /已发布/);
  assert.equal(generations, 1);
  assert.match(view().archive.read(), /Example paper/);
  assert.equal(JSON.parse(view().index.read()).editions.length, 1);

  const relay = vm.createContext({});
  script(relay, 'relay/Code.gs');
  const relayPorts = {
    ackTag: tag, readNote: () => zotero, readDrive: () => view().today.read(),
    writeNote(version, note, tags) {
      assert.equal(version, zotero.version);
      Object.assign(zotero, {version: version + 1, note, tags});
      return true;
    }
  };
  assert.match(relay.relayTick_(relayPorts), /^published:/);
  assert.equal(relay.relayNoteDate_(zotero.note), next);
  assert.match(zotero.note, /href="https:\/\/example\.org\/paper\.pdf"/);
  assert.deepEqual(Array.from(zotero.tags, t => t.tag), ['入口']);
  assert.match(relay.relayTick_(relayPorts), /^paused:/);
});
