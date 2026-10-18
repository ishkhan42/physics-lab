---
doc: spec
status: approved
---

# Mission Board — Technical Specification

The user approved MuJoCo and model-specific solver boundaries for future categories. Scope and PRD remain approved. This is the current build contract; implementation and outstanding verification are tracked in the checklist.

## How This Works, In Plain Language

The student describes an experiment. A small Node API sends the description, supported mechanics vocabulary and output schema to the selected LLM. The model returns data, never executable code or unrestricted solver files. Shared validation checks the result, and a trusted builder converts an admitted mechanics model to MuJoCo's MJCF format.

The official MuJoCo WASM engine compiles and simulates the model in the browser. Three.js renders its geometry; the object cards read its actual physical state. The assembled experiment first appears paused, with assumptions and initial conditions visible. Only Run starts motion. Playback and inspection do not make more model requests.

The first implementation is mechanics-only and compositional, not a menu of complete presets. Thermodynamics, aerodynamics, quantum physics, orbital mechanics and relativity remain future categories, with their own equations, state and observables rather than a forced rigid-body representation.

## Accepted Stack

| Piece | Baseline | Reference |
| --- | --- | --- |
| Runtime | Node 24 LTS, at least 24.12; existing environment 24.21.0 | [Native erasable TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html) |
| UI/types | React 19.3.1, TypeScript 7.0.2 | [React](https://react.dev/learn/build-a-react-app-from-scratch) |
| Tooling | Vite 8.3.4, React plugin 6.1.2 | [Vite](https://vite.dev/guide/) |
| Renderer | Three.js 0.186.1 | [Three.js](https://threejs.org/) |
| Physics | Official `@mujoco/mujoco` 3.16.0, single-threaded WASM | [Versioned bindings](https://github.com/google-deepmind/mujoco/blob/3.16.0/wasm/README.md) |
| Validation | Zod 4.6.7 | [JSON Schema conversion](https://zod.dev/json-schema) |
| Server/tests | Node `http`, `fetch`, `node:test`, `assert` | No provider SDK, HTTP framework or test-runner dependency required. |
| Presentation | CSS, system sans and monospace fonts | No animation framework or asset-generation service needed. |

These versions were checked during planning; pin installed versions and commit the lockfile. Use ESM, explicit `.ts` imports in server/shared modules, erasable TypeScript syntax and a strict no-emit check. Node does not execute TSX or implement TS path aliases.

The official MuJoCo bindings are still documented WIP. Use the tested package version and actual exported APIs, not assumptions from C++, Python or another engine. The default single-threaded build does not require SharedArrayBuffer or cross-origin-isolation headers. GPU acceleration and a native Python backend are not required for this implementation.

## Where It Runs and How Someone Tries It

Local browser plus a loopback Node service, using operator-owned application keys. Public deployment, account systems and an unauthenticated funded proxy are not part of this build.

Implemented local commands:

```sh
npm ci
npm run api
# Second terminal:
npm run dev
```

- `npm run api`: `node --env-file-if-exists=.env --watch server/index.ts`, at `127.0.0.1:3001`.
- `npm run dev`: Vite at `127.0.0.1:5173`, proxying `/api` to Node; open `http://127.0.0.1:5173`.
- `npm run build`: strict TypeScript check and `vite build`.
- `npm test`: Node behavioral tests; engine integration is additionally exercised in the actual browser.
- `npm start`: `node --env-file-if-exists=.env server/index.ts`, serving built `dist` and `/api` at `127.0.0.1:3001`. Build first; Vite preview is not the production API server.

Provide a secret-free `.env.example` naming `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY`. Keep real credential files outside the public-facing tree; an ignored local `.env` link to a private file, or explicitly authorized process environment, supplies them. Never use a `VITE_` secret, copy coding-agent OAuth credentials, or put real values in chat, source, fixtures or logs. Missing keys produce setup guidance, not a fake model. An authorized configured provider is required for live generation verification.

The required demo video must show the real core journey; the public repository remains required. Deployment is optional and needs its own access/spending policy before exposing operator keys.

## Look and Feel

Implements `prd.md > Look and Feel` and `prd.md > Screens and Layout`.

One physics-lab Mission Board, Apple-inspired web glassmorphism and restrained kinetic motion. The current user-requested palette is soft light grey with dark ink, muted teal controls and a light blue-grey canvas, readable sans labels and monospaced values. This is a web approximation, not an official Apple component package.

Prompt/provider/category controls sit beside the simulation on desktop, with object cards directly beneath the canvas. Narrow screens stack the same sections. Use one coherent light theme, sufficient contrast without relying on blur, visible focus, keyboard operation and reduced-motion treatment.

The short themed intro is skippable and has a reduced-motion alternative. It is decorative, not fabricated simulation or progress. Stop decorative animation and unnecessary rendering once the interface/camera is settled. Detailed visual refinement is iterative, while the approved sections and journey remain intact.

## Core Journey Through the System

Implements `prd.md > The Core Journey`.

1. Intro leads to an empty Mission Board. Mechanics is the only active category.
2. The student selects an available provider/model and submits the scenario.
3. `POST /api/assemble` sends the description and any clarification exchange with the supported catalog/schema.
4. Make the best meaningful model within Mechanics. A paused approximate model explicitly names requested behavior it cannot reproduce and the actual approximation. Ask a consequential clarification when necessary; explain unsupported only when no meaningful category model can be made. No fabricated capability or silent change.
5. A validated scene passes through the trusted MJCF builder and actual MuJoCo compilation/initialization. Only successful initialization replaces the previous paused experiment.
6. Initial geometry, cards, assumptions and interpretation appear paused at simulation time zero. Run is explicit.
7. Run advances the local solver; speed changes presentation timing, not the numerical timestep. Pause publishes a consistent current-state snapshot.
8. Provider, validation, compilation and numerical failures preserve the prompt and previous usable experiment. Refusal or malformed output is an error, not a valid physics-support verdict.

## Components

### Mission Board and Assembly State

Implements `prd.md > Mission Board`, `prd.md > Scenario Prompt and Assembly`.

`App.tsx` owns prompt, selected provider/model, clarification context, interpretation, immutable model definition and inspection snapshot. Relevant states are intro, empty, waiting-for-model, clarification, preparing-model, ready-paused, running, paused, unsupported and error.

Report only real stages, without fabricated percentages or agent-log walls. Prevent duplicate in-flight submissions and stale responses replacing newer state. Pause the current experiment while preparing its replacement; retain it if replacement fails. Valid scene definitions are persisted privately before native preparation, and only successful native readiness changes the visible scene and URL. Restore opens paused at initial conditions, never by replaying inference or silently resuming a trajectory.

Desktop uses a composer beside the simulation and inspection directly below the canvas; narrow screens stack them. A brief CSS entrance never blocks typing and respects reduced motion. Editable prompt starters fill descriptions only. Model settings are secondary, with route/cost warnings. Clarification focuses its answer field; current response and preserved-preview assumptions stay distinguishable. Stop waiting aborts the local fetch/candidate, invalidates stale work and preserves the active model; upstream computation and charges may continue.

Submission focuses and scrolls to a prominent progress panel with an indeterminate indicator and monotonic elapsed time. Optional NDJSON progress reports actual provider generation, local validation, one same-model correction if needed, and native preparation; the UI never schedules fake phase transitions or percentages. The pre-submit notice discloses the possible second provider charge. Reduced motion keeps a static activity indicator and elapsed updates. Local stop-waiting returns focus to the draft. The presentation uses a coherent light UI and light blue-grey WebGL background; plane reference points, not arbitrary infinite-plane patch extents, contribute to view framing.

### Model Contract and Catalog

Implements `prd.md > Scenario Prompt and Assembly`, `scope.md > The Unique Kernel`.

`shared/scene.ts` owns strict provider-decision and mechanics-model schemas. The decision has `kind: scene|clarify|unsupported`, `summary`, `assumptions`, nullable `question`, `reason`, `scene`, optional nullable `alternative: {label,description}` (limits 60/1600 characters), and optional nullable `approximation` (1200 characters). A ready scene requires a complete physically validated model and null question/reason/alternative; a nonnull approximation explicitly identifies the requested behavior not represented and the actual substitute. Clarify requires a question and null scene; unsupported requires a reason and null scene. Non-scene decisions cannot claim an approximate preview. Non-scene explanations, questions and proposals may coexist, but never authorize a replacement model. Proposal acceptance fills a draft, not an executable scene.

`shared/scene.ts` owns physical schemas/defaults, validity and the decision contract; `shared/catalog.ts` generates provider instructions from that schema and states the interpretation/units policy. `src/physics/mjcf.ts` and `materials.ts` own trusted compilation/contact calibration; `mujoco.ts` owns native observations. There is no second handwritten response schema or model-supplied solver. The model selects blocks/data, never code, arbitrary formulas, solver overrides, assets or plugins.

The current mechanics definition contains environment/model assumptions, named bodies and geometry, their initial poses and degrees of freedom, constraints/tendons and loads. Body parenting must form a valid tree; explicitly modeled equality connections handle supported loop closures. Normalize quantities to SI and radians before admission. Use a Z-up world with gravity normally `(0,0,-9.81)` when that assumption is explicitly displayed. State conversions and defaults remain visible in the preview.

Every unspecified physical choice must be clarified or sensibly assumed with exact values/units in the model's assumptions, including initial rest/spin, geometry, gravity, contact/friction/damping when used. Proposals must state changed/dropped conditions, preserve the remaining comparison and choose non-overlapping placement unless contact is requested. This is an interpretation policy, not an automatic proof that natural-language intent was correctly understood; native values and explicit review remain necessary.

Provider-native schemas preserve physical descriptions and use one initial-pose convention for generated scalar-joint bodies: the provider cannot emit a second initial `motion.position`; local admission supplies zero. Initial body poses, joint rest references and limits share that zero. The full internal scene API retains nonzero reference-coordinate support for existing validated callers. This is a general representation boundary, not a prompt-specific numerical repair.

Ground omission never removes the default silently. When neither configured ground nor an existing upward horizontal plane is present, the default ground is kept and the scene notes say so. A Ground switch on the canvas validates the changed scene locally and rebuilds it paused without another inference request; the choice stays with the open experiment and its session-history entry. Walls and ceilings do not count as ground; custom horizontal planes avoid duplicate floors.

Validate unique IDs and names, references, topology, positive masses/dimensions, finite values, nonzero axes, quaternion normalization, material ranges, initial constraint consistency and resource budgets. Normalize representation only where it preserves meaning; do not silently clamp physical values or discard objects. Validate on the server and again before browser allocation. Native model compilation is an additional check, not a replacement for validation.

Bodies carry restitution in [0,1] (default0) and friction `{sliding,torsional,rolling,static}`. Sliding is kinetic μ; static null means the same value, otherwise μs must be at least μk. Sliding/static are dimensionless; torsional/rolling are lengths in metres. Pair e is the minimum and friction the component-wise maximum. Interpreting "elastic" as e=1 and "inelastic" as e=0 preserves ideal-mechanics meaning; partial values are explicit.

`ground` defaults to `{height:0,restitution:1,friction:zero}`; explicit null disables it. `physicalScene()` expands the reserved `world-ground` fixed plane for compiler/runtime without mutating the API scene, then sets expanded ground=null to prevent duplication. The actual 128-body budget includes that ground. Ground may be referenced by attachments/constraints, has zero dynamic mass and is rendered/inspectable. Models must not add a duplicate standard floor. Explicit custom supports use their stated materials, normally with built-in ground disabled.

### MuJoCo Model Builder

Implements `prd.md > Scenario Prompt and Assembly`, `prd.md > Read-Only Object Cards`.

`src/physics/mjcf.ts` converts only admitted model data into trusted MJCF. Escape labels and use validated internal identifiers. No model-supplied raw XML, file includes, meshes from URLs, custom plugins or executable callbacks are accepted.

Initial composable building blocks:

| Family | Representation |
| --- | --- |
| Fixed bodies, supports, planes and ramps | Native fixed geometry, with an explicit finite/infinite surface model rather than confusing visual extent with collision extent. |
| Rigid solids | Native sphere, box, cylinder, capsule and ellipsoid geometry with explicit mass, dimensions and modeled inertia. No geometric shape is advertised until its builder and observations work. |
| Point particles | Explicit mass and translational degrees of freedom, without an invented collision surface or physical rotational inertia. Any compiler-required unused inertia is not presented as a measured point-particle property. |
| Articulations | Native free, hinge, slide and ball degrees of freedom with validated initial coordinates/speeds. Child frames/anchors are computed consistently; do not treat every body's velocity as an independent free-joint slice. |
| Connections | Supported connect/weld/coordinate couplings with valid references and declared geometry. |
| Springs and dampers | Native joint/tendon parameters with declared rest state and physical constants. |
| Cables and ideal pulley routing | Spatial tendons using named attachment/via sites, supported geometric wraps and pulley branches; declared equality or unilateral length limits. An ideal routed cord is not a finite-mass deformable cable. |
| Loads | Uniform gravity, constant forces/torques, initialization impulses, linear drag and bounded pairwise Newtonian attraction through trusted functions. |
| Contacts and materials | Direct compliant normal-contact restitution profile, static/kinetic Coulomb sliding, torsional/rolling resistance, and inspectable native contact reactions. |

Build native body/joint/geom/tendon/equality ID mappings after compilation. MJCF body transforms are parent-local; the input/render/inspection conventions must make that explicit or convert through the trusted builder. MuJoCo quaternion order is `(w,x,y,z)`; convert correctly to Three.js `(x,y,z,w)`. Use native geometry transforms for drawing and appropriate center-of-mass frames for physical observations.

MuJoCo supports zero-damping elastic contacts despite lacking a direct e scalar. The earlier unsupported-elasticity response was an application gap, not a physical impossibility. `materials.ts` supplies the validated mapping: normalized stiffness K=1e6 s⁻² and constant impedance 0.9999; solve the unilateral spring/damper relation e=exp(-2ζ acos(ζ)/sqrt(1-ζ²)) below critical damping and its acosh continuation above it, then b=2ζsqrt(K), bounded by 1/h for stable inelastic damping. e=1 uses b=0; e=0 uses the stable damping bound. Nominal reference tests allow absolute e error 0.015 at 0, 0.04 at 0.5 and 0.01 at 1; these are tested-case tolerances, not a universal accuracy claim.

Tangential damping is independently 1000 s⁻¹ so elastic normal contacts do not accidentally eliminate friction. After `mj_step1`, update friction constraint-row damping and `mj_referenceConstraint`. Independent μs/μk uses explicit material pairs only where they differ, chooses static versus kinetic from contact-relative tangential speed with a 0.001 m/s numerical sticking tolerance, updates native pair friction arrays and rebuilds position/velocity constraints only when coefficients change. Preserve MuJoCo parent/weld collision exclusions. Constant-coefficient scenes avoid an O(N²) pair table. No alternate engine, canned trajectory or silent physical fallback is used.

### MuJoCo Runtime and Observations

Implements `prd.md > Simulation and Playback`, `prd.md > Read-Only Object Cards`.

`src/physics/mujoco.ts` owns the single-threaded module, `MjModel`, `MjData`, native mappings and reusable buffers. Compile with `MjModel.from_xml_string`, construct `MjData`, initialize and evaluate the model without advancing time. Only then return a ready-paused runtime.

The playback clock consumes fixed 1 ms ticks. Collidable scenes use 16 native `implicitfast` substeps of 62.5 μs per tick; scenes with no possible collider pair retain 1 ms native steps. Profile selection depends on physical scene structure, never playback speed. Existing equality/cable `solref=(0.005,1)` remains separate from material parameters and satisfies the positive time-constant safety bound.

For state-dependent loads, each native substep uses `mj_step1`, material/friction preparation, clear/recompute external loads, then `mj_step2`. Apply uniform gravity once and initial impulses once, never accumulating persistent forces. This is not RK4. The fixed tick/work-backlog guard still bounds playback and pauses rather than dropping unresolved time.

Refresh poses/forces without advancing time before publication. Use the configured forward pipeline, including material updates; the final forward pass skips already-refreshed position/velocity stages so it does not erase the independent friction reference. A naked `mj_forward` without the material update is not the reference for this configured law. Publish coherent copied observations, not live WASM views.

Bodies/cards do not read raw generalized coordinates as though every object has one free joint: qpos and qvel have different dimensions for quaternion joints. Use actual native poses, velocities and mapping metadata. Use reusable native output buffers where required. Copy an immutable inspection snapshot when publishing to React; do not retain a live WASM view as a supposedly frozen observation.

Use `mj_objectVelocity` for each body's world/center-of-mass velocity, not raw `cvel` translation: that array uses a subtree reference point. Use body-center observations and native geometry transforms for their distinct purposes.

Constraint-force observations are model-specific. Find the correct active rows using native IDs/types and interpret their Jacobian, units and frame. In the tested Atwood path, `J=[-1,-1]`, so tensile magnitude was `-efc_force`, not a universally valid `abs(lambda)`. Include passive/actuator contributions when the requested observable requires them. There is no generic `ten_force` field to assume exists. Contact-frame wrenches and generalized forces must not be mislabeled as world-space net force or cable tension.

Equality-based tendons and unilateral limits use different active constraint rows; resolve by native constraint type and ID. Select dense versus sparse Jacobian interpretation through `mj_isSparse`, not an assumed row-count sentinel. Render only the active native path range from `ten_wrapadr`/`ten_wrapnum`, splitting pulley markers rather than drawing stale allocated-buffer entries.

Detect nonfinite state, numerical-reset/warning conditions and infeasible compilation. Pause with an explanation instead of suppressing warnings, showing invented values or silently resetting the experiment.

Native objects/buffers and copied contacts have explicit ownership. Delete owned data before model and release buffers on replacement/unmount. The SDK's `data.warning` vector is borrowed: delete its owned get() values, not the vector. `data.contact` returns an owned snapshot vector; delete it and its get() copies. Editing those snapshots does not modify native contact data. Modify supported model arrays/constraint references and reacquire detached views after allocation or memory growth.

Sources: [simulation loop and split stepping](https://mujoco.readthedocs.io/en/stable/programming/simulation.html), [modeling/numerics](https://mujoco.readthedocs.io/en/stable/modeling.html), [constraint formulation](https://mujoco.readthedocs.io/en/stable/computation/index.html), [versioned browser bindings](https://github.com/google-deepmind/mujoco/blob/3.16.0/wasm/README.md).

### Playback Clock

Implements `prd.md > Simulation and Playback`.

`src/physics/clock.ts` accumulates wall time multiplied by speed and consumes 1 ms playback ticks; the runtime advances the corresponding native substeps. Support 0.1×–10× with 1× initially. Equal simulated time gives the same state independently of speed; numerical resolution is not reduced to make fast playback appear faster.

Pause stops stepping and preserves time/state; resume continues rather than recreating the model. Pause when hidden or when a wall-frame gap exceeds 0.25 s instead of accumulating unseen catch-up work. Bound work to 512 fixed steps per frame, and in the browser also to a 10 ms wall-clock budget passed by the canvas (`advance(wall, speed, workBudgetMs)`); deferred steps stay queued and are never skipped, and callers that omit the budget step deterministically. When a device cannot sustain the selected speed, the queued wall time is capped at one frame of work and the result is marked throttled; the UI says it is running slower than selected. The timestep and the sequence of physics steps never change. These are implementation safety defaults, not universal performance guarantees.

`MechanicsRuntime.reset()` uses native `mj_resetData`, restores captured initial generalized positions and post-impulse velocities, clears the clock remainder and warning baseline, and recomputes current forces/observations. It reuses the compiled model, does not reapply impulses, remains paused and refits the camera. Fit view uses current geometry, including moving cable vertices, without altering the solver.

### Three.js Canvas and Read-Only Cards

Implements `prd.md > Mission Board`, `prd.md > Simulation and Playback`, `prd.md > Read-Only Object Cards`.

`SimulationCanvas.tsx` owns the WebGL renderer, camera, view-only orbit controls, procedural geometry and lifecycle. Match native geometry dimensions, local frames and rotations; maintain the Z-up convention. Fit the initial scene and show a readable scale/axes. Moving bodies draw a trail of their rendered positions (2048 points, halving resolution rather than dropping the start); every non-plane solid gets a fixed-pixel ring marker that appears only when the body would be under about 5 px on screen. Follow (on by default, off on any manual orbit/zoom/pan) eases the camera to frame bodies and trails while running. Fit and Follow include trails; infinite planes contribute only their reference point. The reference grid and infinite-plane patches scale in powers of ten with the framed scene, and the canvas states the current grid square size. The animation loop must never schedule a second frame callback; camera updates inside a frame fire OrbitControls change events. Rendering or camera movement never alters physical objects.

Update mesh transforms from native state using reusable arrays/matrices. Do not render the whole React tree at physics frequency. Render while stepping or changing the view; stop once paused and settled. Dispose WebGL resources/listeners and the old runtime when a validated replacement is ready. Compilation/renderer failure retains the previous usable scene rather than a false success surface.

`ObjectCards.tsx` lists bodies (including default ground) and connectors. Native descriptors provide mass, dimensions, poses/velocities, angular state/inertia, material coefficients, applied loads, spring constants/generalized force, cable routing/length/tension and world contact reactions. Momentum and translational kinetic energy are body-derived; uniform-gravity potential names its world-origin reference. They are not a complete energy accounting for rotation, compliant contact, mutual gravity or external work. Contact forces are instantaneous, not averaged or mislabeled as total net force. Fixed/ideal elements state assumptions rather than infinite/fake values.

Update ordinary live observations at a modest cadence of about 20 Hz, plus an immediate coherent snapshot on ready/pause. Pose rendering is independent of this cadence. The motion graphs record only these solver snapshots (height, speed, translational kinetic energy for moving bodies), reset with the experiment or Reset, and never interpolate invented samples. Inspection remains read-only; no object dragging, property editing, rewind or history scrubbing is implied.

### Provider API and Local Security

Implements `prd.md > Scenario Prompt and Assembly`, `prd.md > Approved Conventional Defaults`.

Provider/model controls live in the prompt section. Only configured providers can run. Offer `openrouter/free` as the initial free choice when configured; otherwise require an explicit available provider/model, with no silent paid selection.

`server/index.ts` exposes:

| Route | Contract |
| --- | --- |
| `GET /api/config` | Provider availability and safe defaults, never key values. |
| `GET /api/models?provider=openrouter` | Current text-model IDs, names and capabilities, with actual free/router labels. Direct-provider model IDs can be entered explicitly. |
| `POST /api/assemble` | `{provider,model,description,clarification:[{question,answer}]}` to a validated scene/clarify/unsupported decision. Default clients retain final JSON and non-success status errors. `Accept: application/x-ndjson` opts into actual `progress` records (`stage`, `message`) followed by exactly one `decision` or `error` record. |
| `POST /api/scenes` | Validated `{prompt,decision,scene,userGroundChoice?}` to a new immutable saved record; 201 with unguessable UUID, server timestamps, expiry and document. 1 MiB input limit; assembly remains 64 KiB. |
| `GET /api/scenes/:id` | Read the saved definition without renewal; missing/malformed/expired IDs return safe 404 `scene_not_found`. No listing endpoint. |
| `POST /api/scenes/:id/run` | Empty JSON object; atomically renew a live record to 24 hours from server activity, returning metadata only. Expired records cannot be revived. |
| `GET/HEAD /scenes/:id` | Serve the app shell for valid UUID links even when expired, so the browser can explain the unavailable link. Scene routes send noindex/nofollow; API data is no-store. |

Use fixed upstream HTTPS hosts, allowlisted provider values, bounded model IDs, JSON-only requests, allowed local Host/Origin values, size limits and deadlines. No arbitrary proxy URLs, wildcard credentialed CORS, prompt/key logging or raw upstream diagnostic dumps. Serve only files safely resolved inside `dist` with correct MIME types.

The browser bounds the streamed response to 1 MiB, validates progress stages, handles fragmented UTF-8/record boundaries and rejects incomplete, oversized, unknown or duplicate-terminal streams. Every final decision still passes full local scene admission. Once streaming headers are sent, errors are terminal error records, never counterfeit ready models.

Safety budgets start at 128 bodies, 128 constraints/tendons, 256 loads and 32 mutually attracting particles; 64 KiB assembly input, 256 KiB generated response, 8 MiB upstream catalog, 8192 output tokens and a 120-second deadline per model call. Model calls are bounded to two total: initial plus exactly one of validation correction, HTTP 5xx recovery (after a 1-second delay) or review of an unsupported verdict. Public model discovery has a 5-second deadline and 5-minute cache. Native compilation/runtime still enforce numerical feasibility. A representative model must be explicitly labelled, never silently truncated.

## External Service Contracts

`server/providers.ts` derives provider-native strict structured-output schemas from the single shared decision schema. OpenAI/OpenRouter retain supported regex, scalar bounds, array budgets and exact numeric tuple lengths. Anthropic uses its supported subset, representing tuples as required numeric-key objects; restore those before full unchanged local physics validation. Every response is validated locally. At most one additional same-model call either corrects schema/semantic defects, recovers a temporary HTTP 5xx failure, or reviews an `unsupported` verdict for a buildable or labelled approximate scene; the two-call budget is shared. Corrections receive the issue paths plus the app's own fixed physics-rule messages, never echoed model values in user diagnostics. A failed review keeps the original valid verdict. No extra request follows refusals, truncation, quota/auth failures or timeouts, and no unconstrained or paid-model fallback exists. User-facing schema rejection exposes bounded paths/codes only.

Native generation wraps a discriminated decision union as `{decision: ...}` so the root remains an object while branch-specific null/required fields are grammar constrained. The public API returns the unwrapped existing decision. Disconnected clients abort at progress checkpoints before further paid model work; already-sent upstream calls may continue. The recovery backoff completes before its send checkpoint, so cancellation during the delay cannot trigger another call.

| Provider | Request | Accept/reject behavior |
| --- | --- | --- |
| OpenAI | POST `https://api.openai.com/v1/responses`, Bearer key; `text.format:{type:"json_schema",strict:true,schema}` with `store:false`. | Require completed status; collect message `output_text` content from `output`; reject refusal, incomplete or missing text. |
| Anthropic | POST `https://api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version:2023-06-01`; `output_config.format:{type:"json_schema",schema}`. | Require completed `end_turn` text; restore exact tuple transport; reject refusal, truncation and tool use. |
| OpenRouter | POST `https://openrouter.ai/api/v1/chat/completions`, Bearer key; strict `response_format.json_schema`, `provider.require_parameters:true`. | Require completed text choice and full local validation. Preserve the selected exact model ID during correction/recovery. |
| Discovery | GET `https://openrouter.ai/api/v1/models`, cached 5 minutes. | Read actual IDs/modalities/capabilities. Free means the explicit router or an existing `:free` entry. Use advertised 2048-token reasoning budgets or low/minimal effort; disable optional unbounded reasoning only when `mandatory:false` is advertised. Unknown/dynamic-router capabilities retain provider defaults. |

Routing references: [Free Models Router capabilities](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground), [JSON response formats](https://openrouter.ai/docs/api/reference/overview), [required provider parameters](https://openrouter.ai/docs/guides/routing/provider-selection).

Structured-output references: [OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs), [Anthropic](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs), [advertised reasoning controls and shared output budget](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). The initial configured free model is `nvidia/nemotron-3.5-super-vl:free`, not the random free router. Its continued availability is not automatically monitored.

Malformed/truncated output, refusal, HTTP failure, missing key, rate limit or failed validation is an assembly error preserving input/scene. Never turn it into a fabricated physics result. Free inference still needs a key and has changing quotas/availability. Token and time limits do not constitute a guaranteed dollar cap; operator accounts should have provider-side spending controls.

References: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [OpenRouter API](https://openrouter.ai/docs/api/reference/overview), [free router](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground), [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free), [limits](https://openrouter.ai/docs/api/reference/limits).

## Data Ownership and Future Physics

Browser memory owns prompt editing, view state, live observations and unsaved recovery; the native runtime owns solver state. Node privately persists immutable validated scene documents (source prompt, original interpretation, actual scene and ground choice) with creation, last-run and expiry timestamps in SQLite. It does not persist provider settings/credentials, clarification transcripts, runtime handles, trajectories or snapshots. The browser caches up to eight link IDs/titles/expiry hints, verifies records on opening, and never treats cached expiry as authoritative after another viewer runs. Credentials remain server-owned; submitted descriptions still go to the selected provider under its policy.

Saved IDs are random UUID capabilities, with no directory/list or update route. Each setup change creates a new record/link; reading and sharing are non-renewing. Initial lifetime is creation plus 86,400,000 ms. Run/Resume must confirm renewal before physics starts; active playback renews every 60 seconds and at its final Pause. Paused Reset, camera controls and opening links do not extend lifetime. Exact-boundary expiry is enforced in SQL independently of the minute cleanup task, and expired IDs never resurrect. A local definition may explicitly be copied to a fresh ID after expiry.

Scene storage defaults to a private OS app-data file, overridden by `SCENE_DB_PATH` outside the public project tree. Directories are private (0700) and the file 0600; corruption/write/maintenance failures do not fall back to ephemeral success. Production initializes storage and purges expired rows at startup, cleanup runs every minute, and server close releases the database/timer. Test servers use isolated files and injectable clocks. Unlisted links are not authentication: anyone holding one can read/forward/run it. No public deployment or weakening of local Host/Origin guards is implied.

Client URL/candidate generations, Run-start tokens and operation-owned recovery protect stale replies. A late read cannot overwrite a newer lease; Run/heartbeat feedback cannot erase an unsaved setup's Retry action. Requests are bounded to 15 seconds, and save retries reuse the captured document rather than making another model request. A failed renewal blocks playback until recovery. Browser Back/Forward, refresh and local recent links restore actual saved ground/values without a model call.


Keep the small presentation boundary model-defined: timestamped observables with units/frames and a suitable visualization description. Do not make native body classes or pose/velocity arrays the mandatory state of all future domains. Each later model supplies its own typed input, assumptions, validity checks, time semantics and observable mapping.

- Thermodynamics may use lumped gas/heat models or temperature fields; [Cantera](https://cantera.org/stable/reference/reactors/ideal-gas-reactor.html) is an example where control-volume thermodynamics is appropriate.
- Aerodynamics needs declared ideal-flow assumptions or actual CFD fields/mesh/boundary conditions; [OpenFOAM](https://cpp.openfoam.org/v10/rhoPimpleFoam_8C_source.html) illustrates the latter.
- Quantum models evolve states/density matrices and measured expectations/probabilities, for example [QuTiP](https://qutip.readthedocs.io/en/latest/guide/dynamics/dynamics-master.html), not assumed classical trajectories.
- Space/orbit models need appropriate long-horizon integrators and reference frames, for example [REBOUND](https://rebound.readthedocs.io/en/latest/).
- Relativity needs explicit coordinate/proper time and Lorentz/metric/geodesic models; [EinsteinPy](https://github.com/einsteinpy/einsteinpy/blob/master/docs/source/user_guide.rst) illustrates geodesics, while [Einstein Toolkit](https://einsteintoolkit.org/capabilities.html) addresses the separate expensive full-spacetime problem.

Later placement may be browser, CPU server, GPU or buffered computation; no claim of universal real-time execution or automatic cross-domain coupling. Implement only the mechanics runtime now, not placeholder future engines or a plugin/distributed-compute framework. Review licenses when adopting additional libraries.

## File Structure

Current application file layout:

```text
package.json / package-lock.json        exact dependencies and runnable scripts
.env.example / .gitignore               key names only and publication safeguards
index.html / vite.config.ts             browser entry, WASM asset serving, local API proxy
tsconfig.json                          strict no-emit UI/server/shared checks
src/
  main.tsx                             React entry
  App.tsx                              intro, Mission Board and assembly/clarification flow
  styles.css                           lab/glass layout, motion and accessibility
  SimulationCanvas.tsx                 native-scene rendering and view-only camera
  ObjectCards.tsx                      contextual read-only observations
  TelemetryPanel.tsx / telemetry.css   motion graphs from recorded solver snapshots
  SceneLinkBar.tsx / scene-link.css    save, copy-link and expiry feedback
  saved-scenes.ts                    persistence requests and recent-link metadata
  physics/
    mjcf.ts                            trusted mechanics data to MJCF compiler
    mujoco.ts                          WASM lifecycle, loads, steps and observations
    clock.ts                           fixed-step playback and pause budgets
    types.ts                           renderer/inspection boundary without native handles
shared/
  scene.ts                             decision/model schemas and semantic admission
  catalog.ts                           supported blocks, units and observation metadata
  saved-scene.ts                       saved document and retention contracts
server/
  index.ts                             local API and safe built-static serving
  providers.ts                         direct requests and response extraction
  scenes.ts                            private SQLite storage and sliding expiry
tests/
  scene.test.ts                        structural/physical admission invariants
  compiler.test.ts                     physical compilation and frame/constraint behavior
  physics.test.ts                      numerical references, loads, clocks and snapshots
  providers.test.ts                    meaningful refusal/truncation/parse handling
  http.test.ts                         real local request/Host/Origin/body boundaries
  clock.test.ts                        fixed-step timing, pause and retained-work invariants
  fixtures.ts                          isolated synthetic physical reference models
devpost/                               plans, official build checklist and eventual app map
README.md / CHANGELOG.md                actual setup, limitations, run and verified changes
```

No compatibility exports, old-engine adapter, provider SDK abstraction or extra process-launching framework is required.

## Verification and Prior Evidence

Previously exercised official MuJoCo 3.16.0, not a current application build:

- Native and Chromium/WASM routed-tendon Atwood test: 1 kg/2 kg, expected acceleration ±3.27 m/s² and tension 13.08 N. At h=1 ms the one-second positions were approximately +1.636635/-1.636635 m versus ideal ±1.635 m; tension was 13.08 N and path-length error about 4.9e-8 m.
- Halving h to 0.5 ms halved that displacement error. Equal-time state at 0.1×/1×/10× was identical.
- The first overly stiff constraint profile became unstable. The documented positive time-constant profile stabilized it without changing physical acceptance tolerances; numerical settings must be validated, not supplied arbitrarily by the LLM.
- Native RK4 free-flight reference matched analytical position/velocity. This does not establish RK4 accuracy for externally evaluated forces or the split-step runtime.
- Actual single-thread WASM file was 10,751,588 bytes, 2,657,248 bytes gzip, excluding JS/assets. This is not an integrated application download or mobile performance result.

Keep compact deterministic regressions for consumer-visible failures: invalid references/topology/units, unsafe or inconsistent model data, body/geom frame conversion, supported joint/tendon construction, analytical motion/constraints, signed force mapping, exactly-once impulses, state-dependent load timing, fixed-step speed equality, pause/snapshot aliasing, and provider refusal/truncation/errors. Do not test copied wording, source text, CSS, forwarding or mocks that merely echo input.

Every build slice gets its mechanical verification. After integration, run the production build and behavioral suite, then exercise the actual browser: intro/reduced motion, empty board, one real configured-provider prompt, necessary clarification, actual paused model, explicit Run, both speed endpoints, pause/all relevant cards, unsupported/failure preservation, replacement cleanup and responsive camera/layout. Confirm no provider key enters client assets or public history. Authenticated inference is not proved by fixtures or the solver-only smokes.

## Decisions and Open Issues

Current production build and 89 behavioral checks pass, retaining all prior native mechanics/provider/clock references. New checks cover durable private records, process reopen, read-versus-run retention, exact 24-hour expiry, non-resurrection, metadata-only renewal, stale cleanup safety, validation/corruption/permissions and bounded client cancellation. Actual browser/API checks prove refresh and process-restart survival, clean-browser read/run with no inference, immutable ground-choice forks, source-prompt preservation, Back/Forward and clipboard fallback at320px. An isolated clock-controlled server proves access1ms before expiry, exact-boundary denial, non-resurrection, active heartbeat/final Pause renewal, stopped renewal after Pause, expired-link recovery and stale-read/Reset races. Response-boundary probes cover failed-save retries that survive running the old scene. A fresh provider request timed out; the prior saved URL/scene remained intact, and no new inference reliability is claimed.

Source/provider contracts and numerical evidence informed the engineering defaults above. Any discovered change to the product, chosen architecture or supported physical meaning must be discussed, while routine internal corrections are recorded in the checklist's Revisions. A needed new model is not labeled impossible merely because it is absent.

Live model verification needs authorized application API access; never paste keys in chat or reuse coding-agent credentials. This is an external verification prerequisite, not permission for a fake model. Browser/solver research does not substitute for the finished app's hands-on learner feedback and final review.
