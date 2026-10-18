const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const prototype = path.join(__dirname, '../../archive/browser-prototype');
const html = fs.readFileSync(path.join(prototype, 'index.html'), 'utf8');
// Extract this repository's fixture scripts, not arbitrary HTML or user input.
function extractInlineScripts(source) {
  return [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]))
    .map(match => match[2]);
}
const inlineScripts = extractInlineScripts(html);

function loadPage(rows) {
  const select = () => ({value: '', options: [], add(option) { this.options.push(option); }});
  // Only text and explicitly created nodes may reach the result. The real
  // page scripts run here; any return to an HTML-parsing sink fails the test.
  const result = {
    childNodes: [],
    set innerHTML(_value) { throw new Error('Route results must not be parsed as HTML'); },
    set textContent(value) { this.replaceChildren(String(value)); },
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); },
    replaceChildren(...children) {
      this.childNodes = children.map(child => typeof child === 'string'
        ? {nodeType: 3, textContent: child} : child);
    },
  };
  const elements = {start: select(), end: select(), iceToggle: {checked: false}, result};
  const context = vm.createContext({
    document: {
      getElementById(id) { return elements[id]; },
      createElement(tag) {
        assert.equal(tag, 'br', 'Only an explicit line break is needed');
        return {nodeType: 1, tagName: 'BR', textContent: ''};
      },
    },
    Option: function(text, value) { this.text = text; this.value = value; },
    d3: {csv() { return {then(callback) { callback(rows); }}; }},
  });
  vm.runInContext(fs.readFileSync(path.join(prototype, 'app.js'), 'utf8'), context);
  assert.ok(inlineScripts.length, 'The page must contain its event handler');
  for (const script of inlineScripts) vm.runInContext(script, context);
  return {
    elements,
    search(start, end) {
      elements.start.value = start;
      elements.end.value = end;
      context.runPathfinding();
      return result;
    },
  };
}

function connectedRows(start, end) {
  return [
    {Location: start, X: '0', Z: '0', Path: 'Test rail'},
    {Location: end, X: '3', Z: '4', Path: 'Test rail'},
  ];
}

test('page test loader handles script closing-tag variants and skips external scripts', () => {
  for (const close of ['</script>', '</script >', '</SCRIPT\t>', '</script ignored="true">']) {
    assert.deepEqual(extractInlineScripts(
      '<script src="app.js"></script><script>const loaded = true;' + close),
    ['const loaded = true;']);
  }
});

test('route output keeps labels literal, with only one explicit line break', () => {
  for (const name of [
    '<img src=x onerror="alert(1)">',
    '</div><svg onload="alert(1)">',
    'Café 🌳 & <b>Camp</b> "Haven"',
  ]) {
    const page = loadPage(connectedRows(name, 'Destination'));
    assert.ok(page.elements.start.options.some(option => option.text === name && option.value === name));
    const result = page.search(name, 'Destination');
    assert.deepEqual(result.childNodes, [
      {nodeType: 3, textContent: `Path: ${name} ➜ Destination`},
      {nodeType: 1, tagName: 'BR', textContent: ''},
      {nodeType: 3, textContent: 'Total Distance: 7.00 units'},
    ]);
  }
});

test('repeated searches replace the previous route and preserve zero distance', () => {
  const page = loadPage(connectedRows('Start', 'End'));
  page.search('Start', 'End');
  const result = page.search('End', 'End');
  assert.equal(result.childNodes.length, 3);
  assert.equal(result.childNodes[0].textContent, 'Path: End');
  assert.equal(result.childNodes[2].textContent, 'Total Distance: 0.00 units');
  assert.ok(!result.textContent.includes('Start'));
});

test('no-route output clears previous results and the next search still works', () => {
  const page = loadPage([...connectedRows('Start', 'End'),
    {Location: 'Isolated', X: '10', Z: '10', Path: ''}]);
  page.search('Start', 'End');
  const result = page.search('Start', 'Isolated');
  assert.deepEqual(result.childNodes, [{nodeType: 3, textContent: 'No path found.'}]);
  page.search('Start', 'End');
  assert.equal(result.childNodes[0].textContent, 'Path: Start ➜ End');
  assert.equal(result.childNodes.length, 3);
});
