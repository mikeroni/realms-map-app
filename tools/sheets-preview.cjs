// Local-only preview. Google services are simulated in memory; no real Sheet is touched.
const http = require('node:http');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {server, rpcCopy} = require('../tests/sheets/fake-sheets.cjs');
const instance = server();
const methods = new Set(['getEditorState', 'addLocation', 'previewConnections', 'addConnections', 'previewEdit', 'applyEdit', 'prepareRelease', 'approveRelease']);
const shim = `<script>
  window.google = {script: {get run() {
    let success, failure;
    const runner = new Proxy({}, {get(_, name) {
      if (name === 'withSuccessHandler') return handler => {success = handler; return runner;};
      if (name === 'withFailureHandler') return handler => {failure = handler; return runner;};
      return (...args) => fetch('/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method: name, args})})
        .then(response => response.json()).then(result => {if (result.error) failure(new Error(result.error)); else success(result.value);})
        .catch(failure);
    }});
    return runner;
  }}};
</script>`;
const page = () => readFileSync(join(__dirname, '../apps-script/Sidebar.html'), 'utf8')
  .replace('<body>', '<body><p style="padding:8px;background:#fff0cf"><strong>Local demo</strong> — synthetic data only. No Google or GitHub changes.</p>')
  .replace('  <script>', shim + '  <script>');
http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); response.end(page()); return;
  }
  if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404); response.end(); return; }
  if (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:8522') {
    response.writeHead(403); response.end(); return;
  }
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 100000) throw new Error('Request too large.');
    }
    const {method, args} = JSON.parse(body);
    if (!methods.has(method)) throw new Error('Unknown preview method.');
    // Exercise independent RPC copies and differing object key order on save.
    const value = instance.context[method](...rpcCopy(args, method === 'applyEdit'));
    response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({value: rpcCopy(value, true)}));
  } catch (error) {
    response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: error.message}));
  }
}).listen(8522, '127.0.0.1', () => console.log('Synthetic sidebar preview: http://127.0.0.1:8522'));
