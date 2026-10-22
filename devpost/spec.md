---
doc: spec
status: approved
---

# Mission Board — Technical Specification

The final contest POC has been accepted. This specification records implemented behavior, limits and historical evidence; hosted availability depends on deployment configuration.

## How This Works, In Plain Language

The student describes an experiment. A small Node API sends the description, supported mechanics vocabulary and output schema to the selected LLM. The model returns data, never executable code or unrestricted solver files. Shared validation checks the result, and a trusted builder converts an admitted mechanics model to MuJoCo's MJCF format.

The official MuJoCo WASM engine compiles and simulates the model in the browser. Three.js renders its geometry; the object cards read its actual physical state. The assembled experiment first appears paused, with assumptions and initial conditions visible. Only Run starts motion. Playback and inspection do not make more model requests.

The mechanics runtime remains compositional for ordinary prompts, and the composer also offers five curated prepared studies, each with one ready setup. The prepared library is a separate explicit entry path, not model output or a substitute on failure. Thermodynamics, aerodynamics, quantum physics, dedicated long-horizon orbital tools and relativity remain future categories, with their own equations, state and observables rather than a forced rigid-body representation. The current mechanics solver already supports bounded Newtonian point-mass gravity.

## Accepted Stack

| Piece | Baseline | Reference |
| --- | --- | --- |
| Runtime | Node 24 LTS, at least 24.12; existing environment 24.21.0 | [Native erasable TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html) |
| UI/types | React 19.3.1, TypeScript 7.0.2 | [React](https://react.dev/learn/build-a-react-app-from-scratch) |
| Tooling | Vite 8.3.4, React plugin 6.1.2 | [Vite](https://vite.dev/guide/) |
| Renderer | Three.js 0.186.1 | [Three.js](https://threejs.org/) |
| Physics | Official `@mujoco/mujoco` 3.16.0, single-threaded WASM | [Versioned bindings](https://github.com/google-deepmind/mujoco/blob/3.16.0/wasm/README.md) |
| Validation | Zod 4.6.7 | [JSON Schema conversion](https://zod.dev/json-schema) |
| Server/tests/agent | Node `http`, `fetch`, `node:test`, `assert`; pinned Pi agent-core/pi-ai 1.3.0 and Docker | Pi owns the agent loop and provider transport; Docker enforces worker isolation. |
| Presentation | CSS, system sans and monospace fonts | No animation framework or asset-generation service needed. |

These versions were checked during planning; pin installed versions and commit the lockfile. Use ESM, explicit `.ts` imports in server/shared modules, erasable TypeScript syntax and a strict no-emit check. Node does not execute TSX or implement TS path aliases.

The official MuJoCo bindings are still documented WIP. Use the tested package version and actual exported APIs, not assumptions from C++, Python or another engine. The default single-threaded build does not require SharedArrayBuffer or cross-origin-isolation headers. GPU acceleration and a native Python backend are not required for this implementation.

## Where It Runs and How Someone Tries It

Local development uses a browser, loopback Node API and operator-owned provider credentials. Hosted mode serves the API over an HTTPS origin allowlist, stores scenes in Firestore, and routes runs through an authenticated private worker gateway that starts fresh network-denied Docker workers. Hosted image inspection uses a separate keyless, IAM-protected renderer; neither worker nor renderer is a browser endpoint. Hosted model access is limited to free OpenRouter choices or the explicitly authorized, expiring Connected GPT demo.

Implemented local commands:

```sh
npm ci --ignore-scripts
npm run api
# Second terminal:
npm run dev
```

- `npm run api`: automatically build/cache the Docker sandbox, then `node --env-file-if-exists=.env --watch server/index.ts` at `127.0.0.1:3001`.
- `npm run dev`: Vite at `127.0.0.1:5173`, proxying `/api` to Node; open `http://127.0.0.1:5173`.
- `npm run build`: strict TypeScript check and `vite build`.
- `npm test`: Node behavioral tests; engine integration is additionally exercised in the actual browser.
- `npm start`: automatically build/cache the Docker sandbox, then `node --env-file-if-exists=.env server/index.ts`, serving built `dist` and `/api` at `127.0.0.1:3001`. Build first; Docker must be available.

Provide secret-free provider environment names; keep keys outside the public tree and never use VITE_ secrets or copy credentials into source, fixtures, saved scenes or logs. Standard providers use the private environment. Connected GPT requires explicit operator authorization and PHYSICS_LAB_CONNECTED_GPT=1; the broker resolves the local OMP login or a separate bounded hosted OAuth session in Secret Manager, pins one credential per run and supports only gpt-6-luna with High reasoning. The worker never receives credentials or the login store. Missing authorization/login fails closed.


Application source and technical documentation use the root MIT license; package metadata declares `MIT`. The Skill Pack, imported libraries/fonts and CC0 material derivatives retain their original notices and terms. `devpost/app-map.html` is a standalone offline source reference, not an app endpoint.

## Look and Feel

Implements `prd.md > Look and Feel` and `prd.md > Screens and Layout`.

One physics-lab Mission Board, Apple-inspired web glassmorphism and restrained kinetic motion. The current user-requested palette is soft light grey with dark ink, muted teal controls and a light blue-grey canvas, readable sans labels and monospaced values. This is a web approximation, not an official Apple component package.

Use the existing light Geist/teal visual system for nontechnical learners. Compact expandable chat and the composer sit beside the canvas; AI settings, detailed activity, recent scenes and assumptions are disclosures. A visual storyboard presents actual event times, planned launch mass/speed, queued state and native loaded mass before Run. Mechanics is identified in the workbench, not a one-option category form. Narrow screens stack the same surfaces with accessible horizontal timeline scrolling.

The empty workbench omits duplicate welcome copy and defers telemetry/cards until a candidate or active experiment exists. Recents use native details/summary, preserving all links and keyboard operation without additional UI state. Touch pointers receive 44px minimum action targets; narrow form inputs use 16px text. Model instructions request concise plain text without praise, promotional language or repeated unchanged context; they retain exact assumptions/units and do not post-process or censor saved user/model content.

The short themed intro is skippable and has a reduced-motion alternative. It is decorative, not fabricated simulation or progress. Stop decorative animation and unnecessary rendering once the interface/camera is settled. Detailed visual refinement is iterative, while the approved sections and journey remain intact.

## Core Journey Through the System

Implements `prd.md > The Core Journey`.

The composer has two explicit entry paths. **Open setup** loads a deliberately selected bundled scene as a paused native preview and saves it as a new immutable URL; it does not call `/api/lab` or require provider credentials. It still needs the normal local API/save service and native MuJoCo preparation. Only after save and native readiness succeed does the paused scene replace the current preview and clear its active draft/conversation; Run remains explicit, and failures preserve the prior preview/draft. Bundled definitions are independent of expiring saved links; saved copies use the standard 24-hour lifetime from creation or last Run/Resume. **Start from prompt** begins a fresh editable draft, focuses the composer, leaves saved scenes intact, and neither saves nor contacts a model. The student must press Build experiment to send it through the ordinary AI composition path. No library entry is used as a fallback.


1. Intro leads to an empty Mission Board. Mechanics is the only active category; the user may explicitly choose a prepared example.
2. For ordinary composition, the student selects an available provider/model and submits a scenario.
3. POST /api/lab sends the latest description, clarifications, recent history, actual scene, saved human request and prior assumptions. The sandbox computes a measured initial-state snapshot, including startup impulses, so follow-ups do not mistake old momentum fields for velocity or inherit missing context after refresh.
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

Desktop uses a composer beside the simulation and inspection directly below the canvas; narrow screens stack them. The `src/ExampleLibrary.tsx` entry exposes the prepared studies and their comparison setups. **Open setup** uses the bundled, validated `shared/examples.ts` / `shared/examples.json` definitions, then follows the ordinary native-preview and saved-copy path without inference. **Start from prompt** uses the complete standalone prompt to start a fresh editable draft, but neither persists nor sends it until Build experiment. A brief CSS entrance never blocks typing and respects reduced motion. Model settings are secondary, with route/cost warnings. Clarification focuses its answer field; current response and preserved-preview assumptions stay distinguishable. Stop waiting aborts the local fetch/candidate, invalidates stale work and preserves the active model; upstream computation and charges may continue.

Real progress appears in the conversation panel without covering the canvas. Plain-language phase names and elapsed time are visible; raw activity and model IDs stay behind details. Chat text is compact but expandable, and a restored scene exposes its saved request without pre-filling the follow-up composer. Source assumptions keep their provenance; calculated facts come from the solver, not AI arithmetic. Stop aborts further model work and preserves draft/preview, with focus returned to the editor. Reduced motion and visible keyboard focus remain.

### Prepared Example Library

`shared/examples.json` holds the 5° double-pendulum comparison, spring-net impact, three-body figure eight, frictionless polygonal loop and curved domino cascade. `shared/examples.ts` imports each scene once and validates it into a `SceneDocument`; its curated decision wrapper does not claim fresh inference or review. `src/ExampleLibrary.tsx` shows compact actual-simulation frame previews from `src/assets/examples/`, a concise question and observation cue, and an expandable complete prompt. There are no retired study variants or simulation special cases keyed to an example ID.

Opening a selected setup does not call `/api/lab` and does not need provider credentials, but it does use the normal API/save service and native MuJoCo preparation to create a fresh immutable saved copy. Only after save and native readiness succeed does it replace the visible preview and clear the active draft/conversation; it remains paused until Run. The bundled definitions do not expire with old rehearsal or saved-scene URLs. A saved copy retains standard 24-hour behavior, renewed only by Run/Resume activity. Starting from a prompt is a separate home-reset action that fills/focuses the editable composer without persistence or inference. Ordinary prompt composition remains unchanged; errors never substitute a prepared example.

### Model Contract and Catalog

Implements `prd.md > Scenario Prompt and Assembly`, `scope.md > The Unique Kernel`.

`shared/scene.ts` owns strict provider-decision and mechanics-model schemas. The decision has `kind: scene|clarify|unsupported`, `summary`, `assumptions`, nullable `question`, `reason`, `scene`, optional nullable `alternative: {label,description}` (limits 60/1600 characters), and optional nullable `approximation` (1200 characters). A ready scene requires a complete physically validated model and null question/reason/alternative; a nonnull approximation explicitly identifies the requested behavior not represented and the actual substitute. Clarify requires a question and null scene; unsupported requires a reason and null scene. Non-scene decisions cannot claim an approximate preview. Non-scene explanations, questions and proposals may coexist, but never authorize a replacement model. Proposal acceptance fills a draft, not an executable scene.

`shared/scene.ts` owns physical schemas/defaults, validity and the decision contract; `shared/catalog.ts` generates provider instructions from that schema and states the interpretation/units policy. `src/physics/mjcf.ts` and `materials.ts` own trusted compilation/contact calibration; `mujoco.ts` owns native observations. There is no second handwritten response schema or model-supplied solver. The model selects blocks/data, never code, arbitrary formulas, solver overrides, assets or plugins.

The current mechanics definition contains environment/model assumptions, named bodies and geometry, their initial poses and degrees of freedom, constraints/tendons and loads. Body parenting must form a valid tree; explicitly modeled equality connections handle supported loop closures. Normalize quantities to SI and radians before admission. Use a Z-up world with gravity normally `(0,0,-9.81)` when that assumption is explicitly displayed. State conversions and defaults remain visible in the preview.

Every unspecified physical choice must be clarified or sensibly assumed with exact values/units in the model's assumptions, including initial rest/spin, geometry, gravity, contact/friction/damping when used. Proposals must state changed/dropped conditions, preserve the remaining comparison and choose non-overlapping placement unless contact is requested. This is an interpretation policy, not an automatic proof that natural-language intent was correctly understood; native values and explicit review remain necessary.

The lab catalog exposes the complete shared decision JSON schema to Pi through a trusted tool, using numeric arrays for all tuples regardless of provider. Scalar-joint reference poses should use initial coordinate zero; schema defaults supply zero when omitted. Advanced validated callers retain nonzero coordinate support. Tool validation, not a provider-specific tuple rewrite or prompt-specific repair, enforces actual geometry and physics.

Omitted ground receives the shared physical default. An explicit `ground:null` for a requested groundless experiment or replacement support is preserved, so the checked candidate and saved preview stay identical. The Ground switch validates and rebuilds a paused scene locally without inference; saved ground edits fork the immutable setup URL.

### Scheduled actions and carried objects

The scene has events[] (default empty, at most 256) and bodies have heldBy (default null). Events declare unique IDs/labels, nonnegative simulation seconds and one action: world linear/angular impulse; held-body release; held-body launch; or enabling/disabling a continuous load by index. Startup impulse loads remain distinct. Same-time ordering is input order.

At-zero actions wait for the first Run step; exact reached-boundary actions execute before publication. Integer native ticks prevent floating-point accumulation from missing a nominal boundary. Arbitrary off-grid times wait until the first native boundary at or after their declaration, with actual firedAt and timing notes exposed. Reset restores contacts, friction modes, welds, held inventories, load flags, clock and pending events. No action may fire twice per run.

Held objects are real massive free rigid roots attached to a fixed/free solid root carrier by trusted private welds. They contribute mass/inertia while held but are collision- and render-inactive. Activation restores explicit material pairs, markers and trails; hidden bodies cannot distort Fit/Follow bounds or leave pre-launch paths. Validation rejects nested groups, articulated descendants, external user constraints/tendons, incompatible independent held velocities and invalid transition ordering.

World launch velocity is an absolute world target in m/s. Body-frame velocity is relative to the post-recoil carrier point in carrier axes, not projectile geometry axes. The coupled response preserves total free-group linear/angular momentum, including remaining payload and pre-release spin; a fixed carrier supplies an external reaction. Carrier own mass stays separate from native Loaded mass/Carried objects observations. These are ideal instantaneous launches, not barrel/fuel/continuum models or arbitrary topology scripts.


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

Straight two-site tendons expose native path length separately from world-Z separation and angle from world vertical. Wrapped/routed paths must not receive a false chord-based cord angle. Branched strings are separate tendons sharing a moving body-backed junction; world-fixed sites do not create a dynamic knot. MuJoCo requires positive mass for an unconstrained moving junction; an ideal massless approximation must be explicitly disclosed. Initial force absence/zero alone is not evidence of a missing mechanism.

For resting contact performance, `ContactEquilibrium` enables native automatic sleep only when eligible boxes exist. Candidates are initially motionless rough free root boxes with dissipative normal contact, no driven/held/parented/connected/tendon participation, and enough frictional deceleration relative to native sleep tolerance. A supported island plus bounded scaled qvel/qacc is required before native ALLOWED; all other trees remain NEVER. No forced initial sleep. Native awake contact wakes the island; Reset restores policies and fully resets data. Keep Newton, contact profile and timestep unchanged. Sleeping contact-force rows are omitted as stale. This retains separate physical bodies but carries the documented 0.001 m/s approximation; it is not a general exact static solver.

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

SimulationCanvas owns the WebGL renderer, view-only camera/OrbitControls, procedural geometry and lifecycle. Preserve native dimensions/poses and Z-up. Moving bodies retain2048point trails (decimated rather than dropping the start), with fixed-pixel markers for objects below about5pixels. Follow all frames visible bodies and trails; manual navigation hands that overview back. Fit all uses scene bounds, with infinite planes contributing only reference positions. Reference grid/plane patches scale in powers of ten.

Native hinge/ball links use transformed joint anchors and current body centers, including moving-parent anchors. They are non-selectable reference render items, with no added model bodies, DOFs or constraints. Native snapshots expose at most64measured signed contact distances plus truncation state. Model evidence lists actual support/coupling relationships and samples current poses throughout checks, retaining spin and return-to-origin movement rather than only comparing endpoints.

Click/tap picks visible solids, point proxies and cable/connection paths. Screen markers use CSS-pixel hit tolerance and nearest-depth tie breaking; hidden queued objects and infinite planes cannot intercept picks. Capture the target on pointer-down so fast motion cannot outrun a click; reject drag, multitouch, cancel and scene-epoch changes. A single reusable box helper and adaptive marker feedback highlight selection, synchronized with an accessible chooser and read-only inspector title buttons.

Focus frames the selected entity alone. Target follow translates camera/target with current entity bounds, preserving orbit/zoom and excluding other objects/trails; manual pan or arrow keys stops it. A selected hidden entity can arm follow, then frame on activation without exposing its queued geometry. Values scrolls/focuses the selected inspector. Clear/Escape, Reset and successful replacement remove selection; failed replacement retains it. This state is local, does not alter the solver or save/renew records, and clears on refresh.

Picking and camera updates must keep the single-rAF ownership guard: OrbitControls change events inside a frame may already schedule the next callback. Reuse picking vectors/raycaster/intersection storage, update grouped cable bounds from current vertices and dispose helper resources/listeners with the renderer. Keyboard shortcuts must not hijack buttons, selects, text fields or disclosure controls.

Update mesh transforms from native state using reusable arrays/matrices. Do not render the whole React tree at physics frequency. Render while stepping or changing the view; stop once paused and settled. Dispose WebGL resources/listeners and the old runtime when a validated replacement is ready. Compilation/renderer failure retains the previous usable scene rather than a false success surface.

`ObjectCards.tsx` lists bodies (including default ground) and connectors. Native descriptors provide mass, dimensions, poses/velocities, angular state/inertia, material coefficients, applied loads, spring constants/generalized force, cable routing/length/tension and world contact reactions. Momentum and translational kinetic energy are body-derived; uniform-gravity potential names its world-origin reference. They are not a complete energy accounting for rotation, compliant contact, mutual gravity or external work. Contact forces are instantaneous, not averaged or mislabeled as total net force. Fixed/ideal elements state assumptions rather than infinite/fake values.

Update ordinary live observations at a modest cadence of about 20 Hz, plus an immediate coherent snapshot on ready/pause. Pose rendering is independent of this cadence. The motion graphs record only these solver snapshots (height, speed, translational kinetic energy for moving bodies), reset with the experiment or Reset, and never interpolate invented samples. Inspection remains read-only; no object dragging, property editing, rewind or history scrubbing is implied.

### Loaded connector visuals

`TendonVisual` sweeps reusable shaded tube buffers over native world-space routing, with spring coils on free spans, cord braid detail, and signed axial-load arrows. Native sphere/cylinder wrap arcs and pulley branch boundaries remain intact. Spring pitch follows the actual path; rope slack curvature is explicitly schematic. Joint reference links retain their distinct non-tendon guide rendering.

`RenderItem.tendon` carries current native effective length, declared length, signed per-branch force (including pulley division), wrap-edge flags and optional presentation settings. Unknown force is not zero. The model's optional tendon `visual` fields control wire/coil radius, turns and relative-force scale, never mechanical properties. The native physical-check key excludes them; the image key retains them. Both the ordinary viewer and sandbox inspection use the same renderer and report the schematic/cosmetic limits.

Keep dynamic geometry, current bounds and an unattached picking centerline reusable across frames. Compound visuals remain selectable through pixel-tolerant picking and delegate all owned GPU-resource disposal. Force arrows are illustrative glyphs, not extra bodies or forces; geometry updates must not create waves, state changes or time progression.

### Cosmetic environments

`scene.appearance` is the closed `{surface,sky,textured,grid}` contract. Surface choices are ice, stone, concrete, asphalt, rubber and plain; sky choices are studio, day, overcast and sunset. Missing fields/scenes default to concrete/day/textured/grid-off without rewriting the stored record; explicit saved grid choices take precedence. The independent Reference grid switch hides visual guides and the scale caption, never the ground collider. The assistant uses stated material/friction context as a cosmetic cue, not a material-identification rule or permission to change physical coefficients, and preserves appearance on ordinary follow-ups.

`SceneEnvironment` owns local CC0 PBR maps, coordinated lights, sky gradients and their disposal. Color maps are 4K; normal and roughness maps are 2K. WEBP derivatives retain source dimensions, and small-screen GPU maps are capped at 2K within device limits. Load only the selected material when horizontal planes exist. Recompute each plane's UVs only when its physical repeat dimensions change, sharing maps/materials without per-draw uniform mutation or duplicate GPU maps. Non-horizontal authored supports keep their own materials. No displacement, extra collision bodies, remote asset URLs or new dependency is introduced. Sky/lighting presets are static visual gradients, not weather or atmospheric scattering.

The visual picker updates the existing viewer without rebuilding native state, resetting time/graphs/selection or invoking a model. Saving forks the immutable record/link; a save during playback records activity on the new link. An unsaved optimistic look must not expose a misleading Copy link; Retry reuses its captured document and Keep previous look restores the saved appearance. Texture-off keeps the collider; the physical Ground switch remains distinct. Known texture upload frames are excluded from simulation wall-time accounting, while ordinary hidden-tab/frame-gap and native numerical-safety guards remain active.

Viewer and isolated inspection share the renderer and local assets. Inspection's static whitelist admits WEBP, not arbitrary URLs, and capture waits for pending material loading. Missing assets report a plain fallback to both the user and model, without invalidating otherwise valid physics. Appearance is excluded from the native-check cache key but included in the visual key so cosmetic edits cannot return stale screenshots.

### Responsive native stepping and observation rendering

Budgeted `advance` retains a pending contact-substep phase. `steps` counts completed 1 ms macro steps, while `runtime.time` reports actual native-tick progress even when `steps=0`. Check callers must test genuine time progress, drain existing queued wall time before adding another chunk, and retain the deadline. Partial handoffs synchronize poses and check warnings/nonfinite/singular state; due events at the exact boundary execute once. `snapshot()` refreshes force/tendon/velocity observations before exposing them, including after a clock-level pause; invalid native pauses do not trigger an unsafe retry. Reset clears the phase. Unbudgeted stepping retains the original operation sequence; equilibrium qualification remains at macro boundaries. One native call/synchronization cannot be preempted.

Main-thread work is measured through the end of the rendered frame rather than classified as a hidden/suspended gap. True idle gaps still pause; admitted wall-time debt stays bounded. Live observation polls require completed macro progress and a 50 ms wall interval, avoiding a force-evaluation storm while yielding through tiny partial steps. Sampling is independent of geometry rendering, and explicit paused inspection remains coherent at actual native time.

`markers.ts` batches ordinary distant markers in one Points draw and keeps a separate selected marker. Subpixel mesh/edge materials and unresolvable trail drawings are hidden, not their logical objects, physical bodies or recorded buffers. ScenePicker still uses the per-entity marker visibility and full physical bounds, so distant objects remain selectable and focusing restores full geometry. Renderer batches never contribute to experiment framing. Closed inspector details allocate no property rows; opening them exposes current values. Telemetry ingests every distinct snapshot into its bounded 4,000-sample history, coalesces only chart view updates to 100 ms, and resets immediately on experiment/time rewind.

### Provider API and Local Security

Implements `prd.md > Scenario Prompt and Assembly`, `prd.md > Approved Conventional Defaults`.

OpenRouter remains the shipped environment default. Optional environment-configured OpenAI/Anthropic and explicitly enabled Connected GPT appear in AI settings. PHYSICS_LAB_CONNECTED_GPT=1 selects GPT-6 Luna with High reasoning; hosted use additionally requires the protected expiring demo configuration below. Without authorization, the broker rejects connected-GPT requests before reading credentials. No automatic provider/model fallback occurs.

`server/index.ts` exposes:

| Route | Contract |
| --- | --- |
| `GET /api/config` | Provider availability and safe defaults, never key values. |
| `GET /api/models?provider=openrouter` | Current text-model IDs, names and capabilities, with actual free/router labels. Direct-provider model IDs can be entered explicitly. |
| POST /api/lab | provider, model, description plus optional clarification/history/currentScene/sourcePrompt/sourceAssumptions; 1 MiB total. History allows only bounded user/assistant text. The sandbox derives currentInitialState; clients cannot inject measured state, credentials, tools or endpoints. JSON returns one decision; NDJSON adds actual activity and assistant text. |
| `POST /api/scenes` | Validated `{prompt,decision,scene,userGroundChoice?}` to a new immutable saved record; 201 with unguessable UUID, server timestamps, expiry and document. 1 MiB input limit. |
| `GET /api/scenes/:id` | Read the saved definition without renewal; missing/malformed/expired IDs return safe 404 `scene_not_found`. No listing endpoint. |
| `POST /api/scenes/:id/run` | Empty JSON object; atomically renew a live record to 24 hours from server activity, returning metadata only. Expired records cannot be revived. |
| `GET/HEAD /scenes/:id` | Serve the app shell for valid UUID links even when expired, so the browser can explain the unavailable link. Scene routes send noindex/nofollow; API data is no-store. |

Use fixed upstream HTTPS hosts, allowlisted provider values, bounded model IDs, JSON-only requests, allowed local Host/Origin values, size limits and deadlines. No arbitrary proxy URLs, wildcard credentialed CORS, prompt/key logging or raw upstream diagnostic dumps. Serve only files safely resolved inside `dist` with correct MIME types.

The browser bounds the streamed response to 1 MiB, validates bounded activity records, handles fragmented UTF-8/record boundaries and rejects incomplete, oversized, malformed, unknown-type or duplicate-terminal streams. An unfamiliar bounded activity-stage name maps to general progress without aborting a valid final decision. Every final decision still passes full local scene admission. Transport/protocol/service failures carry distinct safe codes. Once streaming headers are sent, errors are terminal error records, never counterfeit ready models. Structured provider overloads inside HTTP200 are classified as service outages, without private error echoes or automatic retries.

Model records declare a trusted builder/reviewer purpose, which the host checks against the active tool scope. Builder requests require any declared lab-tool action; reviewer requests require the named native submit_review tool. Clarification/unsupported outcomes still finish through the decision tool, without physics approval or narration-only loops. There is no plain-text fallback on service rejection. The host supplies authoritative model counts and current validated worker tool counts in bounded progress metadata. UI current-phase/counter/elapsed displays are honest resource/activity information, not a percentage complete. Invalid or absent review after its bounded attempts terminates distinctly, not as an instruction to repeatedly change physically valid data; a genuine negative verdict still returns actionable findings for revision. A reserved-capacity stop retains its last concrete validation issue instead of replacing it with a generic budget message.

Budgets: 128 bodies, 128 combined public/held constraints and tendons, 256 loads, 256 scheduled events and 32 mutual-gravity particles. Each run allows 16 shared builder/reviewer model requests, 24 recognized tool calls and 240 seconds; admission permits two local runs or one hosted run. Reserve final-review capacity; a reviewer has at most two requests to submit a usable verdict, counted inside the total rather than as hidden retries. Each call has 120 seconds, 512 KiB generated deltas and 16 MiB upstream SSE transport; supported providers receive an 8192-output-token request cap. Connected GPT's endpoint lacks that cap, so byte/time limits remain authoritative; its hosted stream also ends at demo expiry. Requests/browser streams are 1 MiB. Catalog: 8 MiB, 5 seconds, 5-minute cache. Agent containers use one CPU: text-only or broker-inspected runs use 512MiB/64PIDs/16MiB scratch; local Chromium inspection uses 1GiB/128PIDs/128MiB scratch. Higher request capacity is not a dollar cap.

AI authoring also accepts a closed `{kind:"grid", counts:[nx,ny,nz], spacing:[dx,dy,dz], body:Body}` entry. The template position is the first cell center and spacing is world XYZ. Preflight total counts, including default ground, before cloning; expand to ordinary separate canonical bodies and run the existing admission rules. No nested grids, code evaluation, dynamic spawning, persisted shorthand or cap increase. Catalog/check evidence reports actual current and remaining capacity.

Each native candidate check has a 60-second wall deadline within the overall run. Existing 10 ms work-budget advances drain queued chunks before adding time, yield the event loop and stream real simulated-time progress, including incomplete-macro native progress. Readiness verifies initialization and a fixed 0.5-second motion warm-up, with native numerical-safety guards active at every handoff. It does not replay scheduled future events or a configurable frame checklist. A synchronous native substep is not preemptible. Deadline feedback is not permission to remove requested bodies or change constants.

The builder-only `calculate` tool accepts at most 32 named arithmetic steps and eight finite operands per step, explicit pi/prior-step references, fixed operation arity, radians for trig and explicit degree/radian conversions. Invalid references, duplicate IDs, undefined/domain/nonfinite results and excess bounds fail closed. No expression/code evaluation, I/O or new authority is exposed.

Compact evidence retains native initial/final observations and sampled warm-up motion, not a continuous first-contact or exact path-length certificate. Initial box AABBs use native poses and full dimensions; rotated AABB overlap is not an exact collision test. Declared launch speed and world-XY elevation are separate provenance-labeled input measurements; carrier-relative or zero-speed elevation remains unknown. Later scheduled actions stay declared and pending rather than being falsely reported as pre-verified.

Complete initial-context/tool-result/review JSON is losslessly framed into ordered text blocks of at most 524,288 UTF-16 code units without splitting surrogate pairs. Both roles read adjacent chunks as one document; image blocks follow the complete review text. Keep the existing per-block guard and total pipe/provider byte limits, rather than raising caps or deleting evidence to fit.

Authoring tools accept a typed `decision` object with the derived complete schema and the retained 524,288-character compact-serialization guard; no embedded-JSON string alias exists. Native report tables group ordered observation descriptors and homogeneous record columns without rounding or deleting values, units, notes, order or provenance.

Every outgoing model request receives current trusted remaining allowances: total model requests after the current admission, builder turns available before the two final-review slots, admitted lab actions, inspection calls and image-attempt quota. Text-only image allowance is unavailable. Each reviewer also sees its own current request and remaining format attempts. Status is added only to the outgoing context, not accumulated in Agent history, and grants no extra tools.

## External Service Contracts

The isolated builder has inspect_catalog, calculate, check_experiment and finish_experiment. A separate independent reviewer uses the same pinned model/credential and only submit_review. Requests and tools count within the existing totals. Native checking advances real fixed steps through the short warm-up; all actions due by that time must have executed, and later actions remain pending. A successful finish requires native initialization, the warm-up and independent intent/fidelity approval. The host forwards an accepted scene's initial-check coverage in final progress without changing saved scene definitions. The interface opens paused, keeps verification detail expandable and preserves the last good experiment on failure.

As an explicit last resort, exhausted automatic correction after a real concrete negative review may produce a host-only `proposal` outcome containing the exact native-checked scene, its check receipt and bounded safe assistant concerns. It is not a model-authorable decision kind, a native-check override or an automatically saved scene. Native invalidity, unusable/unstarted review, provider/transport/cancel/timeout failures do not trigger it. JSON clients can receive `kind:"proposal"` and NDJSON uses one `proposal` terminal; normal decision responses are unchanged.

The UI presents a calm unsaved proposal with inspect, explicit use, keep-previous and refinement choices. The previous definition/link stays intact until acceptance; acceptance uses the ordinary validated save path without another model request, and refinement uses the proposal as current context. Normal approved builds do not acquire a confirmation step. A user-accepted proposal is not represented as AI approval.

Builder and reviewer receive the authoritative schema and reuse one coordinate-conventions block, without a mandatory catalog turn. Native initial/final joint anchors, body origins, distances and gravity-relative angles supplement structural and motion evidence; reviewer findings must identify concrete expected-versus-observed mismatches, not reject valid reference poses because their joint coordinate is zero or demand schema-forbidden values. Fixed-support Position observations use native body origins instead of undefined massless inertial centers; dynamic COM/energy are unchanged. finish_experiment accepts an optional reviewResponse of 1..1600 characters describing a correction or evidence-backed rebuttal. Only the previous rejected findings and this response enter the next ordinary review as untrusted claims; current evidence and independent approval remain authoritative, with no extra reviewer, retry or budget increase.

Only a selected model advertising image input receives inspect_scene; unknown capability stays text-only without heuristics or model switching. The tool accepts any nonnegative safe-integer frame on demand at a 60 Hz reference, including frame 0 for initial diagnosis, without an arbitrary 20-second horizon. Diagnostic inspection validates initialization and returns actual geometry/state plus requested Three.js/MuJoCo frames without first requiring an entire future check. Capture bounds remain three frames/call, two calls/four frame attempts/run, 960×640 JPEG/128KiB each and a 45-second deadline with browser-process termination. Automatic QA uses the initial view and warm-up result as allowance permits; the agent can inspect another relevant moment on demand. Missing current-candidate images are disclosed, never replaced by stale pictures; imageless review never claims pixel verification.

Physics fingerprints exclude cosmetic titles/labels/colors. Cached physical reports are reusable after presentation/summary/assumption edits, while final metadata remains validated and reviewed. An unusable previous native state is reported to the builder as repair context. Free-text evidence is not a formal semantic proof; the graph/contacts/motion and user intent must be considered together.

Terminal records are flushed before exit. Structured failures distinguish model/tool limits, JSON/schema, physics, independent verdict/review, internal and protocol causes, with bounded stage/counts and safe last issue. Unknown exception content, raw responses/reasoning, source prompts, credentials, paths and stacks are omitted. Broker/UI preserve cause rather than converting it to unsupported physics; console failure logs contain only fixed code/stage/counts. Scene links do not retain failed-request transcripts or recover old discarded exceptions.

The host sends model stream start/done/error lifecycle records through the worker pipe, not cumulative SDK partial snapshots. Bounded public builder text deltas stream directly to the client; private reviewer/thinking/tool-argument fragments do not. Original decoded/raw/pipe limits remain enforced. Typed sandbox failures distinguish image absence, Docker/start, worker, resource, timeout, protocol and input/output limits; rebuild advice applies only to a missing image, never every internal exception.

In local mode, `server/sandbox.ts` launches a fresh non-root Docker container with network disabled, read-only root filesystem, all capabilities dropped and no-new-privileges. There are no host binds, Docker socket, database or credential mounts. Only trusted lab source, production dependencies and separately built inspection assets enter the deny-by-default build context. Image capture starts software-rendered Chromium with a private scratch profile and debugging pipe; a same-container loopback asset server and exact request allowlist admit only bundled renderer files. No arbitrary URL/path/code arguments enter inspection; JPEG blocks are capability-gated and validated at the host broker. MuJoCo Embind's function generation is allowed only in that private asset-only page. No shell/file tools, default coding-agent tools, extensions, skills, local auth discovery or MCP are loaded. Missing Docker/image fails closed. `npm run api` and `npm start` automatically build/cache the image; setup downloads may use networking, running workers cannot. Inspection images, like prompts and scene data, are sent to the selected AI service.

The broker pins provider/model, credential and exact HTTPS endpoint for the entire run. Ordinary keys come from the environment; Connected GPT uses a bounded constant-argument local OMP token subprocess or a separate expiring hosted OAuth session in Secret Manager. The local login store is never copied. Hosted renewal uses the pinned Pi OAuth implementation, a durable Firestore lease and publication of the rotated credential before use. A browser disconnect cannot interrupt a rotation already in progress. Credentials never enter the worker, browser or saved scene. All model inference uses guarded SSE, including Codex: no WebSocket bypass, redirects, arbitrary URLs or SDK model retries. Abort terminates the model wait/container and prevents new calls; already-sent provider work may still count toward usage.

| Provider | Brokered Pi transport | Boundaries |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | Tool-capable parameter routing; no browser/search plugins or silent model change. Default environment provider. |
| OpenAI | `https://api.openai.com/v1/responses` | Optional environment key; Pi streaming/tool normalization; same local decision/native checks. |
| Anthropic | `https://api.anthropic.com/v1/messages?beta=true` | Exact pinned Pi SDK beta-messages target; optional environment key and normalized streaming/tools; arbitrary queries and redirects remain denied. |
| Connected GPT | https://chatgpt.com/backend-api/codex/responses | Explicit PHYSICS_LAB_CONNECTED_GPT=1 authorization; local OMP login or separate expiring hosted OAuth session, pinned per run; gpt-6-luna with High reasoning only; SSE and unchanged sandbox denial. |
| Discovery | `https://openrouter.ai/api/v1/models` | Public server-side catalog, text/tool-capable suggestions, cached5minutes; model availability is not automatically monitored. |

References: [Pi agent SDK](https://github.com/earendil-works/pi/tree/main/packages/agent), [Pi integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [Docker network isolation](https://docs.docker.com/engine/network/drivers/none/), [Docker runtime controls](https://docs.docker.com/engine/containers/run/).

Malformed/truncated output, refusal, HTTP failure, missing key, rate limit or failed validation is an assembly error preserving input/scene. Never turn it into a fabricated physics result. Free inference still needs a key and has changing quotas/availability. Token and time limits do not constitute a guaranteed dollar cap; operator accounts should have provider-side spending controls.

References: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [OpenRouter API](https://openrouter.ai/docs/api/reference/overview), [free router](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground), [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free), [limits](https://openrouter.ai/docs/api/reference/limits).

## Data Ownership and Future Physics

Browser memory owns editing, the bounded tab-local conversation, view state, live observations and unsaved recovery; the native runtime owns solver state. Node privately persists immutable validated scene documents, including the source prompt with follow-ups/clarifications, interpretation, actual scene and ground choice, with creation/last-run/expiry timestamps. It does not persist the full Pi/tool transcript, provider settings/credentials, runtime handles, trajectories or snapshots. The browser caches at most8 link metadata entries and revalidates on open. The selected provider receives submitted message/history/scene context under its own policy.

Saved IDs are random UUID capabilities, with no directory/list or update route. Each setup change creates a new record/link; reading and sharing are non-renewing. Initial lifetime is creation plus 86,400,000 ms. Run/Resume must confirm renewal before physics starts; active playback renews every 60 seconds and at its final Pause. Paused Reset, camera controls and opening links do not extend lifetime. Exact-boundary expiry is enforced by the selected repository independently of cleanup, and expired IDs never resurrect. A local definition may explicitly be copied to a fresh ID after expiry.

Local storage defaults to a private OS app-data SQLite file, overridden by SCENE_DB_PATH outside the public project tree. Directories are private (0700) and the file 0600. Hosted mode explicitly selects Firestore Standard using FIRESTORE_PROJECT_ID; creation commits metadata and bounded JSON chunks atomically, reads are consistent, renewal patches metadata only, and cleanup rechecks expiry transactionally before deletion. It does not import local data or fall back to ephemeral storage. SQLite purges at startup and each minute; hosted cleanup runs while the API is awake. Logical expiry is immediate in both modes. Server close releases the repository/timer. Tests use isolated SQLite files or emulator project IDs and injectable clocks. Unlisted links are not authentication: anyone holding one can read/forward/run it.

Client URL/candidate generations, Run-start tokens and operation-owned recovery protect stale replies. A late read cannot overwrite a newer lease; Run/heartbeat feedback cannot erase an unsaved setup's Retry action. Requests are bounded to 15 seconds, and save retries reuse the captured document rather than making another model request. A failed renewal blocks playback until recovery. Browser Back/Forward, refresh and local recent links restore actual saved ground/values without a model call.

Hosted API admission uses an explicit PUBLIC_ORIGINS HTTPS allowlist rather than relaxing local Host/Origin checks. OpenRouter choices remain free-only with zero token-price ceilings. An explicitly authorized public subscription demo requires PHYSICS_LAB_CONNECTED_GPT=1, LAB_DEMO_EXPIRES_AT and CONNECTED_GPT_SECRET; server/demo.ts enforces its configured window, not a login challenge. A separate OAuth session is stored and rotated in Secret Manager, guarded by a Firestore lease containing only ownership/expiry metadata. Resource-specific secret read/version-add IAM conditions and secret expiration match the demo deadline. The server denies subscription requests at exact expiry and bounds active streams to that deadline. The API keeps credentials and Firestore access. Its authenticated private WebSocket gateway runs the network-denied Docker agent/native-check worker on a dedicated VM, with one admission held until teardown completes. The VM has no public IP or NAT; Direct VPC egress and Private Google Access provide the required private API/registry/secret connectivity. A keyless, IAM-protected Cloud Run renderer consumes only validated scene/camera data, using the same renderer and full textures; its identity has no secret or scene-storage permissions. Image-capable agent tools request those images through a bounded broker RPC, without gaining network or browser-command access. The capture deadline remains 45 seconds; RPC time also allows cold-start checking within the unchanged four-minute update budget. Model turns, tool/image allowances, native checks and independent review remain unchanged. Public access can exhaust the owner's subscription quota. Infrastructure budgets are alerts, not guaranteed dollar cutoffs.



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
  ExampleLibrary.tsx                  explicit prepared-scene and prompt entry
  styles.css                           lab/glass layout, motion and accessibility
  SimulationCanvas.tsx                 native-scene rendering and view-only camera
  selection.ts                         ray/marker/path picking and visible entity bounds
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
  examples.json / examples.ts         curated scenes and validated SceneDocuments
  saved-scene.ts                       saved document and retention contracts
  harness.ts                           conversation, run budgets and progress contract
  assembly-stream.ts                   bounded NDJSON progress/text/final admission
server/
  index.ts                             local/hosted API, strict origin admission and static assets
  providers.ts                         Pi adapters and exact-endpoint credential broker
  demo.ts                              configured hosted subscription window
  subscription-auth.ts                 private OAuth rotation and durable lease
  harness.ts                           bounded broker/worker orchestration
  harness-worker.ts                    Pi lab tools and native candidate checks
  sandbox.ts                           local Docker lifecycle or bounded authenticated worker transport
  worker-gateway.ts                    private one-run admission, stdio transport and teardown
  worker-check.ts                      real deployment isolation and native physics self-check
  scenes.ts / firestore-scenes.ts      local SQLite or hosted transactional JSON storage
  render-gateway.ts / renderer-client.ts private validated rendering, identity authentication and cancellation
Dockerfile / .dockerignore              shared API/worker images and deny-by-default context
deploy/worker-startup.sh                dedicated private VM bootstrap, pinned image/secret versions
tests/
  scene.test.ts                        structural/physical admission invariants
  compiler.test.ts                     physical compilation and frame/constraint behavior
  physics.test.ts                      numerical references, loads, clocks and snapshots
  providers.test.ts                    meaningful refusal/truncation/parse handling
  http.test.ts                         real local request/Host/Origin/body boundaries
  clock.test.ts                        fixed-step timing, pause and retained-work invariants
  fixtures.ts                          isolated synthetic physical reference models
devpost/                               project documents, build checklist and current app map
README.md / CHANGELOG.md                actual setup, limitations, run and verified changes
```

Pi supplies the agent/provider APIs. The application exposes no general-purpose coding-agent tool surface, compatibility assembler route or extra process-launching framework.

## Verification and Prior Evidence

Previously exercised official MuJoCo 3.16.0, not a current application build:

- Native and Chromium/WASM routed-tendon Atwood test: 1 kg/2 kg, expected acceleration ±3.27 m/s² and tension 13.08 N. At h=1 ms the one-second positions were approximately +1.636635/-1.636635 m versus ideal ±1.635 m; tension was 13.08 N and path-length error about 4.9e-8 m.
- Halving h to 0.5 ms halved that displacement error. Equal-time state at 0.1×/1×/10× was identical.
- The first overly stiff constraint profile became unstable. The documented positive time-constant profile stabilized it without changing physical acceptance tolerances; numerical settings must be validated, not supplied arbitrarily by the LLM.
- Native RK4 free-flight reference matched analytical position/velocity. This does not establish RK4 accuracy for externally evaluated forces or the split-step runtime.
- Actual single-thread WASM file was 10,751,588 bytes, 2,657,248 bytes gzip, excluding JS/assets. This is not an integrated application download or mobile performance result.

Keep compact deterministic regressions for consumer-visible failures: invalid references/topology/units, unsafe or inconsistent model data, body/geom frame conversion, supported joint/tendon construction, analytical motion/constraints, signed force mapping, exactly-once impulses, state-dependent load timing, fixed-step speed equality, pause/snapshot aliasing, and provider refusal/truncation/errors. Do not test copied wording, source text, CSS, forwarding or mocks that merely echo input.

Historical integration-check scope (not a report of test execution): production build, behavioral suite and browser checks for reduced motion, a configured-provider prompt, clarification, paused preview, Run/speed/pause, unsupported/failure preservation, replacement cleanup and responsive camera/layout. Fixtures and solver-only smokes do not establish authenticated inference.

## Decisions and Open Issues

Historical verification: the scheduled-action and visual-interaction revision passed the production build and 95 behavioral checks. Native references cover carried mass/inertia, world and post-recoil relative velocities, angular/linear momentum, fractional and exact event boundaries, no early/duplicate execution, load switching, friction between actions and Reset/speed invariance. Legacy stored definitions run without rewriting their JSON. The final-review gate rejects unresolved metadata even when physical checks are cached.

Historical GPT/browser evidence: Connected GPT was live-tested with GPT-6 Luna. A brokered run of the unchanged follow-up produced three distinct 10 kg projectiles at 300 m/s and 30 degrees, at 0/10/20 seconds, without the old startup recoil inputs. Actual browser playback showed all three releases and native inventory 1030/1020/1010/1000 kg. Reset and clean-browser restore return to three queued rounds at t0 without inference or renewed expiry. Mobile/reduced-motion checks cover compact chat, horizontal timeline access, cancellation/focus preservation and 100-character label containment. Nine pre-existing records remained byte-identical. Source/asset scans found no configured keys, literal JWTs or live scene IDs. Software-rendered frame gaps can intentionally pause playback; explicit resume preserves every physics step.

The prior Pi-only checkpoint passed 82 behavioral checks. Its Docker probes verified non-root/read-only/capability/network limits and denied host paths, socket, credentials and root writes; cancellation waited for removal. OpenRouter/browser evidence covered elastic/inelastic falls, scene-aware height/velocity edits, preserved masses/materials, paused immutable links, narrow/reduced-motion layout and inference-free restore. Four then-existing records stayed unchanged. A provider502 was not hidden. Provider availability and natural-language interpretation remain limits, not universal guarantees.

The previous saved-scene checkpoint passed89 checks before one-shot adapter tests were retired. Its browser/API evidence covered refresh and process-restart survival, clean-browser read/run without inference, immutable ground forks, source-prompt preservation, Back/Forward and320px clipboard fallback. Clock-controlled checks covered1ms-before/exact expiry, non-resurrection, active heartbeat/final Pause, stopped renewal after Pause, expired-link recovery and stale-read/Reset races. Failed-save retry ownership and all still-relevant native/storage contracts remain covered; obsolete provider-envelope behavior is not retained as a compatibility path.

Source/provider contracts and numerical evidence informed the engineering defaults above. Any discovered change to the product, chosen architecture or supported physical meaning must be discussed, while routine internal corrections are recorded in the checklist's Revisions. A needed new model is not labeled impossible merely because it is absent.

Live provider verification requires authorized AI access. Never paste keys in chat or copy them into the public project. The approved Connected GPT mode is broker-side only; it does not permit credential discovery or worker access. Provider quota/auth failures remain real failures; no fake model substitutes for them.
