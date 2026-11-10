const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8');

function fixture() {
  const timers = [];
  const files = new Map();
  const drafts = [];
  const attachments = [];
  const pdf = {
    libraryID: 1, parentItemID: 3, isPDFAttachment: () => true,
    getFilePathAsync: async () => '/local/example.pdf',
  };
  const fields = { title: 'A *Paper*', url: 'https://example.org/paper', DOI: '10.0000/example' };
  const paper = {
    id: 3, isRegularItem: () => true, loadDataType: async () => {},
    getAttachments: () => attachments,
    getField: name => fields[name],
    getCreatorsJSON: () => [{ creatorType: 'author', firstName: 'Lin', lastName: 'Example' }],
    hasTag: tag => tag === '阅读：在读',
  };
  let observer;
  const context = vm.createContext({
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() { timers.length = 0; },
    Zotero: {
      initializationPromise: Promise.resolve(),
      Notifier: {
        registerObserver(value) { observer = value; return 'mock'; },
        unregisterObserver() { observer = undefined; },
      },
      Libraries: { userLibraryID: 1 },
      Items: { getAsync: async id => Array.isArray(id) ? id : id === 3 ? paper : pdf },
      Attachments: { importFromFile: async options => {
        drafts.push({ ...options, content: files.get(options.file) });
        attachments.push({ attachmentFilename: options.title, loadDataType: async () => {} });
      } },
      getTempDirectory: () => ({ path: '/tmp' }),
      randomString: () => 'test',
      logError(error) { throw error; },
    },
    PathUtils: { join: (...parts) => parts.join('/') },
    IOUtils: {
      makeDirectory: async () => {},
      writeUTF8: async (name, content) => { files.set(name, content); },
      remove: async name => { files.delete(name); },
    },
  });
  vm.runInContext(source, context);
  return { context, pdf, drafts, files, emit: async event => {
    observer?.notify(event, 'item', [7]);
    while (timers.length) await timers.shift()();
  } };
}

test('creates one editable draft under a personal library PDF parent', async () => {
  const f = fixture();
  await f.context.startup();
  await f.emit('add');
  await f.emit('add');
  assert.equal(f.drafts.length, 1);
  assert.equal(f.drafts[0].parentItemID, 3);
  assert.equal(f.drafts[0].contentType, 'text/markdown');
  assert.match(f.drafts[0].content, /A \\\*Paper\\\*/);
  assert.match(f.drafts[0].content, /Lin Example/);
  assert.match(f.drafts[0].content, /阅读状态\*\* 在读/);
  assert.equal(f.files.size, 0);
});

test('waits for a standalone PDF to acquire a paper parent and local file', async () => {
  const f = fixture();
  f.pdf.parentItemID = null;
  f.pdf.getFilePathAsync = async () => false;
  await f.context.startup();
  await f.emit('add');
  f.pdf.parentItemID = 3;
  await f.emit('modify');
  assert.equal(f.drafts.length, 0);
  f.pdf.getFilePathAsync = async () => '/local/example.pdf';
  await f.emit('modify');
  assert.equal(f.drafts.length, 1);
});

test('ignores group library PDFs and stops processing after shutdown', async () => {
  const f = fixture();
  await f.context.startup();
  f.pdf.libraryID = 2;
  await f.emit('add');
  f.context.shutdown();
  f.pdf.libraryID = 1;
  await f.emit('add');
  assert.equal(f.drafts.length, 0);
});
