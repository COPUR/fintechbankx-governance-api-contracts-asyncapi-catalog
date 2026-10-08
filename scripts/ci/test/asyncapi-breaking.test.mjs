import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSpecs, readAccepted, specDir } from '../asyncapi-breaking.mjs';
import { spec, ENVELOPE, reader, deadLetterChannel } from './fixtures.mjs';

const FILE = 'asyncapi/svc-tst-sample.yaml';
const files = (doc) => reader({ [FILE]: doc, 'asyncapi/common/event-envelope.yaml': ENVELOPE });
const rules = (baseDoc, headDoc) => compareSpecs(FILE, files(baseDoc), files(headDoc)).map((f) => f.key);
const data = (mutate) => {
  const doc = spec();
  mutate(doc.components.schemas.SampleCreatedData, doc);
  return doc;
};

test('identical specs have no findings', () => {
  assert.deepEqual(rules(spec(), spec()), []);
});

test('adding an optional property is compatible', () => {
  assert.deepEqual(rules(spec(), data((d) => { d.properties.extra = { type: 'string' }; })), []);
});

test('adding a channel and an enum value is compatible', () => {
  const head = data((d) => { d.properties.status.enum.push('PENDING'); });
  head.channels.updated = { address: 'evt.tst.sample.updated.v1', messages: { SampleCreated: { $ref: '#/components/messages/SampleCreated' } } };
  assert.deepEqual(rules(spec(), head), []);
});

test('removed channel is breaking', () => {
  const head = spec();
  delete head.channels.created;
  assert.deepEqual(rules(spec(), head), ['removed-channel evt.tst.sample.created.v1']);
});

test('removed message is breaking', () => {
  const head = spec();
  head.channels.created.messages = { Other: { $ref: '#/components/messages/SampleCreated' } };
  assert.deepEqual(rules(spec(), head), ['removed-message evt.tst.sample.created.v1 SampleCreated']);
});

test('removed property is breaking', () => {
  assert.deepEqual(rules(spec(), data((d) => { delete d.properties.note; })), ['removed-property evt.tst.sample.created.v1 SampleCreated $.data.note']);
});

test('newly required property is breaking', () => {
  assert.deepEqual(rules(spec(), data((d) => { d.required.push('note'); })), ['newly-required evt.tst.sample.created.v1 SampleCreated $.data.note']);
});

test('new required property is breaking', () => {
  assert.deepEqual(
    rules(spec(), data((d) => { d.properties.extra = { type: 'string' }; d.required.push('extra'); })),
    ['newly-required evt.tst.sample.created.v1 SampleCreated $.data.extra'],
  );
});

test('changed type is breaking', () => {
  assert.deepEqual(rules(spec(), data((d) => { d.properties.note.type = 'integer'; })), ['changed-type evt.tst.sample.created.v1 SampleCreated $.data.note']);
});

test('removed enum value is breaking', () => {
  assert.deepEqual(rules(spec(), data((d) => { d.properties.status.enum = ['OPEN']; })), ['removed-enum-value evt.tst.sample.created.v1 SampleCreated $.data.status "CLOSED"']);
});

test('accepted-breaking list parses keys and ignores comments', () => {
  const accepted = readAccepted('# reason: v2 published\nremoved-channel evt.tst.sample.created.v1  # dual-publish ended\n\n');
  assert.deepEqual([...accepted], ['removed-channel evt.tst.sample.created.v1']);
});

test('removing a dead-letter channel is not breaking (DLQs are consumer-owned, ADR-019)', () => {
  const base = spec();
  base.channels.deadLetter = deadLetterChannel();
  assert.deepEqual(rules(base, spec()), []);
});

// Consumer-breaking changes on the same .vN topic (ADR-019 section 5).
const binding = (mutate) => {
  const doc = spec();
  doc.channels.created.bindings.kafka = { topic: 'evt.tst.sample.created.v1', partitions: 3, topicConfiguration: { 'cleanup.policy': ['delete'], 'retention.ms': 604800000 } };
  if (mutate) mutate(doc.channels.created.bindings.kafka, doc);
  return doc;
};
const withKey = (key) => {
  const doc = spec();
  doc.components.messages.SampleCreated.bindings = { kafka: { key } };
  return doc;
};

test('a property that is no longer required is breaking', () => {
  assert.deepEqual(rules(spec(), data((d) => { d.required = []; })), ['no-longer-required evt.tst.sample.created.v1 SampleCreated $.data.sampleId']);
});

test('a changed const is breaking', () => {
  const withConst = (v) => data((d) => { d.properties.kind = { type: 'string', const: v }; });
  assert.deepEqual(rules(withConst('Sample.Created.v1'), withConst('Sample.Decided.v1')), ['changed-const evt.tst.sample.created.v1 SampleCreated $.data.kind']);
});

test('a changed validation keyword is breaking', () => {
  const base = data((d) => { d.properties.sampleId.minLength = 1; });
  const head = data((d) => { d.properties.sampleId.minLength = 1; d.properties.sampleId.pattern = '^S-[0-9]+$'; });
  assert.deepEqual(rules(base, head), ['changed-constraint evt.tst.sample.created.v1 SampleCreated $.data.sampleId pattern']);
});

test('changed partitions, cleanup policy or topic in the Kafka binding are breaking', () => {
  const head = binding((k) => { k.partitions = 12; k.topicConfiguration['cleanup.policy'] = ['compact']; k.topic = 'evt.tst.sample.made.v1'; });
  assert.deepEqual(rules(binding(), head).sort(), [
    'changed-binding evt.tst.sample.created.v1 cleanup.policy',
    'changed-binding evt.tst.sample.created.v1 partitions',
    'changed-binding evt.tst.sample.created.v1 topic',
  ]);
});

test('shorter retention is breaking, longer retention and replicas are not', () => {
  assert.deepEqual(rules(binding(), binding((k) => { k.topicConfiguration['retention.ms'] = 86400000; })), ['changed-binding evt.tst.sample.created.v1 retention.ms']);
  assert.deepEqual(rules(binding(), binding((k) => { k.topicConfiguration['retention.ms'] = 7776000000; k.replicas = 3; })), []);
});

test('a changed message key is breaking, a reworded key description is not', () => {
  const base = withKey({ type: 'string', description: 'aggregateId (sampleId).' });
  assert.deepEqual(rules(base, withKey({ type: 'string', description: 'The sample id.' })), []);
  assert.deepEqual(rules(base, withKey({ type: 'integer', description: 'aggregateId (sampleId).' })), ['changed-message-key evt.tst.sample.created.v1 SampleCreated']);
});

// Narrowing a value set or closing an object (open finance review, 2026-10-08).
const tags = (values) => data((d) => { d.properties.tags = { type: 'array', items: { type: 'string', ...(values ? { enum: values } : {}) } }; });

test('removing an enum value of array items is breaking', () => {
  assert.deepEqual(rules(tags(['A', 'B']), tags(['A'])), ['removed-enum-value evt.tst.sample.created.v1 SampleCreated $.data.tags[] "B"']);
});

test('adding an enum to array items that had none is breaking', () => {
  assert.deepEqual(rules(tags(null), tags(['A'])), ['changed-constraint evt.tst.sample.created.v1 SampleCreated $.data.tags[] enum']);
});

test('adding an enum to a property that had none is breaking', () => {
  assert.deepEqual(rules(spec(), data((d) => { d.properties.note.enum = ['X']; })), ['changed-constraint evt.tst.sample.created.v1 SampleCreated $.data.note enum']);
});

test('closing additionalProperties is breaking', () => {
  assert.deepEqual(
    rules(spec(), data((d) => { d.additionalProperties = false; })),
    ['changed-constraint evt.tst.sample.created.v1 SampleCreated $.data additionalProperties'],
  );
});

test('opening additionalProperties is compatible', () => {
  assert.deepEqual(rules(data((d) => { d.additionalProperties = false; }), spec()), []);
  assert.deepEqual(rules(data((d) => { d.additionalProperties = false; }), data((d) => { d.additionalProperties = true; })), []);
});

test('spec directory defaults to asyncapi and accepts a provider directory', () => {
  assert.equal(specDir(undefined), 'asyncapi');
  assert.equal(specDir(''), 'asyncapi');
  assert.equal(specDir('api/asyncapi/'), 'api/asyncapi');
  for (const bad of ['/abs', '../x', 'api/../x', './api', 'a//b']) assert.throws(() => specDir(bad), /ASYNCAPI_DIR/);
});
