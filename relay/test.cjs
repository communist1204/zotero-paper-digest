const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const tag = '精选：本期看过';
const oldReport = '# 今日精选｜2025-01-01\n\n等待首次签到。';
const newReport = '# 今日精选｜2025-01-02\n\n## 1. 测试条目\n\n[原文](https://example.org/paper)';

function harness() {
  const calls = [];
  const records = [];
  const triggers = [];
  const properties = {ZOTERO_USER_ID: '123', ZOTERO_NOTE_KEY: 'DEMONOTE',
    ZOTERO_WRITE_KEY: 'fake-write-key', DRIVE_TODAY_FILE_ID: 'fake-drive-file'};
  const item = {key: properties.ZOTERO_NOTE_KEY, itemType: 'note', version: 7,
    tags: [{tag}, {tag: '保留标签', type: 1}],
    note: '<div data-schema-version="9"><h1>今日精选｜2025-01-01</h1></div>'};
  let driveReport = newReport;
  let writeCode = 204;
  const lock = {waitLock() {}, tryLock: () => true, releaseLock() {}};
  const context = vm.createContext({
    console: {log: value => records.push(value)},
    PropertiesService: {getScriptProperties: () => ({getProperty: key => properties[key]})},
    LockService: {getScriptLock: () => lock},
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger(name) {
        return {timeBased() { return this; }, everyMinutes(interval) {
          assert.equal(interval, 5);
          return this;
        }, create: () => triggers.push({getHandlerFunction: () => name})};
      }
    },
    DriveApp: {getFileById(id) {
      assert.equal(id, properties.DRIVE_TODAY_FILE_ID);
      calls.push({type: 'drive'});
      return {getBlob: () => ({getDataAsString: () => driveReport})};
    }},
    UrlFetchApp: {fetch(url, options) {
      assert.equal(url, 'https://api.zotero.org/users/123/items/DEMONOTE?format=json');
      assert.equal(options.headers['Zotero-API-Key'], properties.ZOTERO_WRITE_KEY);
      if (!options.method) {
        calls.push({type: 'get'});
        return {getResponseCode: () => 200, getContentText: () => JSON.stringify({data: item})};
      }
      const patch = JSON.parse(options.payload);
      calls.push({type: options.method, revision: options.headers['If-Unmodified-Since-Version'], patch});
      if (writeCode === 204) Object.assign(item, patch, {version: item.version + 1});
      return {getResponseCode: () => writeCode};
    }}
  });
  vm.runInContext(source, context);
  return {context, item, properties, calls, records, triggers,
    report(value) { driveReport = value; }, writeCode(value) { writeCode = value; },
    tick: () => context.relayTick_(context.relayPorts_())};
}

test('an unsigned issue does not read Drive or write Zotero', () => {
  const h = harness();
  h.item.tags.shift();
  assert.match(h.tick(), /^paused:/);
  assert.deepEqual(h.calls, [{type: 'get'}]);
});

test('setup accepts the same-date starter report but does not mirror it', () => {
  const h = harness();
  h.report(oldReport);
  const status = h.context.relayStatus();
  assert.equal(status.noteDate, status.driveDate);
  assert.equal(status.reportHasCards, false);
  assert.match(h.tick(), /^waiting:/);
  assert.ok(!h.calls.some(call => call.type === 'patch'));
});

test('a newer complete report is mirrored once and only the acknowledgment tag is cleared', () => {
  const h = harness();
  assert.match(h.tick(), /^published:/);
  const patch = h.calls.find(call => call.type === 'patch');
  assert.equal(patch.revision, '7');
  assert.deepEqual(Object.keys(patch.patch), ['note', 'tags']);
  assert.deepEqual(h.item.tags, [{tag: '保留标签', type: 1}]);
  assert.match(h.item.note, /^<div data-schema-version="9"><h1>今日精选｜2025-01-02<\/h1>/);
  assert.match(h.tick(), /^paused:/);
  assert.equal(h.calls.filter(call => call.type === 'patch').length, 1);
});

test('a version conflict never clears a newer Zotero edit', () => {
  const h = harness();
  h.writeCode(412);
  assert.match(h.tick(), /^retrying:/);
  assert.equal(h.item.tags[0].tag, tag);
  h.item.version = 8;
  h.item.tags.push({tag: '新标签'});
  h.writeCode(204);
  assert.match(h.tick(), /^published:/);
  assert.deepEqual(h.calls.filter(call => call.type === 'patch').map(call => call.revision), ['7', '8']);
  assert.deepEqual(h.item.tags.map(value => value.tag), ['保留标签', '新标签']);
});

test('nonsequential cards, unclosed fences and invalid dates do not publish', () => {
  const h = harness();
  h.report(newReport.replace('## 1.', '## 2.'));
  assert.match(h.tick(), /^waiting:/);
  h.report(newReport + '\n```text\n未闭合');
  assert.throws(h.tick, /未闭合/);
  h.report(newReport.replace('2025-01-02', '2025-02-30'));
  assert.throws(h.tick, /有效日期/);
  assert.ok(!h.calls.some(call => call.type === 'patch'));
});

test('HTML is escaped, only HTTPS Markdown links are rendered, and fenced headings are ignored', () => {
  const h = harness();
  h.report(newReport + '\n\n<script>alert(1)</script> [bad](javascript:alert(1))\n\n```text\n## 2. fake\n```');
  assert.match(h.tick(), /^published:/);
  assert.match(h.item.note, /&lt;script&gt;/);
  assert.match(h.item.note, /href="https:\/\/example\.org\/paper"/);
  assert.match(h.item.note, /<pre>## 2\. fake<\/pre>/);
  assert.ok(!/<script>|href="javascript:/.test(h.item.note));
});

test('custom acknowledgment tag is honored, and child notes and links as Drive IDs are rejected', () => {
  const h = harness();
  h.properties.PAPER_ACK_TAG = '自选签到标签';
  assert.match(h.tick(), /^paused:/);
  h.item.tags.push({tag: '自选签到标签'});
  h.item.parentItem = 'PARENT12';
  assert.throws(h.tick, /独立 Zotero 笔记/);
  delete h.item.parentItem;
  h.properties.DRIVE_TODAY_FILE_ID = 'https://drive.google.com/file/d/fake-drive-file/view';
  assert.throws(h.tick, /DRIVE_TODAY_FILE_ID/);
  assert.ok(!h.calls.some(call => call.type === 'patch'));
});

test('install is idempotent and pause removes only the relay trigger', () => {
  const h = harness();
  h.triggers.push({getHandlerFunction: () => 'otherTrigger'});
  h.context.installPaperRelay();
  h.context.installPaperRelay();
  assert.deepEqual(h.triggers.map(trigger => trigger.getHandlerFunction()), ['otherTrigger', 'paperRelayTick']);
  h.context.pausePaperRelay();
  assert.deepEqual(h.triggers.map(trigger => trigger.getHandlerFunction()), ['otherTrigger']);
  assert.ok(!h.calls.some(call => call.type === 'patch'));
});
