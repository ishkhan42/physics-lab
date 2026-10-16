---
doc: checklist
status: approved
---

# Build Checklist

Build mode: fast. The learner approved the presented build order and fast mode. Verification, commits, early hands-on feedback and final review remain required.

Scope, PRD, the MuJoCo technical direction and this build order are approved. Each slice leaves usable behavior rather than a hidden layer. No public deployment or submission is included.

Live model checks require an authorized application API key supplied privately. Missing credentials are an external prerequisite, never permission to substitute a fake model. Do not copy coding-agent credentials or publish personal learner context.

## Slices

- [x] **1. Describe a mechanics situation and inspect a real paused experiment**
  Becomes usable: A local Mission Board accepts a description through a configured provider, asks a consequential clarification if needed, compiles the resulting mechanics data with actual MuJoCo, and shows a paused 3D scene with initial object properties and assumptions.
  Why now: Proves the unique kernel early: description to composed physics model, not a generic interface waiting for its core feature. Project bootstrapping is included here.
  PRD ref: `prd.md > The Core Journey`, `prd.md > Scenario Prompt and Assembly`, `prd.md > Mission Board`, `prd.md > Read-Only Object Cards`.
  Spec ref: `spec.md > Model Contract and Catalog`, `spec.md > MuJoCo Model Builder`, `spec.md > Provider API and Local Security`, `spec.md > Three.js Canvas and Read-Only Cards`, `spec.md > File Structure`.
  Build: Install the pinned UI/rendering/MuJoCo/validation dependencies and native Node tooling; add runnable commands, the shared strict model contract/catalog, trusted MJCF compiler, actual WASM lifecycle, three provider adapters, secure local API, minimal styled Mission Board, paused canvas and contextual initial cards. Advertise only implemented physical blocks. Preserve prompt/scene on a real error, and provide honest missing-key guidance.
  Verify (mechanical): Run the production build and available behavioral checks. Start the documented local services and exercise one real configured-provider prompt in the browser through interpretation, any necessary clarification, native compilation and paused preview. Independently verify trusted compiler/frame/constraint behavior with synthetic numerical cases. Verify model output never supplies unrestricted XML/code and a missing key is not a fabricated success.
  Learner check: Open the Mission Board, describe a mechanics situation, and inspect the paused setup. Tell us whether the scene represents the intended experiment and whether its initial assumptions/properties are understandable. In fast mode, the planned early hands-on checkpoint follows slice two, so the whole journey can be tried together.
  Commit: `Add prompt-to-paused MuJoCo experiments`

- [x] **2. Run, change speed, pause and inspect the actual physical state**
  Becomes usable: A prepared experiment runs only after Run, supports 0.1x–10x playback, and can be paused to inspect every participating object's context-relevant state, including validated cable/constraint observations.
  Why now: Closes the functional learning loop before final presentation polish and exposes numerical/timing problems while the implementation is still easy to change.
  PRD ref: `prd.md > Simulation and Playback`, `prd.md > Read-Only Object Cards`, `prd.md > Observable Acceptance Criteria Already Established`.
  Spec ref: `spec.md > MuJoCo Runtime and Observations`, `spec.md > Playback Clock`, `spec.md > Three.js Canvas and Read-Only Cards`, `spec.md > Verification and Prior Evidence`.
  Build: Complete fixed-step advancement, correctly ordered state-dependent loads and exactly-once impulses, native constraint/readout mappings, consistent render/card snapshots, pause/resume, speed controls and resource/numerical-failure handling. Keep raw engine views private and refresh derived data at the actual displayed time. Use defined profiles rather than silently changing requested physical laws or coefficients.
  Verify (mechanical): Run behavioral regressions and the production build. Exercise a real generated experiment in the browser at both speed endpoints, Run, pause, resume and inspection. Check analytical free flight and the routed-tendon Atwood reference, timestep convergence, equal-time states across speeds, signed force mapping, no cumulative load/duplicate impulse, and no mutation of a paused published snapshot. Verify requested unavailable models/observables are explained rather than invented.
  Learner check: Try a scenario out of curiosity or to check a solution. Run it, change speed, pause at a chosen moment and read the object cards. What did you notice, and what would you change?
  Commit: `Add physical playback and contextual inspection`

- [x] **3. Finish a coherent Mission Board and production-local core journey**
  Becomes usable: The complete app opens through its themed intro into the physics-lab/glass/kinetic workspace, works at narrow widths and with reduced motion, preserves a previous experiment on failed replacement, and runs from the built local server.
  Why now: Earlier feedback can shape the final look and interaction without rebuilding the physics kernel. This step completes the promised product rather than adding another feature family.
  PRD ref: `prd.md > Opening Intro`, `prd.md > Mission Board`, `prd.md > Look and Feel`, `prd.md > Approved Conventional Defaults`, `prd.md > Scenario Prompt and Assembly`.
  Spec ref: `spec.md > Look and Feel`, `spec.md > Mission Board and Assembly State`, `spec.md > Provider API and Local Security`, `spec.md > Where It Runs and How Someone Tries It`, `spec.md > Data Ownership and Future Physics`.
  Build: Complete the themed/skippable intro, accessible responsive presentation, truthful assembly states, robust replacement/disposal, provider/free-model controls, safe static production serving, documented private credential setup, actual run instructions and changelog. Preserve all agreed sections and read-only inspection. No placeholder future physics engines, database, account system, public proxy or fake sample results.
  Verify (mechanical): Run the current production build and full behavioral suite, then launch npm start and exercise the real browser core journey from intro to paused inspection using an authorized configured provider. Check reduced motion, keyboard/focus/contrast, narrow layout, actual WASM asset loading, free selection without paid fallback, unsupported/invalid inputs, failed replacement preserving data, and repeated scene disposal. Use isolated local error cases rather than deliberately exhausting paid API quotas. Inspect intended staged changes for secrets and unrelated work before committing.
  Learner check: Explore the completed running app freely, including awkward prompts, simulation controls and inspection. Identify anything broken, confusing or worth changing; agree refinements before they are implemented. Confirm readiness only after the agreed changes have been tried and verified.
  Commit: `Complete the Mission Board experience`

## Hands-on Checkpoints

- [x] Early trial attempted and feedback received — the learner encountered a model-decision error before completing the journey and requested a high-grade usability revision. This is not a claim that the full journey worked for them.
- [ ] Final kick-the-tires exploration and feedback completed — after slice three and any agreed revisions.

## Final Review

- [ ] Final review complete — feedback resolved and learner confirms ready to ship.

Agreed revisions are implemented and mechanically verified below; leave them unchecked until the learner retries the affected behavior.
- [ ] Retry the original two-ball request with real e=1/e=0 rebound/settling and physical ground; confirm the mechanics rather than accepting a no-elasticity substitute.
- [ ] Try the revised composer/canvas layout, model settings, example prompts, playback/reset/view controls and inspection; confirm or refine the usability.
- [ ] Retry the brighter interface, prominent progress/elapsed time, concise responses/proposal review and explicit assumed defaults; confirm or refine the experience.
- [ ] Try friction/material requests and inspect coefficients, momentum, energy components and contact/spring reactions; confirm or refine the modeled behavior.

## Code Tour and App Map

- [ ] Learning activity complete — connect a real model-to-observable or numerical-validation decision to a reusable practice.
- [ ] Optional edit and transfer reflection addressed — offered, declined, already covered or not applicable, without inventing a new learning goal.
- [ ] `devpost/app-map.html` generated from finished code, checked and shown, including a project-grounded practice to reuse.

Activity and evidence: No activity has taken place; use actual implementation and verification evidence after final revisions.
Route and stops: No code route has been selected before the application exists; record actual paths/symbols when complete.
Edit outcome: No optional edit offered or performed yet.
Reflection: Not yet offered; any personal answer belongs in the private learner profile.
Activity mode: Not started; a focused verification decision is recommended rather than a redundant beginner tour.

## Revisions

- Functional code for the first two slices is implemented. Production build and 43 behavioral checks pass; Chromium checks exercised real MuJoCo, both playback endpoints, read-only observations, native-invalid/unsupported replacement preservation, changing wrap geometry, responsive layout and built WASM serving.
- Initial browser checks used synthetic assembly responses only at the network boundary; no fake provider or interception is shipped. After the user supplied a private application key, an authenticated `openrouter/free` request passed scene generation, native paused preview, Run/Pause, both speed endpoints and frozen inspection without interception. The live-provider mechanical gate is cleared; learner hands-on reviews remain pending.
- Native integration required explicit erasable TypeScript fields, equality-versus-limit row lookup, `mj_isSparse` layout detection, body/world velocity conversion and active native wrap-range handling. Corrected those internal assumptions without changing the product or replacing missing physics with invented values.
- The same shared compiler/runtime supplies both functional slices. Early trial feedback then reported invalid model output and requested high-grade UI/UX; that feedback activated the final workbench revision rather than another planning gate.
- Revised presentation places the composer beside the canvas and inspection directly below it, with secondary model settings, editable prompt starters, focused clarification and preserved-preview context. A brief nonblocking entrance respects reduced motion. Native Reset, Fit view and speed shortcuts support repeated exploration without model calls.
- The earlier workbench passed production building and 45 behavioral checks. Its elastic/inelastic prompt returned a genuine valid unsupported decision through the authorized free route; exact historical schema failure is unknown because its payload was not retained. Genuine two-sphere free fall passed playback at both endpoints, numerical comparison, reset and view recovery. Synthetic response-boundary probes verified UI recovery only; no fake provider or engine is shipped.
- Actual desktop and 320px mobile surfaces were checked, including expanded settings/capabilities, reduced motion, zero horizontal overflow and local cancellation. Stop waiting does not promise to cancel upstream processing or billing. Learner retry and final readiness remain open.
- Further hands-on feedback rejected dead waiting, internal response prose and the dark theme, and required clarification or explicit sensible defaults for missing physical details. The resulting light workbench adds real-phase timed progress and consent-gated supported proposals; explanations/questions can coexist without becoming a scene.
- The previous workbench passed building and49checks; its supported-proposal journey omitted bounce. That behavior is superseded by the actual mechanics implementation below, not treated as completion of elasticity.
- Reopened the material layer after feedback: retained MuJoCo and all existing composed blocks, implemented e=0/partial/1 targets and independent static/kinetic friction, added default physical ground and explicit groundless mode. Added momentum, translational energy, uniform-gravity potential, contact forces and joint spring/damping readouts.
- Production build and 62 behavioral checks pass, including measured restitution, unequal-mass elastic conservation, friction/stiction, combined elastic+friction response, contact cadence invariance and all prior pulley/wrap/joint/load cases. Actual original prompt produced two spheres with e=1/e=0 on real ground; browser motion showed rebound versus settling and correct ground reaction. A real explicit free-model friction comparison showed a static box held by a 4 N contact reaction and a moving box following kinetic friction; playback/reset remained local.
- The generic free router rejected one friction-generation reply; choosing a current explicit free model succeeded. No automatic retry or paid fallback was added. Coefficients remain finite-step numerical targets, not universal solver guarantees; final learner approval remains open.
- The learner's later identical-prompt failure showed that isolated successful free-router samples did not establish reliability. Replaced syntax-only JSON with provider-native constrained, discriminated decision branches; fixed tuple arity and canonical generated joint poses rather than adding prompt-specific repairs.
- Bound inference to two same-model calls total for local validation correction OR temporary 5xx recovery, visibly streamed with charge disclosure. A canceled/disconnected wait prevents further automatic calls; already-sent provider work may continue. The named free default uses advertised optional-reasoning controls, not hidden paid fallback.
- Final production build and74behavioral checks pass. Actual browser generation exercised elastic/inelastic motion, sliding friction, a correctly positioned slider/spring and an explicit rigid-body deformation proxy. Browser boundary checks covered preserved native state, retry/diagnostic hierarchy, ground consent/custom-plane deduplication and320px reduced-motion progress without overflow. Numerical/material and natural-language limits remain explicit; learner retry/readiness is still open.
