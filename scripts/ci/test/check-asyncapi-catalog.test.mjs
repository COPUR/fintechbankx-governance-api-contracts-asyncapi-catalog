import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCatalog } from '../check-asyncapi-catalog.mjs';
import { spec, entry, writeCatalog } from './fixtures.mjs';

const errorsOf = (opts) => checkCatalog(writeCatalog(opts)).errors;
const expectError = (opts, re) => {
  const errors = errorsOf(opts);
  assert.ok(errors.some((e) => re.test(e)), `expected an error matching ${re}, got:\n${errors.join('\n')}`);
};

test('a consistent catalog passes', () => {
  assert.deepEqual(errorsOf(), []);
});

test('an expected entry without a file passes', () => {
  const expected = entry({ file: null, serviceId: 'svc-tst-other', namespace: 'evt.tst.other', channels: [], implementationStatus: 'no-contract' });
  assert.deepEqual(errorsOf({ services: [entry(), expected] }), []);
});

test('fails when a spec has no index entry', () => {
  expectError({ services: [] }, /spec has no entry in catalog\/index\.json/);
});

test('fails when an index entry points to a missing spec', () => {
  expectError({ specs: {} }, /entry file asyncapi\/svc-tst-sample\.yaml does not exist/);
});

test('fails when a channel address breaks the topic pattern', () => {
  const doc = spec();
  doc.channels.created.address = 'evt.tst.sample.SampleCreated';
  doc.channels.created.bindings.kafka.topic = 'evt.tst.sample.SampleCreated';
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.sample.SampleCreated', 'evt.tst.sample.dlq.v1'] })] }, /does not match/);
});

test('fails on a legacy dotted topic', () => {
  const doc = spec();
  doc.channels.created.address = 'rtp.pay_requests.v1';
  delete doc.channels.created.bindings;
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['rtp.pay_requests.v1', 'evt.tst.sample.dlq.v1'] })] }, /does not match/);
});

test('fails when a channel is outside the index namespace', () => {
  const doc = spec();
  doc.channels.created.address = 'evt.tst.foreign.created.v1';
  doc.channels.created.bindings.kafka.topic = 'evt.tst.foreign.created.v1';
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.foreign.created.v1', 'evt.tst.sample.dlq.v1'] })] }, /outside the service namespace evt\.tst\.sample/);
});

test('fails when the spec namespace differs from the index', () => {
  expectError({ services: [entry({ namespace: 'evt.tst.other' })] }, /x-event-namespace .* differs from index namespace/);
});

test('fails when a message does not use the common envelope', () => {
  const doc = spec();
  doc.components.messages.SampleCreated.payload = { $ref: '#/components/schemas/SampleCreatedData' };
  expectError({ specs: { 'svc-tst-sample.yaml': doc } }, /does not use the common envelope/);
});

test('fails when two specs declare the same topic', () => {
  const other = spec({ serviceId: 'svc-tst-other', namespace: 'evt.tst.other' });
  other.channels.dup = { address: 'evt.tst.sample.created.v1', messages: { SampleCreated: { $ref: '#/components/messages/SampleCreated' } } };
  expectError({
    specs: { 'svc-tst-sample.yaml': spec(), 'svc-tst-other.yaml': other },
    services: [entry(), entry({ file: 'asyncapi/svc-tst-other.yaml', serviceId: 'svc-tst-other', namespace: 'evt.tst.other', channels: ['evt.tst.other.created.v1', 'evt.tst.other.dlq.v1', 'evt.tst.sample.created.v1'] })],
  }, /topic evt\.tst\.sample\.created\.v1 is also declared by asyncapi\/svc-tst-(other|sample)\.yaml/);
});

test('fails when index channels differ from the spec', () => {
  expectError({ services: [entry({ channels: ['evt.tst.sample.created.v1'] })] }, /index channels differ from spec/);
});

test('fails on duplicate namespaces in the index', () => {
  const dup = entry({ file: null, serviceId: 'svc-tst-other', channels: [], implementationStatus: 'no-contract' });
  expectError({ services: [entry(), dup] }, /duplicate namespace evt\.tst\.sample/);
});

test('fails on an unknown implementation status', () => {
  expectError({ services: [entry({ implementationStatus: 'live' })] }, /implementationStatus must be one of/);
});
