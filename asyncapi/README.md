# AsyncAPI event contracts

Status: **Proposed**. Each provider repository owns its contract; this catalog mirrors it.

One AsyncAPI 3.0.0 document per publishing service, named `asyncapi/<service-id>.yaml`. Every message uses the
standard envelope in [`common/event-envelope.yaml`](common/event-envelope.yaml): `eventId`, `eventType`,
`occurredAt`, `aggregateId`, `aggregateVersion`, `correlationId`, `causationId`, `producer`, `data`. The Kafka
record key is `aggregateId`. Naming follows
[`NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md`](../docs/NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md).

| Contract | Service | Topic (one per aggregate) | Event types (`eventType` header) | Implementation today |
|---|---|---|---|---|
| [svc-ln-loan-lifecycle.yaml](svc-ln-loan-lifecycle.yaml) | Loan lifecycle | `evt.ln.loan.v1` | `Lending.Loan.*.v1`: Created, Approved, Rejected, Disbursed, Cancelled, PaymentMade, FullyPaid | Domain events raised; no publisher adapter |
| [svc-pay-initiation-settlement.yaml](svc-pay-initiation-settlement.yaml) | Payment initiation and settlement | `evt.pay.payment.v1` | nine payment and loan-payment event types (see the spec) | Domain events raised; no publisher adapter |
| [svc-pay-request-to-pay.yaml](svc-pay-request-to-pay.yaml) | Request to pay | `evt.pay.rtp.v1` | `Payments.PayRequest.*.v1`: Created, Accepted, Rejected | Published to legacy `rtp.pay_requests.v1` without envelope |
| [svc-cus-profile-kyc.yaml](svc-cus-profile-kyc.yaml) | Customer profile and KYC | `evt.cus.customer.v1` | seven customer event types (see the spec) | Transactional outbox and relay on unmerged provider branch `claude/customer-risk-compliance-deployable-ygi0zo` |
| [svc-rsk-decisioning.yaml](svc-rsk-decisioning.yaml) | Risk decisioning | `evt.rsk.risk.v1` | `Risk.RiskAssessment.Assessed.v1` | Transactional outbox and relay on unmerged provider branch `claude/customer-risk-compliance-deployable-ygi0zo` |
| [svc-cmp-evidence.yaml](svc-cmp-evidence.yaml) | Compliance evidence | `evt.cmp.compliance.v1` | `Compliance.ComplianceScreening.Screened.v1` | Transactional outbox and relay on unmerged provider branch `claude/customer-risk-compliance-deployable-ygi0zo` |

One topic per aggregate (ADR-019, owner decision 2026-10-08): every event of a namespace's aggregate goes to
`<namespace>.v<N>`, keyed by the aggregate id, so one aggregate instance's events stay in order in one partition.
In a spec that is one channel holding every event type of the aggregate as a message. Each message fixes its
`eventType` with a `const` in the payload and declares the same `const` for the `eventType` record header
(`EventHeaders`); the catalog check enforces both and rejects per-event topics. Consumers skip event types they
do not handle. A namespace whose service consumes a topic also has a dead-letter topic `<namespace>.dlq.v1`.

Dead-letter topics are consumer-owned (ADR-019 in the ADR repo): a consumer that gives up on a record after bounded
retries writes it to the DLQ in **its own** namespace, never to the source topic's namespace. For example, the loan
service dead-letters a failed `evt.pay.payment.v1` record to `evt.ln.loan.dlq.v1`, not to
`evt.pay.payment.dlq.v1`. The `DeadLetterHeaders` in [common/event-envelope.yaml](common/event-envelope.yaml)
(`dlq-original-topic`, `dlq-original-partition`, `dlq-original-offset`, `dlq-consumer-group`) identify the source,
so the owning team can replay it. Every dead-letter header value is UTF-8 text, numbers as decimal text, because
Kafka header values are bytes. A dead-letter message keeps the poison record's value and key unchanged, so its
payload need not be the envelope (it may be raw bytes); its headers must be the common `DeadLetterHeaders`.
A spec lists its DLQ as a `send` channel in its own namespace; the catalog check
rejects a send channel outside it. Topics are provisioned by `scripts/kafka/create-topics.sh` in
`fintechbankx-platform-event-streaming-kafka`.

No other fintechbankx service publishes events in code today (consent, account data, payee, metadata, open data,
bulk and recurring payments). Consent, recurring mandates and bulk payments are
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
| `providerSpecPath` | Path of the AsyncAPI file in the provider repository (for example `api/asyncapi/<service-id>.yaml`), set as soon as the provider carries the file, on its default branch or on the branch named in `pendingImplementation`; `null` only while the provider has none |
| `implementationStatus` | `contract-only`, `publishes-legacy`, `outbox` or `no-contract` (see `statusValues` in the file) |
| `pendingImplementation` | Unmerged provider branch that changes the status, if any |

Status today (Proposed):

| Service | Namespace | Status | Note |
|---|---|---|---|
| `svc-ln-loan-lifecycle` | `evt.ln.loan` | `contract-only` | outbox and relay on unmerged provider branch `claude/project-thread-ty79y4` |
| `svc-pay-initiation-settlement` | `evt.pay.payment` | `contract-only` | outbox and relay on unmerged provider branch `claude/project-thread-ty79y4` |
| `svc-cus-profile-kyc` | `evt.cus.customer` | `contract-only` | outbox and relay on unmerged provider branch `claude/customer-risk-compliance-deployable-ygi0zo` (provider PR #13) |
| `svc-pay-request-to-pay` | `evt.pay.rtp` | `publishes-legacy` | legacy topic `rtp.pay_requests.v1`, no envelope |
| `svc-rsk-decisioning` | `evt.rsk.risk` | `contract-only` | outbox and relay on unmerged provider branch `claude/customer-risk-compliance-deployable-ygi0zo` (provider PR #13) |
| `svc-cmp-evidence` | `evt.cmp.compliance` | `contract-only` | outbox and relay on unmerged provider branch `claude/customer-risk-compliance-deployable-ygi0zo` (provider PR #13) |
| `svc-of-consent-authorization` | `evt.of.consent` | `no-contract` | expected |
| `svc-pay-recurring-mandates` | `evt.pay.mandate` | `no-contract` | expected |
| `svc-pay-bulk-orchestration` | `evt.pay.bulk` | `no-contract` | expected |

Customer, risk and compliance carry `api/asyncapi/<service-id>.yaml` on the provider branch named in `pendingImplementation`, so their `providerSpecPath` is set; the other entries stay `null` until their provider carries its own spec.

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
| Breaking changes | `scripts/ci/asyncapi-breaking.sh` (rules in `asyncapi-breaking.mjs`) | compared with the merge base of `BASE_REF` (default `origin/main`): a spec, channel or message is removed; a payload property (envelope or `data`) is removed; a property becomes required, stops being required, or a new required property appears; a property's type changes; an enum value is removed, or an enum is added to a property that had none (at every level, array items included); a `const` changes (`eventType`, `producer`); a validation keyword (`pattern`, `format`, length, range or item limits) is added, removed or changed, or `additionalProperties` is closed or changed (opening it is compatible); the channel's Kafka `topic`, `partitions` or `cleanup.policy` changes or `retention.ms` drops; the message's Kafka key schema changes. Removing a `*.dlq.vN` channel is not breaking (ADR-019). New spec files are skipped |
| Unit tests | `scripts/ci/test/*.test.mjs` (`node:test`) | a rule above stops failing on its fixture |

`npx @asyncapi/cli@2.13.0 diff` is not used because it does not support AsyncAPI 3.0 documents. The breaking check
needs full history; the `ci/test` checkout uses `fetch-depth: 0`.

Provider repositories run the same script unchanged on their own directory: set `ASYNCAPI_DIR` to the spec
directory relative to the repository root (for example `ASYNCAPI_DIR=api/asyncapi`), with `BASE_REF=origin/main`
(ADR-019 section 5). The accepted-breaking file then sits next to the spec in that directory.

Accepted breaking changes go in `asyncapi/<service-id>.accepted-breaking.txt`, one finding key per line exactly as
the check prints it (for example `removed-property evt.pay.rtp.v1 PayRequestAccepted $.data.creditorName`),
with a `#` comment that links the major-version and dual-publish plan. Event payload schemas and their own
compatibility checks live in `fintechbankx-governance-api-contracts-schema-registry`, generated from these specs.

### Validate one spec

```bash
npx -y @asyncapi/cli@2.13.0 validate asyncapi/<service-id>.yaml
```

`asyncapi/common/` holds shared schemas only and is resolved through `$ref`, not validated on its own.

## Consumers

A spec may declare channels it only consumes (every operation on the channel has `action: receive`), for example
`svc-ln-loan-lifecycle` consuming `evt.pay.payment.v1` (handling only the loan-payment event types) with group
`cg.svc-ln-loan-lifecycle.loan-repayment-allocation.v1`. Such channels may sit in another namespace, are listed in the
index entry's `consumes` array (not in `channels`), and the check fails if the owning namespace's spec is in the catalog
but does not publish that topic.

## Change rules

- Adding an optional field or a new event type is a minor change: bump `info.version` minor.
- Removing or renaming a field, changing a type or changing meaning of one event is a new event major on the same
  topic (a new message with `eventType` `...v2`); the producer publishes both majors until every consumer has moved.
- The topic major (`<namespace>.v2`) changes only when the record key, partition count or cleanup policy changes;
  the producer then dual-publishes to both topics.
- Versions count from the first time a spec lands on this catalog's `main`. Before that the spec is pre-release:
  it stays `1.0.0`, carries no version-history paragraph, and a change that would be breaking later is folded
  into `1.0.0` (no `accepted-breaking.txt` entry, no new event major). A pre-release spec has no consumers by
  definition, because consumers build against the catalog's `main`.
- Change the contract in the provider repository first, then mirror it here in a separate PR, updating
  `catalog/index.json` in the same PR.

## Servers and authentication

Every spec declares two servers, matching ADR-024 (`docs/architecture/decisions/ADR-024-kafka-runtime-msk-iam-and-producer-defaults.md` in `fintechbankx-governance-architecture-enablement-adr-runbooks`, adr-runbooks PR #10 until it merges) and the platform contract of 2026-10-08:

- `msk`: Amazon MSK on AWS. TLS in transit, SASL_SSL with mechanism `AWS_MSK_IAM` using the service's IRSA role; topic-scoped IAM
  policies come from the terraform module `msk-client-access`. AsyncAPI has no IAM scheme type, so the `mskIam` scheme uses
  `userPassword` (the SASL family) with `x-sasl-mechanism: AWS_MSK_IAM`.
- `local`: Strimzi in namespace `kafka` for local and non-AWS clusters, mutual TLS.

Client conventions (consumer groups `cg.<svc>.<purpose>.v<major>`, the outbox relay metrics such as `outbox.oldest.pending.age.seconds`, `traceparent` header) are in
`docs/guides/SERVICE_CLIENT_CONFIGURATION.md` of `fintechbankx-platform-event-streaming-kafka`.
