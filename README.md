# Physics Lab — Mission Board

A web mechanics lab that turns described situations into validated MuJoCo models and also offers a small library of prepared physics studies. Scenes open paused, then can be run and inspected. `physics-lab` is the working repository name; Mission Board names the workspace.

## Devpost Learn Skill Pack evidence

The development workflow uses the official [Devpost Learn Skill Pack](https://github.com/challengepost/learn-ai-basics). The [six installed skills](.agents/skills/), [source hashes](skills-lock.json) and [upstream license](.agents/skills/LICENSE) are included; the project-specific outputs are:

| Artifact | What it records |
| --- | --- |
| [Scope](devpost/scope.md) | The compositional mechanics kernel, intended audience, success conditions and scope cuts. |
| [Product requirements](devpost/prd.md) | User decisions, the describe–preview–run–inspect journey, visual direction and acceptance criteria. |
| [Technical specification](devpost/spec.md) | Implementation choices, physical-model boundaries, validation and verification, linked to the requirements. |
| [Build checklist](devpost/checklist.md) | Fast-mode build slices, hands-on feedback, revisions, verification evidence and remaining readiness checks. |
| [Technical app map](devpost/app-map.html) | An offline source reference and project-grounded practice to reuse, not a claim of a completed hands-on tour. Download/open locally to view it. |

**History:** the [first implementation commit, `4b37d3c`](https://github.com/ishkhan42/physics-lab/tree/4b37d3cea77344c715521a480de15f9655c0de4c), already contains the skills and substantive planning documents. Plans and implementation were committed together; this is not a separate pre-code approval record.

**Current status:** planning documents and build order are approved; the checklist records the implemented slices and technical checks. Final learner readiness remains open. This index does not claim completion of all six steps or Devpost submission.

The personal learner profile is private and ignored; an ignore rule does not make AI conversations private or remove previously tracked material.

## Development status

The mechanics lab supports real contacts, friction, recoil, scheduled launches/releases, timed impulses and continuous-load switching. The light workbench uses compact chat and a visual action timeline; saved scenes retain their 24-hour sliding lifetime. Pi works only with trusted lab tools inside a no-network sandbox. Native checks validate execution, not every natural-language interpretation or long-term physical outcome. Final learner approval remains in the [build checklist](devpost/checklist.md).

Current production and inspection/Docker builds pass, along with **184 behavioral checks**. Browser verification opened all nine prepared setups without inference and checked provider-free playback, prompt drafts, save retry, delayed expiry replies, keyboard cancellation and 320px touch/reduced-motion layout. Prior clean-install and authenticated model checks remain in the [build checklist](devpost/checklist.md); this library verification does not claim fresh AI generation from the curated prompts or final learner approval.

The application never loads a pretend model when credentials are missing. Earlier browser checks used synthetic assembly responses only at the test boundary; the subsequent authenticated OpenRouter check used no interception or synthetic response. No fake provider is part of the app.

## Run locally

Requires Node 24.12 or later in the Node 24 line, Docker, and access to a running Docker daemon. Install the pinned dependencies:

```sh
npm ci --ignore-scripts
```

For generation, copy the secret-free `.env.example` to a private location outside this checkout, populate an authorized provider key, and link that file as the ignored `.env`. Do not put keys in browser code, `VITE_` variables, source, fixtures or logs. OpenRouter is the shipped default. An explicitly authorized existing OMP GPT login can instead be used by starting with `PHYSICS_LAB_CONNECTED_GPT=1 npm start` (or `npm run api`): this opt-in selects GPT-6 Luna and resolves a credential through the installed `omp token` command in the server broker. No token is copied into project files, environment templates, saved scenes or the sandbox; one credential is pinned for the whole lab run. OMP must be installed and signed in on that host.

Development uses two terminals:

```sh
npm run api
```

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. The frontend proxies `/api` to the loopback server on port 3001. Restart the API after changing credentials, then reload the page.

`npm run api` and `npm start` automatically build/cache the sandbox image before starting. First setup needs registry access to download the Node base image and pinned packages; the running agent container has networking disabled. Docker failure stops setup: there is no unsandboxed fallback. Restart through these commands after changing harness, shared-contract or physics code so the image matches the app.

For the built local app:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. Do not start another API process on the same port. This is deliberately local-only; exposing an operator-funded model endpoint publicly requires a separate access/spending policy.

```sh
npm run sandbox:build
npm test
```

Tests run one file at a time to bound simultaneous WASM/container work. They use native Node HTTP, actual MuJoCo WASM and the real isolated Pi worker. Model responses are substituted only at the test boundary; tests need the built Docker image, not a provider key or GPU. Numerical fixtures are test data, not built-in product experiments.

## Use

**Examples** are bundled with the app and do not depend on the lifetime of older saved links. **Open setup** is an explicit selection that prepares the chosen scene natively and saves a new immutable URL; it makes no `/api/lab` inference request and needs no provider credential. It still needs the normal local API/save service and browser MuJoCo preparation. The new preview stays paused, and only after save and native readiness succeeds does it replace the current preview and clear its active draft/conversation. Run remains explicit. Saved copies use the usual 24-hour lifetime from creation or last Run/Resume; opening or copying a link does not renew it. **Start from prompt** begins a fresh editable draft, focuses the composer and leaves saved scenes intact; it does not save or contact a model. Press **Build experiment** to use the ordinary AI composition flow. Example loading never replaces normal prompt composition, and API, save, native or model failures do not fall back to a library scene.

1. Describe a mechanics situation, or choose **Start from prompt** for a prepared example's standalone prompt. Examples remain editable; submitting a prompt uses the ordinary model path. The empty viewer stays uncluttered; charts and object cards appear once an experiment is being prepared.
2. Press Build experiment, or Update experiment for a follow-up. The assistant shows its actual current activity and elapsed time beside the conversation, leaving the canvas visible. Detailed activity and AI settings are collapsed by default. OpenRouter's named free route remains the default unless connected-GPT mode was explicitly enabled; quota failures never silently select a paid model.
3. Review the paused preview, visual action timeline, planned mass/speed values and native loaded-mass readout before Run. Missing details are asked about or explicitly assumed. Approximations remain visible; fuller assumptions and model notes are behind disclosures. A proposal only fills a draft and still needs your explicit submission.
   A physical plane at z=0 is included by default (ideal reference restitution 1, zero friction). An explicitly groundless model or custom replacement support may use `ground:null`; the checked scene is not silently rewritten afterward. Switch Ground on/off on the canvas to rebuild locally without another model request. The reference grid is not the ground collider.
4. Press Run (or Space outside an editing control), choose a playback speed, and pause to inspect. Follow all initially keeps bodies and recorded paths in view; manual orbit, zoom or pan turns that overview tracking off. The grid grows with the scene and shows its square size. A slow device runs more slowly without skipping physics. Motion over time graphs actual solver samples at about20Hz. Reset clears selection and restores the initial state, view, trails and graphs without inference; Fit all (F) restores the overview.
5. Ask for changes without rewriting the setup. The actual scene, saved human request, prior assumptions, measured initial state and recent conversation accompany the update, including after refresh. Old model mistakes are not treated as user intent. Conversation stays tab-local. Failed/canceled updates preserve your draft and existing preview; successful changes receive a fresh paused URL. Stop prevents further model turns and tears down the sandbox; already-sent provider work may still count toward usage.
6. Open **Recent scenes** to see up to eight links kept on this browser across refreshes. The list starts collapsed so it does not crowd the composer. Opening a scene fetches its saved record without another model request; a cached expiry never overrides renewal by another viewer.

Interface text uses short, direct instructions. The assistant is instructed to use plain text, describe the setup or change without promotional filler, and keep assumptions explicit with values and units. This guides model output; it is not a guarantee of every provider's wording.

### Surface and sky

Open **Appearance** in the viewer to pick Ice, Stone, Concrete, Asphalt, Rubber or Plain, plus Studio, Daylight, Overcast or Sunset lighting. Surface thumbnails use the actual local materials. **Surface texture** removes visual detail only; the separate **Ground** switch controls the physical floor. Under **Guides**, **Reference grid** independently shows/hides the grid and its scale caption. It defaults on for old scenes and is saved with the shared look.

The assistant chooses these cosmetic presets using the request and material/friction context, discloses assumed looks, and preserves them on follow-ups. A friction coefficient does not identify a material; changing a look never changes friction, restitution, gravity, geometry or events. Old scenes default to concrete/daylight with texture enabled.

Materials bundle CC0 4096×4096 color maps and 2048×2048 normal/roughness maps, encoded as WEBP. Only the selected material loads; narrow screens use at most 2K GPU maps and device texture limits are respected. Texture density stays in metres as reference ground patches grow. Ice has an assumed cosmetic 1 m repeat, not measured terrain dimensions. The sky presets are smooth static gradients with coordinated lighting, not atmospheric or weather simulation. Asset sources and terms are in [the material license](src/assets/environment/LICENSE.txt).

Appearance edits preview immediately and save a fresh immutable URL without another AI call or rebuilding/resetting playback. Previously shared links keep their original look and physics. Failed saves show an unsaved look with Retry and Keep previous look; missing texture assets keep a plain usable surface and an explicit notice. Refresh restores the saved look at the paused initial state. The assistant's isolated screenshot renderer uses the same local materials and waits for the selected surface to load or report its fallback.

### Dense-scene performance

- Budgeted stepping can yield between the 16 calibrated contact substeps instead of blocking through a whole millisecond of physics. No native steps, bodies or scheduled actions are skipped. One native solve and the required state synchronization remain indivisible, so the 10 ms work budget is not a hard ceiling.
- The browser distinguishes its own foreground physics/render work from a genuinely suspended frame gap. Hidden-tab and numerical-safety pauses remain active.
- Unresolvable body geometry is replaced by batched screen markers, and subpixel trails are not drawn. All physical objects, recorded paths, selection and bounds remain; focusing/zooming restores full geometry and resolvable trails.
- Collapsed inspector details are created on demand. Charts retain all distinct input snapshots within their 4,000-sample history, while redraws are coalesced to at most 10 Hz. Live observation polling also waits for completed millisecond progress, avoiding repeated full force solves after every tiny partial handoff. Pause and explicit inspection still obtain coherent current values.

These changes improve rendering and interaction, not the mathematical cost of hundreds of coupled contacts. Stiff settling/impact phases can remain far below real time on a slower browser. The solver, contact calibration and timesteps are not weakened to conceal this. A much larger physics-throughput change needs separate numerical validation or a compute-location/engine decision; a Web Worker alone does not make the same solver faster.

### Select and follow an object

- Click/tap a solid object or cable. Tiny distant objects can be selected through their visible ring markers; infinite planes stay background, and dragging/pinching does not accidentally select.
- The selected object is outlined and its read-only inspector card is highlighted. The Choose object menu and selectable card titles provide a keyboard-accessible alternative.
- Focus frames just that object. Follow tracks its motion without pulling other objects/trails into the view; orbit and zoom stay attached. Pan or arrow-key navigation hands the camera back to you.
- A queued object can be selected and armed for following before it appears. The view waits, then frames and follows it on activation.
- Values brings its card into view. Clear or Escape removes selection. Reset and successful scene replacement clear it; failed replacement preserves the current view. Selection/camera actions do not edit physics, create a saved scene or renew retention, and are not persisted on refresh.

Hinge/ball joints display native anchor-to-body reference links, including anchors carried by moving parents. These add no bodies, mass or constraints and do not intercept object picking.

AI services have changing quotas, availability and latency. Each update permits at most **16 total selected-model requests**, including independent reviews, **24 lab-tool calls** and **four minutes** total, with a 120-second deadline per request. Final-review capacity is reserved instead of allowing the builder to spend every request first. A reviewer can use at most two requests to correct an unusable verdict within the same total; this is not a provider/network retry or an approval fallback. Providers that support it receive an 8192-output-token limit; connected GPT additionally relies on fixed time/byte limits because its subscription endpoint does not accept that cap. This is not a dollar cap: the higher request allowance can increase usage. Provider/SDK retries remain disabled, with no silent model or prepared-example fallback and no unsandboxed execution.

Scene, clarification and limitation decisions share one contract. Questions, explanations and one optional supported proposal may coexist while no scene is ready. A ready scene has no unresolved questions or proposals and still undergoes strict physical validation; an explicit approximation is separate metadata, not permission to weaken that validation. Technical diagnostics sit behind a disclosure rather than becoming the main response. Selecting a proposal only fills the editable draft; it does not send a request.

Chat shows the actual current **Build / Test / Review** activity, elapsed work time and AI requests used against the limit. These checks can repeat; the counter is a resource allowance, not a completion percentage or ETA. Activity details reveal bounded recent public work and lab-action counts, never private reasoning. A compact receipt remains after completion, clarification, failure or Stop; a fresh request starts a fresh count. Stop retains the message and previous scene, and returning to an existing saved link makes no AI request.

## Pi harness and isolation

The harness uses pinned Pi agent/provider [SDKs](https://github.com/earendil-works/pi/tree/main/packages/agent), without coding CLI tools, extensions, skills, MCP or repository instructions. The builder has inspect_catalog, calculate, check_experiment and finish_experiment. **Only a selected model that advertises image input also receives inspect_scene.** Exact provider/Pi catalog metadata determines capability; unknown or text-only models receive neither the tool nor images, and are never silently replaced. A separate same-model reviewer has only the bounded submit_review tool, with an explicit native argument schema and a required native tool choice. Its calls count inside the same 16-request/24-tool budget. Host-validated builder/reviewer roles cannot grant extra tools. Finalization preflights review capacity before simulation/screenshots; failure to start review, exhaustion of unusable-verdict attempts and an unresolved concrete rejection are distinct outcomes. Readiness checks the initial setup and a short motion warm-up, not an entire scheduled future.

### Readiness, not a future-outcome certificate

Normal approved previews open paused after schema validation, native initialization, a **0.5-second motion warm-up** and independent review. No arbitrary frame list or event-time replay blocks them. All declared bodies, materials and scheduled actions remain unchanged; actions beyond the warm-up stay pending and run when you press Run. Native numerical-safety checks remain active throughout actual playback.

The interface keeps the last good experiment while building, shows actual Build/Test/Review progress and preserves the request on failure. Initial-check coverage belongs in the completed update's expandable activity, not another user-facing configuration panel or a false claim that every future event was proved.

Builder requests also require at least one declared lab-tool action. A clarification or limitation must be submitted through finish_experiment, not repeated as uncommitted prose. This prevents narration-only model turns from consuming the remaining allowance without a usable decision. The exact provider endpoints remain pinned; Anthropic uses the installed SDK's literal `/v1/messages?beta=true` target rather than allowing arbitrary queries.

Finish validates and checks the candidate, then independently compares its mechanism, initial contact, excitation and claims with the request. A concrete rejection returns findings for revision; approval accepts directly. There is no identical-copy/resubmit handshake. Display titles, labels and colors do not invalidate cached physics; final metadata stays validated and independently reviewed. A bad prior native state becomes repair context instead of blocking the repair. This improves fidelity but does not formally prove every natural-language condition, chaos or long-term outcome.

Independent semantic review is still model-dependent and can reject an otherwise valid setup. A reviewer objection alone is not proof that an engine operator is unsupported. Automatic correction remains the ordinary path. Only as a last resort after concrete review objections exhaust that path may the host offer a genuinely native-checked proposal for the user's explicit decision; it is not Ready and is not saved or substituted automatically.

### Last-resort user review

The interface presents unresolved assistant concerns calmly, lets the user inspect the actual unsaved proposal, and offers **Use this setup**, **Keep previous** and adjustment through the existing composer. Acceptance creates a new saved scene through the normal validation/save flow without another model call. Rejection preserves the previous definition and link. Refinement uses the proposal as context rather than accidentally editing the old scene.

This is not a native-check override or an automatic fallback. Invalid physics, canceled runs, provider/transport failures and unusable reviews do not become proposals. The model cannot author the host-only proposal outcome or forge its check receipt. Normal approved builds do not acquire an extra confirmation step.

Builder and reviewer receive the same authoritative schema and coordinate conventions, without a required catalog roundtrip. Review evidence includes computed native joint-anchor distances and angles relative to gravity; zero joint coordinate means the declared reference pose, not necessarily vertical. Fixed-support positions use the physical body origin, not MuJoCo's undefined inertial center for a massless body. Moving-body center-of-mass observations and energy calculations remain unchanged. After a rejection, finish_experiment accepts a bounded reviewResponse describing a correction or evidence-backed rebuttal; the next ordinary review considers the previous finding and response as untrusted claims against the current evidence. Neither can override native checks or independent approval.

The shared conventions also cover scheduled actions and carried bodies. Structural evidence is explicitly initial-before-events: it reports native carrying relationships, carrier-relative mobility and release boundaries instead of describing queued bodies as independent world-jointed mechanisms. Both world-target and carrier-relative launch modes have native momentum reaction. This evidence complements measured loaded mass, event status and motion; it is not an automatic approval rule.

For image-capable models, the builder is encouraged to inspect its actual Three.js/MuJoCo scene before finishing. The tool supports overview/front/side/top views, optional object focus and **any nonnegative safe-integer frame on demand**, including frame 0 for initial-state diagnosis. Frame numbers use a 60 Hz simulation reference independent of display FPS. There is no arbitrary 20-second inspection horizon; native stability and the capture deadline still bound what can be rendered. Native steps are executed, not teleported. Each run permits two capture calls and four frame attempts total, with at most three 960×640/128KiB frames per call and a 45-second capture deadline. Exhausting this allowance alone does not prevent a physically checked revision from finishing: activity and review explicitly disclose missing current-candidate images, and stale screenshots are never substituted. Numerical checks and independent review still apply. Text-only review does not claim to see the scene.

Automatic visual QA uses the initial view and warm-up result while allowance remains. The model can inspect another meaningful moment on demand instead of marching through a fixed screenshot sequence. Every model request receives trusted current remaining allowances for model requests, lab actions, inspection calls and image attempts, including the final-review reserve and the reviewer's own format-request allowance.

`inspect_scene` is diagnostic: it returns native initial state and geometry plus real requested frames without requiring an entire future run first. Initial compilation/constraint checks still apply, and finalization still requires the short motion check and independent review. An unchanged failed physical candidate reuses its prior failure within that assistant run; changing only explanatory text does not repeat an expensive simulation.

Worker failures retain bounded cause, stage, model/tool counts and safe last-check information instead of discarding exceptions. Malformed JSON/schema, physics/review failure, model/tool budget, internal and protocol errors are distinct. UI details preserve this evidence while the main message stays concise. Server failure logs contain code/stage/counts only, not prompts, scenes, raw provider responses, reasoning, credentials or stacks. Failed-attempt transcripts are not persisted with scene URLs; earlier failures whose cause was discarded cannot be reconstructed retroactively.

Large repeated arrangements can be authored as a bounded declarative grid. It expands to separate ordinary bodies before checking/saving; it does not merge bricks or increase the 128-body limit (including ground). The assistant receives the measured current capacity rather than guessing it. Sandbox transport forwards model lifecycle bookends, not growing partial tool-argument snapshots; public builder text remains live. Missing-image, startup, protocol, resource and byte-limit failures have distinct safe diagnostics.

Branched strings use separate cords sharing a body-backed moving junction. A moving ideal zero-mass knot needs an explicitly disclosed positive-mass approximation; a world-fixed site is not a substitute. Straight-cord checks report actual path length, world-Z separation and angle from vertical separately. A stated vertical drop is not silently treated as cord length.

Native checks have a 60-second wall-clock budget inside the overall four-minute assistant run. They yield between bounded advances and stream measured simulated time, rather than leaving an expensive check looking idle. Queued fixed steps are drained without double-counting time. A costly arrangement returns concrete repair feedback; its requested body count/constants are not silently reduced. One individual native step is synchronous and cannot be preempted.

Startup uses MuJoCo's [staged forward pipeline](https://mujoco.readthedocs.io/en/latest/programming/simulation.html#simulation-loop) for kinematics, velocity and inertia, then solves forces after the startup inputs are installed. This avoids redundant intermediate force solves without changing solver/contact parameters.

The builder has a trusted `calculate` tool for bounded arithmetic, trigonometry and explicit degree/radian conversions: at most 32 named steps, eight operands per step, prior-step references and finite results. It cannot evaluate code or access files/network. Review still requires an independent verdict; the calculator does not approve scenes.

Scene tools take a typed `decision` object with the actual authoring schema, not a JSON document hidden inside a string. Homogeneous vectors keep exact length bounds, the existing serialized decision-size limit remains, and old string arguments are not accepted. Model-facing inspection tables share ordered quantity/unit descriptors without deleting measurements; the runtime, object cards and saved scene format are unchanged.

Checks retain compact native initial/final observations and sampled motion during the short warm-up. Sampled motion is not an exact path-length or continuous first-contact record. Declared launch speed/elevation is labeled separately from measured execution, and carrier-relative launches do not receive invented world angles.

Large initial context, tool results and review JSON are framed into ordered text blocks within the existing 524,288-character block boundary, preserving Unicode and every measurement. This prevents a valid repair review from becoming an invalid-response error merely because it is slightly larger than the first review. Overall pipe/provider/time limits remain unchanged; evidence is not truncated.

Transport interruption, malformed response, provider overload and physics/review failures have distinct safe messages; no response values or raw provider errors are exposed. A structured provider-overload event is recognized even inside HTTP200. It is not blamed on the student's prompt or tool capability, and is not retried automatically. Bounded unfamiliar activity-stage names fall back to general progress rather than aborting a valid final scene; unknown record types, malformed data, invalid scenes, duplicates and byte limits still fail closed.

Each run gets a disposable non-root container with `--network=none`, read-only root filesystem, all capabilities dropped, no-new-privileges and one CPU. Text-only runs retain 512MiB/64PIDs/16MiB scratch; image-capable runs use 1GiB/128PIDs/128MiB scratch for Chromium. Scratch remains no-exec/nosuid. No host directories, Docker socket, scene database, `.env` or provider credentials are mounted or copied into it. The deny-by-default Docker build context includes only dependencies, trusted lab code and the separately built inspection assets. Chromium uses a private profile, software rendering and a debugging pipe; a loopback-only asset server inside the same isolated container admits only the bundled renderer assets. There are no arbitrary URL/file/code tool arguments or external browser requests. MuJoCo's trusted Embind bindings require JavaScript function generation in that private page. Docker isolation shares the host kernel; it is not a VM or a claim of absolute escape resistance.

The worker connects to the server only through bounded JSON lines. The credential broker pins provider/model and exact HTTPS inference endpoint, denies redirects/arbitrary targets and forces SSE, including for connected GPT. Only image-capable models may advertise scene inspection or receive bounded canonical inline JPEGs in user/inspection-result blocks; remote image URLs, other image formats and assistant/system images are denied. OpenRouter/OpenAI/Anthropic use private environment keys. Connected GPT is unavailable unless PHYSICS_LAB_CONNECTED_GPT=1 was explicitly set; it uses the existing OMP login for gpt-6-luna without mounting or exporting the login store. The public model catalog is fetched separately with a five-minute cache. Requests, source context, scene data and any inspection screenshots still go to the selected AI service.

POST /api/lab accepts provider, model, description, optional clarification/history/currentScene/sourcePrompt/sourceAssumptions, up to 1 MiB. Client history cannot introduce privileged roles, tools, endpoints or keys. The sandbox computes currentInitialState itself, rather than trusting a client-supplied measurement. JSON clients receive one validated decision; NDJSON also carries real activity and public assistant text. Saved source prompts are bounded to 16,000 characters before inference. Provider settings and credentials are never saved with scenes.

## Scheduled actions

- Declare events with unique IDs, labels and nonnegative simulation times in seconds (maximum256). Timed impulses, held-object launch/release and enabling/disabling existing continuous loads are supported. Equal-time actions follow their input order.
- At-zero events wait for Run; they do not execute in the paused preview. Integer solver ticks avoid accumulated time drift, and reached-boundary actions are applied before publishing the new state. Off-grid times execute at the first native boundary at or after the requested time; firedAt records that boundary. Reset rearms all events, contacts, held objects and load states.
- A launch uses a separately declared free rigid body with heldBy pointing to a fixed/free solid root carrier. Its mass/inertia physically contribute while held; its collision/render state stays inactive until release. Carried groups cannot be nested, articulated or attached to unsupported external joints/tendons. Held-body velocity fields must be zero/default placeholders: actual motion is inherited from the carrier.
- Carrier body.mass is its own mass, excluding separately declared payload. Native Loaded mass and Carried objects readouts update as objects leave; those calculated facts are not guessed AI assumptions. Launches conserve linear/angular momentum for a free carried group; a fixed carrier supplies an external reaction.
- World launch velocity is an absolute world-space target in m/s. Body velocity is relative to the post-recoil carrier point, expressed in carrier axes. Spin is inherited from the pre-release carrier. Release alone preserves carried velocity.
- These are ideal instantaneous actions and rigid-body payloads, not internal ballistics, continuous fuel burn, arbitrary scripts or general body merging/fracture. Old saved scenes without events/heldBy still run, and reading or renewing them does not rewrite their stored JSON.

## Saved scenes and sharing

- Ready scenes receive an unguessable `/scenes/<uuid>` URL. **Copy link** shares the saved setup; clipboard-denied browsers get a selectable link instead.
- Records start with 24 hours of retention. Run/Resume renews it, active runs send one-minute heartbeats, and Pause records the final activity. The server uses elapsed hours, not a calendar-day cutoff.
- Opening, sharing, paused Reset and Fit do not renew retention. Expired links become unavailable at the deadline and cannot be resurrected by Run; a still-open local setup can be saved as a new copy.
- Refresh or another browser restores the saved request, assumptions, actual ground, appearance and complete schedule at the initial paused state. The saved request is readable behind its disclosure; the composer is empty and ready for a follow-up. Trajectories, graphs, camera and playback position are not saved.
- Setup changes such as Ground or Appearance create a new URL. Existing shared definitions are immutable, so another viewer cannot overwrite them.
- Link holders can view the prompt, assumptions and setup and run the scene. There is no public directory or account system; treat the link as access permission. Provider settings and credentials are not part of a saved record.

The server uses Node 24's built-in SQLite, with no separate database service. The default is the private OS application-data folder (`~/.local/share/physics-lab/scenes.sqlite` on Linux). `SCENE_DB_PATH` can select another persistent private file **outside the source tree**. Keep that path consistent across restarts. New directories are mode 0700; existing directories must already be private, and database files are mode 0600. Do not commit live data or copy it into public project assets.

Expired rows are purged at startup and once a minute; expired records are inaccessible immediately, independently of cleanup. Storage failures preserve the previous usable preview and offer a local retry without another inference request. Client storage requests have a 15-second deadline. Local browser history contains link metadata only, not scene definitions.

Links work wherever the app is reachable. The default server is still loopback-only: a localhost link is not a public Internet deployment. No Host/Origin guard or provider-spending boundary is relaxed by this feature.

## Physics and safety boundaries

- Mechanics only: explicit SI quantities and a Z-up reference frame. Other physics categories are future work, not functioning choices.
- The LLM supplies validated data, never unrestricted MJCF, code, plugins or external assets. Elasticity/friction requests are modeled rather than downgraded to a no-bounce alternative.

| Mechanics family | Implemented model |
| --- | --- |
| Bodies and coordinates | Sphere, box, capsule, cylinder, ellipsoid, infinite plane and point particle; free, hinge, slide, ball and fixed motion; primitive-derived mass/inertia. |
| Materials and contacts | Elastic/partial/inelastic normal restitution targets; independent static and kinetic sliding friction; torsional/rolling resistance lengths. |
| Loads | Uniform gravity, force/torque at declared frames, one-time impulses, linear drag and bounded mutual point-particle gravity. |
| Scheduled actions | One-shot timed impulses, held-body launch/release and continuous-load toggles; real pending/completed state and loaded-mass accounting. |
| Springs, joints and connections | Joint/tendon springs and damping, limits, connect/weld/scalar couplings, fixed/slack/spring cords, geometric wraps and pulley branches. |
| Readouts | Native state/inertia, material values (including zero), linear momentum, translational kinetic energy, uniform-gravity potential, instantaneous world contact forces, joint spring/damping force/torque and cable tension. |

Pair restitution is `min(eA,eB)` and friction uses the component-wise maximum; the ideal default ground lets the ball's coefficient govern the requested rebound. A stated elastic body is e=1, not an arbitrary 0.8. Static friction prevents slip; an unconstrained sphere can still roll. Ground and model assumptions are inspectable.

Supported frictional free boxes that start at rest may enter MuJoCo automatic sleep after low-speed, low-acceleration equilibrium is observed. The native 0.001 m/s sleep tolerance is a numerical approximation, not exact static mechanics. Contact with an awake object wakes the island; awakened or accelerating bodies must qualify for supported equilibrium again, so airborne objects cannot freeze at their apex. Explicitly moving, driven, carried, jointed, connected, tendon-attached and lossless objects retain ordinary integration. Newton/contact stiffness/timesteps are unchanged. Sleeping bodies remain separate, selectable physical objects; resting contact-force rows and incomplete fixed-support totals are omitted rather than reported as zero. Reset clears sleep state. Large unsettled contact arrangements can still run slower than real time.

The trusted contact profile maps restitution to MuJoCo's direct spring/damping law, with 16 native substeps inside each 1 ms playback tick when collisions are possible. Contact-free scenes retain 1 ms native stepping. Contact coefficients are numerical targets, not an exact hard-impact or universal accuracy guarantee. Regression cases measure e=0/0.5/1, momentum/energy in an isolated elastic collision, Coulomb deceleration, stiction, and elastic impact with friction. Contact forces are instantaneous; contact jitter and finite-step error can occur. Energy rows distinguish kinetic components and uniform gravity rather than claiming a universally conserved total.

- Broad composition is supported, but deformable bodies, adhesive sticking, continuum fluids, arbitrary force histories and arbitrary user solvers are not advertised. High-speed/small-scale, very stiff/high-frequency and large coupled-contact scenes need additional numerical validation. Point particles have no collision surface; contact materials require a colliding primitive.
- Reference grids are visual aids, infinite planes display as patches, and point markers are not physical radii. Inspection is read-only; camera movement does not change physics.
- Oversized, invalid or numerically unstable models fail with an explanation. The app does not delete excess objects, suppress warnings or substitute another experiment.
- Provider keys stay on the server; prompts go to the selected provider under its policy. Saved-scene records include the source prompt and validated setup until expiry, not credentials, provider settings or a conversation transcript.

The official MuJoCo JS bindings are still marked WIP. The version is pinned. The viewer has a substantial initial JS bundle and downloads the WASM engine on first model preparation; build-size and upstream Node-branch externalization warnings are not hidden.

## Code and workflow

- `shared/scene.ts`, `shared/catalog.ts`: physical admission, provider decision contract and generated model instructions.
- `server/`: local API, safe built-file serving and the three real provider adapters.
- `src/physics/`: trusted MJCF compiler, calibrated material/contact law, MuJoCo lifecycle/observations and playback clock.
- `src/`: Mission Board, actual Three.js canvas and read-only object cards.
- `tests/`: deterministic physical references, frame/force/path regressions, HTTP boundaries and provider error parsing.

## License

The application source and its documentation are available under the [MIT License](LICENSE).

Third-party material keeps its own terms: the [Devpost Learn Skill Pack notice](.agents/skills/LICENSE), [CC0 ground-material sources](src/assets/environment/LICENSE.txt), and upstream library/font licenses are not replaced by the application license. Dependency packages retain their notices when installed.
