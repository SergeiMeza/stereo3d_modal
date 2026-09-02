# Graph Report - gateway  (2026-09-02)

## Corpus Check
- 40 files · ~49,252 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 579 nodes · 1612 edges · 25 communities (22 shown, 3 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 223 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3c3cad57`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_WriteErr|WriteErr]]
- [[_COMMUNITY_pricing_test.go|pricing_test.go]]
- [[_COMMUNITY_Project|Project]]
- [[_COMMUNITY_Batch|Batch]]
- [[_COMMUNITY_Service|Service]]
- [[_COMMUNITY_projects_test.go|projects_test.go]]
- [[_COMMUNITY_Client|Client]]
- [[_COMMUNITY_Conversion|Conversion]]
- [[_COMMUNITY_PhotoPack|PhotoPack]]
- [[_COMMUNITY_Rates|Rates]]
- [[_COMMUNITY_Gateway — production wrapper for the stereo3d Modal API|Gateway — production wrapper for the stereo3d Modal API]]
- [[_COMMUNITY_Client|Client]]
- [[_COMMUNITY_.HandleSettleBilling|.HandleSettleBilling]]
- [[_COMMUNITY_Client|Client]]
- [[_COMMUNITY_Verifier|Verifier]]
- [[_COMMUNITY_Slack|Slack]]
- [[_COMMUNITY_corsHandler|corsHandler]]
- [[_COMMUNITY_testClient|testClient]]
- [[_COMMUNITY_Video|Video]]
- [[_COMMUNITY_TestDownloadPaymentGate|TestDownloadPaymentGate]]
- [[_COMMUNITY_deploy.sh|deploy.sh]]
- [[_COMMUNITY_spatial-ai-labsstereo3d-gateway|spatial-ai-labs/stereo3d-gateway]]

## God Nodes (most connected - your core abstractions)
1. `Conversion` - 47 edges
2. `Project` - 41 edges
3. `WriteErr()` - 38 edges
4. `WriteOK()` - 36 edges
5. `AuthedUser` - 35 edges
6. `Log()` - 29 edges
7. `resolveOK()` - 24 edges
8. `Service` - 23 edges
9. `Batch` - 23 edges
10. `Err()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `Load()`  [INFERRED]
  cmd/gateway/main.go → internal/config/config.go
- `main()` --calls--> `NewSlack()`  [INFERRED]
  cmd/gateway/main.go → internal/notify/slack.go
- `main()` --calls--> `ErrNotFound()`  [INFERRED]
  cmd/gateway/main.go → internal/httpx/httpx.go
- `main()` --calls--> `ErrUnauthorized()`  [INFERRED]
  cmd/gateway/main.go → internal/httpx/httpx.go
- `main()` --calls--> `WithCORS()`  [INFERRED]
  cmd/gateway/main.go → internal/httpx/httpx.go

## Import Cycles
- None detected.

## Communities (25 total, 3 thin omitted)

### Community 0 - "WriteErr"
Cohesion: 0.10
Nodes (46): AuthedUser, createConversionReq, main(), APIError, ctxKey, jobDescription(), billableSeconds(), downloadPaymentGate() (+38 more)

### Community 1 - "pricing_test.go"
Cohesion: 0.11
Nodes (45): T, TestBatchCapTiers(), TestBatchWindow(), TestNextBatchTier(), TestQuoteVideoOneMinuteFloor(), T, TestQuoteStepMiganMultipliers(), TestQuoteVideoModeMultiplier() (+37 more)

### Community 2 - "Project"
Cohesion: 0.09
Nodes (34): sceneOverrideReq, analyzeResponse(), depthContentDims(), depthWorkMP(), halfSourceFPS(), maxTargetFPS(), probeDuration(), probeFPS() (+26 more)

### Community 3 - "Batch"
Cohesion: 0.11
Nodes (21): batchDescription(), batchItemsJSON(), batchMetadata(), Service, Context, Request, ResponseWriter, pendingEntry() (+13 more)

### Community 4 - "Service"
Cohesion: 0.09
Nodes (27): Config, encodeSceneOverrides(), formatMinSec(), Service, Client, Context, RawMessage, profileShots() (+19 more)

### Community 5 - "projects_test.go"
Cohesion: 0.17
Nodes (41): stepConvReq, T, proProject(), resolveErr(), resolveErrP(), resolveOK(), resolveOKP(), soReq() (+33 more)

### Community 6 - "Client"
Cohesion: 0.11
Nodes (18): Event, cardInfo(), ClassifyChargeError(), New(), stripeErrCode(), T, TestClassifyChargeErrorAPIOutageIsTransient(), TestClassifyChargeErrorAuthenticationRequired() (+10 more)

### Community 7 - "Conversion"
Cohesion: 0.14
Nodes (17): T, mobileConv(), TestCreateConversionReqValidate(), TestModalBodyMobileParams(), conversionsCol(), customersCol(), Client, Context (+9 more)

### Community 8 - "PhotoPack"
Cohesion: 0.16
Nodes (12): Service, Context, Request, ResponseWriter, Context, DocumentRef, DocumentSnapshot, Store (+4 more)

### Community 9 - "Rates"
Cohesion: 0.16
Nodes (15): depthFactor(), fpsFactor(), Client, Context, Duration, Time, New(), round4() (+7 more)

### Community 10 - "Gateway — production wrapper for the stereo3d Modal API"
Cohesion: 0.08
Nodes (24): Abuse containment, Billing models, Conversion state machine, Data model (Firestore), Design goals, Gateway — production wrapper for the stereo3d Modal API, HTTP surface, Layout (+16 more)

### Community 11 - "Client"
Cohesion: 0.22
Nodes (9): Context, RawMessage, New(), AnalyzeMetadata, Client, Job, ReuseLookup, SubmitResponse (+1 more)

### Community 12 - ".HandleSettleBilling"
Cohesion: 0.24
Nodes (7): Service, Context, Request, ResponseWriter, jobMetadataFromConversion(), T, TestJobMetadataFromConversion()

### Community 13 - "Client"
Cohesion: 0.21
Nodes (4): Client, Context, Duration, New()

### Community 14 - "Verifier"
Cohesion: 0.24
Nodes (7): errUnauthorizedType, User, Verifier, Client, Context, Request, New()

### Community 15 - "Slack"
Cohesion: 0.38
Nodes (5): Client, Context, NewSlack(), truncate(), Slack

### Community 16 - "corsHandler"
Cohesion: 0.47
Nodes (8): contains(), corsHandler(), Handler, T, TestCORSDisallowedOriginGetsNoHeadersAndReachesMux(), TestCORSNoOriginHeaderIsUntouched(), TestCORSPreflightAllowedOrigin(), TestCORSWildcardReflectsOrigin()

### Community 17 - "testClient"
Cohesion: 0.50
Nodes (7): Client, T, testClient(), TestInPrefix(), TestKeyFromPublicURL(), TestKeyFromPublicURLWrongBucket(), TestUploadKey()

### Community 18 - "Video"
Cohesion: 0.60
Nodes (5): Context, Image(), parseRate(), Video(), Result

## Knowledge Gaps
- **24 isolated node(s):** `deploy.sh script`, `spatial-ai-labs/stereo3d-gateway`, `Service`, `ctxKey`, `Design goals` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Conversion` connect `Conversion` to `WriteErr`, `Project`, `Batch`, `Service`, `PhotoPack`, `.HandleSettleBilling`?**
  _High betweenness centrality (0.226) - this node is a cross-community bridge._
- **Why does `StepInputs` connect `Rates` to `WriteErr`, `pricing_test.go`?**
  _High betweenness centrality (0.198) - this node is a cross-community bridge._
- **Why does `Project` connect `Project` to `WriteErr`, `Service`, `projects_test.go`?**
  _High betweenness centrality (0.147) - this node is a cross-community bridge._
- **Are the 32 inferred relationships involving `WriteErr()` (e.g. with `.finalizeAutoBilled()` and `.HandleArchiveProject()`) actually correct?**
  _`WriteErr()` has 32 INFERRED edges - model-reasoned connections that need verification._
- **Are the 33 inferred relationships involving `WriteOK()` (e.g. with `.finalizeAutoBilled()` and `.HandleArchiveProject()`) actually correct?**
  _`WriteOK()` has 33 INFERRED edges - model-reasoned connections that need verification._
- **What connects `deploy.sh script`, `spatial-ai-labs/stereo3d-gateway`, `Service` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `WriteErr` be split into smaller, more focused modules?**
  _Cohesion score 0.09904240766073871 - nodes in this community are weakly interconnected._