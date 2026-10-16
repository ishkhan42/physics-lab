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
4. A valid clarification asks one consequential question. A valid unsupported decision explains a real current modeling/resource limitation; a simpler model requires the student's agreement.
5. A validated scene passes through the trusted MJCF builder and actual MuJoCo compilation/initialization. Only successful initialization replaces the previous paused experiment.
6. Initial geometry, cards, assumptions and interpretation appear paused at simulation time zero. Run is explicit.
7. Run advances the local solver; speed changes presentation timing, not the numerical timestep. Pause publishes a consistent current-state snapshot.
8. Provider, validation, compilation and numerical failures preserve the prompt and previous usable experiment. Refusal or malformed output is an error, not a valid physics-support verdict.

## Components

### Mission Board and Assembly State

Implements `prd.md > Mission Board`, `prd.md > Scenario Prompt and Assembly`.

`App.tsx` owns prompt, selected provider/model, clarification context, interpretation, immutable model definition and inspection snapshot. Relevant states are intro, empty, waiting-for-model, clarification, preparing-model, ready-paused, running, paused, unsupported and error.

Report only real stages, without fabricated percentages or agent-log walls. Prevent duplicate in-flight submissions and stale responses replacing newer state. Pause the current experiment while preparing its replacement; retain it if replacement fails. State is in browser memory, so refresh starts a new session. No database, login, saved-scene service or conversation logging is added.

Desktop uses a composer beside the simulation and inspection directly below the canvas; narrow screens stack them. A brief CSS entrance never blocks typing and respects reduced motion. Editable prompt starters fill descriptions only. Model settings are secondary, with route/cost warnings. Clarification focuses its answer field; current response and preserved-preview assumptions stay distinguishable. Stop waiting aborts the local fetch/candidate, invalidates stale work and preserves the active model; upstream computation and charges may continue.

Submission focuses and scrolls to a prominent progress panel with an indeterminate indicator, monotonic elapsed time and two actual phases: waiting for interpretation, then native model preparation. No fake percentage or scheduled stage transition is used. Reduced motion keeps a static activity indicator and elapsed updates. Local stop-waiting returns focus to the draft. The presentation uses a coherent light UI and light blue-grey WebGL background; plane reference points, not arbitrary infinite-plane patch extents, contribute to view framing.

### Model Contract and Catalog

Implements `prd.md > Scenario Prompt and Assembly`, `scope.md > The Unique Kernel`.

`shared/scene.ts` owns strict provider-decision and mechanics-model schemas. The decision has `kind: scene|clarify|unsupported`, `summary`, `assumptions`, nullable `question`, `reason`, `scene`, and optional nullable `alternative: {label,description}` (limits 60/1600 characters). A ready scene requires a complete physically validated model and null question/reason/alternative. Clarify requires a question and null scene; unsupported requires a reason and null scene. Non-scene explanations, questions and proposals may coexist, but never authorize a replacement model. Proposal acceptance fills a draft, not an executable scene.

`shared/scene.ts` owns physical schemas/defaults, validity and the decision contract; `shared/catalog.ts` generates provider instructions from that schema and states the interpretation/units policy. `src/physics/mjcf.ts` and `materials.ts` own trusted compilation/contact calibration; `mujoco.ts` owns native observations. There is no second handwritten response schema or model-supplied solver. The model selects blocks/data, never code, arbitrary formulas, solver overrides, assets or plugins.

The current mechanics definition contains environment/model assumptions, named bodies and geometry, their initial poses and degrees of freedom, constraints/tendons and loads. Body parenting must form a valid tree; explicitly modeled equality connections handle supported loop closures. Normalize quantities to SI and radians before admission. Use a Z-up world with gravity normally `(0,0,-9.81)` when that assumption is explicitly displayed. State conversions and defaults remain visible in the preview.

Every unspecified physical choice must be clarified or sensibly assumed with exact values/units in the model's assumptions, including initial rest/spin, geometry, gravity, contact/friction/damping when used. Proposals must state changed/dropped conditions, preserve the remaining comparison and choose non-overlapping placement unless contact is requested. This is an interpretation policy, not an automatic proof that natural-language intent was correctly understood; native values and explicit review remain necessary.

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

Pause stops stepping and preserves time/state; resume continues rather than recreating the model. Pause when hidden or when a wall-frame gap exceeds 0.25 s instead of accumulating unseen catch-up work. Bound work to 512 steps per frame, retaining the remainder; if more than one simulated second remains queued, pause and explain the resource limit rather than drop physics steps or pretend to sustain 10×. These are implementation safety defaults to validate against real scenes, not universal performance guarantees.

`MechanicsRuntime.reset()` uses native `mj_resetData`, restores captured initial generalized positions and post-impulse velocities, clears the clock remainder and warning baseline, and recomputes current forces/observations. It reuses the compiled model, does not reapply impulses, remains paused and refits the camera. Fit view uses current geometry, including moving cable vertices, without altering the solver.

### Three.js Canvas and Read-Only Cards

Implements `prd.md > Mission Board`, `prd.md > Simulation and Playback`, `prd.md > Read-Only Object Cards`.

`SimulationCanvas.tsx` owns the WebGL renderer, camera, view-only orbit controls, procedural geometry and lifecycle. Match native geometry dimensions, local frames and rotations; maintain the Z-up convention. Fit the initial scene and show a readable scale/axes. Rendering or camera movement never alters physical objects.

Update mesh transforms from native state using reusable arrays/matrices. Do not render the whole React tree at physics frequency. Render while stepping or changing the view; stop once paused and settled. Dispose WebGL resources/listeners and the old runtime when a validated replacement is ready. Compilation/renderer failure retains the previous usable scene rather than a false success surface.

`ObjectCards.tsx` lists bodies (including default ground) and connectors. Native descriptors provide mass, dimensions, poses/velocities, angular state/inertia, material coefficients, applied loads, spring constants/generalized force, cable routing/length/tension and world contact reactions. Momentum and translational kinetic energy are body-derived; uniform-gravity potential names its world-origin reference. They are not a complete energy accounting for rotation, compliant contact, mutual gravity or external work. Contact forces are instantaneous, not averaged or mislabeled as total net force. Fixed/ideal elements state assumptions rather than infinite/fake values.

Update ordinary live observations at a modest cadence such as 10 Hz, plus an immediate coherent snapshot on ready/pause. Pose rendering is independent of this cadence. Inspection remains read-only; no object dragging, property editing, rewind or history scrubbing is implied.

### Provider API and Local Security

Implements `prd.md > Scenario Prompt and Assembly`, `prd.md > Approved Conventional Defaults`.

Provider/model controls live in the prompt section. Only configured providers can run. Offer `openrouter/free` as the initial free choice when configured; otherwise require an explicit available provider/model, with no silent paid selection.

`server/index.ts` exposes:

| Route | Contract |
| --- | --- |
| `GET /api/config` | Provider availability and safe defaults, never key values. |
| `GET /api/models?provider=openrouter` | Current text-model IDs, names and capabilities, with actual free/router labels. Direct-provider model IDs can be entered explicitly. |
| `POST /api/assemble` | `{provider,model,description,clarification:[{question,answer}]}` to a validated scene/clarify/unsupported decision; safe errors use non-success HTTP status. |

Use fixed upstream HTTPS hosts, allowlisted provider values, bounded model IDs, JSON-only requests, allowed local Host/Origin values, size limits and deadlines. No arbitrary proxy URLs, wildcard credentialed CORS, prompt/key logging or raw upstream diagnostic dumps. Serve only files safely resolved inside `dist` with correct MIME types.

Safety budgets start at 128 bodies, 128 constraints/tendons, 256 loads and 32 mutually attracting particles; 64 KiB assembly input, 256 KiB generated response, 8 MiB upstream model catalog, 8192 requested output tokens and a 60-second model deadline. Compilation and runtime must also enforce numerical feasibility. These budgets can be revised from evidence; they do not guarantee every device/model handles their maxima. Reject with an explanation rather than delete excess objects or modify the experiment.

## External Service Contracts

`server/providers.ts` implements three direct adapters feeding the same decision schema. The baseline asks for a JSON object with generated schema/catalog guidance and human-facing branch examples. For `openrouter/free`, additionally send `response_format:{type:'json_object'}` and `provider:{require_parameters:true}` to select JSON-capable free endpoints rather than rely only on prompting. Explicit other model IDs retain the text baseline. JSON mode does not prove semantic or physical correctness: validate every response. No automatic repair calls, app retry framework or paid model fallback is added. Schema rejection includes bounded paths/codes, never raw response values.

| Provider | Request | Accept/reject behavior |
| --- | --- | --- |
| OpenAI | POST `https://api.openai.com/v1/responses`, Bearer key; `{model,input,max_output_tokens:8192,store:false}`. | Require completed status; collect message `output_text` content from `output`; reject refusal, incomplete or missing text. Top-level `output_text` is an SDK convenience, not a REST field. |
| Anthropic | POST `https://api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version:2023-06-01`; `{model,max_tokens:8192,system,messages}`. | Collect text content and require completed `end_turn`; reject token/context limits, refusal, tool use or paused termination. |
| OpenRouter | POST `https://openrouter.ai/api/v1/chat/completions`, Bearer key; `{model,messages,max_tokens:8192}`. | Require a completed text choice; parse `choices[0].message.content` and validate it. Preserve the selected exact model ID. |
| Discovery | GET `https://openrouter.ai/api/v1/models`. | Read actual IDs/modalities/capabilities. Free means the explicit `openrouter/free` route or an existing `:free` entry, not arbitrary suffixing or zero token prices alone. |

Routing references: [Free Models Router capabilities](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground), [JSON response formats](https://openrouter.ai/docs/api/reference/overview), [required provider parameters](https://openrouter.ai/docs/guides/routing/provider-selection).

Malformed/truncated output, refusal, HTTP failure, missing key, rate limit or failed validation is an assembly error preserving input/scene. Never turn it into a fabricated physics result. Free inference still needs a key and has changing quotas/availability. Token and time limits do not constitute a guaranteed dollar cap; operator accounts should have provider-side spending controls.

References: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [OpenRouter API](https://openrouter.ai/docs/api/reference/overview), [free router](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground), [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free), [limits](https://openrouter.ai/docs/api/reference/limits).

## Data Ownership and Future Physics

Browser memory holds the prompt exchange, immutable model definition, view state and current observations. The native runtime owns its engine-specific state. Node owns configured provider credentials and current request processing, without a scene/conversation database. Submitted descriptions go to the selected provider under that provider's data policy.

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
  physics/
    mjcf.ts                            trusted mechanics data to MJCF compiler
    mujoco.ts                          WASM lifecycle, loads, steps and observations
    clock.ts                           fixed-step playback and pause budgets
    types.ts                           renderer/inspection boundary without native handles
shared/
  scene.ts                             decision/model schemas and semantic admission
  catalog.ts                           supported blocks, units and observation metadata
server/
  index.ts                             local API and safe built-static serving
  providers.ts                         direct requests and response extraction
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

Current production build and 62 behavioral checks pass. Native references cover default/disabled ground, e=0/0.5/1, unequal-mass elastic momentum/energy, static/kinetic friction, combined elastic impact with friction, contact invariance across playback/publication cadence and all prior composed mechanics. Admission rejects contact materials on non-colliding points. Actual browser generation of the original request preserved e=1/e=0 and physical ground, then showed rebound versus settling. A separately selected current free model generated a static/kinetic box comparison that passed force/motion, 0.1×/10× and Reset checks. The generic free router rejected one friction reply; no automatic retry/fallback was added. Existing light/progress/recovery features remain. Numerical targets and natural-language interpretation still require review; final learner approval and other-provider live calls are not claimed.

Source/provider contracts and numerical evidence informed the engineering defaults above. Any discovered change to the product, chosen architecture or supported physical meaning must be discussed, while routine internal corrections are recorded in the checklist's Revisions. A needed new model is not labeled impossible merely because it is absent.

Live model verification needs authorized application API access; never paste keys in chat or reuse coding-agent credentials. This is an external verification prerequisite, not permission for a fake model. Browser/solver research does not substitute for the finished app's hands-on learner feedback and final review.
