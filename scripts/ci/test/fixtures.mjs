// Minimal in-memory catalog fixtures for the checker unit tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

export const ENVELOPE = {
  EventEnvelope: {
    type: 'object',
    required: ['eventId', 'eventType', 'data'],
    properties: {
      eventId: { type: 'string', format: 'uuid' },
      eventType: { type: 'string' },
      data: { type: 'object' },
    },
  },
};

export function spec({ serviceId = 'svc-tst-sample', namespace = 'evt.tst.sample', channels, data } = {}) {
  const dataSchema = data ?? {
    type: 'object',
    required: ['sampleId'],
    properties: {
      sampleId: { type: 'string' },
      status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
      note: { type: 'string' },
    },
  };
  const chans = channels ?? {
    created: {
      address: `${namespace}.created.v1`,
      messages: { SampleCreated: { $ref: '#/components/messages/SampleCreated' } },
      bindings: { kafka: { topic: `${namespace}.created.v1` } },
    },
  };
  return {
    asyncapi: '3.0.0',
    info: { title: serviceId, version: '1.0.0', 'x-service-id': serviceId, 'x-event-namespace': namespace },
    channels: chans,
    components: {
      schemas: {
        EventEnvelope: { $ref: './common/event-envelope.yaml#/EventEnvelope' },
        SampleCreatedData: dataSchema,
      },
      messages: {
        SampleCreated: {
          payload: {
            allOf: [
              { $ref: '#/components/schemas/EventEnvelope' },
              { type: 'object', properties: { data: { $ref: '#/components/schemas/SampleCreatedData' } } },
            ],
          },
        },
        DeadLetter: { payload: { $ref: '#/components/schemas/EventEnvelope' } },
      },
    },
  };
}

/** A dead-letter channel in the spec's own namespace (only valid when the spec consumes something). */
export const deadLetterChannel = (namespace = 'evt.tst.sample') => ({
  address: `${namespace}.dlq.v1`,
  messages: { DeadLetter: { $ref: '#/components/messages/DeadLetter' } },
});

export function entry(overrides = {}) {
  return {
    file: 'asyncapi/svc-tst-sample.yaml',
    serviceId: 'svc-tst-sample',
    ownerRepo: 'COPUR/fintechbankx-test-sample',
    namespace: 'evt.tst.sample',
    channels: ['evt.tst.sample.created.v1'],
    providerSpecPath: null,
    implementationStatus: 'contract-only',
    ...overrides,
  };
}

/** Writes a temporary catalog: specs = { 'svc-x.yaml': object }, services = index entries. */
export function writeCatalog({ specs = { 'svc-tst-sample.yaml': spec() }, services = [entry()] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asyncapi-catalog-test-'));
  fs.mkdirSync(path.join(root, 'asyncapi', 'common'), { recursive: true });
  fs.mkdirSync(path.join(root, 'catalog'));
  fs.writeFileSync(path.join(root, 'asyncapi', 'common', 'event-envelope.yaml'), stringify(ENVELOPE));
  for (const [name, doc] of Object.entries(specs)) {
    fs.writeFileSync(path.join(root, 'asyncapi', name), stringify(doc));
  }
  fs.writeFileSync(path.join(root, 'catalog', 'index.json'), JSON.stringify({ schemaVersion: 1, services }, null, 2));
  return root;
}

/** In-memory reader for compareSpecs: files = { 'asyncapi/x.yaml': object }. */
export function reader(files) {
  return (f) => (f in files ? stringify(files[f]) : null);
}
