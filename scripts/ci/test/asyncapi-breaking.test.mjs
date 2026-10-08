import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSpecs, readAccepted } from '../asyncapi-breaking.mjs';
import { spec, ENVELOPE, reader } from './fixtures.mjs';

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
