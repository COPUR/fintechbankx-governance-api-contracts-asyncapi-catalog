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
  doc.channels.created.address = 'evt.tst.foreign.v1';
  doc.channels.created.bindings.kafka.topic = 'evt.tst.foreign.v1';
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.foreign.v1', 'evt.tst.sample.dlq.v1'] })] }, /outside the service namespace evt\.tst\.sample/);
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
  other.channels.dup = { address: 'evt.tst.sample.v1', messages: { SampleCreated: { $ref: '#/components/messages/SampleCreated' } } };
  expectError({
    specs: { 'svc-tst-sample.yaml': spec(), 'svc-tst-other.yaml': other },
    services: [entry(), entry({ file: 'asyncapi/svc-tst-other.yaml', serviceId: 'svc-tst-other', namespace: 'evt.tst.other', channels: ['evt.tst.other.v1', 'evt.tst.other.dlq.v1', 'evt.tst.sample.v1'] })],
  }, /topic evt\.tst\.sample\.v1 is also declared by asyncapi\/svc-tst-(other|sample)\.yaml/);
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
const provider = () => entry({ serviceId: 'svc-tst-provider', file: 'asyncapi/svc-tst-provider.yaml', namespace: 'evt.tst.provider', channels: ['evt.tst.provider.v1'] });

test('a receive-only channel in another namespace passes when listed in consumes', () => {
  const specs = {
    'svc-tst-sample.yaml': consumerSpec('evt.tst.provider.v1'),
    'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }),
  };
  assert.deepEqual(errorsOf({ specs, services: [entry({ consumes: ['evt.tst.provider.v1'] }), provider()] }), []);
});

test('fails when a consumed channel is missing from consumes', () => {
  const specs = { 'svc-tst-sample.yaml': consumerSpec('evt.tst.provider.v1') };
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
  const doc = consumerSpec('evt.tst.provider.v1');
  doc.operations.receivePaymentDone.action = 'send';
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.sample.v1', 'evt.tst.sample.dlq.v1', 'evt.tst.provider.v1'] })] }, /outside the service namespace/);
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
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.sample.v1', 'evt.tst.sample.dlq.v1'] })] }, /dead-letter topic .* but consumes nothing/);
});

test('a dead-letter topic is allowed when the spec consumes a topic', () => {
  const doc = consumerSpec('evt.tst.provider.v1');
  doc.channels.deadLetter = deadLetterChannel();
  doc.operations.publishDeadLetter = { action: 'send', channel: { $ref: '#/channels/deadLetter' } };
  const specs = { 'svc-tst-sample.yaml': doc, 'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }) };
  assert.deepEqual(errorsOf({ specs, services: [entry({ channels: ['evt.tst.sample.v1', 'evt.tst.sample.dlq.v1'], consumes: ['evt.tst.provider.v1'] }), provider()] }), []);
});

test('a dead-letter message may carry raw bytes but must declare the common dead-letter headers', () => {
  const build = (message) => {
    const doc = consumerSpec('evt.tst.provider.v1');
    doc.components.messages.DeadLetter = message;
    doc.channels.deadLetter = deadLetterChannel();
    doc.operations.publishDeadLetter = { action: 'send', channel: { $ref: '#/channels/deadLetter' } };
    const specs = { 'svc-tst-sample.yaml': doc, 'svc-tst-provider.yaml': spec({ serviceId: 'svc-tst-provider', namespace: 'evt.tst.provider' }) };
    return errorsOf({ specs, services: [entry({ channels: ['evt.tst.sample.v1', 'evt.tst.sample.dlq.v1'], consumes: ['evt.tst.provider.v1'] }), provider()] });
  };
  const headers = { $ref: './common/event-envelope.yaml#/DeadLetterHeaders' };
  assert.deepEqual(build({ contentType: 'application/octet-stream', headers, payload: { type: 'string', format: 'binary' } }), []);
  const missing = build({ contentType: 'application/octet-stream', payload: { type: 'string', format: 'binary' } });
  assert.ok(missing.some((e) => /dead-letter headers must use the common DeadLetterHeaders/.test(e)), missing.join('\n'));
});

// One topic per aggregate (ADR-019, owner decision 2026-10-08).
test('fails on a per-event topic', () => {
  const doc = spec();
  doc.channels.created.address = 'evt.tst.sample.created.v1';
  doc.channels.created.bindings.kafka.topic = 'evt.tst.sample.created.v1';
  expectError({ specs: { 'svc-tst-sample.yaml': doc }, services: [entry({ channels: ['evt.tst.sample.created.v1'] })] }, /one topic per aggregate/);
});

const withMessage = (key, eventType, headerType = eventType) => {
  const doc = spec();
  doc.components.messages[key] = structuredClone(doc.components.messages.SampleCreated);
  doc.components.messages[key].payload.allOf[1].properties.eventType = { const: eventType };
  doc.components.messages[key].headers.allOf[1].properties.eventType = { const: headerType };
  doc.channels.created.messages[key] = { $ref: `#/components/messages/${key}` };
  return doc;
};

test('an aggregate topic carries several event types', () => {
  assert.deepEqual(errorsOf({ specs: { 'svc-tst-sample.yaml': withMessage('SampleClosed', 'Test.Sample.Closed.v1') } }), []);
});

test('fails when two messages of one aggregate topic share an eventType', () => {
  expectError({ specs: { 'svc-tst-sample.yaml': withMessage('SampleCreatedAgain', 'Test.Sample.Created.v1') } }, /eventType "Test.Sample.Created.v1" is also carried by message SampleCreated/);
});

test('fails when the eventType header differs from the payload eventType', () => {
  expectError({ specs: { 'svc-tst-sample.yaml': withMessage('SampleClosed', 'Test.Sample.Closed.v1', 'Test.Sample.Opened.v1') } }, /headers must declare the eventType record header with the same const/);
});

test('fails when the payload does not fix its eventType', () => {
  const doc = spec();
  delete doc.components.messages.SampleCreated.payload.allOf[1].properties.eventType;
  expectError({ specs: { 'svc-tst-sample.yaml': doc } }, /payload must fix eventType with a const/);
});

test('a pending provider spec names its provider PR as COPUR/<repository>#<number>', () => {
  const pending = { branch: 'claude/x', pullRequest: 'COPUR/fintechbankx-test-sample#7', note: 'mirrors commit abc1234' };
  assert.deepEqual(errorsOf({ services: [entry({ providerSpecPath: 'api/asyncapi/svc-tst-sample.yaml', pendingImplementation: pending })] }), []);
});

test('fails when a pending provider spec has no pullRequest', () => {
  const pending = { branch: 'claude/x', note: 'mirrors commit abc1234' };
  expectError({ services: [entry({ providerSpecPath: 'api/asyncapi/svc-tst-sample.yaml', pendingImplementation: pending })] }, /pullRequest must be written COPUR\/<repository>#<number>/);
});

test('fails when pullRequest is a URL or names another repository', () => {
  for (const pullRequest of ['https://github.com/COPUR/fintechbankx-test-sample/pull/7', 'COPUR/fintechbankx-test-other#7', 'COPUR/fintechbankx-test-sample#0']) {
    const pending = { branch: 'claude/x', pullRequest };
    expectError({ services: [entry({ providerSpecPath: 'api/asyncapi/svc-tst-sample.yaml', pendingImplementation: pending })] }, /pullRequest must be written COPUR\/<repository>#<number>/);
  }
});
