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
risk, compliance, bulk and recurring payments). Add a contract here when the provider adds one.

## Validate

The CI step (`ci/test`, "AsyncAPI contract lint") validates each top-level file:

```bash
for spec in asyncapi/*.yaml; do npx -y @asyncapi/cli@2.13.0 validate "$spec"; done
```

`asyncapi/common/` holds shared schemas only and is resolved through `$ref`, not validated on its own.

## Change rules

- Adding an optional field is a minor change: bump `info.version` minor.
- Removing or renaming a field, changing a type or changing meaning is a new major version on a new topic
  (`...v2`); the producer dual-publishes until every consumer has moved.
- Change the contract in the provider repository first, then mirror it here in a separate PR.
