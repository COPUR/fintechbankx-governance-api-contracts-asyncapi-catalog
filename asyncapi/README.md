# AsyncAPI event contracts

Status: **Proposed**. Each provider repository owns its contract; this catalog mirrors it.

One AsyncAPI 3.0.0 document per publishing service, named `asyncapi/<service-id>.yaml`. Every message uses the
standard envelope in [`common/event-envelope.yaml`](common/event-envelope.yaml): `eventId`, `eventType`,
`occurredAt`, `aggregateId`, `aggregateVersion`, `correlationId`, `causationId`, `producer`, `data`. The Kafka
record key is `aggregateId`. Naming follows
[`NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md`](../docs/NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md).

| Contract | Service | Namespace | Topics | Implementation today |
|---|---|---|---|---|
| [svc-ln-loan-lifecycle.yaml](svc-ln-loan-lifecycle.yaml) | Loan lifecycle | `evt.ln.loan` | `created`, `approved`, `rejected`, `disbursed`, `cancelled`, `payment-made`, `fully-paid` | Domain events raised; no publisher adapter |
| [svc-pay-initiation-settlement.yaml](svc-pay-initiation-settlement.yaml) | Payment initiation and settlement | `evt.pay.payment` | `created`, `processing-started`, `completed`, `failed`, `cancelled`, `refunded`, `loan-payment-created`, `loan-payment-completed`, `loan-payment-failed` | Domain events raised; no publisher adapter |
| [svc-pay-request-to-pay.yaml](svc-pay-request-to-pay.yaml) | Request to pay | `evt.pay.rtp` | `created`, `accepted`, `rejected` | Published to legacy `rtp.pay_requests.v1` without envelope |
| [svc-cus-profile-kyc.yaml](svc-cus-profile-kyc.yaml) | Customer profile and KYC | `evt.cus.customer` | `created`, `contact-updated`, `credit-limit-updated`, `credit-reserved`, `credit-released`, `credit-score-updated` | Published after save via an external `DomainEventPublisher`; no outbox |

Full topic names are `<namespace>.<event>.v1`. Each namespace also has a dead-letter topic `<namespace>.dlq.v1`,
written by consumers after bounded retries. Topics are provisioned by `scripts/kafka/create-topics.sh` in
`fintechbankx-platform-event-streaming-kafka`.

No other fintechbankx service publishes events in code today (consent, account data, payee, metadata, open data,
risk, compliance, bulk and recurring payments). Risk, compliance, consent, recurring mandates and bulk payments are
expected publishers and are listed in the catalog index without a file. Add a contract here, and update the index
entry, when the provider adds one.

## Catalog index

[`catalog/index.json`](../catalog/index.json) lists every publishing service, one entry per `asyncapi/<service-id>.yaml`
plus "expected" entries (`file: null`) for services that will publish but have no contract yet. Fields:

| Field | Meaning |
|---|---|
| `file` | `asyncapi/<service-id>.yaml`, or `null` for an expected publisher |
| `serviceId`, `namespace` | Service id and event namespace from `repository-bootstrap-manifest.csv` |
| `ownerRepo`, `canonicalRepo` | Actual GitHub repository (`COPUR/...`) and canonical name used in governance docs |
| `channels` | Full topic addresses declared by the spec, dead-letter topic included |
| `providerSpecPath` | Path of the AsyncAPI file in the provider repository; `null` while the provider has none |
| `implementationStatus` | `contract-only`, `publishes-legacy`, `outbox` or `no-contract` (see `statusValues` in the file) |
| `pendingImplementation` | Unmerged provider branch that changes the status, if any |

Status today (Proposed):

| Service | Namespace | Status | Note |
|---|---|---|---|
| `svc-ln-loan-lifecycle` | `evt.ln.loan` | `contract-only` | outbox and relay on unmerged provider branch `claude/project-thread-ty79y4` |
| `svc-pay-initiation-settlement` | `evt.pay.payment` | `contract-only` | outbox and relay on unmerged provider branch `claude/project-thread-ty79y4` |
| `svc-cus-profile-kyc` | `evt.cus.customer` | `contract-only` | outbox and relay on unmerged provider branch `claude/project-thread-ty79y4` |
| `svc-pay-request-to-pay` | `evt.pay.rtp` | `publishes-legacy` | legacy topic `rtp.pay_requests.v1`, no envelope |
| `svc-rsk-decisioning` | `evt.rsk.risk` | `no-contract` | expected |
| `svc-cmp-evidence` | `evt.cmp.compliance` | `no-contract` | expected |
| `svc-of-consent-authorization` | `evt.of.consent` | `no-contract` | expected |
| `svc-pay-recurring-mandates` | `evt.pay.mandate` | `no-contract` | expected |
| `svc-pay-bulk-orchestration` | `evt.pay.bulk` | `no-contract` | expected |

No provider repository carries its own AsyncAPI file yet, so every `providerSpecPath` is `null`.

## Checks

All run in `ci/test` (`.github/workflows/required-gates.yml`). Run them locally with Node 22:

```bash
npm ci
npm test                                   # catalog consistency + unit tests
bash scripts/ci/asyncapi-breaking.sh       # breaking changes vs origin/main (BASE_REF overrides)
for spec in asyncapi/*.yaml; do npx -y @asyncapi/cli@2.13.0 validate "$spec"; done
```

| Check | Script | Fails when |
|---|---|---|
| AsyncAPI validation | `@asyncapi/cli@2.13.0 validate` | a top-level spec is not valid AsyncAPI |
| Catalog consistency | `scripts/ci/check-asyncapi-catalog.mjs` | a spec has no index entry or an entry has no spec; an entry is malformed or duplicates a service id, file or namespace; `info.x-service-id` / `info.x-event-namespace` differ from the index; a channel address does not match `^evt\.[a-z]+\.[a-z0-9-]+\.[a-z0-9-]+\.v[0-9]+$` (dead-letter `<namespace>.dlq.v<N>` matches it); a channel is outside the spec's namespace; `bindings.kafka.topic` differs from the address; the index channel list differs from the spec; a message payload does not `$ref` `common/event-envelope.yaml#/EventEnvelope` (directly or via `allOf`); two specs declare the same topic |
| Breaking changes | `scripts/ci/asyncapi-breaking.sh` (rules in `asyncapi-breaking.mjs`) | compared with the merge base of `BASE_REF` (default `origin/main`): a spec, channel or message is removed; a payload property (envelope or `data`) is removed; a property becomes required or a new required property appears; a property's type changes; an enum value is removed. New spec files are skipped |
| Unit tests | `scripts/ci/test/*.test.mjs` (`node:test`) | a rule above stops failing on its fixture |

`npx @asyncapi/cli@2.13.0 diff` is not used because it does not support AsyncAPI 3.0 documents. The breaking check
needs full history; the `ci/test` checkout uses `fetch-depth: 0`.

Accepted breaking changes go in `asyncapi/<service-id>.accepted-breaking.txt`, one finding key per line exactly as
the check prints it (for example `removed-property evt.pay.rtp.accepted.v1 PayRequestAccepted $.data.creditorName`),
with a `#` comment that links the major-version and dual-publish plan. Event payload schemas and their own
compatibility checks live in `fintechbankx-governance-api-contracts-schema-registry`, generated from these specs.

### Validate one spec

```bash
npx -y @asyncapi/cli@2.13.0 validate asyncapi/<service-id>.yaml
```

`asyncapi/common/` holds shared schemas only and is resolved through `$ref`, not validated on its own.

## Consumers

A spec may declare channels it only consumes (every operation on the channel has `action: receive`), for example
`svc-ln-loan-lifecycle` consuming `evt.pay.payment.loan-payment-completed.v1` with group
`cg.svc-ln-loan-lifecycle.loan-repayment-allocation.v1`. Such channels may sit in another namespace, are listed in the
index entry's `consumes` array (not in `channels`), and the check fails if the owning namespace's spec is in the catalog
but does not publish that topic.

## Change rules

- Adding an optional field is a minor change: bump `info.version` minor.
- Removing or renaming a field, changing a type or changing meaning is a new major version on a new topic
  (`...v2`); the producer dual-publishes until every consumer has moved.
- Change the contract in the provider repository first, then mirror it here in a separate PR, updating
  `catalog/index.json` in the same PR.

## Servers and authentication

Every spec declares two servers, matching ADR-024 and the platform contract of 2026-10-08:

- `msk`: Amazon MSK on AWS. TLS in transit, SASL_SSL with mechanism `AWS_MSK_IAM` using the service's IRSA role; topic-scoped IAM
  policies come from the terraform module `msk-client-access`. AsyncAPI has no IAM scheme type, so the `mskIam` scheme uses
  `userPassword` (the SASL family) with `x-sasl-mechanism: AWS_MSK_IAM`.
- `local`: Strimzi in namespace `kafka` for local and non-AWS clusters, mutual TLS.

Client conventions (consumer groups `cg.<svc>.<purpose>.v<major>`, the `outbox_pending_events` gauge, `traceparent` header) are in
`docs/guides/SERVICE_CLIENT_CONFIGURATION.md` of `fintechbankx-platform-event-streaming-kafka`.
