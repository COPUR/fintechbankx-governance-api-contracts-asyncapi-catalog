import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCatalog } from '../check-asyncapi-catalog.mjs';
import { spec, deadLetterChannel, entry, writeCatalog } from './fixtures.mjs';

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
  expectError({ services: [entry({ channels: ['evt.tst.sample.other.v1'] })] }, /index channels differ from spec/);
});

test('fails on duplicate namespaces in the index', () => {
  const dup = entry({ file: null, serviceId: 'svc-tst-other', channels: [], implementationStatus: 'no-contract' });
  expectError({ services: [entry(), dup] }, /duplicate namespace evt\.tst\.sample/);
});

test('fails on an unknown implementation status', () => {
  expectError({ services: [entry({ implementationStatus: 'live' })] }, /implementationStatus must be one of/);
});

// Consumed (receive-only) channels may live in another namespace.
function consumerSpec(addr) {
  const doc = spec();
  doc.channels.paymentDone = {
    address: addr,
    messages: { SampleCreated: { $ref: '#/components/messages/SampleCreated' } },
    bindings: { kafka: { topic: addr } },
  };
  doc.operations = {
    publishCreated: { action: 'send', channel: { $ref: '#/channels/created' } },
    receivePaymentDone: { action: 'receive', channel: { $ref: '#/channels/paymentDone' } },
  };
  return doc;
}
const provider = () => entry({ serviceId: 'svc-tst-provider', file: 'asyncapi/svc-tst-provider.yaml', namespace: 'evt.tst.provider', channels: ['evt.tst.provider.created.v1'] });

test('a receive-only channel in another namespace passes when listed in consumes', () => {
  const specs = {
    'svc-tst-sample.yaml': consumerSpec('evt.tst.provider.created.v1'),
    'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }),
  };
  assert.deepEqual(errorsOf({ specs, services: [entry({ consumes: ['evt.tst.provider.created.v1'] }), provider()] }), []);
});

test('fails when a consumed channel is missing from consumes', () => {
  const specs = { 'svc-tst-sample.yaml': consumerSpec('evt.tst.provider.created.v1') };
  expectError({ specs }, /index consumes \[\] differs/);
});

test('fails when the provider spec does not publish the consumed topic', () => {
  const specs = {
    'svc-tst-sample.yaml': consumerSpec('evt.tst.provider.paid.v1'),
    'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }),
  };
  expectError({ specs, services: [entry({ consumes: ['evt.tst.provider.paid.v1'] }), provider()] }, /does not publish/);
});

test('a send channel outside the namespace still fails even with operations declared', () => {
  const doc = consumerSpec('evt.tst.provider.created.v1');
  doc.operations.receivePaymentDone.action = 'send';
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.sample.created.v1', 'evt.tst.sample.dlq.v1', 'evt.tst.provider.created.v1'] })] }, /outside the service namespace/);
});

test('fails when a spec consumes another namespace\'s dead-letter topic (DLQs are consumer-owned)', () => {
  const specs = {
    'svc-tst-sample.yaml': consumerSpec('evt.tst.provider.dlq.v1'),
    'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }),
  };
  expectError({ specs, services: [entry({ consumes: ['evt.tst.provider.dlq.v1'] }), provider()] }, /dead-letter topic of another namespace/);
});

test('fails when a spec declares its dead-letter topic but consumes nothing (DLQs are consumer-owned)', () => {
  const doc = spec();
  doc.channels.deadLetter = deadLetterChannel();
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.sample.created.v1', 'evt.tst.sample.dlq.v1'] })] }, /dead-letter topic .* but consumes nothing/);
});

test('a dead-letter topic is allowed when the spec consumes a topic', () => {
  const doc = consumerSpec('evt.tst.provider.created.v1');
  doc.channels.deadLetter = deadLetterChannel();
  doc.operations.publishDeadLetter = { action: 'send', channel: { $ref: '#/channels/deadLetter' } };
  const specs = { 'svc-tst-sample.yaml': doc, 'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }) };
  assert.deepEqual(errorsOf({ specs, services: [entry({ channels: ['evt.tst.sample.created.v1', 'evt.tst.sample.dlq.v1'], consumes: ['evt.tst.provider.created.v1'] }), provider()] }), []);
});
