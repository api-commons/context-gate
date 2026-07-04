import './style.css';
import { parseApi, operations, flattenFields, emitTyk, emitMcp, emitRuleset, toYaml, toJson, type LoadedApi, type Operation, type Selection, type GateConfig, type FieldNode } from './engine';
import { searchApisIo, searchGitHub, type SearchHit } from './sources';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const val = (s: string) => ($(s) as HTMLInputElement | HTMLSelectElement).value;

const apis = new Map<string, LoadedApi>();
const opsByApi = new Map<string, Operation[]>();
const fieldCache = new Map<string, { params: string[]; req: FieldNode[]; res: FieldNode[] }>();
const openFields = new Set<string>();
const sel: Selection = {};
let source: 'upload' | 'apisio' | 'github' = 'upload';
let outTab: 'tyk' | 'mcp' | 'ruleset' = 'tyk';
let seq = 0;

init();
async function init() {
  wire();
  try {
    const text = await fetch(`${import.meta.env.BASE_URL}sample-openapi.json`).then((r) => r.text());
    addApi(text, 'sample');
    // pre-select the two GET invoice operations so output is populated
    for (const op of opsByApi.get('sample') || []) if (['listInvoices', 'getInvoice'].includes(op.operationId)) ensureSel(op).selected = true;
    renderSurface(); emit();
  } catch { renderSurface(); }
}

function wire() {
  document.querySelectorAll<HTMLButtonElement>('#src-seg button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#src-seg button').forEach((x) => x.classList.remove('is-active')); b.classList.add('is-active');
    source = b.dataset.src as typeof source;
    const searching = source !== 'upload';
    $('#q').hidden = !searching; $('#search-btn').hidden = !searching; $('#gh-token').hidden = source !== 'github';
    $('#upload-btn').hidden = source !== 'upload'; $('#paste-btn').hidden = source !== 'upload';
  }));
  $('#upload-btn').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => tryAdd(String(r.result), f.name); r.readAsText(f); });
  $('#paste-btn').addEventListener('click', () => { const d = $('#paste-drawer') as HTMLDetailsElement; d.hidden = false; d.open = true; });
  $('#paste-add').addEventListener('click', () => { tryAdd(val('#paste-text'), 'pasted'); (($('#paste-text')) as HTMLTextAreaElement).value = ''; ($('#paste-drawer') as HTMLDetailsElement).open = false; });
  $('#sample-btn').addEventListener('click', async () => { const t = await fetch(`${import.meta.env.BASE_URL}sample-openapi.json`).then((r) => r.text()); tryAdd(t, 'sample'); });
  $('#search-btn').addEventListener('click', doSearch);
  $('#q').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') doSearch(); });
  document.querySelectorAll<HTMLButtonElement>('.out-tab').forEach((t) => t.addEventListener('click', () => { document.querySelectorAll('.out-tab').forEach((x) => x.classList.remove('is-active')); t.classList.add('is-active'); outTab = t.dataset.out as typeof outTab; emit(); }));
  ['#cfg-name', '#cfg-upstream', '#cfg-listen', '#cfg-auth', '#cfg-ratelimit'].forEach((s) => $(s).addEventListener('input', emit));
  $('#dl-out').addEventListener('click', downloadOut);
  $('#copy-out').addEventListener('click', () => navigator.clipboard?.writeText(currentOut));
  $('#engage-ae').addEventListener('click', () => { location.href = 'mailto:info@apievangelist.com?subject=' + encodeURIComponent('Governing what agents consume — Context Gate'); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); about(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('about-modal')?.remove(); });
  $('#surface').addEventListener('click', onSurfaceClick);
}

function tryAdd(text: string, name: string) { try { addApi(text, `${name}-${++seq}`); renderSurface(); emit(); } catch (e) { alert(`Could not load "${name}": ${(e as Error).message}`); } }
function addApi(text: string, id: string) { const api = parseApi(text, id); apis.set(api.id, api); opsByApi.set(api.id, operations(api)); }
function ensureSel(op: Operation) { return (sel[op.key] ??= { selected: false, params: {}, reqFields: {}, resFields: {} }); }
function readCfg(): GateConfig { return { name: val('#cfg-name') || 'Context Gate', upstreamUrl: val('#cfg-upstream'), listenPath: val('#cfg-listen'), auth: val('#cfg-auth') as any, rateLimitWrites: ($('#cfg-ratelimit') as HTMLInputElement).checked }; }

// ---- search -----------------------------------------------------------------
async function doSearch() {
  const q = val('#q').trim(); if (!q) return;
  const box = $('#results'); box.hidden = false; box.innerHTML = '<div class="muted small">Searching…</div>';
  try {
    const hits = source === 'github' ? await searchGitHub(q, val('#gh-token').trim()) : await searchApisIo(q);
    if (!hits.length) { box.innerHTML = '<div class="muted small">No results.</div>'; return; }
    box.innerHTML = hits.map((h, i) => `<div class="hit"><span class="h-name">${esc(h.name)}${h.provider ? ` <span class="h-prov">· ${esc(h.provider)}</span>` : ''}</span><button data-hit="${i}" type="button">＋ Add</button></div>`).join('');
    box.querySelectorAll<HTMLButtonElement>('button[data-hit]').forEach((b) => b.addEventListener('click', async () => { b.textContent = '…'; try { const t = await hits[+b.dataset.hit!].fetch(); tryAdd(t, hits[+b.dataset.hit!].name || 'api'); b.textContent = '✓'; } catch (e) { b.textContent = '✕'; alert((e as Error).message); } }));
  } catch (e) { box.innerHTML = `<div class="cov-error">${esc((e as Error).message)}</div>`; }
}

// ---- surface render ---------------------------------------------------------
function fieldsOf(op: Operation) {
  if (!fieldCache.has(op.key)) { const doc = apis.get(op.apiId)!.doc; fieldCache.set(op.key, { params: op.params.map((p) => p.name), req: op.requestSchema ? flattenFields(doc, op.requestSchema) : [], res: op.responseSchema ? flattenFields(doc, op.responseSchema) : [] }); }
  return fieldCache.get(op.key)!;
}

function renderSurface() {
  const host = $('#surface');
  if (!apis.size) { host.innerHTML = '<div class="empty-note">Load an API to choose the operations and fields you expose to agents.</div>'; return; }
  host.innerHTML = [...apis.values()].map((api) => {
    const ops = opsByApi.get(api.id) || [];
    return `<div class="api-block"><div class="api-head"><b>${esc(api.title)}</b> <span class="muted small">${esc(api.version)} · ${ops.length} ops</span><button class="rm" data-act="remove-api" data-id="${esc(api.id)}" title="Remove">✕</button></div>
      ${ops.map((op) => opRow(op)).join('')}</div>`;
  }).join('');
}

function opRow(op: Operation): string {
  const s = sel[op.key]; const selected = !!s?.selected; const open = openFields.has(op.key);
  return `<div class="op ${selected ? 'sel' : ''}">
    <div class="op-head">
      <input type="checkbox" data-act="toggle-op" data-key="${esc(op.key)}" ${selected ? 'checked' : ''} />
      <span class="method ${op.method}">${op.method.toUpperCase()}</span>
      <span class="op-path" data-act="toggle-op" data-key="${esc(op.key)}">${esc(op.path)}</span>
      ${selected ? `<button class="op-fields-btn" data-act="toggle-fields" data-key="${esc(op.key)}">${open ? 'hide fields' : 'fields ▾'}</button>` : `<span class="op-sum">${esc(op.summary)}</span>`}
    </div>
    ${selected && open ? fieldsPanel(op) : ''}
  </div>`;
}

function fieldsPanel(op: Operation): string {
  const f = fieldsOf(op); const s = ensureSel(op);
  const paramRows = f.params.map((name) => { const inc = s.params[name] ?? true; return `<div class="field ${inc ? '' : 'excl'}"><input type="checkbox" data-act="toggle-param" data-key="${esc(op.key)}" data-name="${esc(name)}" ${inc ? 'checked' : ''} /><span class="fpath">${esc(name)}</span></div>`; }).join('') || '<div class="muted small">none</div>';
  const fieldRows = (nodes: FieldNode[], kind: 'req' | 'res') => nodes.map((n) => {
    const map = kind === 'req' ? s.reqFields : s.resFields; const inc = map[n.path]?.included ?? true; const pii = map[n.path]?.pii ?? n.pii;
    const tag = n.secret ? '<span class="pii-tag secret">secret</span>' : `<button class="pii-tag ${pii ? 'pii' : 'off'}" data-act="toggle-pii" data-key="${esc(op.key)}" data-kind="${kind}" data-path="${esc(n.path)}">pii</button>`;
    return `<div class="field ${inc ? '' : 'excl'}"><input type="checkbox" data-act="toggle-field" data-key="${esc(op.key)}" data-kind="${kind}" data-path="${esc(n.path)}" ${inc ? 'checked' : ''} /><span class="fpath">${esc(n.path)}</span><span class="ftype">${esc(n.type)}</span>${tag}</div>`;
  }).join('') || '<div class="muted small">none</div>';
  return `<div class="fields open">
    <div class="fgroup"><h5>Parameters</h5>${paramRows}</div>
    ${f.req.length ? `<div class="fgroup"><h5>Request body</h5>${fieldRows(f.req, 'req')}</div>` : ''}
    ${f.res.length ? `<div class="fgroup"><h5>Response</h5>${fieldRows(f.res, 'res')}</div>` : ''}
  </div>`;
}

function onSurfaceClick(ev: Event) {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!el) return;
  const act = el.dataset.act!; const key = el.dataset.key!;
  const op = key ? [...opsByApi.values()].flat().find((o) => o.key === key) : undefined;
  if (act === 'remove-api') { const id = el.dataset.id!; apis.delete(id); const ops = opsByApi.get(id) || []; ops.forEach((o) => { delete sel[o.key]; openFields.delete(o.key); }); opsByApi.delete(id); renderSurface(); emit(); return; }
  if (!op) return;
  if (act === 'toggle-op') { const s = ensureSel(op); s.selected = !s.selected; if (s.selected) openFields.add(op.key); else openFields.delete(op.key); renderSurface(); emit(); return; }
  if (act === 'toggle-fields') { openFields.has(op.key) ? openFields.delete(op.key) : openFields.add(op.key); renderSurface(); return; }
  if (act === 'toggle-param') { const s = ensureSel(op); const n = el.dataset.name!; s.params[n] = !(s.params[n] ?? true); (el.closest('.field') as HTMLElement).classList.toggle('excl', !s.params[n]); emit(); return; }
  if (act === 'toggle-field') { const s = ensureSel(op); const kind = el.dataset.kind as 'req' | 'res'; const path = el.dataset.path!; const map = kind === 'req' ? s.reqFields : s.resFields; const cur = map[path]?.included ?? true; map[path] = { included: !cur, pii: map[path]?.pii ?? false }; (el.closest('.field') as HTMLElement).classList.toggle('excl', cur); emit(); return; }
  if (act === 'toggle-pii') { const s = ensureSel(op); const kind = el.dataset.kind as 'req' | 'res'; const path = el.dataset.path!; const map = kind === 'req' ? s.reqFields : s.resFields; const cur = map[path]?.pii ?? false; map[path] = { included: map[path]?.included ?? true, pii: !cur }; el.classList.toggle('pii', !cur); el.classList.toggle('off', cur); emit(); return; }
}

// ---- emit -------------------------------------------------------------------
let currentOut = '';
function emit() {
  const cfg = readCfg();
  const allOps = [...opsByApi.values()].flat();
  const selCount = allOps.filter((o) => sel[o.key]?.selected).length;
  let piiExposed = 0, secretExposed = 0;
  for (const o of allOps) { const s = sel[o.key]; if (!s?.selected) continue; const f = fieldsOf(o);
    for (const n of f.res.concat(f.req)) { const inc = (n.path in (s.resFields) ? s.resFields[n.path]?.included : s.reqFields[n.path]?.included) ?? true; if (!inc) continue; if (n.secret) secretExposed++; else if ((s.resFields[n.path]?.pii ?? s.reqFields[n.path]?.pii ?? n.pii)) piiExposed++; } }
  $('#gate-stats').innerHTML = `<span><b>${selCount}</b> operations exposed</span><span class="${piiExposed ? 'warnf' : ''}"><b>${piiExposed}</b> PII fields</span><span class="${secretExposed ? 'warnf' : ''}"><b>${secretExposed}</b> secret-like fields</span>`;
  $('#status').innerHTML = `<b>${apis.size}</b> API${apis.size === 1 ? '' : 's'} · <b>${selCount}</b> selected`;

  if (!selCount) { currentOut = ''; $('#output').textContent = 'Select one or more operations to compose the exposed surface.'; $('#out-hint').textContent = ''; return; }
  if (outTab === 'tyk') { currentOut = toYaml(emitTyk(apis, allOps, sel, cfg)); $('#out-hint').textContent = 'The governed Tyk OpenAPI — only selected ops + kept fields, with x-tyk-api-gateway.'; }
  else if (outTab === 'mcp') { currentOut = toJson(emitMcp(apis, allOps, sel, cfg)); $('#out-hint').textContent = 'MCP tool manifest — one tool per exposed operation, input schema from kept params/body.'; }
  else { currentOut = toYaml(emitRuleset(apis, allOps, sel, cfg)); $('#out-hint').textContent = 'Spectral ruleset for the surface — Tyk base + exposed-schema + PII/secret exposure checks.'; }
  $('#output').textContent = currentOut;
}
function downloadOut() {
  const cfg = readCfg(); const names = { tyk: `${slugName(cfg.name)}-tyk.yaml`, mcp: `${slugName(cfg.name)}-mcp.json`, ruleset: `${slugName(cfg.name)}-ruleset.yaml` };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([currentOut], { type: 'text/plain' })); a.download = names[outTab]; a.click(); URL.revokeObjectURL(a.href);
}
const slugName = (s: string) => (s || 'context-gate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'context-gate';

function about() {
  const el = document.createElement('div'); el.id = 'about-modal';
  el.innerHTML = `<div class="about-backdrop"></div><div class="about-card">
    <button class="detail-close" id="about-close">&times;</button>
    <h2>Governance, from the consumer's side</h2>
    <p>Almost every API tool and ruleset governs what a <em>producer</em> ships. But the pressing question now is the other direction: of everything your APIs can do, what should an <strong>agent</strong> actually be allowed to consume? Context Gate is governance from the consumer side.</p>
    <p>Search or upload your OpenAPIs, then <strong>choose the exact operations</strong> you'll expose — that selection becomes both the <strong>API paths</strong> and the <strong>MCP tools</strong> you offer — with field-level control over the <strong>parameters and schema</strong> each one carries. It emits a governed <strong>Tyk OpenAPI</strong> (with vendor extensions), an <strong>MCP tool manifest</strong>, and a <strong>Spectral ruleset</strong> for the exposed surface: base Tyk validity, extension posture, exposed-schema minimization, and the checks that matter most when handing data to agents — <strong>PII, secrets, and compliance</strong>.</p>
    <p>The context you give an agent is a surface you compose and govern on purpose — not everything your backend happens to expose. It pairs with the <a href="https://validator.apicommons.org" target="_blank" rel="noopener">Validator</a> and <a href="https://agents.apicommons.org" target="_blank" rel="noopener">Agent Rule Export</a>.</p>
    <p class="muted small">Runs entirely in your browser. Your API descriptions and tokens never leave the page.</p>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#about-close')!.addEventListener('click', () => el.remove());
  el.querySelector('.about-backdrop')!.addEventListener('click', () => el.remove());
}
