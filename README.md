# Context Gate

Compose and govern exactly the **context — API operations and fields — your services
expose to agents.** Almost every API tool and ruleset governs what a *producer* ships;
Context Gate governs the other direction: of everything your APIs can do, what should an
**agent** actually be allowed to consume? No backend, no accounts; runs in your browser.
Live at **[contextgate.apicommons.org](https://contextgate.apicommons.org)**.

Part of the [API Commons](https://apicommons.org/tools/) tools, alongside
[API Validator](https://github.com/api-commons/api-validator),
[Agent Rule Export](https://github.com/api-commons/governance-agent-export),
[Governance Coverage](https://github.com/api-commons/governance-coverage), and
[API Certification](https://github.com/api-commons/governance-certification).

## What it does

1. **Source your APIs** — search [APIs.io](https://apis.io) or GitHub code (with your own
   token), or upload / paste an OpenAPI.
2. **Choose the operations** you'll expose. That selection becomes both the **API paths**
   and the **MCP tools** you offer to agents.
3. **Control the fields** — for each operation, include or exclude individual parameters and
   request/response schema fields, and flag fields as **PII**. Excluded fields are pruned
   from the exposed surface (excluding a parent object cascades to its children).
4. **Emit three governed artifacts:**
   - **Tyk OpenAPI** — a self-contained OAS with only the selected operations and kept
     fields, plus the `x-tyk-api-gateway` extension (upstream, listen path, authentication,
     per-operation `allow` / `validateRequest` / optional `rateLimit`).
   - **MCP tool manifest** — one tool per exposed operation, its input schema built from the
     kept parameters and body (Tyk can serve MCP from the generated OpenAPI).
   - **Spectral ruleset** — governance for the *exposed surface*, in tiers: base Tyk OAS
     validity, extension posture (auth enabled, operations allow-listed), exposed-schema
     minimization (every field typed, no open `additionalProperties`), and the checks that
     matter most when handing data to agents — **PII review, secret-field blocking, and
     no-secrets-in-parameters**.

The context you give an agent is a surface you compose and govern *on purpose* — not
everything your backend happens to expose.

## Why this is different

The rest of the governance toolchain is producer-centric: is *your* API well-formed, well
documented, secure? Context Gate is **consumer-centric** — it governs the *least-privilege
slice* of your APIs that reaches an agent, and generates the ruleset to keep that slice
honest as it changes. It pairs with the [Validator](https://validator.apicommons.org) (lint
the generated Tyk OAS against the generated ruleset) and
[Agent Rule Export](https://agents.apicommons.org) (hand the rules to the agent).

## Develop

```bash
npm install
npm run dev
npm run build     # → dist/
```

Pure client-side. The Tyk OAS shape follows Tyk's `x-tyk-api-gateway` OpenAPI extension.

## Privacy

Everything runs client-side. Your API descriptions and your GitHub token never leave the
page — search and file fetches go directly from your browser to APIs.io / GitHub.

---

**Governance guidance** — the human *why*:
[Guardrails](https://guidance.apievangelist.com/store/guardrails/) and
[Consumption](https://guidance.apievangelist.com/store/consumption/) at
guidance.apievangelist.com.

A project of [API Evangelist](https://apievangelist.com), maintained openly under
[API Commons](https://apicommons.org). Free to fork; API Evangelist offers expert API
governance services — including governing what your agents consume — when you want help.
Apache-2.0.
