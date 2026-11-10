const draftFilename = '科研学习档案.md';
const pending = new Set();
const waitingForPDF = new Set();
let observerID;
let timer;
let draining = false;
let enabled = false;

async function startup() {
  enabled = true;
  await Zotero.initializationPromise;
  if (enabled && !observerID) {
    observerID = Zotero.Notifier.registerObserver({ notify }, ['item'], 'paper-digest-reading-draft');
  }
}

function shutdown() {
  enabled = false;
  if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  clearTimeout(timer);
  timer = undefined;
  pending.clear();
  waitingForPDF.clear();
}

function install() {}
function uninstall() {}

function notify(event, type, ids, extraData = {}) {
  if (!enabled || type !== 'item' || extraData.skipAutoSync) return;
  for (const id of ids) {
    if (event === 'delete' || event === 'trash') {
      pending.delete(id);
      waitingForPDF.delete(id);
    } else if (event === 'add' || (event === 'modify' && waitingForPDF.has(id))) {
      pending.add(id);
    }
  }
  // Save the draft after Zotero finishes the PDF import transaction.
  if (pending.size && !draining && timer === undefined) {
    timer = setTimeout(drain, 0);
  }
}

async function drain() {
  timer = undefined;
  draining = true;
  try {
    while (enabled && pending.size) {
      const id = pending.values().next().value;
      pending.delete(id);
      try {
        await createDraftForPDF(id);
      } catch (error) {
        Zotero.logError(error);
      }
    }
  } finally {
    draining = false;
  }
}

async function createDraftForPDF(id) {
  const pdf = await Zotero.Items.getAsync(id);
  if (!pdf || pdf.deleted || pdf.libraryID !== Zotero.Libraries.userLibraryID || !pdf.isPDFAttachment()) {
    waitingForPDF.delete(id);
    return;
  }

  // A PDF saved on its own can gain a paper parent after metadata retrieval.
  waitingForPDF.add(id);
  if (!pdf.parentItemID || !await pdf.getFilePathAsync()) return;

  const paper = await Zotero.Items.getAsync(pdf.parentItemID);
  if (!paper?.isRegularItem() || paper.deleted) {
    waitingForPDF.delete(id);
    return;
  }
  await paper.loadDataType('childItems', true);
  const attachments = await Zotero.Items.getAsync(paper.getAttachments(true));
  for (const attachment of attachments) {
    await attachment.loadDataType('itemData');
    if (attachment.attachmentFilename === draftFilename || attachment.getField('title') === draftFilename) {
      waitingForPDF.delete(id);
      return;
    }
  }

  await paper.loadDataType('itemData');
  await paper.loadDataType('creators');
  await paper.loadDataType('tags');
  if (!enabled || paper.deleted || pdf.deleted) return;
  await attachDraft(paper.id, draftText(paper));
  waitingForPDF.delete(id);
}

function inlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().replace(/[\\`*_\[\]<>|]/g, '\\$&');
}

function draftText(paper) {
  const field = name => inlineText(paper.getField(name));
  const title = field('title') || '待补标题';
  const authors = paper.getCreatorsJSON()
    .filter(creator => creator.creatorType === 'author')
    .map(creator => inlineText(creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(' ')))
    .filter(Boolean).join('、');
  const venue = field('publicationTitle') || field('proceedingsTitle') || field('conferenceName') || field('repository');
  const url = String(paper.getField('url') || '').trim();
  const source = /^https?:\/\/[^\s<>]+$/i.test(url) ? `<${url}>` : '';
  const date = new Intl.DateTimeFormat('sv-SE').format(new Date());
  const status = paper.hasTag('阅读：已读') ? '已读' : paper.hasTag('阅读：在读') ? '在读' : '待读';

  return [
    `# ${title}｜科研学习档案`,
    '',
    `- **作者** ${authors || '待补'}`,
    `- **出处与日期** ${[venue, field('date')].filter(Boolean).join(' · ') || '待补'}`,
    `- **DOI** ${field('DOI') || '待补'}`,
    `- **原文** ${source || '见 Zotero 条目及 PDF'}`,
    `- **登记日期** ${date}`,
    `- **登记时的阅读状态** ${status}`,
    '',
    '## 阅读进度与续接位置',
    '',
    '- 已读范围',
    '- 下次从哪里继续',
    '',
    '## 方法、公式与代码',
    '',
    '- 学到的内容及原文位置',
    '- 掌握情况与依据',
    '',
    '## 疑问、想法与下一步',
    '',
    '## 我的笔记',
    '',
  ].join('\n');
}

async function attachDraft(parentItemID, content) {
  const directory = PathUtils.join(Zotero.getTempDirectory().path, `reading-draft-${Zotero.randomString(12)}`);
  const file = PathUtils.join(directory, draftFilename);
  await IOUtils.makeDirectory(directory, { ignoreExisting: false });
  try {
    await IOUtils.writeUTF8(file, content);
    if (enabled) {
      await Zotero.Attachments.importFromFile({
        file,
        parentItemID,
        title: draftFilename,
        contentType: 'text/markdown',
        charset: 'utf-8',
        saveOptions: { skipSelect: true },
      });
    }
  } finally {
    await IOUtils.remove(file, { ignoreAbsent: true });
    await IOUtils.remove(directory, { ignoreAbsent: true });
  }
}
