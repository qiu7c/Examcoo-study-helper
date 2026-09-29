// 纯逻辑自测：在 Node 里用最小 DOM/油猴桩跑一遍 userscript 内部的 AI 相关函数。
// 运行：node Examcoo/tests/ai-logic.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('../examcoo-study-helper.user.js', import.meta.url);
const source = fs.readFileSync(fileURLToPath(scriptUrl), 'utf8');

const EXPORT_BLOCK = `
  globalThis.__examcooTest = {
    normalize, plainText, similarity, splitAnswerToken, resolveAnswerTokens, readAnswerTokens,
    parseAiItem, combineVotes, findReferences, collectReferencePool, aiPrompt, aiQuestionType,
    extractJsonObject, confidenceLevel, matchOptionByText, resolveMatchedInputs, optionOrderMatches,
    getBank: () => bank,
    setBank: (value) => { bank = value; }
  };
`;

assert.ok(/\n\}\)\(\);\s*$/.test(source), '未找到 userscript 的 IIFE 结尾');
const injected = source.replace(/\n\}\)\(\);\s*$/, `\n${EXPORT_BLOCK}})();\n`);

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function makeElement() {
  let innerHTML = '';
  return {
    style: {},
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {} },
    get innerHTML() { return innerHTML; },
    set innerHTML(value) { innerHTML = value; },
    get value() { return decodeEntities(innerHTML); },
    set value(next) { innerHTML = next; },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    click() {},
    remove() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

function createSandbox() {
  const store = new Map();
  const sandbox = {
    console,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    Event: class {},
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    window: { location: { pathname: '/editor/do/exam/1', href: 'https://examcoo.com/editor/do/exam/1' }, innerWidth: 1200, innerHeight: 800 },
    unsafeWindow: {},
    document: {
      createElement: () => makeElement(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { appendChild() {} },
      body: { appendChild() {} },
      documentElement: { appendChild() {} }
    },
    GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    GM_setValue: (key, value) => { store.set(key, value); },
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest() { throw new Error('测试环境不应发起真实请求'); }
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

const sandbox = createSandbox();
vm.createContext(sandbox);
vm.runInContext(injected, sandbox, { filename: 'examcoo-study-helper.user.js' });
const api = sandbox.__examcooTest;
// vm 里创建的数组/对象与宿主 realm 的原型不同，比较前先转成纯数据。
const plain = (value) => JSON.parse(JSON.stringify(value));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

check('normalize 压缩空白、标点与实体', () => {
  assert.equal(api.normalize('  下列 说法 正确 的 是 ？ '), '下列说法正确的是');
  assert.equal(api.normalize('<p>甲&nbsp;乙</p>'), '甲乙');
  assert.equal(api.normalize('（ ）'), '()');
});

check('similarity 对同义/无关题干有区分度', () => {
  assert.equal(api.similarity('abcdefgh', 'abcdefgh'), 1);
  assert.ok(api.similarity('中国的首都是哪座城市', '中国的首都是哪座城市呢') > 0.6);
  assert.ok(api.similarity('中国的首都是哪座城市', '光合作用的产物是什么') < 0.2);
});

check('readAnswerTokens 兼容数组、顿号与字母串', () => {
  assert.deepEqual(plain(api.readAnswerTokens({ choice: ['A', 'C'] })), ['A', 'C']);
  assert.deepEqual(plain(api.readAnswerTokens({ answer: 'A、C' })), ['A', 'C']);
  assert.deepEqual(plain(api.readAnswerTokens({ choice: 'A' })), ['A']);
  assert.deepEqual(plain(api.readAnswerTokens({ answers: ['上海'] })), ['上海']);
  assert.deepEqual(plain(api.readAnswerTokens({})), []);
});

check('resolveAnswerTokens 支持字母、序号、原文与模糊匹配', () => {
  const question = { id: 's1_1', multiple: false, options: ['北京', '上海', '广州', '深圳'] };
  assert.deepEqual(plain(api.resolveAnswerTokens(question, ['A']).indexes), [0]);
  assert.deepEqual(plain(api.resolveAnswerTokens(question, ['C']).indexes), [2]);
  assert.deepEqual(plain(api.resolveAnswerTokens(question, ['A,B']).indexes), [0, 1]);
  assert.deepEqual(plain(api.resolveAnswerTokens(question, ['3']).indexes), [2]);
  assert.deepEqual(plain(api.resolveAnswerTokens(question, ['上海']).indexes), [1]);
  assert.deepEqual(plain(api.resolveAnswerTokens(question, ['D. 深圳']).indexes), [3]);
  assert.equal(api.resolveAnswerTokens(question, ['Z']).unmatched, 1);
});

check('parseAiItem 校验题型题量并容错', () => {
  const single = { id: 's1_7', multiple: false, options: ['北京', '上海', '广州', '深圳'] };
  assert.equal(api.parseAiItem({ id: 's1_7', choice: ['B'], confidence: 0.91, reason: '首都' }, single).indexes[0], 1);
  assert.equal(api.parseAiItem({ id: 's1_7', answers: ['上海'], confidence: 0.91 }, single).indexes[0], 1);
  assert.equal(api.parseAiItem({ id: 's1_7', choice: ['A'] }, single).confidence, 0.5);
  assert.equal(api.parseAiItem({ id: 's1_7', choice: ['A', 'B'], confidence: 0.9 }, single), null);
  assert.equal(api.parseAiItem({ id: 's9_9', choice: ['A'], confidence: 0.9 }, single), null);
  assert.equal(api.parseAiItem({ id: 's1_7', choice: ['Z'], confidence: 0.9 }, single), null);

  const multi = { id: 's2_7', multiple: true, options: ['甲', '乙', '丙', '丁'] };
  assert.deepEqual(plain(api.parseAiItem({ id: 's2_7', choice: 'A,B', confidence: 0.7 }, multi).indexes), [0, 1]);
  assert.equal(api.parseAiItem({ id: 's2_7', choice: ['A'], confidence: 0.7 }, multi), null);
});

check('combineVotes 对一致/分歧给出不同置信度', () => {
  const primary = { indexes: [1], answers: ['上海'], confidence: 0.6, reason: '首轮', rounds: 1 };
  const agreed = api.combineVotes(primary, [
    { indexes: [1], answers: ['上海'], confidence: 0.8 },
    { indexes: [1], answers: ['上海'], confidence: 0.7 }
  ]);
  assert.deepEqual(plain(agreed.indexes), [1]);
  assert.equal(agreed.rounds, 3);
  assert.ok(agreed.confidence > primary.confidence);
  assert.equal(agreed.disagreement.length, 0);

  const split = api.combineVotes(primary, [{ indexes: [2], answers: ['广州'], confidence: 0.9 }]);
  assert.deepEqual(plain(split.indexes), [1], '平票时应保留首轮结果');
  assert.ok(split.confidence < 0.6);
  assert.deepEqual(plain(split.disagreement), ['C']);
});

check('findReferences 能从官方题库找到同知识点题目', () => {
  const bankQuestion = '下列关于光合作用的说法正确的是什么';
  api.setBank({
    [api.normalize(bankQuestion)]: {
      question: bankQuestion,
      options: ['甲说法', '乙说法', '丙说法', '丁说法'],
      answers: ['乙说法'],
      multiple: false,
      source: 'examcoo-reference'
    }
  });
  const target = { key: api.normalize('关于光合作用的说法，以下哪项是正确的呢'), multiple: false, options: ['甲说法', '乙说法', '丙说法', '丁说法'] };
  const references = api.findReferences(target, api.collectReferencePool());
  assert.equal(references.length, 1);
  assert.equal(references[0].source, '官方题库');
  assert.deepEqual(plain(references[0].answer), ['B. 乙说法']);
});

check('aiQuestionType 区分单选/多选/判断', () => {
  assert.ok(api.aiQuestionType({ multiple: false, options: ['对', '错'] }).includes('判断'));
  assert.ok(api.aiQuestionType({ multiple: true, options: ['甲', '乙', '丙'] }).includes('多选'));
  assert.ok(api.aiQuestionType({ multiple: false, options: ['甲', '乙', '丙'] }).includes('单选'));
});

check('aiPrompt 输出字母化选项并剔除 HTML', () => {
  const prompt = api.aiPrompt([{
    question: { id: 's1_1', text: '<p>题干&nbsp;内容</p>', options: ['甲', '乙'], multiple: false },
    references: [{ source: '官方题库', question: '旧题干', answer: ['A. 甲'] }]
  }]);
  assert.ok(prompt.includes('"s1_1"'));
  assert.ok(prompt.includes('A. 甲'));
  assert.ok(prompt.includes('B. 乙'));
  assert.ok(!prompt.includes('<p>'));
  assert.ok(prompt.includes('references'));
});

check('extractJsonObject 兼容代码块与夹带文字', () => {
  assert.deepEqual(plain(api.extractJsonObject('```json\n{"answers":[]}\n```')), { answers: [] });
  assert.deepEqual(plain(api.extractJsonObject('好的：{"answers":[1]}，以上')), { answers: [1] });
  assert.equal(api.extractJsonObject(''), null);
  assert.equal(api.extractJsonObject('没有 JSON'), null);
});

check('confidenceLevel 按阈值分级', () => {
  assert.equal(api.confidenceLevel(0.95), 'high');
  assert.equal(api.confidenceLevel(0.7), 'mid');
  assert.equal(api.confidenceLevel(0.3), 'low');
});

function fakeInput(text, value) {
  const content = { innerText: text };
  const box = { querySelector: (selector) => (selector === '.optionContent' ? content : null) };
  return {
    value: String(value),
    checked: false,
    type: 'radio',
    name: 'q_option',
    labels: [],
    nextSibling: null,
    parentElement: null,
    closest: (selector) => (String(selector).includes('.radioBox') ? box : null)
  };
}

check('resolveMatchedInputs 按选项内容定位，不受页面排列顺序影响', () => {
  const question = { options: ['甲', '乙', '丙', '丁'] };
  // 页面把选项倒着渲染，位掩码仍是 1<<序号
  const inputs = [fakeInput('丁', 8), fakeInput('丙', 4), fakeInput('乙', 2), fakeInput('甲', 1)];
  const resolved = api.resolveMatchedInputs(question, inputs, ['乙']);
  assert.equal(resolved.method, 'option-text');
  assert.equal(resolved.inputs.length, 1);
  assert.equal(resolved.inputs[0].value, '2', '应选中内容为“乙”的输入框');
});

check('resolveMatchedInputs 文字对不上且顺序不一致时不再按位置猜', () => {
  const question = { options: ['甲', '乙', '丙', '丁'] };
  const inputs = [fakeInput('3、丙', 4), fakeInput('4、丁', 8), fakeInput('1、甲', 1), fakeInput('2、乙', 2)];
  const resolved = api.resolveMatchedInputs(question, inputs, ['乙']);
  assert.equal(resolved.method, 'option-text');
  assert.equal(resolved.inputs.length, 0, '顺序不一致时必须放弃按位置匹配');
});

check('resolveMatchedInputs 文字对不上但顺序一致时回退到位掩码', () => {
  const question = { options: ['甲', '乙', '丙', '丁'] };
  const inputs = [fakeInput('1、甲', 1), fakeInput('2、乙', 2), fakeInput('3、丙', 4), fakeInput('4、丁', 8)];
  assert.equal(api.optionOrderMatches(question, inputs), true);
  const resolved = api.resolveMatchedInputs(question, inputs, ['乙', '丁']);
  assert.equal(resolved.method, 'option-value');
  assert.deepEqual(plain(resolved.inputs.map((input) => input.value)), ['2', '8']);
});

check('matchOptionByText 相似度接近时判为无法识别', () => {
  const options = ['北京市海淀区中关村大街一号院一号楼', '北京市海淀区中关村大街一号院二号楼'];
  assert.equal(api.matchOptionByText(options, '北京市海淀区中关村大街一号院一号楼'), 0);
  assert.equal(api.matchOptionByText(options, '北京市海淀区中关村大街一号院三号楼'), -1);
  assert.equal(api.matchOptionByText(['甲', '乙', '丙'], '丙'), 2);
  assert.equal(api.matchOptionByText(['甲', '乙'], '完全不相干的一段内容'), -1);
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  if (!result.ok) console.log(`      ${result.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
