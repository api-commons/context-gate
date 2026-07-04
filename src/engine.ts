// Context Gate engine: take OpenAPIs + a selection of operations and exposed fields,
// and emit the three governed artifacts — a Tyk OAS (the consumer surface), an MCP
// tool manifest, and a Spectral ruleset for the exposed surface (Tyk base + extension
// + exposed-schema + agent-exposure/PII). Pure data; no DOM.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
export const PII_RE = /(?:^|_|-|\b)(e?mail|ssn|social.?security|phone|mobile|tel|dob|birth|first.?name|last.?name|full.?name|surname|given.?name|address|street|city|zip|postal|passport|license|tax.?id|national.?id|iban|account.?number|card.?number|credit.?card|cvv|cvc|routing)(?:$|_|-|\b)/i;
export const SECRET_RE = /(?:^|_|-|\b)(password|passwd|secret|api.?key|apikey|token|bearer|auth|credential|private.?key|access.?key)(?:$|_|-|\b)/i;

export interface LoadedApi { id: string; title: string; version: string; doc: any; }
export interface OpParam { name: string; in: string; required: boolean; schema?: any; description?: string; }
export interface Operation {
  apiId: string; key: string; method: string; path: string; operationId: string;
  summary: string; tags: string[]; params: OpParam[];
  requestSchema?: any; responseSchema?: any; responseCode?: string;
}
export interface FieldNode { path: string; type: string; pii: boolean; secret: boolean; }
export interface FieldSel { included: boolean; pii: boolean; }
export interface OpSelection { selected: boolean; params: Record<string, boolean>; resFields: Record<string, FieldSel>; reqFields: Record<string, FieldSel>; }
export type Selection = Record<string, OpSelection>;
export interface GateConfig { name: string; upstreamUrl: string; listenPath: string; auth: 'none' | 'apiKey' | 'jwt'; rateLimitWrites: boolean; }

// ---- parse ------------------------------------------------------------------
export function parseApi(text: string, id: string): LoadedApi {
  const t = text.trim(); if (!t) throw new Error('empty document');
  let doc: any; try { doc = JSON.parse(t); } catch { doc = parseYaml(t); }
  if (!doc || (!doc.openapi && !doc.swagger)) throw new Error('not an OpenAPI/Swagger document');
  return { id, title: String(doc.info?.title || id), version: String(doc.info?.version || ''), doc };
}

function resolveRef(doc: any, ref: string): any {
  if (!ref?.startsWith('#/')) return {};
  let cur = doc; for (const seg of ref.slice(2).split('/')) { cur = cur?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')]; if (cur == null) return {}; }
  return cur;
}
// Resolve a schema one hop (follow a top-level $ref).
export function deref(doc: any, schema: any, seen: any[] = []): any {
  let s = schema; let guard = 0;
  while (s && s.$ref && guard++ < 20) s = resolveRef(doc, s.$ref);
  return s || {};
}

export function operations(api: LoadedApi): Operation[] {
  const doc = api.doc; const out: Operation[] = [];
  const paths = doc.paths || {};
  for (const path of Object.keys(paths)) {
    const item = paths[path]; if (!item || typeof item !== 'object') continue;
    const shared: OpParam[] = (item.parameters || []).map((p: any) => normParam(doc, p));
    for (const m of METHODS) {
      const op = item[m]; if (!op || typeof op !== 'object') continue;
      const opId = op.operationId || `${m}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      const params = [...shared, ...(op.parameters || []).map((p: any) => normParam(doc, p))];
      let requestSchema, responseSchema, responseCode;
      const rb = op.requestBody && deref(doc, op.requestBody);
      if (rb?.content) { const ct = pickJson(rb.content); if (ct) requestSchema = deref(doc, ct.schema); }
      const responses = op.responses || {};
      const okCode = Object.keys(responses).find((c) => /^2/.test(c)) || Object.keys(responses)[0];
      if (okCode) { const r = deref(doc, responses[okCode]); if (r?.content) { const ct = pickJson(r.content); if (ct) { responseSchema = deref(doc, ct.schema); responseCode = okCode; } } }
      out.push({ apiId: api.id, key: `${api.id}::${m}::${path}`, method: m, path, operationId: opId, summary: op.summary || op.description?.slice(0, 80) || '', tags: op.tags || [], params, requestSchema, responseSchema, responseCode });
    }
  }
  return out;
}
const pickJson = (content: any) => content['application/json'] || content[Object.keys(content)[0]];
function normParam(doc: any, p: any): OpParam { p = deref(doc, p); return { name: p.name, in: p.in, required: !!p.required, schema: p.schema, description: p.description }; }

// ---- field flattening (for the selection tree) ------------------------------
export function flattenFields(doc: any, schema: any, prefix = '', seen: any[] = [], depth = 0): FieldNode[] {
  const s = deref(doc, schema, seen); if (!s || depth > 8 || seen.includes(s)) return [];
  const out: FieldNode[] = []; const next = [...seen, s];
  if (s.properties) for (const name of Object.keys(s.properties)) {
    const child = deref(doc, s.properties[name], next);
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({ path, type: child.type || (child.properties ? 'object' : child.items ? 'array' : 'any'), pii: PII_RE.test(name), secret: SECRET_RE.test(name) });
    out.push(...flattenFields(doc, child, path, next, depth + 1));
  }
  if (s.items) out.push(...flattenFields(doc, s.items, prefix ? `${prefix}[]` : '[]', next, depth + 1));
  return out;
}

// Prune a schema to only included field paths (resolving refs, inlining the result).
function pruneSchema(doc: any, schema: any, isIncluded: (path: string) => boolean, prefix = '', seen: any[] = [], depth = 0): any {
  const s = deref(doc, schema, seen); if (!s || depth > 8 || seen.includes(s)) return {};
  const next = [...seen, s];
  const copy: any = {};
  for (const k of ['type', 'format', 'description', 'enum', 'example', 'required', 'nullable']) if (s[k] !== undefined) copy[k] = s[k];
  if (s.properties) {
    copy.properties = {};
    for (const name of Object.keys(s.properties)) {
      const path = prefix ? `${prefix}.${name}` : name;
      // Default is included; an explicitly-excluded field (leaf OR branch) is dropped
      // whole — excluding a parent object cascades to all its descendants.
      if (!isIncluded(path)) continue;
      copy.properties[name] = pruneSchema(doc, deref(doc, s.properties[name], next), isIncluded, path, next, depth + 1);
    }
    if (Array.isArray(copy.required)) copy.required = copy.required.filter((r: string) => copy.properties[r]);
  }
  if (s.items) copy.items = pruneSchema(doc, s.items, isIncluded, prefix ? `${prefix}[]` : '[]', next, depth + 1);
  return copy;
}

export function slug(s: string) { return String(s || 'context-gate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'context-gate'; }

// ---- 1. emit Tyk OAS --------------------------------------------------------
export function emitTyk(apis: Map<string, LoadedApi>, ops: Operation[], sel: Selection, cfg: GateConfig): any {
  const paths: any = {};
  const opMiddleware: any = {};
  for (const op of ops) {
    const s = sel[op.key]; if (!s?.selected) continue;
    const doc = apis.get(op.apiId)!.doc;
    const inc = (map: Record<string, FieldSel>, path: string) => map[path]?.included ?? true;
    const operation: any = { operationId: op.operationId, summary: op.summary, responses: {} };
    if (op.tags?.length) operation.tags = op.tags;
    const params = op.params.filter((p) => s.params[p.name] ?? true).map((p) => ({ name: p.name, in: p.in, required: p.required, ...(p.description ? { description: p.description } : {}), schema: p.schema || { type: 'string' } }));
    if (params.length) operation.parameters = params;
    if (op.requestSchema) operation.requestBody = { content: { 'application/json': { schema: pruneSchema(doc, op.requestSchema, (p) => inc(s.reqFields, p)) } } };
    operation.responses[op.responseCode || '200'] = { description: 'Success', ...(op.responseSchema ? { content: { 'application/json': { schema: pruneSchema(doc, op.responseSchema, (p) => inc(s.resFields, p)) } } } : {}) };
    (paths[op.path] ??= {})[op.method] = operation;
    opMiddleware[op.operationId] = {
      allow: { enabled: true },
      ...(op.requestSchema ? { validateRequest: { enabled: true, errorResponseCode: 422 } } : {}),
      ...(cfg.rateLimitWrites && ['post', 'put', 'patch', 'delete'].includes(op.method) ? { rateLimit: { enabled: true, rate: 30, per: '1m0s' } } : {}),
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: cfg.name, version: '1.0.0', description: `Governed context surface generated by Context Gate — a curated subset of upstream operations exposed to agents via Tyk API and MCP.` },
    servers: [{ url: cfg.upstreamUrl || 'https://upstream.example.com' }],
    paths,
    'x-tyk-api-gateway': {
      info: { id: slug(cfg.name), name: cfg.name, state: { active: true } },
      upstream: { url: cfg.upstreamUrl || 'https://upstream.example.com' },
      server: {
        listenPath: { value: cfg.listenPath || `/${slug(cfg.name)}/`, strip: true },
        authentication: { enabled: cfg.auth !== 'none' },
      },
      middleware: {
        global: { cors: { enabled: true, allowedOrigins: ['*'], allowedMethods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] } },
        operations: opMiddleware,
      },
    },
  };
}

// ---- 2. emit MCP tool manifest ---------------------------------------------
export function emitMcp(apis: Map<string, LoadedApi>, ops: Operation[], sel: Selection, cfg: GateConfig): any {
  const tools: any[] = [];
  for (const op of ops) {
    const s = sel[op.key]; if (!s?.selected) continue;
    const doc = apis.get(op.apiId)!.doc;
    const properties: any = {}; const required: string[] = [];
    for (const p of op.params) { if (!(s.params[p.name] ?? true)) continue; properties[p.name] = { ...(p.schema || { type: 'string' }), ...(p.description ? { description: p.description } : {}) }; if (p.required) required.push(p.name); }
    if (op.requestSchema) { const pruned = pruneSchema(doc, op.requestSchema, (path) => s.reqFields[path]?.included ?? true); if (pruned.properties) { properties.body = pruned; required.push('body'); } }
    tools.push({ name: op.operationId, description: op.summary || `${op.method.toUpperCase()} ${op.path}`, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } });
  }
  return { name: cfg.name, description: `MCP tools exposing the governed Context Gate surface.`, transport: 'served by Tyk from the generated OpenAPI', tools };
}

// ---- 3. emit Spectral ruleset (4 tiers) ------------------------------------
export function emitRuleset(apis: Map<string, LoadedApi>, ops: Operation[], sel: Selection, cfg: GateConfig): any {
  // find exposed fields flagged (or detected) as PII/secret for a targeted note
  const flagged: string[] = [];
  for (const op of ops) { const s = sel[op.key]; if (!s?.selected) continue;
    for (const [path, f] of Object.entries(s.resFields)) if (f.included && (f.pii || PII_RE.test(path.split('.').pop() || ''))) flagged.push(`${op.operationId}:${path}`);
  }
  const rules: any = {
    // --- base: well-formed Tyk OAS ---
    'tyk-extension-present': { description: 'The API must carry the x-tyk-api-gateway extension.', message: 'Missing x-tyk-api-gateway — this is not a Tyk OAS.', severity: 'error', given: '$', then: { field: 'x-tyk-api-gateway', function: 'truthy' } },
    'tyk-info-name': { description: 'The Tyk API must be named.', severity: 'error', given: '$.x-tyk-api-gateway.info', then: { field: 'name', function: 'truthy' } },
    'tyk-upstream-url': { description: 'The gateway must declare an upstream URL.', severity: 'error', given: '$.x-tyk-api-gateway.upstream', then: { field: 'url', function: 'truthy' } },
    'tyk-listen-path': { description: 'The gateway must declare a listen path.', severity: 'error', given: '$.x-tyk-api-gateway.server.listenPath', then: { field: 'value', function: 'truthy' } },
    // --- tyk extension posture ---
    ...(cfg.auth === 'none' ? {} : { 'tyk-authentication-enabled': { description: 'Authentication should be enabled on a surface exposed to agents.', severity: 'warn', given: '$.x-tyk-api-gateway.server.authentication', then: { field: 'enabled', function: 'truthy' } } }),
    'tyk-operations-allowlisted': { description: 'Every exposed operation should be explicitly allow-listed — the surface is opt-in, not open.', severity: 'warn', given: '$.x-tyk-api-gateway.middleware.operations[*]', then: { field: 'allow', function: 'truthy' } },
    // --- exposed schema quality ---
    'exposed-property-typed': { description: 'Every exposed field must declare a type — agents rely on it.', severity: 'warn', given: '$.paths[*][*]..content[*].schema..properties[*]', then: { field: 'type', function: 'truthy' } },
    'exposed-response-no-open-additional-properties': { description: 'Exposed response schemas should not allow arbitrary additional properties — you are minimizing what reaches the agent.', severity: 'warn', given: '$.paths[*][*].responses[*].content[*].schema', then: { field: 'additionalProperties', function: 'falsy' } },
    // --- agent-exposure: PII / secrets / compliance ---
    'exposed-field-pii-review': { description: 'A field exposed to agents has a name that looks like PII. Confirm it must be shared, or exclude/redact it.', message: 'Possible PII exposed to agents: {{property}}', severity: 'warn', given: '$.paths[*][*]..properties[*]~', then: { function: 'pattern', functionOptions: { notMatch: PII_RE.source } } },
    'exposed-field-secret-block': { description: 'A field exposed to agents looks like a secret or credential. This must never reach an agent.', message: 'Secret-like field exposed to agents: {{property}}', severity: 'error', given: '$.paths[*][*]..properties[*]~', then: { function: 'pattern', functionOptions: { notMatch: SECRET_RE.source } } },
    'exposed-parameter-no-secret': { description: 'Parameters exposed to agents must not carry secrets or keys.', message: 'Secret-like parameter exposed to agents: {{value}}', severity: 'error', given: '$.paths[*][*].parameters[*].name', then: { function: 'pattern', functionOptions: { notMatch: SECRET_RE.source } } },
  };
  return {
    rules,
    // metadata carried as comments-in-values (Spectral ignores unknown top-level keys under x-)
    'x-context-gate': {
      generatedFor: cfg.name,
      surface: `${ops.filter((o) => sel[o.key]?.selected).length} operations`,
      note: 'Ruleset for the exposed agent surface: base Tyk OAS + extension posture + exposed-schema minimization + PII/secret exposure. Lint the generated Tyk OAS against this with the API Validator or spectral-cli.',
      flaggedExposedFields: flagged,
    },
  };
}

export const toYaml = (obj: any) => stringifyYaml(obj);
export const toJson = (obj: any) => JSON.stringify(obj, null, 2);
