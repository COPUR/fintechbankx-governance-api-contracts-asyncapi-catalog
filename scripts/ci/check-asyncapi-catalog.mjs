#!/usr/bin/env node
// AsyncAPI catalog consistency gate.
// Status: Proposed (API Governance Guild review required).
//
// Usage: node scripts/ci/check-asyncapi-catalog.mjs [repoRoot]
//
// Fails (exit 1) when:
//   - a top-level asyncapi/*.yaml|yml spec has no catalog/index.json entry, or an entry points to a missing file;
//   - an index entry is malformed (service id, owner repo, namespace, status, file name);
//   - two index entries share a serviceId, file or namespace;
//   - a spec's info.x-service-id / info.x-event-namespace differ from its index entry;
//   - a channel address does not match ^evt\.[a-z]+\.[a-z0-9-]+\.[a-z0-9-]+\.v[0-9]+$
//     (dead-letter topics <namespace>.dlq.v<N> match the same pattern);
//   - a channel address is outside the spec's namespace, or its Kafka binding topic differs from the address;
//   - the index channel list differs from the spec's channel addresses;
//   - a message payload does not use the common envelope ($ref to common/event-envelope.yaml#/EventEnvelope);
//   - the same topic address is published by two specs.
// Consumed channels (every operation on the channel is `receive`) may sit in another namespace. They must be
// listed in the entry's optional `consumes` array, are not counted as published, and when the owning
// namespace has a spec in the catalog that spec must publish the topic.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  TOPIC_RE, NAMESPACE_RE, loadYaml, usesEnvelope, createResolver, listChannels,
} from './lib/asyncapi-model.mjs';

export const STATUSES = ['contract-only', 'publishes-legacy', 'outbox', 'no-contract'];
const SERVICE_ID_RE = /^svc-[a-z]+-[a-z0-9-]+$/;
const OWNER_REPO_RE = /^COPUR\/fintechbankx-[a-z0-9-]+$/;

export function listSpecFiles(root) {
  const dir = path.join(root, 'asyncapi');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => `asyncapi/${e.name}`)
    .sort();
}

export function checkCatalog(root) {
  const errors = [];
  const notes = [];
  const err = (msg) => errors.push(msg);

  const indexPath = path.join(root, 'catalog', 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { errors: ['catalog/index.json is missing'], notes };
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return { errors: [`catalog/index.json: invalid JSON: ${e.message}`], notes };
  }
  const entries = Array.isArray(index.services) ? index.services : null;
  if (!entries) return { errors: ['catalog/index.json: "services" must be an array'], notes };

  // 1. Entry shape and uniqueness.
  const seen = { serviceId: new Map(), file: new Map(), namespace: new Map() };
  entries.forEach((e, i) => {
    const where = `catalog/index.json services[${i}] (${e?.serviceId ?? '?'})`;
    if (!SERVICE_ID_RE.test(e?.serviceId ?? '')) err(`${where}: serviceId must match ${SERVICE_ID_RE}`);
    if (!OWNER_REPO_RE.test(e?.ownerRepo ?? '')) err(`${where}: ownerRepo must match ${OWNER_REPO_RE}`);
    if (!NAMESPACE_RE.test(e?.namespace ?? '')) err(`${where}: namespace must match ${NAMESPACE_RE}`);
    if (!STATUSES.includes(e?.implementationStatus)) err(`${where}: implementationStatus must be one of ${STATUSES.join(', ')}`);
    if (!Array.isArray(e?.channels)) err(`${where}: channels must be an array`);
    if (e?.consumes !== undefined && !Array.isArray(e.consumes)) err(`${where}: consumes must be an array when present`);
    if (!(e?.providerSpecPath === null || typeof e?.providerSpecPath === 'string')) err(`${where}: providerSpecPath must be a string or null`);
    if (e?.file === null) {
      if (e?.implementationStatus !== 'no-contract') err(`${where}: entries without a file must have implementationStatus "no-contract"`);
      if (Array.isArray(e?.channels) && e.channels.length > 0) err(`${where}: entries without a file must not list channels`);
    } else {
      if (e?.file !== `asyncapi/${e?.serviceId}.yaml`) err(`${where}: file must be asyncapi/<serviceId>.yaml`);
      if (e?.implementationStatus === 'no-contract') err(`${where}: an entry with a file cannot be "no-contract"`);
    }
    for (const field of ['serviceId', 'file', 'namespace']) {
      const v = e?.[field];
      if (v === null || v === undefined) continue;
      if (seen[field].has(v)) err(`${where}: duplicate ${field} ${v} (also services[${seen[field].get(v)}])`);
      else seen[field].set(v, i);
    }
  });

  // 2. Spec files <-> index entries.
  const specFiles = listSpecFiles(root);
  const byFile = new Map(entries.filter((e) => e?.file).map((e) => [e.file, e]));
  for (const f of specFiles) {
    if (!byFile.has(f)) err(`${f}: spec has no entry in catalog/index.json`);
  }
  for (const f of byFile.keys()) {
    if (!fs.existsSync(path.join(root, f))) err(`catalog/index.json: entry file ${f} does not exist`);
  }

  // 3. Per-spec checks.
  const topicOwner = new Map();
  const consumed = []; // { file, where, addr }
  const resolver = createResolver((rel) => {
    const p = path.join(root, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  });
  for (const f of specFiles) {
    const entry = byFile.get(f);
    let doc;
    try {
      doc = loadYaml(fs.readFileSync(path.join(root, f), 'utf8'), f);
    } catch (e) {
      err(e.message);
      continue;
    }
    if (!entry) continue;
    const ns = entry.namespace;
    if (doc?.info?.['x-service-id'] !== entry.serviceId) {
      err(`${f}: info.x-service-id (${doc?.info?.['x-service-id']}) differs from index serviceId ${entry.serviceId}`);
    }
    if (doc?.info?.['x-event-namespace'] !== ns) {
      err(`${f}: info.x-event-namespace (${doc?.info?.['x-event-namespace']}) differs from index namespace ${ns}`);
    }
    let channels;
    try {
      channels = listChannels(doc, f, resolver);
    } catch (e) {
      err(`${f}: ${e.message}`);
      continue;
    }
    const addresses = [];
    const consumedHere = [];
    const opActions = new Map(); // channel key -> Set(actions)
    for (const op of Object.values(doc?.operations ?? {})) {
      const ref = op?.channel?.$ref ?? '';
      const key = ref.startsWith('#/channels/') ? ref.slice('#/channels/'.length) : null;
      if (!key) continue;
      if (!opActions.has(key)) opActions.set(key, new Set());
      opActions.get(key).add(op?.action);
    }
    for (const ch of channels) {
      const where = `${f} channels.${ch.key}`;
      const addr = ch.address;
      if (typeof addr !== 'string') {
        err(`${where}: missing address`);
        continue;
      }
      const actions = opActions.get(ch.key);
      const receiveOnly = actions && actions.size > 0 && [...actions].every((a) => a === 'receive');
      if (receiveOnly) {
        consumedHere.push(addr);
        if (!TOPIC_RE.test(addr)) err(`${where}: consumed address ${addr} does not match ${TOPIC_RE}`);
        consumed.push({ file: f, where, addr });
        continue;
      }
      addresses.push(addr);
      if (!TOPIC_RE.test(addr)) {
        err(`${where}: address ${addr} does not match ${TOPIC_RE} (dead-letter: <namespace>.dlq.v<N>)`);
      } else if (addr.split('.').slice(0, 3).join('.') !== ns) {
        err(`${where}: address ${addr} is outside the service namespace ${ns}`);
      }
      const bindingTopic = ch.channel?.bindings?.kafka?.topic;
      if (bindingTopic !== undefined && bindingTopic !== addr) {
        err(`${where}: bindings.kafka.topic ${bindingTopic} differs from address ${addr}`);
      }
      if (topicOwner.has(addr) && topicOwner.get(addr) !== f) {
        err(`${where}: topic ${addr} is also declared by ${topicOwner.get(addr)}`);
      } else if (topicOwner.has(addr)) {
        err(`${where}: topic ${addr} is declared twice in the same spec`);
      } else {
        topicOwner.set(addr, f);
      }
      if (ch.messages.length === 0) err(`${where}: channel declares no messages`);
      for (const m of ch.messages) {
        if (!usesEnvelope(m.message?.payload, doc)) {
          err(`${where} message ${m.key}: payload does not use the common envelope ($ref to common/event-envelope.yaml#/EventEnvelope)`);
        }
      }
    }
    for (const [mKey, msg] of Object.entries(doc?.components?.messages ?? {})) {
      if (!usesEnvelope(msg?.payload, doc)) {
        err(`${f} components.messages.${mKey}: payload does not use the common envelope`);
      }
    }
    const indexed = [...(entry.channels ?? [])].sort();
    const actual = [...addresses].sort();
    if (JSON.stringify(indexed) !== JSON.stringify(actual)) {
      const missing = actual.filter((a) => !indexed.includes(a));
      const extra = indexed.filter((a) => !actual.includes(a));
      err(`${f}: index channels differ from spec (missing in index: [${missing.join(', ')}], not in spec: [${extra.join(', ')}])`);
    }
    const indexedConsumes = [...(entry.consumes ?? [])].sort();
    if (JSON.stringify(indexedConsumes) !== JSON.stringify([...consumedHere].sort())) {
      err(`${f}: index consumes [${indexedConsumes.join(', ')}] differs from the spec's receive-only channels [${[...consumedHere].sort().join(', ')}]`);
    }
    notes.push(`${f}: ${entry.serviceId} ${ns} ${addresses.length} channel(s), ${consumedHere.length} consumed, status ${entry.implementationStatus}`);
  }
  const nsWithSpec = new Map(entries.filter((e) => e?.file).map((e) => [e.namespace, e.file]));
  for (const c of consumed) {
    const owner = nsWithSpec.get(c.addr.split('.').slice(0, 3).join('.'));
    if (owner && topicOwner.get(c.addr) !== owner) {
      err(`${c.where}: consumes ${c.addr}, which ${owner} does not publish`);
    }
  }
  for (const e of entries.filter((x) => x?.file === null)) {
    notes.push(`expected (no contract yet): ${e.serviceId} ${e.namespace} owner ${e.ownerRepo}`);
  }
  return { errors, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] ?? '.');
  const { errors, notes } = checkCatalog(root);
  notes.forEach((n) => console.log(`ok  ${n}`));
  if (errors.length > 0) {
    errors.forEach((e) => console.error(`ERR ${e}`));
    console.error(`asyncapi catalog check failed: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log('asyncapi catalog check passed');
}
